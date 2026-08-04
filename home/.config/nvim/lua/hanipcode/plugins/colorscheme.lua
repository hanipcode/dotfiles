return {
	"catppuccin/nvim",
	name = "catppuccin",
	priority = 10000,
	config = function()
		require("catppuccin").setup({
			flavour = "macchiato",
			transparent_background = true, -- disables setting the background color.
			float = {
				transparent = true, -- enable transparent floating windows
				solid = false, -- use solid styling for floating windows, see |winborder|
			},
			custom_highlights = function(colors)
				return {
					-- Was #292c3c = Frappe mantle, left over from the Frappe era.
					-- #363a4f is Macchiato surface0, the equivalent subtle tone.
					SnacksIndent = { fg = "#363a4f" },
				}
			end,
		})

		vim.cmd.colorscheme("catppuccin")
		-- vim.api.nvim_set_hl(0, "SnacksIndent", { fg = "color", bg = "color", bold = true, italic = false })
	end,
}
