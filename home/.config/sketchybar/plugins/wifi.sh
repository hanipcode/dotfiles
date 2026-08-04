#!/usr/bin/env bash
# Bar chip state (icon + SSID label); also closes the popup menu when the
# mouse leaves it (mouse.exited.global arrives via hover.sh dispatch).

BASE_DIR=$(cd "$(dirname "$0")/.." && pwd)
source "$BASE_DIR/colors.sh"

NAME="${NAME:-wifi}"

if [ "${SENDER:-}" = "mouse.exited.global" ]; then
  sketchybar --set "$NAME" popup.drawing=off
  exit 0
fi

iface=$(route -n get default 2>/dev/null | awk '/interface:/ { print $2 }')
wifi_if=$(networksetup -listallhardwareports 2>/dev/null | awk '/Wi-Fi/ { getline; print $2 }')

if [ -z "$iface" ]; then
  sketchybar --set "$NAME" icon="󰤭" icon.color="$RED" label.drawing=off
  exit 0
fi

if [ "$iface" = "$wifi_if" ]; then
  ssid=$(ipconfig getsummary "$iface" 2>/dev/null | awk -F ' SSID : ' '/ SSID :/ { print $2 }')
  # macOS redacts the SSID without location permission — icon-only in that case
  if [ -n "$ssid" ] && [[ "$ssid" != *redacted* ]]; then
    sketchybar --set "$NAME" icon="󰤨" icon.color="$SAPPHIRE" label="$ssid" label.drawing=on
  else
    sketchybar --set "$NAME" icon="󰤨" icon.color="$SAPPHIRE" label.drawing=off
  fi
else
  sketchybar --set "$NAME" icon="󰈀" icon.color="$SAPPHIRE" label.drawing=off
fi
