--- ytmusic.nvim — YouTube Music player for Neovim (yt-dlp + mpv).
--- Inspired by jam.nvim.
local M = {}

local subcommands = {
	search = function(args)
		require("ytmusic.picker").search({ query = #args > 0 and table.concat(args, " ") or nil })
	end,
	toggle = function()
		require("ytmusic.player").toggle()
	end,
	pause = function()
		require("ytmusic.mpv").set("pause", true)
	end,
	resume = function()
		require("ytmusic.mpv").set("pause", false)
	end,
	next = function()
		require("ytmusic.player").next()
	end,
	prev = function()
		require("ytmusic.player").prev()
	end,
	stop = function()
		require("ytmusic.player").stop()
	end,
	quit = function()
		require("ytmusic.player").quit()
	end,
	queue = function()
		require("ytmusic.picker").queue()
	end,
	now = function()
		require("ytmusic.ui").toggle()
	end,
	volume = function(args)
		require("ytmusic.player").volume(args[1])
	end,
	seek = function(args)
		require("ytmusic.player").seek(tonumber(args[1]) or 0)
	end,
	url = function(args)
		if args[1] then
			require("ytmusic.player").play_url(args[1])
		end
	end,
	autoplay = function()
		local cfg = require("ytmusic.config").options
		cfg.autoplay = not cfg.autoplay
		vim.notify("[ytmusic] autoplay " .. (cfg.autoplay and "on" or "off"), vim.log.levels.INFO)
	end,
}

function M.setup(opts)
	require("ytmusic.config").setup(opts)

	vim.api.nvim_create_user_command("YTMusic", function(cmd)
		local fargs = cmd.fargs
		local sub = table.remove(fargs, 1) or "search"
		local fn = subcommands[sub]
		if not fn then
			vim.notify("[ytmusic] unknown subcommand: " .. sub, vim.log.levels.ERROR)
			return
		end
		fn(fargs)
	end, {
		nargs = "*",
		desc = "YouTube Music player",
		complete = function(arglead, cmdline)
			if cmdline:match("^%s*YTMusic%s+%S+%s") then
				return {}
			end
			return vim.tbl_filter(function(s)
				return vim.startswith(s, arglead)
			end, vim.tbl_keys(subcommands))
		end,
	})

	vim.api.nvim_create_autocmd("VimLeavePre", {
		group = vim.api.nvim_create_augroup("YTMusicQuit", { clear = true }),
		callback = function()
			require("ytmusic.mpv").quit()
		end,
	})
end

--- For statusline integration (lualine etc.)
function M.statusline()
	if not package.loaded["ytmusic.mpv"] then
		return ""
	end
	return require("ytmusic.ui").statusline()
end

return M
