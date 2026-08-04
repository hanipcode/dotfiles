return {
	{
		"xiyaowong/transparent.nvim",
		lazy = false, -- disable lazy loading — it should load immediately
		config = function()
			require("transparent").setup({
				groups = {
					"Normal",
					"NormalNC",
					"Comment",
					"Constant",
					"Special",
					"Identifier",
					"Statement",
					"PreProc",
					"Type",
					"Underlined",
					"Todo",
					"String",
					"Function",
					"Conditional",
					"Repeat",
					"Operator",
					"Structure",
					"LineNr",
					"NonText",
					"SignColumn",
					"CursorLine",
					"CursorLineNr",
					-- "StatusLine" / "StatusLineNC" deliberately NOT cleared:
					-- lualine paints its sections with its own lualine_* groups, but
					-- the filler between them uses StatusLine. Clearing it punched a
					-- transparent gap through the middle of the bar, which is what
					-- made it look off-theme. Re-add them if you want a see-through
					-- status bar back.
					"EndOfBuffer",
				},
				extra_groups = { "NeoTreeNormal", "NeoTreeNormalNC" }, -- you can add more
				exclude_groups = {},
				on_clear = function() end,
			})
		end,
	},
}
