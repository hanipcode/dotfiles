#!/usr/bin/env bash
# Workspace switcher popup behind the collapsed "A" chip.
#   toggle   — (re)build the workspace list and toggle the dropdown
#   go <ws>  — switch to workspace <ws> and close
#
# One row per occupied workspace (plus the focused one even when empty):
# icon = workspace id, label = the apps living there. The focused row is
# accent-filled and inert — you're already there. Rows are rebuilt on every
# open, so the list never goes stale.

BASE_DIR=$(cd "$(dirname "$0")/.." && pwd)
source "$BASE_DIR/design.sh"

PLUGIN="$BASE_DIR/plugins/aerospace_menu.sh"

MAX_LABEL=42 # apps list is truncated past this many chars

apps_in() { # $1 = workspace → "Google Chrome, Slack" (deduped, in order)
  aerospace list-windows --workspace "$1" --format '%{app-name}' 2>/dev/null |
    awk 'NF && !seen[$0]++' | paste -sd', ' -
}

case "$1" in
  toggle)
    if [ "$(sketchybar --query aerospace 2>/dev/null | jq -r '.popup.drawing')" = "on" ]; then
      sketchybar --set aerospace popup.drawing=off
      exit 0
    fi
    sketchybar --remove '/aerospace\.ws\..*/' 2>/dev/null

    focused=$(aerospace list-workspaces --focused 2>/dev/null)
    list=$(aerospace list-workspaces --monitor all --empty no 2>/dev/null)
    # An empty focused workspace still belongs in the list
    grep -qx "$focused" <<<"$list" ||
      list=$(printf '%s\n%s\n' "$focused" "$list" | awk 'NF' | sort -f)

    # Collect first so every row can share one width
    rows=""
    maxlen=0
    while IFS= read -r ws; do
      [ -z "$ws" ] && continue
      apps=$(apps_in "$ws")
      [ -z "$apps" ] && apps="—"
      [ "${#apps}" -gt "$MAX_LABEL" ] && apps="${apps:0:$MAX_LABEL}…"
      rows+="$ws|$apps"$'\n'
      [ "${#apps}" -gt "$maxlen" ] && maxlen=${#apps}
    done <<<"$list"
    W=$(menu_width "$maxlen")

    args=()
    while IFS='|' read -r ws apps; do
      [ -z "$ws" ] && continue
      item="aerospace.ws.$ws"
      args+=(--add item "$item" popup.aerospace
        --set "$item"
        "${MENU_ROW[@]}" width="$W"
        icon="$ws"
        icon.width=28
        icon.align=left
        label="$apps"
        click_script="$PLUGIN go $ws")
      if [ "$ws" = "$focused" ]; then
        # script="" opts the row out of hover.sh — the accent fill must stay
        args+=(--set "$item"
          background.drawing=on
          background.color="$ACCENT"
          icon.color="$CRUST"
          label.color="$CRUST"
          script="")
      else
        args+=(--set "$item"
          icon.color="$ACCENT"
          label.color="$SUBTEXT"
          --subscribe "$item" mouse.entered mouse.exited)
      fi
    done <<<"$rows"

    sketchybar "${args[@]}" --set aerospace popup.drawing=on
    ;;

  go)
    sketchybar --set aerospace popup.drawing=off
    aerospace workspace "$2" 2>/dev/null
    ;;
esac
exit 0
