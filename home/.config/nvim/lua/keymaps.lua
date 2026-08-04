-- keymaps.lua: Neovim keymap configurations

-- Replace all occurrences in file
vim.keymap.set("n", "<leader>R", function()
	local old_str = vim.fn.input("Replace: ")
	if old_str == "" then
		return
	end
	local new_str = vim.fn.input("With: ")
	-- Execute the substitute command
	vim.cmd("%s/" .. vim.fn.escape(old_str, "/") .. "/" .. vim.fn.escape(new_str, "/") .. "/g")
end, { desc = "Replace all occurrences in file" })
