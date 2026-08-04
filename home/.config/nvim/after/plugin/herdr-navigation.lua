-- Seamless <C-h/j/k/l> across Neovim splits and herdr panes.
--
-- Replaces vim-tmux-navigator's mappings (that plugin stays installed and is
-- still used as the fallback when $TMUX is set, e.g. over ssh).
--
-- Chain per keypress:
--   1. wincmd h/j/k/l          -> move within Neovim
--   2. still in the same window (we're at a split edge):
--        in herdr ($HERDR_PANE_ID) -> herdr pane focus --direction
--        in tmux  ($TMUX)          -> TmuxNavigate<Dir>
--        neither                   -> nothing, wincmd already no-oped
--
-- Lives in after/plugin so it loads last and wins over any other <C-h/j/k/l>
-- mapping. herdr side: [[keys.command]] vim-herdr-navigation.* in
-- ~/.config/herdr/config.toml.

local tmux_dir = { left = "Left", down = "Down", up = "Up", right = "Right" }

local function navigate(wincmd, direction)
	local previous = vim.api.nvim_get_current_win()
	vim.cmd("wincmd " .. wincmd)
	if vim.api.nvim_get_current_win() ~= previous then
		return
	end

	if vim.env.HERDR_PANE_ID and vim.env.HERDR_PANE_ID ~= "" then
		-- Target this pane explicitly: --current resolves to the server's globally
		-- focused pane, which is not guaranteed to be the one nvim runs in.
		local herdr = vim.env.HERDR_BIN_PATH
		if herdr == nil or herdr == "" then
			herdr = "herdr"
		end
		vim.fn.system({ herdr, "pane", "focus", "--direction", direction, "--pane", vim.env.HERDR_PANE_ID })
	elseif vim.env.TMUX and vim.env.TMUX ~= "" then
		pcall(vim.cmd, "TmuxNavigate" .. tmux_dir[direction])
	end
end

local function map(lhs, wincmd, direction)
	vim.keymap.set("n", lhs, function()
		navigate(wincmd, direction)
	end, { silent = true, noremap = true, desc = "Navigate " .. direction .. " (vim/herdr/tmux)" })
end

map("<C-h>", "h", "left")
map("<C-j>", "j", "down")
map("<C-k>", "k", "up")
map("<C-l>", "l", "right")
