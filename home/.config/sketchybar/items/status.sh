#!/usr/bin/env bash
# Right-side status widgets, grouped under one bracket background.
# Added right-to-left: battery sits closest to the clock.
# Items route their scripts through hover.sh for a hover highlight; the real
# plugin is passed along and receives every non-mouse event untouched.
# Popup/menu styling comes from design.sh (POPUP_PROPS, MENU_* tokens).

# Centered under the item's icon, like native menu extras
RIGHT_POPUP=("${POPUP_PROPS[@]}" popup.align=center)

sketchybar --add item battery right \
  --set battery \
    icon.color=$GREEN \
    update_freq=60 \
    script="$PLUGIN_DIR/hover.sh overlay $PLUGIN_DIR/battery.sh" \
  --subscribe battery power_source_change system_woke mouse.entered mouse.exited

# Click → macOS-style popup: power toggle, known networks, scan, settings
sketchybar --add item wifi right \
  --set wifi \
    icon.color=$SAPPHIRE \
    update_freq=30 \
    "${RIGHT_POPUP[@]}" \
    script="$PLUGIN_DIR/hover.sh overlay $PLUGIN_DIR/wifi.sh" \
    click_script="$PLUGIN_DIR/wifi_menu.sh toggle" \
  --subscribe wifi wifi_change system_woke mouse.entered mouse.exited mouse.exited.global

# Click → horizontal popup: mute button (leftmost) + volume slider.
# Symmetric popup padding: 12px from either edge to the first/last control.
sketchybar --add item volume right \
  --set volume \
    icon.color=$PEACH \
    "${RIGHT_POPUP[@]}" \
    popup.horizontal=on \
    script="$PLUGIN_DIR/hover.sh overlay $PLUGIN_DIR/volume.sh" \
    click_script="$PLUGIN_DIR/volume_control.sh toggle" \
  --subscribe volume volume_change mouse.entered mouse.exited mouse.exited.global

sketchybar --add item volume.mute popup.volume \
  --set volume.mute \
    "${MENU_ROW[@]}" \
    icon=󰝟 \
    icon.color=$PEACH \
    icon.padding_left=6 \
    label.drawing=off \
    label.padding_right=0 \
    padding_right=0 \
  --set volume.mute click_script="$PLUGIN_DIR/volume_control.sh mute" \
  --subscribe volume.mute mouse.entered mouse.exited

sketchybar --add slider volume.slider popup.volume 140 \
  --set volume.slider \
    slider.percentage=50 \
    slider.highlight_color=$PEACH \
    slider.background.color=$SURFACE1 \
    slider.background.height=6 \
    slider.background.corner_radius=3 \
    slider.knob=● \
    slider.knob.color=$TEXT \
    padding_left=4 \
    padding_right=12 \
    script="$PLUGIN_DIR/volume_control.sh slide" \
  --subscribe volume.slider mouse.clicked

sketchybar --add item cpu right \
  --set cpu \
    icon=󰍛 \
    icon.color=$RED \
    update_freq=5 \
    script="$PLUGIN_DIR/hover.sh overlay $PLUGIN_DIR/cpu.sh" \
  --subscribe cpu mouse.entered mouse.exited

# Claude / Codex usage gauge; click → popup with per-provider limit gauges
sketchybar --add item ai right \
  --set ai \
    icon=󰓅 \
    icon.color=$TEAL \
    label.drawing=off \
    update_freq=300 \
    "${RIGHT_POPUP[@]}" \
    script="$PLUGIN_DIR/hover.sh overlay $PLUGIN_DIR/ai_usage.sh update" \
    click_script="$PLUGIN_DIR/ai_usage.sh toggle" \
  --subscribe ai system_woke mouse.entered mouse.exited mouse.exited.global

sketchybar --add bracket status ai cpu volume wifi battery \
  --set status \
    background.color=$ITEM_BG \
    background.corner_radius=9 \
    background.height=26
