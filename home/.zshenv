. "$HOME/.cargo/env"

# Let fzf keep ctrl+j / ctrl+k instead of herdr's vim-herdr-navigation stealing
# them for pane focus. Restores the tmux behaviour, where the is_vim regex in
# ~/.tmux.conf already listed fzf alongside vim/nvim. Read by navigate.sh, so it
# must be in herdr's server environment — `herdr server stop` to pick up changes.
export HERDR_NAV_PASSTHROUGH_RE='^fzf$'
