--- Now-playing floating window.
local config = require("ytmusic.config")
local mpv = require("ytmusic.mpv")
local player = require("ytmusic.player")
local search = require("ytmusic.search")

local M = {
	win = nil,
	buf = nil,
	timer = nil,
}

mpv.on_exit(function()
	M.close()
end)

local function bar(pos, dur, width)
	if not dur or dur <= 0 then
		return string.rep("─", width)
	end
	local filled = math.floor(math.min(pos / dur, 1) * (width - 1))
	return string.rep("━", filled) .. "●" .. string.rep("─", width - 1 - filled)
end

local function truncate(str, width)
	if vim.fn.strdisplaywidth(str) <= width then
		return str
	end
	return vim.fn.strcharpart(str, 0, width - 1) .. "…"
end

local function render(time_pos)
	if not (M.buf and vim.api.nvim_buf_is_valid(M.buf)) then
		return
	end
	local width = config.options.ui.width
	local track = player.current()
	local title = track and track.title or mpv.props["media-title"]
	local artist = track and track.artist or nil

	local lines
	if not title or mpv.props["idle-active"] ~= false then
		lines = {
			"  nothing playing",
			"",
			"  [/] search   [q] close",
		}
	else
		local dur = mpv.props["duration"] or (track and track.duration)
		local pos = time_pos or 0
		local icon = mpv.props["pause"] and "⏸" or "▶"
		local vol = math.floor(mpv.props["volume"] or 0)
		local plpos = (mpv.props["playlist-pos"] or 0) + 1
		local plcount = mpv.props["playlist-count"] or 1
		local timing = string.format("%s / %s", search.format_time(pos), dur and search.format_time(dur) or "?")
		lines = {
			"  " .. truncate(title, width - 4),
			"  " .. truncate(artist or "", width - 4),
			string.format("  %s %s", icon, bar(pos, dur, width - 6)),
			string.format("  %s   %d/%d   vol %d%%", timing, plpos, plcount, vol),
			"  [space] play  [n/b] next/prev  [h/l] seek",
			"  [-/=] vol  [e] queue  [/] search  [q] close",
		}
	end
	vim.bo[M.buf].modifiable = true
	vim.api.nvim_buf_set_lines(M.buf, 0, -1, false, lines)
	vim.bo[M.buf].modifiable = false
end

local function tick()
	if not (M.win and vim.api.nvim_win_is_valid(M.win)) then
		return
	end
	if mpv.is_running() then
		mpv.get("time-pos", function(pos)
			render(tonumber(pos))
		end)
	else
		render(nil)
	end
end

function M.close()
	if M.timer then
		M.timer:stop()
		M.timer:close()
		M.timer = nil
	end
	if M.win and vim.api.nvim_win_is_valid(M.win) then
		vim.api.nvim_win_close(M.win, true)
	end
	M.win = nil
	M.buf = nil
end

function M.open()
	if M.win and vim.api.nvim_win_is_valid(M.win) then
		return
	end
	local width = config.options.ui.width
	M.buf = vim.api.nvim_create_buf(false, true)
	vim.bo[M.buf].bufhidden = "wipe"
	vim.bo[M.buf].filetype = "ytmusic"

	M.win = vim.api.nvim_open_win(M.buf, true, {
		relative = "editor",
		anchor = "SE",
		row = vim.o.lines - 2,
		col = vim.o.columns - 1,
		width = width,
		height = 6,
		style = "minimal",
		border = "rounded",
		title = " ♪ YouTube Music ",
		title_pos = "center",
	})
	vim.wo[M.win].winhighlight = "Normal:NormalFloat,FloatBorder:FloatBorder"

	local function bmap(lhs, fn)
		vim.keymap.set("n", lhs, fn, { buffer = M.buf, nowait = true, silent = true })
	end
	bmap("q", M.close)
	bmap("<Esc>", M.close)
	bmap("<space>", player.toggle)
	bmap("n", player.next)
	bmap("b", player.prev)
	bmap("h", function()
		player.seek(-5)
	end)
	bmap("l", function()
		player.seek(5)
	end)
	bmap("-", function()
		player.volume("-5")
	end)
	bmap("=", function()
		player.volume("+5")
	end)
	bmap("s", player.stop)
	bmap("e", function()
		M.close()
		require("ytmusic.picker").queue()
	end)
	bmap("/", function()
		M.close()
		require("ytmusic.picker").search()
	end)

	vim.api.nvim_create_autocmd("WinClosed", {
		pattern = tostring(M.win),
		once = true,
		callback = M.close,
	})

	render(nil)
	tick()
	M.timer = (vim.uv or vim.loop).new_timer()
	M.timer:start(
		config.options.ui.refresh,
		config.options.ui.refresh,
		vim.schedule_wrap(tick)
	)
end

function M.toggle()
	if M.win and vim.api.nvim_win_is_valid(M.win) then
		M.close()
	else
		M.open()
	end
end

--- Statusline component, e.g. for lualine: require("ytmusic").statusline
function M.statusline()
	if not player.is_active() then
		return ""
	end
	local track = player.current()
	local title = track and track.title or mpv.props["media-title"]
	if not title then
		return ""
	end
	local icon = mpv.props["pause"] and "⏸" or "♪"
	return icon .. " " .. title
end

return M
