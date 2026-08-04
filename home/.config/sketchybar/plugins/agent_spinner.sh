#!/usr/bin/env bash
# Animates the icon of every "working" agent chip with a braille spinner
# (~10fps). Started by agents.sh whenever a working agent exists; exits by
# itself when none remain. A pidfile lock keeps it a singleton.

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

STATE_DIR="$HOME/.cache/agent-status"
LOCK="$STATE_DIR/.spinner.pid"

if [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK")" 2>/dev/null; then
  exit 0
fi
echo $$ >"$LOCK"
trap 'rm -f "$LOCK"' EXIT

FRAMES=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏)
i=0

while :; do
  # grep handles both compact (opencode) and pretty-printed (claude) JSON
  working=$(grep -l '"status": *"working"' "$STATE_DIR"/*.json 2>/dev/null)
  [ -z "$working" ] && break

  args=()
  while IFS= read -r f; do
    # icon.width every frame: guards against reconciler races that would
    # otherwise let a frame render at dynamic width (chip jitter)
    args+=(--set "agent.$(basename "$f" .json)" icon="${FRAMES[$i]}" icon.width=16)
  done <<<"$working"

  sketchybar "${args[@]}" 2>/dev/null
  i=$(((i + 1) % ${#FRAMES[@]}))
  sleep 0.1
done
exit 0
