-- vim-tmux-navigator is kept as the TMUX FALLBACK only.
--
-- <C-h/j/k/l> are now owned by after/plugin/herdr-navigation.lua, which tries
-- herdr first and calls TmuxNavigate<Dir> when $TMUX is set (ssh, remote boxes).
-- This plugin's own mappings are disabled so there is a single source of truth;
-- it still lazy-loads on demand because the commands are declared below.
return {
	"christoomey/vim-tmux-navigator",
	init = function()
		vim.g.tmux_navigator_no_mappings = 1
	end,
	cmd = {
		"TmuxNavigateLeft",
		"TmuxNavigateDown",
		"TmuxNavigateUp",
		"TmuxNavigateRight",
		"TmuxNavigatePrevious",
		"TmuxNavigatorProcessList",
	},
	keys = {
		{ "<c-\\>", "<cmd><C-U>TmuxNavigatePrevious<cr>" },
	},
}
