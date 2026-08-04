-- local plugin: ~/.config/nvim/ytmusic.nvim (YouTube Music via yt-dlp + mpv)
return {
	dir = vim.fn.stdpath("config") .. "/ytmusic.nvim",
	name = "ytmusic.nvim",
	dependencies = { "nvim-telescope/telescope.nvim", "nvim-lua/plenary.nvim" },
	cmd = "YTMusic",
	keys = {
		{ "<leader>js", "<cmd>YTMusic search<cr>", desc = "YT Music: search" },
		{ "<leader>jj", "<cmd>YTMusic toggle<cr>", desc = "YT Music: play/pause" },
		{ "<leader>jn", "<cmd>YTMusic next<cr>", desc = "YT Music: next track" },
		{ "<leader>jb", "<cmd>YTMusic prev<cr>", desc = "YT Music: previous track" },
		{ "<leader>jq", "<cmd>YTMusic queue<cr>", desc = "YT Music: queue" },
		{ "<leader>jm", "<cmd>YTMusic now<cr>", desc = "YT Music: now playing" },
	},
	opts = {},
	config = function(_, opts)
		require("ytmusic").setup(opts)
	end,
}
