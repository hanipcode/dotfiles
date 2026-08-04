return {
	"folke/snacks.nvim",
	priority = 1000,
	lazy = false,
	opts = {
		-- your configuration comes here
		-- or leave it empty to use the default settings
		-- refer to the configuration section below
		bigfile = { enabled = true },
		dashboard = { enabled = true },
		explorer = { enabled = false },
		indent = {
			enabled = true,
			animate = {
				enabled = false,
			},
			scope = {
				enabled = false,
			},
		},
		input = { enabled = true },
		picker = { enabled = true },
		notifier = { enabled = true },
		quickfile = { enabled = true },
		scope = { enabled = true },
		scroll = { enabled = false },
		terminal = {
			enabled = true,
			win = {
				keys = {
					nav_h = false,
					nav_j = false,
					nav_k = false,
					nav_l = false,
				},
			},
		},
		statuscolumn = { enabled = true },
		words = { enabled = true },
	},
	config = function(_, opts)
		require("snacks").setup(opts)
		
		-- Set up terminal navigation keymaps to work with tmux navigator
		vim.api.nvim_create_autocmd("TermOpen", {
			callback = function()
				local tnoremap = function(lhs, rhs)
					vim.api.nvim_buf_set_keymap(0, "t", lhs, rhs, { noremap = true, silent = true })
				end
				
				-- Use TmuxNavigate commands in terminal mode
				tnoremap("<C-h>", "<C-\\><C-n><cmd>TmuxNavigateLeft<cr>")
				tnoremap("<C-j>", "<C-\\><C-n><cmd>TmuxNavigateDown<cr>")
				tnoremap("<C-k>", "<C-\\><C-n><cmd>TmuxNavigateUp<cr>")
				tnoremap("<C-l>", "<C-\\><C-n><cmd>TmuxNavigateRight<cr>")
				
				-- Close terminal with C-,
				tnoremap("<C-,>", "<C-\\><C-n><cmd>close<cr>")
			end,
		})
	end,
}
