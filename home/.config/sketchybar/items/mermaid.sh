#!/usr/bin/env bash
# Icon-only launcher for the standalone Mermaid diagram viewer.

sketchybar --add item mermaid left \
  --set mermaid \
    icon=󰙅 \
    icon.color=$MAUVE \
    icon.padding_left=10 \
    icon.padding_right=10 \
    label.drawing=off \
    background.color=$ITEM_BG \
    background.drawing=on \
    click_script="$PLUGIN_DIR/mermaid.sh toggle" \
    script="$PLUGIN_DIR/hover.sh chip" \
  --subscribe mermaid mouse.entered mouse.exited
