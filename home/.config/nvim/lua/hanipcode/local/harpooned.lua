local M = {}
local harpoon = require("harpoon")

--- Get the last N segments of a path, prefixed with `../`
--- @param fullpath string
--- @param count number? (default 3)
--- @return string
function M.short_path(fullpath, count)
	count = count or 3

	-- Split the path into components
	local parts = {}
	for part in string.gmatch(fullpath, "[^/]+") do
		table.insert(parts, part)
	end

	local len = #parts

	-- If path has 3 or fewer parts, return the original
	if len <= count then
		return fullpath
	end

	-- Otherwise, return the last `count` parts with a ../ prefix
	local slice = {}
	for i = len - count + 1, len do
		table.insert(slice, parts[i])
	end

	return "../" .. table.concat(slice, "/")
end

--- Explode a path into its short form, prefix, and truncation info
--- @param fullpath string
--- @param count number? (default 3)
--- @return table { short_path = string, pre = string|nil, is_truncated = boolean }
function M.path_exploder(fullpath, count)
	count = count or 3

	local parts = {}
	for part in string.gmatch(fullpath, "[^/]+") do
		table.insert(parts, part)
	end

	local len = #parts

	if len <= count then
		return {
			short_path = fullpath,
			pre = nil,
			is_truncated = false,
		}
	end

	local prefix = {}
	for i = 1, len - count do
		table.insert(prefix, parts[i])
	end

	local suffix = {}
	for i = len - count + 1, len do
		table.insert(suffix, parts[i])
	end

	return {
		short_path = "../" .. table.concat(suffix, "/"),
		pre = table.concat(prefix, "/"),
		is_truncated = true,
	}
end

-- Keep the old telescope function for backward compatibility
function M.harpoon_pickers()
	-- This function is now deprecated but kept for compatibility
	-- Use harpoon_pickers_fzf instead
	M.harpoon_pickers_fzf()
end

-- New fzf-lua based harpoon picker
function M.harpoon_pickers_fzf()
	local fzf = require("fzf-lua")
	local harpoon_list = harpoon:list()
	local file_paths = {}
	for _, item in ipairs(harpoon_list.items) do
		table.insert(file_paths, M.short_path(item.value) .. " " .. item.value)
	end

	fzf.fzf_exec(file_paths, {
		prompt = "Harpoon> ",
		actions = {
			["default"] = function(selected)
				if selected and selected[1] then
					-- Extract the full path from the selection
					local full_path = selected[1]:match("%s+(.+)$")
					if full_path then
						vim.cmd("edit " .. full_path)
					end
				end
			end,
		},
		previewer = "builtin",
		preview = {
			type = "cmd",
			fn = function(items)
				if items and items[1] then
					local full_path = items[1]:match("%s+(.+)$")
					if full_path then
						return { "bat", "--style=numbers", "--color=always", full_path }
					end
				end
				return { "echo", "No preview available" }
			end,
		},
	})
end

function M.share_harpoon_file()
	local Path = require("plenary.path")
	local fs = require("hanipcode.local.filesharer")
	local harpoon_list = harpoon:list()
	for _, item in ipairs(harpoon_list.items) do
		local relpath = Path:new(item.value):make_relative()
		fs.share(item.value, relpath)
	end
end

return M
