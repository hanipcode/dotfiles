#!/usr/bin/env bash

sketchybar --add item clock right \
  --set clock \
    icon=󰥔 \
    icon.color=$MAUVE \
    icon.padding_left=10 \
    label.font="$FONT:Bold:13.0" \
    label.padding_right=10 \
    background.color=$ITEM_BG \
    update_freq=10 \
    script="$PLUGIN_DIR/hover.sh chip $PLUGIN_DIR/clock.sh" \
  --subscribe clock mouse.entered mouse.exited
