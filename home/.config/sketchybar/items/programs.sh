#!/usr/bin/env bash
# "Programs" — dock-style dropdown of running apps. All rows are built at
# click time by plugins/programs.sh; this only registers the anchor chip.

sketchybar --add item programs left \
  --set programs \
    icon=󰀻 \
    icon.color=$ACCENT \
    icon.padding_left=10 \
    icon.padding_right=10 \
    label.drawing=off \
    background.color=$ITEM_BG \
    background.drawing=on \
    "${POPUP_PROPS[@]}" \
    click_script="$PLUGIN_DIR/programs.sh toggle" \
    script="$PLUGIN_DIR/hover.sh chip $PLUGIN_DIR/programs.sh autohide" \
  --subscribe programs mouse.exited.global front_app_switched mouse.entered mouse.exited
