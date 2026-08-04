#!/usr/bin/env bash
# Catppuccin Macchiato palette — swap these to re-theme the whole bar.
# Kept in sync with ghostty, herdr, nvim, pi and opencode (all Macchiato).

# ~/.local/bin holds claude/codex — sketchybar's launchd env doesn't have it,
# so plugins shelling out to them need it added explicitly.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/sbin:/sbin:$PATH"

# Fonts (defined here so runtime plugins get them too, not just sketchybarrc)
export FONT="Maple Mono NF"
export APP_FONT="sketchybar-app-font:Regular:15.0"

# Workflow: the main terminal lives on this workspace; agent click-jump
# re-points its tmux client when the agent's session isn't visible anywhere
export MAIN_WS="S"
export TERMINAL_APP="Ghostty"

export BASE=0xff24273a
export MANTLE=0xff1e2030
export CRUST=0xff181926
export SURFACE0=0xff363a4f
export SURFACE1=0xff494d64
export OVERLAY=0xff6e738d
export TEXT=0xffcad3f5
export SUBTEXT=0xffa5adcb

export LAVENDER=0xffb7bdf8
export MAUVE=0xffc6a0f6
export BLUE=0xff8aadf4
export SAPPHIRE=0xff7dc4e4
export TEAL=0xff8bd5ca
export GREEN=0xffa6da95
export YELLOW=0xffeed49f
export PEACH=0xfff5a97f
export RED=0xffed8796

# Semi-transparent crust; the bar also gets background blur.
export BAR_COLOR=0xf2181926
export BAR_BORDER=0xff363a4f
export ITEM_BG=0xff363a4f
export ACCENT=$MAUVE
export HOVER=$SURFACE1 # hover highlight for chips and menu rows
