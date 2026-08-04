#!/usr/bin/env bash

source "$CONFIG_DIR/colors.sh"

batt_info=$(pmset -g batt)
pct=$(grep -Eo '[0-9]+%' <<<"$batt_info" | head -1 | tr -d '%')
[ -z "$pct" ] && exit 0

if grep -q 'AC Power' <<<"$batt_info"; then
  icon="󰂄" color=$GREEN
elif [ "$pct" -ge 80 ]; then icon="󰁹" color=$GREEN
elif [ "$pct" -ge 60 ]; then icon="󰂀" color=$GREEN
elif [ "$pct" -ge 40 ]; then icon="󰁾" color=$YELLOW
elif [ "$pct" -ge 20 ]; then icon="󰁻" color=$PEACH
else                          icon="󰁺" color=$RED
fi

sketchybar --set "$NAME" icon="$icon" icon.color="$color" label="$pct%"
