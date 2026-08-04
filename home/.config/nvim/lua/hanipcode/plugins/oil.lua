return {
	"stevearc/oil.nvim",
	config = function()
		local oil = require("oil")
		oil.setup({
			default_file_explorer = true,
			float = {
				-- fullscreen: no gap around the floating window
				padding = 0,
				border = "none",
			},
			keymaps = {
				["q"] = {
					desc = "share file with code companion",
					callback = function()
						local oil = require("oil")
						local Path = require("plenary.path")
						local FileSharer = require("hanipcode.local.filesharer")

						local cur_dir = oil.get_current_dir()
						local entry = oil.get_cursor_entry()
						if entry == nil then
							vim.notify("Entry not found", vim.log.levels.ERROR)
							return
						end
						local fullpath = cur_dir .. entry.name
						if entry.type == "directory" then
							FileSharer.share_dir(fullpath)
							return
						end

						local relpath = Path:new(fullpath):make_relative()

						FileSharer.share(fullpath, relpath)
					end,
				},
			},
		})
		vim.keymap.set("n", "<leader>o", "", {
			noremap = true,
			silent = true,
			callback = function()
				oil.toggle_float()
			end,
		})
		local defaultDir = ""
		vim.keymap.set("n", "<leader>i", "", {
			noremap = true,
			silent = true,
			callback = function()
				vim.ui.input({
					prompt = ">Directories",
					default = defaultDir,
					completion = "dir",
				}, function(word)
					defaultDir = word
					oil.toggle_float(word)
				end)
			end,
		})
	end,
	-- Optional dependencies
	dependencies = { "nvim-tree/nvim-web-devicons", "nvim-lua/plenary.nvim" }, -- use if prefer nvim-web-devicons
}
