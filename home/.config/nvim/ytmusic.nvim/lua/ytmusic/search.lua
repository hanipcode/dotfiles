--- YouTube Music search via the InnerTube API (same API the web client uses).
--- No auth required; requests go through plain curl.
local config = require("ytmusic.config")

local M = {}

local SEARCH_ENDPOINT = "https://music.youtube.com/youtubei/v1/search"
local NEXT_ENDPOINT = "https://music.youtube.com/youtubei/v1/next"
local USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"

-- search filter params (protobuf blobs, same values ytmusicapi uses)
local FILTERS = {
	songs = "EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D",
	videos = "EgWKAQIQAWoKEAkQChAFEAMQBA%3D%3D",
}

-- jam.nvim-style prefixes: "v:query" searches videos, "s:query" songs (default)
local PREFIXES = { s = "songs", v = "videos" }

function M.format_time(secs)
	secs = math.floor(secs or 0)
	local h = math.floor(secs / 3600)
	local m = math.floor((secs % 3600) / 60)
	local s = secs % 60
	if h > 0 then
		return string.format("%d:%02d:%02d", h, m, s)
	end
	return string.format("%d:%02d", m, s)
end

local function parse_duration(str)
	local parts = {}
	for n in str:gmatch("%d+") do
		table.insert(parts, tonumber(n))
	end
	if #parts == 2 then
		return parts[1] * 60 + parts[2]
	elseif #parts == 3 then
		return parts[1] * 3600 + parts[2] * 60 + parts[3]
	end
end

local function client_context()
	return {
		client = { clientName = "WEB_REMIX", clientVersion = "1.20250101.00.00", hl = "en" },
	}
end

local function curl_args(endpoint, body)
	return {
		"curl",
		"-s",
		"--max-time",
		"15",
		endpoint,
		"-H",
		"Content-Type: application/json",
		"-H",
		"Origin: https://music.youtube.com",
		"-H",
		"Referer: https://music.youtube.com/",
		"-H",
		"User-Agent: " .. USER_AGENT,
		"--data",
		body,
	}
end

--- Collect every node stored under `key` anywhere in the response.
local function collect_items(node, key, out)
	if type(node) ~= "table" then
		return out
	end
	for k, v in pairs(node) do
		if k == key and type(v) == "table" then
			table.insert(out, v)
		else
			collect_items(v, key, out)
		end
	end
	return out
end

--- flexColumn runs -> list of " • "-separated text segments.
local function column_segments(runs)
	local segments = { "" }
	for _, run in ipairs(runs or {}) do
		local text = run.text or ""
		if text == " • " then
			table.insert(segments, "")
		else
			segments[#segments] = segments[#segments] .. text
		end
	end
	return segments
end

local function item_to_track(item)
	local vid = vim.tbl_get(item, "playlistItemData", "videoId")
	if not vid then
		return nil
	end
	local cols = {}
	for _, fc in ipairs(item.flexColumns or {}) do
		local runs = vim.tbl_get(fc, "musicResponsiveListItemFlexColumnRenderer", "text", "runs")
		table.insert(cols, column_segments(runs))
	end
	local title = cols[1] and cols[1][1]
	if not title or title == "" then
		return nil
	end

	local track = {
		id = vid,
		title = title,
		url = "https://music.youtube.com/watch?v=" .. vid,
	}
	-- col 2: songs = artists • album • duration / videos = channel • views • duration
	local meta = cols[2] or {}
	track.artist = meta[1] ~= "" and meta[1] or nil
	for _, seg in ipairs(meta) do
		if seg:match("^%d+:%d%d$") or seg:match("^%d+:%d%d:%d%d$") then
			track.duration = parse_duration(seg)
			track.duration_str = seg
		end
	end
	if meta[2] and not meta[2]:match("views$") and meta[2] ~= track.duration_str then
		track.album = meta[2]
	end
	return track
end

function M.parse(json_text)
	local ok, data = pcall(vim.json.decode, json_text)
	if not ok or type(data) ~= "table" then
		return {}
	end
	local tracks = {}
	for _, item in ipairs(collect_items(data, "musicResponsiveListItemRenderer", {})) do
		local track = item_to_track(item)
		if track then
			table.insert(tracks, track)
		end
	end
	return tracks
end

local function runs_text(node)
	local parts = {}
	for _, run in ipairs((node or {}).runs or {}) do
		table.insert(parts, run.text or "")
	end
	return table.concat(parts)
end

--- "up next" radio panel item -> track
local function panel_to_track(item)
	local vid = item.videoId
	local title = runs_text(item.title)
	if not vid or title == "" then
		return nil
	end
	local track = {
		id = vid,
		title = title,
		url = "https://music.youtube.com/watch?v=" .. vid,
	}
	-- byline: artists • album • year
	local meta = column_segments(vim.tbl_get(item, "longBylineText", "runs"))
	track.artist = meta[1] ~= "" and meta[1] or nil
	track.album = meta[2]
	local len = runs_text(item.lengthText)
	if len:match("^%d+:%d%d$") or len:match("^%d+:%d%d:%d%d$") then
		track.duration = parse_duration(len)
		track.duration_str = len
	end
	return track
end

function M.parse_related(json_text, seed_id)
	local ok, data = pcall(vim.json.decode, json_text)
	if not ok or type(data) ~= "table" then
		return {}
	end
	local tracks = {}
	for _, item in ipairs(collect_items(data, "playlistPanelVideoRenderer", {})) do
		local track = panel_to_track(item)
		if track and track.id ~= seed_id then
			table.insert(tracks, track)
		end
	end
	return tracks
end

--- Async search: cb(tracks) on the main loop. Returns the vim.system
--- handle so callers can kill superseded requests.
function M.search(query, cb)
	local filter = "songs"
	local prefix, rest = query:match("^(%a):%s*(.+)$")
	if prefix and PREFIXES[prefix] then
		filter = PREFIXES[prefix]
		query = rest
	end
	local body = vim.json.encode({
		context = client_context(),
		query = query,
		params = FILTERS[filter],
	})
	return vim.system(curl_args(SEARCH_ENDPOINT, body), { text = true }, function(out)
		vim.schedule(function()
			if out.code ~= 0 then
				cb({})
				return
			end
			local tracks = M.parse(out.stdout or "")
			local limit = config.options.search_limit
			if #tracks > limit then
				tracks = vim.list_slice(tracks, 1, limit)
			end
			cb(tracks)
		end)
	end)
end

--- Async "up next" radio for a track: cb(tracks) on the main loop.
function M.related(track, cb)
	if not track or not track.id then
		vim.schedule(function()
			cb({})
		end)
		return
	end
	local body = vim.json.encode({
		context = client_context(),
		videoId = track.id,
		playlistId = "RDAMVM" .. track.id,
		isAudioOnly = true,
	})
	return vim.system(curl_args(NEXT_ENDPOINT, body), { text = true }, function(out)
		vim.schedule(function()
			if out.code ~= 0 then
				cb({})
				return
			end
			cb(M.parse_related(out.stdout or "", track.id))
		end)
	end)
end

return M
