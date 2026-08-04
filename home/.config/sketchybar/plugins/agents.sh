#!/usr/bin/env bash
# Reconciles agent chips with the state files in ~/.cache/agent-status/.
# One chip per live Claude Code / OpenCode session; click jumps to its
# terminal window + tmux window. Agents whose process died are auto-removed
# (this runs on every agents_update event and every 15s).
# Status: working → peach icon · waiting → yellow · done → green · seen → dim
# Duplicate project names get their tmux window index appended (proj ·2).

source "$CONFIG_DIR/design.sh"

# Drops noisy, near-universal tokens from project-derived labels (repo names
# at work all share "example"/"dashboard"/"fe" — they add length, not signal).
# Hyphen-token match only, so "feature" or "café" survive untouched.
STRIP_WORDS="example dashboard fe hanif hanipcode"
strip_label() {
  local name="$1" out="" tok first=1 toks
  IFS='-' read -ra toks <<<"$name"
  for tok in "${toks[@]}"; do
    [[ " $STRIP_WORDS " == *" ${tok,,} "* ]] && continue
    if [ "$first" -eq 1 ]; then out="$tok" first=0; else out+="-$tok"; fi
  done
  printf '%s' "${out:-$name}" # never blank out an all-stripped name
}

STATE_DIR="$HOME/.cache/agent-status"
mkdir -p "$STATE_DIR"

# Age-based sweep for files that predate the pid field (>12h old)
find "$STATE_DIR" -name '*.json' -mmin +720 -delete 2>/dev/null

# True if $1 is a descendant of the agent's tmux pane. Prefers the stable
# pane id ($4, e.g. "%8") — window indexes can shift if windows get moved;
# falls back to all panes of session:window. Catches lingering daemonized
# servers: pid alive but detached from the pane.
alive_in_pane() {
  local pane_pids p
  [ -n "$4" ] && pane_pids=$(tmux display-message -t "$4" -p '#{pane_pid}' 2>/dev/null)
  [ -z "$pane_pids" ] && pane_pids=$(tmux list-panes -t "$2:$3" -F '#{pane_pid}' 2>/dev/null)
  [ -z "$pane_pids" ] && return 1 # pane and window both gone
  p=$1
  while [ -n "$p" ] && [ "$p" -gt 1 ] 2>/dev/null; do
    grep -qx "$p" <<<"$pane_pids" && return 0
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
  done
  return 1
}

