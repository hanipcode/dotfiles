#!/usr/bin/env bash
# Generic hover highlight + dispatcher, so items keep their real plugin.
#   script="$PLUGIN_DIR/hover.sh <mode> [real_plugin args...]"
# Modes:
#   chip    — item with a persistent ITEM_BG background: tint on enter
#   overlay — transparent item (bracket members, popup rows): draw bg on enter
# mouse.entered / mouse.exited are consumed here; every other event is
# forwarded to the real plugin (sketchybar env vars carry through exec).

BASE_DIR=$(cd "$(dirname "$0")/.." && pwd)
source "$BASE_DIR/colors.sh"

mode="$1"
shift

case "${SENDER:-}" in
  mouse.entered)
    case "$mode" in
      overlay)
        sketchybar --set "$NAME" background.color="$HOVER" background.drawing=on
        ;;
      *)
        sketchybar --animate tanh 8 --set "$NAME" background.color="$HOVER"
        ;;
    esac
    ;;
  mouse.exited)
    case "$mode" in
      overlay) sketchybar --set "$NAME" background.drawing=off ;;
      *) sketchybar --animate tanh 8 --set "$NAME" background.color="$ITEM_BG" ;;
    esac
    ;;
  *)
    [ $# -gt 0 ] && exec "$@"
    ;;
esac
exit 0
