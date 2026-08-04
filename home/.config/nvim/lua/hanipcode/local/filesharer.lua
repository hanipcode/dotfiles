local M = {}

local Path = require("plenary.path")
local cc = require("codecompanion")
local fmt = string.format
local constants = require("codecompanion.config").config.constants

function M.share_dir(dir_path)
	local scandir = require("plenary.scandir")

	local files = scandir.scan_dir(dir_path, {
		hidden = true, -- include dotfiles
		depth = nil, -- nil = infinite
		add_dirs = false, -- exclude directories from result
	})

	for _, file in ipairs(files) do
		local relpath = Path:new(file):make_relative()
		M.share(file, relpath)
	end
end

function M.share(fullpath, relpath)
	local path = Path:new(fullpath)
	local ok, content = pcall(function()
		return path:read()
	end)

	if not ok then
		vim.notify("Failed to read file: " .. fullpath, vim.log.levels.ERROR)
		return
	end

	local ft = vim.filetype.match({ filename = fullpath })
	local description = fmt(
		[[%s %s:

```%s
%s
```]],
		"Here is the content of the file",
		"located at `" .. relpath .. "`",
		ft,
		content
	)

	local id = "<file>" .. relpath .. "</file>"
	local chat = cc.last_chat()
	if not chat then
		vim.notify("No active chat session", vim.log.levels.WARN)
		return
	end

	chat:add_message({
		role = constants.USER_ROLE,
		content = description,
	}, { reference = id, visible = false })

	chat.references:add({
		id = id,
		path = relpath,
		source = "codecompanion.strategies.chat.slash_commands.file",
	})

	vim.notify(relpath .. " added to chat")
end

return M
