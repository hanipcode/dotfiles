if [[ -n "$HEHERDR_USER_ZDOTDIR" ]]; then
  ZDOTDIR="$HEHERDR_USER_ZDOTDIR"
  [[ -r "$ZDOTDIR/.zshrc" ]] && source "$ZDOTDIR/.zshrc"
fi
unset HEHERDR_USER_ZDOTDIR

# Popup terminals receive Ctrl+Q directly, so disable terminal flow control and
# turn it into a close action in every interactive ZLE keymap.
stty -ixon
_heherdr_close_popup() {
  exit
}
zle -N _heherdr_close_popup
bindkey -M emacs '^Q' _heherdr_close_popup
bindkey -M viins '^Q' _heherdr_close_popup
bindkey -M vicmd '^Q' _heherdr_close_popup
