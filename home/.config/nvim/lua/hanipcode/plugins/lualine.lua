return {
	"nvim-lualine/lualine.nvim",
	dependencies = { "nvim-tree/nvim-web-devicons" },
	config = function()
		require("lualine").setup({
			options = {
				-- Pinned to the flavour rather than plain "catppuccin", which
				-- follows whatever flavour is active. Explicit = it can't drift if
				-- the colorscheme flavour ever changes.
				theme = "catppuccin-macchiato",
			},
			sections = {

				lualine_c = { { "filename", file_status = true, path = 1 } },
				lualine_x = {
					-- require("minuet.lualine"),
					"encoding",
					"fileformat",
					"filetype",
				},
			},
		})
	end,
}
