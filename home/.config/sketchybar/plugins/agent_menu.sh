#!/usr/bin/env bash
# Context-menu actions for agent chips: agent_menu.sh <action> <state-base>
#   close      — kill this agent's process (tmux window survives, shell remains)
#   close-all  — kill every agent in the same tmux session
#   close-tmux — kill the tmux session itself
# Chips disappear via the state-file removal + agents_update trigger.

BASE_DIR=$(cd "$(dirname "$0")/.." && pwd)
source "$BASE_DIR/colors.sh" # PATH

STATE_DIR="$HOME/.cache/agent-status"
action="$1" base="$2"
f="$STATE_DIR/$base.json"

sketchybar --set "agent.$base" popup.drawing=off 2>/dev/null
[ -f "$f" ] || exit 0

kill_agent() { # $1 = state file
  local pid
  pid=$(jq -r '.pid // 0' "$1" 2>/dev/null)
  if [ "$pid" -gt 1 ] 2>/dev/null && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null
  fi
  rm -f "$1"
}

same_session_files() { # $1 = tmux session name
  local g
  for g in "$STATE_DIR"/*.json; do
    [ -e "$g" ] || continue
    [ "$(jq -r '.tmux // ""' "$g" 2>/dev/null)" = "$1" ] && echo "$g"
  done
}

sess=$(jq -r '.tmux // ""' "$f" 2>/dev/null)

case "$action" in
  close)
    kill_agent "$f"
    ;;
  close-all)
    if [ -n "$sess" ]; then
      while IFS= read -r g; do kill_agent "$g"; done < <(same_session_files "$sess")
    else
      kill_agent "$f"
    fi
    ;;
  close-tmux)
    if [ -n "$sess" ]; then
      while IFS= read -r g; do rm -f "$g"; done < <(same_session_files "$sess")
      tmux kill-session -t "$sess" 2>/dev/null
    else
      kill_agent "$f"
    fi
    ;;
esac

sketchybar --trigger agents_update
exit 0
