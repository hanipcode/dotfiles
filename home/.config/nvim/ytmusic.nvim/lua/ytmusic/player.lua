--- Queue and playback orchestration on top of the mpv IPC client.
local mpv = require("ytmusic.mpv")
local config = require("ytmusic.config")

local M = {
	queue = {}, -- list of tracks, mirrors mpv's internal playlist
	played = {}, -- video ids seen this session; keeps autoplay from repeating
}

local fetching_related = false

mpv.on_exit(function()
	M.queue = {}
	fetching_related = false
end)

local function ensure(cb)
	mpv.start(function(ok)
		if ok then
			cb()
		end
	end)
end

local function notify(msg)
	vim.notify(msg, vim.log.levels.INFO, { title = "ytmusic" })
end

local function label(track)
	return track.artist and (track.title .. " — " .. track.artist) or track.title
end

local function mark_played(track)
	if track.id then
		M.played[track.id] = true
	end
end

--- Fetch "up next" radio for the tail of the queue and append it, so
--- playback continues instead of stopping when the queue runs out.
local function autoplay_fetch()
	local seed = M.queue[#M.queue]
	if fetching_related or not seed or not seed.id then
		return
	end
	fetching_related = true
	require("ytmusic.search").related(seed, function(tracks)
		fetching_related = false
		if not config.options.autoplay or #M.queue == 0 or not mpv.is_running() then
			return
		end
		local added = 0
		for _, track in ipairs(tracks) do
			if added >= config.options.autoplay_batch then
				break
			end
			if not M.played[track.id] then
				mark_played(track)
				table.insert(M.queue, track)
				-- append-play also restarts playback if the queue already ran dry
				mpv.send({ "loadfile", track.url, "append-play" })
				added = added + 1
			end
		end
		if added > 0 then
			notify(("↪ radio: queued %d related track%s"):format(added, added == 1 and "" or "s"))
		end
	end)
end

-- prefetch as soon as the last queued track starts playing
mpv.on_prop("playlist-pos", function(pos)
	if not config.options.autoplay then
		return
	end
	if type(pos) == "number" and pos >= 0 and pos + 1 >= #M.queue then
		autoplay_fetch()
	end
end)

-- fallback: the queue ran dry before the prefetch landed (e.g. very short track)
mpv.on_prop("idle-active", function(idle)
	if idle == true and config.options.autoplay and #M.queue > 0 then
		autoplay_fetch()
	end
end)

--- Replace the playlist and play this track now.
function M.play(track)
	ensure(function()
		M.queue = { track }
		mark_played(track)
		mpv.send({ "loadfile", track.url, "replace" })
		mpv.set("pause", false)
		notify("♪ " .. label(track))
	end)
end

--- Append to the playlist (starts playing if nothing is).
function M.enqueue(track)
	ensure(function()
		if #M.queue == 0 then
			M.play(track)
			return
		end
		table.insert(M.queue, track)
		mark_played(track)
		mpv.send({ "loadfile", track.url, "append-play" })
		notify("+ queued: " .. label(track))
	end)
end

--- Jump to 1-based queue index.
function M.play_index(i)
	if not M.queue[i] then
		return
	end
	mpv.send({ "playlist-play-index", i - 1 })
	mpv.set("pause", false)
end

--- Remove 1-based queue index.
function M.remove_index(i)
	if not M.queue[i] then
		return
	end
	mpv.send({ "playlist-remove", i - 1 })
	table.remove(M.queue, i)
end

--- Currently playing track (from our queue mirror) or nil.
function M.current()
	local pos = mpv.props["playlist-pos"]
	if type(pos) ~= "number" or pos < 0 then
		return nil
	end
	return M.queue[pos + 1], pos + 1
end

function M.is_active()
	return mpv.is_running() and mpv.props["idle-active"] == false
end

function M.toggle()
	if not mpv.is_running() then
		notify("nothing playing")
		return
	end
	mpv.send({ "cycle", "pause" })
end

function M.next()
	mpv.send({ "playlist-next", "weak" })
end

function M.prev()
	mpv.send({ "playlist-prev", "weak" })
end

function M.seek(secs)
	mpv.send({ "seek", secs, "relative" })
end

--- volume("+5") / volume("-5") / volume("50")
function M.volume(arg)
	local n = tonumber(arg)
	if not n then
		return
	end
	local relative = type(arg) == "string" and arg:match("^[+-]")
	if relative then
		mpv.send({ "add", "volume", n })
	else
		mpv.set("volume", math.max(0, math.min(100, n)))
	end
end

function M.stop()
	M.queue = {}
	mpv.send({ "stop" })
end

function M.quit()
	M.queue = {}
	mpv.quit()
end

--- Play an arbitrary URL (video, mix, playlist...). mpv expands playlists
--- itself, so the queue mirror only tracks the URL entry.
function M.play_url(url)
	M.play({ title = url, url = url })
end

return M
