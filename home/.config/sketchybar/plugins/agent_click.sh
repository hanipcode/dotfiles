#!/usr/bin/env bash
# Click on an agent chip / notification: bring that agent's terminal into
# view, and acknowledge a finished run so the chip dims.
#
# Preference ladder:
#   1. A window (any workspace) already showing the agent's tmux session
#      (matched by title, tmux set-titles is on) → focus it.
#   2. Otherwise re-point the MAIN terminal — the $TERMINAL_APP window on
#      workspace $MAIN_WS — to the agent's session and focus it.
#   3. Otherwise any $TERMINAL_APP window anywhere.
#   4. Last resort: just switch to the workspace recorded for the agent.

BASE_DIR=$(cd "$(dirname "$0")/.." && pwd)
source "$BASE_DIR/colors.sh" # PATH, MAIN_WS, TERMINAL_APP

STATE_DIR="$HOME/.cache/agent-status"
f="$STATE_DIR/$1.json"
[ -f "$f" ] || exit 0

# An open popup captures the bar's clicks until it closes, so popups are
# exclusive: close every agent popup before doing anything else.
popup_args=()
while IFS= read -r it; do
  [ "$it" = "agent.$1" ] && continue
  popup_args+=(--set "$it" popup.drawing=off)
done < <(sketchybar --query bar 2>/dev/null | jq -r '.items[]?' | grep '^agent\.' | grep -v '\.menu\.')

# Right-click → context menu popup; left/notification click falls through to jump
if [ "${BUTTON:-}" = "right" ]; then
  sketchybar "${popup_args[@]}" --set "agent.$1" popup.drawing=toggle 2>/dev/null
  exit 0
fi
sketchybar "${popup_args[@]}" --set "agent.$1" popup.drawing=off 2>/dev/null

read -r status ws tmx twin pane < <(jq -r '[.status, .ws, .tmux, .win // "", .pane // ""] | map(if . == "" then "-" else . end) | join(" ")' "$f")

focus_window_titled() {
  local win
  win=$(aerospace list-windows --all --format '%{window-id}|%{window-title}' 2>/dev/null |
    awk -F'|' -v t="$1" '$2 == t { print $1; exit }')
  [ -n "$win" ] && aerospace focus --window-id "$win" 2>/dev/null
}

# Switch the tmux client shown in window $1 (currently titled $2) to session
# $3, then focus that window.
repoint_window() {
  local client
  client=$(tmux list-clients -F '#{client_name} #{client_session}' 2>/dev/null |
    awk -v s="$2" '$2 == s { print $1; exit }')
  [ -n "$client" ] || return 1
  tmux switch-client -c "$client" -t "$3" 2>/dev/null || return 1
  aerospace focus --window-id "$1" 2>/dev/null
}

# First terminal window on workspace $1 as "id|title" ("--workspace all" for any)
terminal_on() {
  aerospace list-windows --workspace "$1" --format '%{window-id}|%{app-name}|%{window-title}' 2>/dev/null |
    awk -F'|' -v app="$TERMINAL_APP" '$2 == app { print $1 "|" $3; exit }'
}

log() {
  echo "$(date '+%H:%M:%S') $1 -> $2" >>"$STATE_DIR/clicks.log"
  tail -50 "$STATE_DIR/clicks.log" >"$STATE_DIR/clicks.log.tmp" && mv "$STATE_DIR/clicks.log.tmp" "$STATE_DIR/clicks.log"
}

jumped=""
if [ "$tmx" != "-" ]; then
  if focus_window_titled "$tmx"; then
    jumped=1
    log "$1" "focused window titled $tmx"
  else
    row=$(terminal_on "$MAIN_WS")
    [ -z "$row" ] && row=$(terminal_on all)
    if [ -n "$row" ]; then
      if repoint_window "${row%%|*}" "${row#*|}" "$tmx"; then
        jumped=1
        log "$1" "repointed window ${row%%|*} (${row#*|}) to $tmx"
      else
        log "$1" "FAILED repoint of window ${row%%|*} (${row#*|}) to $tmx"
      fi
    else
      log "$1" "no $TERMINAL_APP window found at all"
    fi
  fi
else
  log "$1" "no tmux recorded, ws=$ws"
fi

# Inside the session, also select the tmux window/pane the agent runs in.
# The pane id is stable across window moves; the window index is a fallback.
if [ -n "$jumped" ]; then
  if [ "$pane" != "-" ] && tmux select-window -t "$pane" 2>/dev/null; then
    tmux select-pane -t "$pane" 2>/dev/null
  elif [ "$twin" != "-" ]; then
    tmux select-window -t "${tmx}:${twin}" 2>/dev/null
  fi
fi

# Fallback: at least land on the workspace the agent was started from
[ -z "$jumped" ] && [ "$ws" != "-" ] && aerospace workspace "$ws" 2>/dev/null

if [ "$status" = "done" ]; then
  tmp=$(mktemp)
  jq '.status="seen"' "$f" >"$tmp" && mv "$tmp" "$f"
  sketchybar --trigger agents_update
fi
exit 0
