#!/usr/bin/env bash
# Keeps the collapsed "A" chip in sync: label = focused workspace, dimmed
# when that workspace is empty. Also tears the switcher popup down when the
# pointer leaves it or the front app changes (a row click does both).

BASE_DIR=$(cd "$(dirname "$0")/.." && pwd)
source "$BASE_DIR/design.sh"

NAME="${NAME:-aerospace}"

case "${SENDER:-}" in
  mouse.exited.global | front_app_switched)
    sketchybar --set "$NAME" popup.drawing=off
    ;;
esac

focused="${FOCUSED_WORKSPACE:-$(aerospace list-workspaces --focused 2>/dev/null)}"
[ -z "$focused" ] && exit 0

if aerospace list-windows --workspace "$focused" 2>/dev/null | grep -q .; then
  color=$TEXT
else
  color=$OVERLAY
fi

sketchybar --set "$NAME" label="$focused" label.color="$color"