# First pass: gather live agents as "base|tool|project|win|status" lines,
# dropping state files whose owning process is gone or has left its pane.
rows=""
for f in "$STATE_DIR"/*.json; do
  [ -e "$f" ] || continue
  IFS='|' read -r pid tmx twin pane < <(jq -r '[(.pid // 0 | tostring), .tmux // "", .win // "", .pane // ""] | join("|")' "$f" 2>/dev/null)
  if [ "$pid" -gt 1 ] 2>/dev/null; then
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$f"
      continue
    fi
    if { [ -n "$pane" ] || { [ -n "$tmx" ] && [ -n "$twin" ]; }; } &&
      ! alive_in_pane "$pid" "$tmx" "$twin" "$pane"; then
      rm -f "$f"
      continue
    fi
  fi
  rows+=$(jq -r '[(input_filename | split("/")[-1] | rtrimstr(".json")), .tool, .project, (.win // ""), .status] | join("|")' "$f")$'\n'
done

existing=$(sketchybar --query bar 2>/dev/null | jq -r '.items[]?' | grep '^agent\.' || true)

args=()
want=""
while IFS='|' read -r base tool project win status; do
  [ -z "$base" ] && continue
  item="agent.$base"
  want+="$item"$'\n'"$item.menu.close"$'\n'"$item.menu.closeall"$'\n'"$item.menu.killtmux"$'\n'

  case "$tool" in
    opencode) icon="󰅬" ;;
    *)        icon="󰚩" ;;
  esac

  # State colors: working = peach spinner + peach border, waiting = yellow,
  # finished = green, idle/acknowledged = dimmed
  border=0x00000000 border_w=0
  case "$status" in
    working) bg=$ITEM_BG icon_color=$PEACH   label_color=$TEXT
             icon="⠋" border=$PEACH border_w=1 ;; # spinner takes over
    waiting) bg=$YELLOW  icon_color=$CRUST   label_color=$CRUST ;;
    done)    bg=$GREEN   icon_color=$CRUST   label_color=$CRUST ;;
    *)       bg=$ITEM_BG icon_color=$OVERLAY label_color=$SUBTEXT ;;
  esac

  # Disambiguate agents sharing a project name with their tmux window index
  # (exact field match, on the raw project name — a project named "opencode"
  # or with regex chars must not collide with the tool/other columns)
  label="$(strip_label "$project")"
  dupes=$(awk -F'|' -v p="$project" '$3 == p' <<<"$rows" | grep -c .)
  if [ "$dupes" -gt 1 ]; then
    label="$label ·${win:-?}"
  fi

  if ! grep -qx "$item" <<<"$existing"; then
    args+=(--add item "$item" center)

    # Right-click context menu (see agent_click.sh for the BUTTON routing)
    menu="$CONFIG_DIR/plugins/agent_menu.sh"
    args+=(--set "$item"
      "${POPUP_PROPS[@]}"
      script="sketchybar --set \$NAME popup.drawing=off")
    args+=(--subscribe "$item" mouse.exited.global)
    AGENT_MENU_W=$(menu_width 20) # "Close all in session"
    args+=(--add item "$item.menu.close" popup."$item"
      --set "$item.menu.close" "${MENU_ROW[@]}" width="$AGENT_MENU_W"
      icon=󰅖 icon.color="$PEACH" label="Close agent"
      click_script="$menu close $base"
      --subscribe "$item.menu.close" mouse.entered mouse.exited)
    args+=(--add item "$item.menu.closeall" popup."$item"
      --set "$item.menu.closeall" "${MENU_ROW[@]}" width="$AGENT_MENU_W"
      icon=󰩹 icon.color="$RED" label="Close all in session"
      click_script="$menu close-all $base"
      --subscribe "$item.menu.closeall" mouse.entered mouse.exited)
    args+=(--add item "$item.menu.killtmux" popup."$item"
      --set "$item.menu.killtmux" "${MENU_ROW[@]}" width="$AGENT_MENU_W"
      icon=󰆴 icon.color="$RED" label="Kill tmux session"
      click_script="$menu close-tmux $base"
      --subscribe "$item.menu.killtmux" mouse.entered mouse.exited)
  fi

  # While working, the spinner daemon owns the icon — don't fight over it.
  # Fixed icon.width stops the chip from reflowing as spinner frames change.
  if [ "$status" = "working" ]; then
    icon_arg=(icon.width=16 icon.align=center)
    grep -qx "$item" <<<"$existing" || icon_arg+=(icon="$icon")
  else
    icon_arg=(icon="$icon" icon.width=dynamic)
  fi

  args+=(--animate sin 20 --set "$item"
    "${icon_arg[@]}"
    icon.padding_left=9
    icon.color="$icon_color"
    label="$label"
    label.padding_right=9
    label.color="$label_color"
    background.drawing=on
    background.color="$bg"
    background.border_color="$border"
    background.border_width="$border_w"
    drawing=on
    click_script="$CONFIG_DIR/plugins/agent_click.sh $base")

  [ "$status" = "working" ] && need_spinner=1
done <<<"$rows"

# Remove chips whose sessions are gone; brackets/close buttons from the old
# pill design (agent.*.bg / agent.*.x) are always stale now.
remove_stale() {
  while IFS= read -r item; do
    [ -z "$item" ] && continue
    grep -qx "$item" <<<"$want" || args+=(--remove "$item")
  done <<<"$1"
}
remove_stale "$(grep -E '\.(bg|x)$' <<<"$existing")"
remove_stale "$(grep -Ev '\.(bg|x)$' <<<"$existing")"

[ ${#args[@]} -gt 0 ] && sketchybar "${args[@]}"

# Spawn the spinner only AFTER chip settings (fixed icon.width) are applied
if [ -n "$need_spinner" ]; then
  "$CONFIG_DIR/plugins/agent_spinner.sh" >/dev/null 2>&1 &
fi
exit 0
