local M = {}

M.defaults = {
	-- number of search results to show
	search_limit = 25,
	-- when the queue runs out, keep playing YouTube Music's "up next" radio
	autoplay = true,
	-- how many radio tracks to append per fetch
	autoplay_batch = 5,
	-- initial mpv volume (0-100)
	volume = 80,
	-- ms to wait after typing stops before searching
	debounce = 400,
	-- yt-dlp format string passed to mpv
	audio_format = "bestaudio/best",
	mpv = {
		bin = "mpv",
		-- extra CLI args appended to the mpv invocation
		extra_args = {},
	},
	ytdlp = {
		bin = "yt-dlp",
	},
	ui = {
		width = 46,
		-- refresh interval for the now-playing window (ms)
		refresh = 500,
	},
}

M.options = vim.deepcopy(M.defaults)

function M.setup(opts)
	M.options = vim.tbl_deep_extend("force", vim.deepcopy(M.defaults), opts or {})
end

return M
