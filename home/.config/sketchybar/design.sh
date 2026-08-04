#!/usr/bin/env bash
# Design language — one source of truth for the bar's visual system.
# Source this (it pulls colors.sh in itself) wherever items, popups, or
# menu rows are built. Spacing scale: 4 / 8 / 12 / 16 — stick to these steps.
#
# Vertical popup menus are built from three row kinds:
#   MENU_ROW    — interactive row (hover pill; also --subscribe the row to
#                 mouse.entered mouse.exited)
#   MENU_HEADER — dim section title, aligned with row icons
#   MENU_INFO   — passive text row (gauges, footnotes)
#   MENU_SEP    — separator line
#   MENU_GAP    — small vertical breathing room between sections
# Every row in one menu must share a fixed width from `menu_width <chars>`
# (longest label in the menu) so hover pills span the menu uniformly
# instead of hugging their content.

DESIGN_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$DESIGN_DIR/colors.sh"

# Byte-counting locales make ${#label} overshoot on glyphs; count characters.
export LC_ALL=en_US.UTF-8

HOVER_SH="$DESIGN_DIR/plugins/hover.sh"

# ---- popup container -----------------------------------------------------------
POPUP_PROPS=(
  popup.background.color=$MANTLE
  popup.background.corner_radius=10
  popup.background.border_width=2
  popup.background.border_color=$SURFACE1
)

# ---- menu rows -------------------------------------------------------------------
MENU_ROW=(
  background.corner_radius=7
  background.height=26
  padding_left=6
  padding_right=6
  icon.padding_left=12
  icon.padding_right=8
  label.padding_right=16
  script="$HOVER_SH overlay"
)

MENU_HEADER=(
  icon.drawing=off
  padding_left=6
  padding_right=6
  label.padding_left=12
  label.padding_right=16
  label.font="$FONT:Bold:11.0"
  label.color=$SUBTEXT
)

MENU_INFO=(
  icon.drawing=off
  padding_left=6
  padding_right=6
  label.padding_left=12
  label.padding_right=16
)

MENU_SEP=(
  icon.drawing=off
  padding_left=6
  padding_right=6
  label.padding_left=12
  label.color=$SURFACE1
)

# Row width for a menu whose longest label is $1 characters.
# Maple Mono NF advances 0.600em = 7.8px/char at 13px (FiraCode was 0.6154em =
# 8.0px). The 8 is kept deliberately: over-estimating widens a menu harmlessly,
# under-estimating truncates labels. 64 covers the icon cell + paddings.
menu_width() { echo $(($1 * 8 + 64)); }

# Separator line spanning a menu whose longest label is $1 characters
# (pair with MENU_SEP: label="$(menu_sep <chars>)").
menu_sep() { printf '─%.0s' $(seq 1 $(($1 + 3))); }
