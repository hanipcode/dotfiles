#!/usr/bin/env bash
# notify.sh <title> <sound> <message> <agent-state-base>
# Shows a notification via alerter; clicking it jumps to the agent's
# workspace/tmux session (agent_click.sh). Falls back to osascript.

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

title="$1" sound="$2" message="$3" agent="$4"
BASE_DIR=$(cd "$(dirname "$0")/.." && pwd)

if command -v alerter >/dev/null; then
  # Long timeout: the click only works while this process is alive, so keep
  # listening even if the user reacts from Notification Center minutes later
  resp=$(alerter --title "$title" --message "$message" --sound "$sound" \
    --group "agent-$agent" --timeout 900 2>/dev/null)
  case "$resp" in
    *CONTENTCLICKED* | *ACTIONCLICKED* | *contentsClicked* | *actionClicked* | Show*)
      "$BASE_DIR/plugins/agent_click.sh" "$agent"
      ;;
  esac
else
  osascript -e "display notification \"$message\" with title \"$title\" sound name \"$sound\"" >/dev/null 2>&1
fi
