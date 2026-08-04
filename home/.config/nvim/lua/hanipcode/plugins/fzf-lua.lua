return {
	"ibhagwan/fzf-lua",
	dependencies = {
		"nvim-tree/nvim-web-devicons",
		"folke/todo-comments.nvim",
	},
	config = function()
		local fzf = require("fzf-lua")
		local actions = require("fzf-lua.actions")

		local ignore_markdown = true

		local function get_rg_opts()
			local base_opts = "--column --line-number --no-heading --color=always --smart-case --max-columns=4096"
			if ignore_markdown then
				return base_opts .. " --glob '!*.md' -e"
			else
				return base_opts .. " -e"
			end
		end

		local function get_fd_cmd()
			local base_cmd = "fd --type f --hidden --follow --exclude .git"
			if ignore_markdown then
				return base_cmd .. " --exclude '*.md'"
			else
				return base_cmd
			end
		end

		fzf.setup({
			winopts = {
				height = 0.8,
				width = 0.8,
				preview = {
					default = "builtin",
					layout = "flex",
					flip_columns = 120,
				},
			},
			keymap = {
				builtin = {
					["<C-q>"] = "select-all+accept",
				},
				fzf = {
					["ctrl-q"] = "select-all+accept",
				},
			},
			actions = {
				files = {
					["default"] = actions.file_edit,
					["ctrl-q"] = function(selected)
						-- Send to quickfix list
						vim.fn.setqflist({}, " ", {
							title = "FZF-Lua",
							items = vim.tbl_map(function(file)
								return { filename = file, lnum = 1, col = 1 }
							end, selected),
						})
						vim.cmd("copen")
					end,
				},
			},
			files = {
				prompt = "Files> ",
				cmd = get_fd_cmd(),
			},
			grep = {
				prompt = "Grep> ",
				rg_opts = get_rg_opts(),
			},
		})

		-- Keymaps matching telescope
		vim.keymap.set("n", "<leader>pf", fzf.files, { desc = "Find files" })
		vim.keymap.set("n", "<leader>pg", function()
			local git_root = vim.fn.systemlist("git rev-parse --show-toplevel")[1]
			if vim.v.shell_error == 0 then
				fzf.files({ cwd = git_root })
			else
				vim.notify("Not in a git repository", vim.log.levels.WARN)
			end
		end, { desc = "Find files in git root" })
		-- vim.keymap.set("n", "<leader>pg", fzf.git_files, { desc = "Find git files" })
		-- vim.keymap.set("n", "<leader>pws", function()
		-- 	local word = vim.fn.expand("<cword>")
		-- 	fzf.grep({ search = word })
		-- end, { desc = "Grep word under cursor" })
		-- vim.keymap.set("n", "<leader>pWs", function()
		-- 	local word = vim.fn.expand("<cWORD>")
		-- 	fzf.grep({ search = word })
		-- end, { desc = "Grep WORD under cursor" })
		--
		-- vim.keymap.set("n", "<leader>ps", fzf.grep_visual)
		-- -- local defaultText = ""
		-- -- vim.keymap.set("n", "<leader>ps", function()
		-- -- 	vim.ui.input({
		-- -- 		prompt = ">Grep",
		-- -- 		default = defaultText,
		-- -- 		completion = nil,
		-- -- 	}, function(word)
		-- -- 		if word then
		-- -- 			defaultText = word
		-- -- 			fzf.grep({ search = word })
		-- -- 		end
		-- -- 	end)
		-- -- end, { silent = true, noremap = true, desc = "Grep with input" })
		--
		-- vim.keymap.set("n", "<leader>vh", fzf.help_tags, { desc = "Help tags" })
		--
		-- -- Todo-comments integration with fzf-lua
		-- vim.keymap.set("n", "<leader>p!", function()
		-- 	fzf.grep({
		-- 		search = "TODO|FIXME|HACK|WARN|PERF|NOTE|TEST",
		-- 		rg_opts = "--column --line-number --no-heading --color=always --smart-case --max-columns=4096",
		-- 	})
		-- end, { desc = "Find todos" })
		--
		-- -- Neoclip will need separate handling or you can use fzf-lua's registers
		-- vim.keymap.set("n", "<leader>pv", fzf.registers, { desc = "Find registers" })
		--
		-- vim.keymap.set("n", "<leader>po", fzf.buffers, { desc = "Find buffers" })
		--
		-- -- Harpoon integration with fzf-lua
		-- vim.keymap.set("n", "<leader>ph", function()
		-- 	local harpooned = require("hanipcode.local.harpooned")
		-- 	harpooned.harpoon_pickers_fzf()
		-- end, { desc = "Harpoon picker" })
		--
		-- vim.keymap.set("n", "<leader>f", fzf.blines, { desc = "Current buffer fuzzy find" })
		--
		-- -- Toggle markdown filtering command
		-- vim.api.nvim_create_user_command("FzfToggleMarkdown", function()
		-- 	ignore_markdown = not ignore_markdown
		-- 	fzf.setup({
		-- 		files = {
		-- 			cmd = get_fd_cmd(),
		-- 		},
		-- 		grep = {
		-- 			rg_opts = get_rg_opts(),
		-- 		},
		-- 	})
		-- 	local status = ignore_markdown and "ignoring" or "including"
		-- 	print("FZF now " .. status .. " markdown files")
		-- end, { desc = "Toggle markdown file filtering in FZF" })
	end,
}
