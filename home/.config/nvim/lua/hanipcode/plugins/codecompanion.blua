local adapter = require("hanipcode.local.adapter")

return {
	"olimorris/codecompanion.nvim",
	config = function()
		require("codecompanion").setup({
			display = {
				diff = {
					provider = "mini_diff",
				},
			},
			strategies = {
				chat = {
					slash_commands = adapter.get_slash_commands(),
					adapter = "openrouter",
					keymaps = {
						submit = {
							modes = { n = "<CR>" },
							description = "Submit",
							callback = function(chat)
								local config = adapter.read_config()
								chat:apply_model(config.current_model)
								chat:submit()
							end,
						},
					},
					roles = {
						llm = function(_adapter)
							return "CodeCompanion (" .. _adapter.model.name .. ")"
						end,
					},
				},
				inline = {
					adapter = "openrouter",
				},
			},
			adapters = {
				openrouter = adapter.get_adapter(),
			},
			extensions = adapter.get_extensions(),
		})

		vim.keymap.set({ "n", "v" }, "<leader>ck", "<cmd>CodeCompanionActions<cr>", { noremap = true, silent = true })
		vim.keymap.set(
			{ "n", "v" },
			"<leader>a",
			"<cmd>CodeCompanionChat Toggle<cr>",
			{ noremap = true, silent = true }
		)
		vim.keymap.set("v", "ga", "<cmd>CodeCompanionChat Add<cr>", { noremap = true, silent = true })

		vim.keymap.set("n", "<leader>cs", adapter.select_model, { desc = "Select Gemini Model" })
		-- Expand 'cc' into 'CodeCompanion' in the command line
		vim.cmd([[cab cc CodeCompanion]])
	end,

	dependencies = {
		"nvim-lua/plenary.nvim",
		"hakonharnes/img-clip.nvim",
		"nvim-treesitter/nvim-treesitter",
		"j-hui/fidget.nvim",
		"ravitemer/codecompanion-history.nvim",
	},
	init = function()
		require("hanipcode.plugins.codecompanion.fidget_spinner"):init()
		adapter.init_config()
	end,
}
