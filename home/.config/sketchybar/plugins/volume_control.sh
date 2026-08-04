#!/usr/bin/env bash
# Volume popup controls. Dispatcher: volume_control.sh <action>
#   toggle — open/close the slider popup (bar chip click)
#   slide  — slider clicked: set output volume to $PERCENTAGE (0 also mutes)
#   mute   — mute button (leftmost in the popup): toggle output mute

BASE_DIR=$(cd "$(dirname "$0")/.." && pwd)
source "$BASE_DIR/colors.sh"

refresh() { NAME=volume SENDER=forced "$BASE_DIR/plugins/volume.sh"; }

case "$1" in
  toggle)
    if [ "$(sketchybar --query volume 2>/dev/null | jq -r '.popup.drawing')" = "on" ]; then
      sketchybar --set volume popup.drawing=off
    else
      refresh
      sketchybar --set volume popup.drawing=on
    fi
    ;;

  slide)
    pct="${PERCENTAGE:-0}"
    if [ "$pct" -eq 0 ]; then
      # Dragged/clicked to the far left → treat as mute
      osascript -e 'set volume output volume 0' -e 'set volume output muted true'
    else
      osascript -e "set volume output volume $pct" -e 'set volume output muted false'
    fi
    refresh
    ;;

  mute)
    osascript -e 'set volume output muted (not (output muted of (get volume settings)))'
    refresh
    ;;
esac
exit 0
