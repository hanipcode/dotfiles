#!/usr/bin/env bash
# Keeps the bar chip, the popup slider, and the mute button in sync.
# Runs on volume_change, on demand from volume_control.sh, and closes the
# popup when the mouse leaves it (mouse.exited.global via hover.sh dispatch).

BASE_DIR=$(cd "$(dirname "$0")/.." && pwd)
source "$BASE_DIR/design.sh"

NAME="${NAME:-volume}"

if [ "${SENDER:-}" = "mouse.exited.global" ]; then
  sketchybar --set "$NAME" popup.drawing=off
  exit 0
fi

read -r vol muted < <(osascript -e \
  'tell (get volume settings) to return (output volume as text) & " " & (output muted as text)')
# $INFO is only the volume for volume_change; click events put JSON in it
[[ "${INFO:-}" =~ ^[0-9]+$ ]] && [ "${SENDER:-}" = "volume_change" ] && vol="$INFO"

if [ "$muted" = "true" ] || [ "$vol" -eq 0 ]; then icon="󰝟"
elif [ "$vol" -lt 33 ]; then icon="󰕿"
elif [ "$vol" -lt 66 ]; then icon="󰖀"
else icon="󰕾"
fi

if [ "$muted" = "true" ]; then
  mute_icon="󰝟" mute_color=$RED label="muted"
else
  mute_icon="󰕾" mute_color=$PEACH label="$vol%"
fi

sketchybar --set "$NAME" icon="$icon" label="$label" \
  --set volume.slider slider.percentage="$vol" \
  --set volume.mute icon="$mute_icon" icon.color="$mute_color"
