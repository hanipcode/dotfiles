return {
	"nvzone/floaterm",
	dependencies = "nvzone/volt",
	cmd = "FloatermToggle",
	keys = {
		{ "<leader>t", "<cmd>FloatermToggle<CR>", desc = "Toggle floating terminal" },
	},
	opts = {
		mappings = {
			sidebar = nil,
			term = function(buf)
				vim.keymap.set({ "n", "t" }, "<C-q>", function()
					require("floaterm").toggle()
				end, { buffer = buf })

				vim.keymap.set({ "n", "v", "i" }, "q", function()
					require("floaterm").toggle()
				end, { buffer = buf })
			end,
		},
	},
}
