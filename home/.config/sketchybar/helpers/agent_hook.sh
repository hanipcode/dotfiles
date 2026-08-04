#!/usr/bin/env bash
# Called by Claude Code hooks: agent_hook.sh <working|waiting|done|end>
# Reads the hook JSON on stdin, maintains one state file per session in
# ~/.cache/agent-status/, pokes sketchybar, and notifies when a run finishes
# while you're on a different workspace.

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

EVENT="$1"
STATE_DIR="$HOME/.cache/agent-status"
mkdir -p "$STATE_DIR"

input=$(cat 2>/dev/null)
sid=$(jq -r '.session_id // empty' <<<"$input" 2>/dev/null)
cwd=$(jq -r '.cwd // empty' <<<"$input" 2>/dev/null)
[ -z "$sid" ] && exit 0

f="$STATE_DIR/claude-$sid.json"
project=$(basename "${cwd:-$PWD}")

echo "$(date '+%H:%M:%S') $EVENT $project ${sid:0:8}" >>"$STATE_DIR/events.log"
tail -100 "$STATE_DIR/events.log" >"$STATE_DIR/events.log.tmp" && mv "$STATE_DIR/events.log.tmp" "$STATE_DIR/events.log"

# Nearest 'claude' ancestor pid — lets the reconciler drop the state file if
# the session dies without a clean SessionEnd (crash, kill, closed window)
find_owner_pid() {
  local p=$PPID
  while [ -n "$p" ] && [ "$p" -gt 1 ]; do
    case "$(ps -o comm= -p "$p" 2>/dev/null)" in
      *claude*)
        echo "$p"
        return
        ;;
    esac
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
  done
  echo 0
}

capture_tmux() { # sets tmx, twin (the stable pane id comes from $TMUX_PANE)
  tmx="" twin=""
  if [ -n "$TMUX" ]; then
    # -t $TMUX_PANE pins the query to OUR pane; without it tmux reports the
    # session's currently active window, which may be a different agent's
    IFS='|' read -r tmx twin < <(tmux display-message ${TMUX_PANE:+-t "$TMUX_PANE"} -p '#S|#I' 2>/dev/null)
  fi
}

case "$EVENT" in
  end)
    rm -f "$f"
    ;;
  working)
    # User just submitted a prompt here, so the focused workspace IS this
    # agent's workspace. Capture it (and the tmux pane) for click-to-jump.
    ws=$(aerospace list-workspaces --focused 2>/dev/null)
    capture_tmux
    jq -n --arg tool claude --arg id "$sid" --arg project "$project" \
      --arg ws "$ws" --arg tmux "$tmx" --arg win "$twin" --arg pane "${TMUX_PANE:-}" \
      --argjson pid "$(find_owner_pid)" \
      '{tool:$tool,id:$id,project:$project,ws:$ws,tmux:$tmux,win:$win,pane:$pane,pid:$pid,status:"working"}' >"$f"
    ;;
  resume)
    # A tool ran → the human answered whatever we were waiting on. Only acts
    # on waiting→working; exits silently otherwise (fires per tool call).
    if [ -f "$f" ] && [ "$(jq -r '.status' "$f" 2>/dev/null)" = "waiting" ]; then
      tmp=$(mktemp)
      jq '.status="working"' "$f" >"$tmp" && mv "$tmp" "$f"
      sketchybar --trigger agents_update >/dev/null 2>&1
    fi
    exit 0
    ;;
  waiting|done)
    if [ -f "$f" ]; then
      # Already waiting → nothing new to say (avoids duplicate notifications
      # when Notification + PermissionRequest fire for the same prompt)
      [ "$EVENT" = "waiting" ] && [ "$(jq -r '.status' "$f" 2>/dev/null)" = "waiting" ] && exit 0
      tmp=$(mktemp)
      jq --arg s "$EVENT" '.status=$s' "$f" >"$tmp" && mv "$tmp" "$f"
    else
      # No prior record (hook added mid-session or file swept): still capture
      # pid + pane so the liveness sweep applies to this file too
      capture_tmux
      jq -n --arg tool claude --arg id "$sid" --arg project "$project" --arg s "$EVENT" \
        --arg tmux "$tmx" --arg win "$twin" --arg pane "${TMUX_PANE:-}" \
        --argjson pid "$(find_owner_pid)" \
        '{tool:$tool,id:$id,project:$project,ws:"",tmux:$tmux,win:$win,pane:$pane,pid:$pid,status:$s}' >"$f"
    fi
    if [ "$EVENT" = "done" ] || [ "$EVENT" = "waiting" ]; then
      agent_ws=$(jq -r '.ws // empty' "$f" 2>/dev/null)
      cur_ws=$(aerospace list-workspaces --focused 2>/dev/null)
      # Only notify when you're NOT already looking at that workspace
      if [ -z "$agent_ws" ] || [ "$cur_ws" != "$agent_ws" ]; then
        if [ "$EVENT" = "done" ]; then
          title="Claude Code finished" sound="Glass"
        else
          title="Claude Code needs input" sound="Funk"
        fi
        # notify.sh blocks while the notification is on screen (to catch the
        # click), so run it detached from this hook.
        "$(cd "$(dirname "$0")" && pwd)/notify.sh" "$title" "$sound" "$project" "claude-$sid" >/dev/null 2>&1 &
        disown
      fi
    fi
    ;;
esac

sketchybar --trigger agents_update >/dev/null 2>&1
exit 0
