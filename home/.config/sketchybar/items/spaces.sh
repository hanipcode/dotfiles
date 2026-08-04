#!/usr/bin/env bash
# AeroSpace workspaces, collapsed into a single "A" chip. The chip's label is
# the focused workspace; clicking it opens a switcher popup listing the
# occupied ones (plugins/aerospace_menu.sh) — same model as the Programs menu.

sketchybar --add event aerospace_workspace_change

sketchybar --add item aerospace left \
  --set aerospace \
    icon="A" \
    icon.color=$ACCENT \
    icon.padding_left=10 \
    label.font="$FONT:Bold:13.0" \
    label.padding_right=10 \
    background.color=$ITEM_BG \
    "${POPUP_PROPS[@]}" \
    click_script="$PLUGIN_DIR/aerospace_menu.sh toggle" \
    script="$PLUGIN_DIR/hover.sh chip $PLUGIN_DIR/aerospace.sh" \
  --subscribe aerospace \
    aerospace_workspace_change \
    front_app_switched \
    space_windows_change \
    system_woke \
    mouse.entered \
    mouse.exited \
    mouse.exited.global
