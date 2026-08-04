return {
	"nvim-telescope/telescope.nvim",
	branch = "0.1.x",
	dependencies = {
		"nvim-lua/plenary.nvim",
		"nvim-tree/nvim-web-devicons",
		"folke/todo-comments.nvim",
		{
			"isak102/telescope-git-file-history.nvim",
			dependencies = {
				"nvim-lua/plenary.nvim",
				"tpope/vim-fugitive",
			},
		},
	},
	config = function()
		local telescope = require("telescope")
		local actions = require("telescope.actions")

		telescope.setup({
			defaults = {
				mappings = {
					i = {
						["<C-q>"] = actions.send_selected_to_qflist + actions.open_qflist,
					},
					n = {
						["<C-q>"] = actions.send_selected_to_qflist + actions.open_qflist,
						["q"] = function()
							local Path = require("plenary.path")
							local action_state = require("telescope.actions.state")
							local FileSharer = require("hanipcode.local.filesharer")

							local selection = action_state.get_selected_entry()[1]
							local cwd = vim.fn.getcwd()
							local fullpath = cwd .. "/" .. selection
							local relpath = Path:new(fullpath):make_relative()

							FileSharer.share(fullpath, relpath)
						end,
					},
				},
				path_display = { "smart" },
				layout_config = {
					vertical = { height = 0.8 },
					horizontal = { height = 0.8 },
				},
				show_filter_column = false,
			},
		})
		-- git file history
		require("telescope").load_extension("git_file_history")
		-- monorepo
		require("telescope").load_extension("monorepo")

		-- hanip
		-- require("telescope").load_extension("stack")

		local builtin = require("telescope.builtin")

		-- vim.keymap.set("n", "<leader>pf", builtin.find_files, {})
		vim.keymap.set("n", "<leader>pg", builtin.git_files, {})
		vim.keymap.set("n", "<leader>pws", function()
			local word = vim.fn.expand("<cword>")
			builtin.grep_string({ search = word })
		end)
		vim.keymap.set("n", "<leader>pWs", function()
			local word = vim.fn.expand("<cWORD>")
			builtin.grep_string({ search = word })
		end)
		local defaultText = ""
		vim.keymap.set("n", "<leader>ps", function()
			builtin.live_grep()
			-- vim.ui.input({
			-- 	prompt = ">Grep",
			-- 	default = defaultText,
			-- 	completion = nil,
			-- }, function(word)
			-- 	defaultText = word
			-- 	builtin.grep_string({ search = word })
			-- end)
		end, { silent = true, noremap = true })
		vim.keymap.set("n", "<leader>vh", builtin.help_tags, {})
		vim.keymap.set("n", "<leader>p!", "<cmd>TodoTelescope<cr>", { desc = "Find todos" })
		vim.keymap.set("n", "<leader>pv", "<cmd>Telescope neoclip<cr>", { desc = "Find clipboard" })
		vim.keymap.set("n", "<leader>po", builtin.oldfiles, { desc = "Find old files" })
		vim.keymap.set("n", "<leader>pl", function()
			vim.ui.input({
				prompt = "Shell: ",
				default = "",
				completion = "shellcmd",
			}, function(input)
				if input and input ~= "" then
					-- Use zsh interactive mode to load aliases
					require("snacks").terminal(
						{ "zsh", "-ic", input .. "; echo '\nPress any key to exit...'; read -k1 -s" },
						{
							win = {
								position = "float",
								border = "rounded",
								title = " " .. input .. " ",
								title_pos = "center",
								width = 0.8,
								height = 0.8,
								backdrop = 60,
							},
						}
					)
				end
			end)
		end, { desc = "Run shell command" })
		vim.keymap.set("n", "<leader>pd", function()
			local harpooned = require("hanipcode.local.harpooned")
			harpooned.harpoon_pickers()
		end)
		vim.keymap.set("n", "<leader>f", builtin.current_buffer_fuzzy_find, {})
	end,
}
