-- Key mappings
local map = vim.api.nvim_set_keymap

-- Define getOpts function
local function getOpts()
	if vim.g.vscode then
		return {}
	else
		return { noremap = true, silent = true }
	end
end

-- Mappings using getOpts function
map("n", "<leader>we", "<cmd>only<CR>", getOpts())
map("n", "<leader>ww", "<cmd>close<CR>", getOpts())
map("n", "<C-d>", "<C-d>zz", getOpts())
map("n", "<C-u>", "<C-u>zz", getOpts())
map("n", "n", "nzzzv", getOpts())
map("n", "N", "Nzzzv", getOpts())
vim.keymap.set("n", "<leader>vv", function()
	vim.cmd("normal! v%V")
end, { noremap = true, silent = true })
map("n", "+", "<C-a>", getOpts())
map("n", "-", "<C-x>", getOpts())
map("n", "<leader>y", '"+y', getOpts())
map("v", "<leader>y", '"+y', getOpts())
map("n", "<leader>pp", '"+gP', getOpts())
map("v", "<leader>pp", '"+gP', getOpts())
-- Project switcher. In herdr this invokes the sessionizer plugin (workspace
-- picker first, Esc falls through to the project picker); under tmux it keeps
-- using tmux-sessionizer so remote/ssh sessions are unaffected.
vim.keymap.set("n", "<C-f>", function()
	if vim.env.HERDR_PANE_ID and vim.env.HERDR_PANE_ID ~= "" then
		local herdr = vim.env.HERDR_BIN_PATH
		if herdr == nil or herdr == "" then
			herdr = "herdr"
		end
		vim.fn.system({ herdr, "plugin", "action", "invoke", "sessionizer.open" })
	else
		vim.cmd("silent !tmux neww tmux-sessionizer")
	end
end, { noremap = true, silent = true, desc = "Open project (sessionizer)" })
vim.keymap.set("v", "J", ":m '>+1<CR>gv=gv")
vim.keymap.set("v", "K", ":m '<-2<CR>gv=gv")
vim.keymap.set("n", "<C-m>", "<cmd>cnext<CR>zz")
vim.keymap.set("n", "<C-p>", "<cmd>cprev<CR>zz")

vim.keymap.set("n", "<leader>sa", [[:%s/\<<C-r><C-w>\>/<C-r><C-w>/gI<Left><Left><Left>]])
vim.keymap.set("n", "<leader>sr", [[:%s/\<<C-r><C-w>\>//gI<Left><Left><Left>]])
vim.keymap.set("v", "<leader>sa", [["zy:%s/<C-r><C-r>z/<C-r><C-r>z/gI<Left><Left><Left>]])
vim.keymap.set("v", "<leader>sr", [["zy:%s/<C-r><C-r>z//gI<Left><Left><Left>]])

-- Helper function to get file path (relative to git root if in git project, otherwise relative to cwd)
local function get_relative_path()
	local git_root = vim.fn.systemlist("git rev-parse --show-toplevel 2>/dev/null")[1]
	if git_root and git_root ~= "" then
		local file_path = vim.fn.expand("%:p")
		-- Remove git root prefix from absolute path
		if file_path:sub(1, #git_root) == git_root then
			return file_path:sub(#git_root + 2) -- +2 to skip the trailing /
		end
		return file_path
	else
		-- Not in git project, return path relative to cwd
		return vim.fn.fnamemodify(vim.fn.expand("%"), ":.")
	end
end

-- Copy all file content to clipboard
vim.keymap.set("n", "<leader>cc", "<cmd>%y+<CR>", { desc = "Copy entire file to clipboard" })

-- Copy current file path to clipboard (relative to git root if in git project)
vim.keymap.set("n", "<leader>cp", function()
	vim.fn.setreg("+", "@" .. get_relative_path())
end, { desc = "Copy file path to clipboard" })

-- Copy file path with line number to clipboard (normal mode) or path with line range (visual mode)
vim.keymap.set("n", "<leader>cl", function()
	local path_with_line = "@" .. get_relative_path() .. ":L" .. vim.fn.line(".")
	vim.fn.setreg("+", path_with_line)
end, { desc = "Copy file path with line number to clipboard" })
vim.keymap.set("v", "<leader>cl", function()
	local start_line = vim.fn.line("v")
	local end_line = vim.fn.line(".")
	if start_line > end_line then
		start_line, end_line = end_line, start_line
	end
	local path_with_lines = "@" .. get_relative_path() .. ":L" .. start_line .. "-L" .. end_line
	vim.fn.setreg("+", path_with_lines)
	-- Exit visual mode without shifting
	vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<Esc>", true, false, true), "n", false)
end, { desc = "Copy file path with line range to clipboard" })

-- Pick an AI agent and open its TUI in a new pane on the left of the current one
vim.keymap.set("n", "<leader>aa", function()
	vim.ui.select({ "pi", "opencode", "claude", "codex" }, { prompt = "Open agent" }, function(agent)
		if not agent then
			return
		end
		if vim.env.HERDR_PANE_ID and vim.env.HERDR_PANE_ID ~= "" then
			local herdr = vim.env.HERDR_BIN_PATH
			if herdr == nil or herdr == "" then
				herdr = "herdr"
			end
			-- herdr's SplitDirection is right|down only, so: split right, run the
			-- agent in the new pane, then swap so it ends up on the LEFT — the
			-- layout `tmux split-window -hb` used to give. --no-focus keeps the
			-- cursor in nvim throughout.
			vim.fn.system({
				herdr, "pane", "split",
				"--pane", vim.env.HERDR_PANE_ID,
				"--direction", "right",
				"--ratio", "0.4",
				"--cwd", vim.fn.getcwd(),
				"--no-focus",
			})
			local out = vim.fn.system({ herdr, "pane", "neighbor", "--direction", "right", "--pane", vim.env.HERDR_PANE_ID })
			-- Note: neighbor_pane_id, NOT pane_id — the latter is this pane.
			local target = out:match('"neighbor_pane_id"%s*:%s*"([^"]+)"')
			if target then
				vim.fn.system({ herdr, "pane", "run", target, agent })
				vim.fn.system({ herdr, "pane", "swap", "--direction", "right", "--pane", vim.env.HERDR_PANE_ID })
			end
		elseif vim.env.TMUX then
			-- -h: horizontal split, -b: place new pane before (left of) current
			vim.fn.system({ "tmux", "split-window", "-hb", "-c", vim.fn.getcwd(), agent })
		else
			-- fallback outside any multiplexer: nvim terminal split on the left
			vim.cmd("leftabove vsplit")
			vim.cmd("terminal " .. agent)
			vim.cmd("startinsert")
		end
	end)
end, { desc = "Open AI agent in left pane" })
