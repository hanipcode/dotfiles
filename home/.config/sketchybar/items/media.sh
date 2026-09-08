#!/usr/bin/env bash
# Unified music transport: previous, marquee title, play/pause, next.

sketchybar --add event music_change

sketchybar --add item media.prev left \
  --set media.prev \
    icon=󰒮 \
    icon.color=$SUBTEXT \
    label.drawing=off \
    icon.padding_left=8 \
    icon.padding_right=7 \
    click_script="$PLUGIN_DIR/media.sh previous" \
    script="$PLUGIN_DIR/hover.sh overlay" \
  --subscribe media.prev mouse.entered mouse.exited

sketchybar --add item media.title left \
  --set media.title \
    icon=󰎈 \
    icon.color=$RED \
    label="Nothing playing" \
    label.max_chars=26 \
    width=225 \
    update_freq=1 \
    script="$PLUGIN_DIR/hover.sh overlay $PLUGIN_DIR/media.sh update" \
    click_script="$PLUGIN_DIR/media.sh popup" \
  --subscribe media.title mouse.entered mouse.exited system_woke music_change

sketchybar --add item media.play left \
  --set media.play \
    icon=󰐊 \
    icon.color=$TEXT \
    label.drawing=off \
    icon.padding_left=8 \
    icon.padding_right=7 \
    click_script="$PLUGIN_DIR/media.sh playback" \
    script="$PLUGIN_DIR/hover.sh overlay" \
  --subscribe media.play mouse.entered mouse.exited

sketchybar --add item media.next left \
  --set media.next \
    icon=󰒭 \
    icon.color=$SUBTEXT \
    label.drawing=off \
    icon.padding_left=7 \
    icon.padding_right=8 \
    click_script="$PLUGIN_DIR/media.sh next" \
    script="$PLUGIN_DIR/hover.sh overlay" \
  --subscribe media.next mouse.entered mouse.exited

sketchybar --add bracket music_controls media.prev media.title media.play media.next \
  --set music_controls \
    background.color=$ITEM_BG \
    background.corner_radius=9 \
    background.height=26
