vim.keymap.set("n", "<leader>i", function()
	local adapter = require("hanipcode.local.adapter")
	local codecompanion = require("codecompanion")
	local chat = codecompanion:last_chat()
	if not chat then
		vim.notify("Chat not exist")
	end
	adapter.slash_paste_image(chat)
end)
