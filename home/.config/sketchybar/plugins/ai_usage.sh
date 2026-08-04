#!/usr/bin/env bash
# Claude / Codex usage gauge. Dispatcher: ai_usage.sh <action>
#   update        — routine fetch + recolor the bar icon (worst limit)
#   toggle        — open/close the popup (rows rebuilt from cache, then a
#                   background fetch re-renders if anything was stale)
#   select-toggle — tab bar click: flip between claude and codex
#   refresh       — force-fetch both providers and re-render
#
# Data sources:
#   Claude — OAuth token from the "Claude Code-credentials" keychain item →
#            https://api.anthropic.com/api/oauth/usage (5h + 7d utilization).
#            Skipped when the token is expired; Claude Code refreshes it on
#            its next run, we just keep serving the cached numbers.
#   Codex  — newest rate_limits entry in ~/.codex/sessions/**/rollout-*.jsonl
#            (the CLI logs them with every token count, no network needed).

BASE_DIR=$(cd "$(dirname "$0")/.." && pwd)
source "$BASE_DIR/design.sh"

PLUGIN="$BASE_DIR/plugins/ai_usage.sh"
CACHE="$HOME/.cache/sketchybar-ai"
mkdir -p "$CACHE"
CLAUDE_JSON="$CACHE/claude.json"
CODEX_JSON="$CACHE/codex.json"
SEL="$CACHE/provider"

# ---- fetchers ----------------------------------------------------------------

fetch_claude() { # $1 = "force" to bypass the 4-minute cache window
  if [ "$1" != "force" ] && [ -f "$CLAUDE_JSON" ]; then
    [ $(($(date +%s) - $(stat -f %m "$CLAUDE_JSON"))) -lt 240 ] && return 0
  fi
  local creds tok exp plan out
  creds=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null) || return 1
  tok=$(jq -r '.claudeAiOauth.accessToken // empty' <<<"$creds")
  [ -z "$tok" ] && return 1
  exp=$(jq -r '.claudeAiOauth.expiresAt // 0' <<<"$creds") # milliseconds
  [ "$((exp / 1000))" -le "$(date +%s)" ] && return 1      # expired token
  plan=$(jq -r '.claudeAiOauth.subscriptionType // empty' <<<"$creds")
  out=$(curl -sS -m 8 "https://api.anthropic.com/api/oauth/usage" \
    -H "Authorization: Bearer $tok" \
    -H "anthropic-beta: oauth-2025-04-20" 2>/dev/null) || return 1
  jq -e '.five_hour.utilization' <<<"$out" >/dev/null 2>&1 || return 1
  jq --arg plan "$plan" '. + {plan: $plan}' <<<"$out" >"$CLAUDE_JSON"
}

# Live limits from the Codex app-server (JSON-RPC over stdio, ~1.5s). It
# closes stdin-EOF immediately, so the request goes through a coprocess we
# tear down as soon as the id:2 reply lands.
codex_live() {
  local line out="" cid codex_bin
  # Resolved explicitly: a bare `codex` only works if PATH carries ~/.local/bin
  codex_bin=$(command -v codex 2>/dev/null) || codex_bin="$HOME/.local/bin/codex"
  [ -x "$codex_bin" ] || return 1
  cid='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"sketchybar","title":"sketchybar","version":"1.0.0"}}}'
  coproc CDX { "$codex_bin" app-server 2>/dev/null; }
  {
    printf '%s\n' "$cid"
    printf '%s\n' '{"jsonrpc":"2.0","method":"initialized","params":{}}'
    printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"account/rateLimits/read","params":{}}'
  } >&"${CDX[1]}" 2>/dev/null
  while IFS= read -r -t 10 line <&"${CDX[0]}"; do
    case "$line" in *'"id":2'*) out="$line"; break ;; esac
  done
  kill "$CDX_PID" 2>/dev/null
  wait "$CDX_PID" 2>/dev/null
  [ -n "$out" ] || return 1
  jq -e '.result.rateLimitsByLimitId' <<<"$out" >/dev/null 2>&1 || return 1
  # Flatten every limit id (plan + model-scoped ones like Codex Spark) and
  # both of its windows into one list
  jq '{
    source: "live",
    plan: (.result.rateLimits.planType // ""),
    limits: [ .result.rateLimitsByLimitId | to_entries[]
      | .value as $v | (($v.limitName // "")) as $n
      | ([$v.primary, $v.secondary] | map(select(. != null))[])
      | {name: $n, win: (.windowDurationMins // 10080),
         used: (.usedPercent // 0), resets: (.resetsAt // 0)} ]
      | sort_by(.name != "") # plan limit first, model-scoped ones after
  }' <<<"$out"
}

# Offline fallback: newest rate_limits line in the rollout logs. Only written
# while a CLI session runs, so this can be weeks stale — flagged as such.
codex_logs() {
  local f rl
  while IFS= read -r f; do
    rl=$(grep '"rate_limits"' "$f" 2>/dev/null | tail -1 |
      jq -c '.payload.rate_limits // empty' 2>/dev/null)
    if [ -n "$rl" ] && [ "$rl" != "null" ]; then
      jq '{
        source: "logs",
        plan: (.plan_type // ""),
        limits: [ (.primary, .secondary) | select(. != null)
          | {name: "", win: (.window_minutes // 10080),
             used: (.used_percent // 0), resets: (.resets_at // 0)} ]
      }' <<<"$rl"
      return 0
    fi
  done < <(ls -t "$HOME"/.codex/sessions/*/*/*/rollout-*.jsonl 2>/dev/null | head -10)
  return 1
}

fetch_codex() { # $1 = "force" to bypass the 4-minute cache window
  if [ "$1" != "force" ] && [ -f "$CODEX_JSON" ]; then
    [ $(($(date +%s) - $(stat -f %m "$CODEX_JSON"))) -lt 240 ] && return 0
  fi
  local out
  out=$(codex_live) || out=$(codex_logs) || return 1
  printf '%s' "$out" >"$CODEX_JSON"
}

# ---- formatting helpers --------------------------------------------------------

gauge() { # $1 = used percent, $2 = cells → bar
  local filled=$((($1 * $2 + 50) / 100)) s="" j
  [ "$filled" -gt "$2" ] && filled=$2
  for ((j = 0; j < $2; j++)); do
    [ "$j" -lt "$filled" ] && s+="█" || s+="░"
  done
  printf '%s' "$s"
}

pct_color() {
  if [ "$1" -ge 90 ]; then echo "$RED"
  elif [ "$1" -ge 70 ]; then echo "$YELLOW"
  else echo "$TEAL"; fi
}

epoch_from_iso() { # 2026-07-17T20:00:00.331337+00:00 → epoch seconds
  local s
  s=$(sed -E 's/\.[0-9]+//; s/([+-][0-9]{2}):([0-9]{2})$/\1\2/; s/Z$/+0000/' <<<"$1")
  date -j -f '%Y-%m-%dT%H:%M:%S%z' "$s" +%s 2>/dev/null
}

fmt_reset() { # epoch → "8:00 PM" today, "Sat 7 PM" beyond 24h
  [ -z "$1" ] && return
  [ "$1" -gt 0 ] 2>/dev/null || return
  local d=$(($1 - $(date +%s)))
  if [ "$d" -le 0 ]; then
    echo "now" # window already elapsed — never render a past time as upcoming
  elif [ "$d" -lt 86400 ]; then
    date -r "$1" '+%-I:%M %p'
  else
    date -r "$1" '+%a %-I %p'
  fi
}

age_of() { # cache file → "just now" / "Nm ago" / "Nh ago"
  local m=$((($(date +%s) - $(stat -f %m "$1" 2>/dev/null || echo 0)) / 60))
  if [ "$m" -lt 1 ]; then echo "just now"
  elif [ "$m" -lt 60 ]; then echo "${m}m ago"
  else echo "$((m / 60))h ago"; fi
}

win_name() { # Codex window minutes → human label
  case "$1" in
    10080) echo "Weekly" ;;
    300) echo "Session" ;;
    *) echo "$(($1 / 60))h" ;;
  esac
}

limit_label() { # $1 = limit name ("" for the plan limit), $2 = window minutes
  if [ -z "$1" ]; then
    win_name "$2"
  else
    printf '%s %s' "${1##*-}" "$(win_name "$2")" # GPT-5.3-Codex-Spark → Spark
  fi
}

# ---- popup --------------------------------------------------------------------
# CodexBar-style vertical layout: per limit a title row (name left, % used
# right), a full-width bar, and a dim right-aligned reset line underneath.

BAR_CELLS=26
MENU_CHARS=$BAR_CELLS
W=$(menu_width "$MENU_CHARS")
INNER=$((W - 40))     # content width inside the row paddings
HALF=$((INNER / 2))   # title / percent columns

# Segmented Claude | Codex tab bar as one row: the icon slot is the Claude
# pill, the label slot the Codex pill. Clicking flips the selection.
add_tabs() { # $1 = selected provider
  local c_bg c_fg x_bg x_fg
  if [ "$1" = "claude" ]; then
    c_bg=$ACCENT c_fg=$CRUST x_bg=0x00000000 x_fg=$SUBTEXT
  else
    c_bg=0x00000000 c_fg=$SUBTEXT x_bg=$ACCENT x_fg=$CRUST
  fi
  args+=(--add item ai.menu.tabs popup.ai
    --set ai.menu.tabs
    padding_left=8
    padding_right=8
    icon="󰧑 Claude"
    icon.font="$FONT:SemiBold:13.0"
    icon.color="$c_fg"
    icon.padding_left=14
    icon.padding_right=14
    icon.background.drawing=on
    icon.background.color="$c_bg"
    icon.background.corner_radius=7
    icon.background.height=22
    label="󱚝 Codex"
    label.font="$FONT:SemiBold:13.0"
    label.color="$x_fg"
    label.padding_left=14
    label.padding_right=14
    label.background.drawing=on
    label.background.color="$x_bg"
    label.background.corner_radius=7
    label.background.height=22
    click_script="$PLUGIN select-toggle")
}

add_block() { # $1 key, $2 title, $3 pct, $4 reset-epoch ("" → no reset row)
  local pct color
  pct=$(printf '%.0f' "$3")
  color=$(pct_color "$pct")
  args+=(--add item "ai.menu.$1.title" popup.ai
    --set "ai.menu.$1.title"
    width="$W"
    padding_left=6 padding_right=6
    icon="$2"
    icon.font="$FONT:SemiBold:13.0"
    icon.color="$TEXT"
    icon.padding_left=12 icon.padding_right=0
    icon.width="$HALF" icon.align=left
    label="${pct}% used"
    label.color="$color"
    label.width="$HALF" label.align=right
    label.padding_right=16)
  args+=(--add item "ai.menu.$1.bar" popup.ai
    --set "ai.menu.$1.bar"
    "${MENU_INFO[@]}" width="$W"
    label="$(gauge "$pct" "$BAR_CELLS")"
    label.color="$color")
  if [ -n "$4" ]; then
    args+=(--add item "ai.menu.$1.reset" popup.ai
      --set "ai.menu.$1.reset"
      "${MENU_INFO[@]}" width="$W"
      label="resets $(fmt_reset "$4")"
      label.font="$FONT:Bold:11.0"
      label.color="$SUBTEXT"
      label.width="$INNER" label.align=right)
  fi
}

rebuild() {
  local sel args=() meta=""
  sel=$(cat "$SEL" 2>/dev/null)
  [ "$sel" != "codex" ] && sel=claude

  sketchybar --remove '/ai\.menu\..*/' 2>/dev/null

  add_tabs "$sel"
  args+=(--add item ai.menu.sep1 popup.ai
    --set ai.menu.sep1 "${MENU_SEP[@]}" width="$W" label="$(menu_sep "$MENU_CHARS")")

  if [ "$sel" = "claude" ]; then
    if [ -f "$CLAUDE_JSON" ]; then
      local po plan
      add_block s5 "Session" \
        "$(jq -r '.five_hour.utilization // 0' "$CLAUDE_JSON")" \
        "$(epoch_from_iso "$(jq -r '.five_hour.resets_at // empty' "$CLAUDE_JSON")")"
      add_block s7 "Weekly" \
        "$(jq -r '.seven_day.utilization // 0' "$CLAUDE_JSON")" \
        "$(epoch_from_iso "$(jq -r '.seven_day.resets_at // empty' "$CLAUDE_JSON")")"
      # Model-scoped weekly limit only exists on some plans
      po=$(jq -r '.seven_day_opus.utilization // empty' "$CLAUDE_JSON")
      [ -n "$po" ] && add_block opus "Opus" "$po" ""
      plan=$(jq -r '.plan // empty' "$CLAUDE_JSON")
      meta="${plan:+$plan · }$(age_of "$CLAUDE_JSON")"
    else
      meta="No data — run Claude Code"
    fi
  else
    if [ -f "$CODEX_JSON" ]; then
      local plan src n=0 lname lwin lused lresets
      # NB: '|' not tab — tab is IFS-whitespace, so `read` would swallow the
      # plan limit's empty name field and shift every column left
      while IFS='|' read -r lname lwin lused lresets; do
        [ -z "$lwin" ] && continue
        add_block "c$n" "$(limit_label "$lname" "$lwin")" "$lused" "$lresets"
        n=$((n + 1))
      done < <(jq -r '.limits[] | [.name, (.win|tostring), (.used|tostring), (.resets|tostring)] | join("|")' "$CODEX_JSON" 2>/dev/null)
      plan=$(jq -r '.plan // empty' "$CODEX_JSON")
      src=$(jq -r '.source // "live"' "$CODEX_JSON")
      if [ "$src" = "logs" ]; then
        # Rollout logs only move when a CLI session runs — say so plainly
        meta="${plan:+$plan · }stale (from local logs)"
      else
        meta="${plan:+$plan · }$(age_of "$CODEX_JSON")"
      fi
      [ "$n" -eq 0 ] && meta="No limits reported"
    else
      meta="No data — is Codex logged in?"
    fi
  fi

  args+=(--add item ai.menu.sep2 popup.ai
    --set ai.menu.sep2 "${MENU_SEP[@]}" width="$W" label="$(menu_sep "$MENU_CHARS")")
  args+=(--add item ai.menu.meta popup.ai
    --set ai.menu.meta
    "${MENU_HEADER[@]}" width="$W"
    label="$meta")
  args+=(--add item ai.menu.refresh popup.ai
    --set ai.menu.refresh
    "${MENU_ROW[@]}" width="$W"
    icon=󰑐 icon.color="$SUBTEXT"
    label="Refresh"
    click_script="$PLUGIN refresh"
    --subscribe ai.menu.refresh mouse.entered mouse.exited)

  sketchybar "${args[@]}"

  # Re-adding rows to an already-open popup doesn't always redraw it;
  # re-asserting drawing forces the popup window to re-render.
  if [ "$(sketchybar --query ai 2>/dev/null | jq -r '.popup.drawing')" = "on" ]; then
    sketchybar --set ai popup.drawing=on
  fi
}

# Recolor the bar icon from the worst limit across both providers
recolor() {
  local worst=0 v
  for v in \
    "$(jq -r '.five_hour.utilization // 0' "$CLAUDE_JSON" 2>/dev/null)" \
    "$(jq -r '.seven_day.utilization // 0' "$CLAUDE_JSON" 2>/dev/null)" \
    "$(jq -r '[.limits[].used] | max // 0' "$CODEX_JSON" 2>/dev/null)"; do
    v=$(printf '%.0f' "${v:-0}")
    [ "$v" -gt "$worst" ] && worst=$v
  done
  sketchybar --set ai icon.color="$(pct_color "$worst")"
}

# ---- dispatch -------------------------------------------------------------------

case "$1" in
  update)
    if [ "${SENDER:-}" = "mouse.exited.global" ]; then
      sketchybar --set ai popup.drawing=off
      exit 0
    fi
    fetch_claude
    fetch_codex
    recolor
    ;;

  toggle)
    if [ "$(sketchybar --query ai 2>/dev/null | jq -r '.popup.drawing')" = "on" ]; then
      sketchybar --set ai popup.drawing=off
      exit 0
    fi
    rebuild # instant, from cache
    sketchybar --set ai popup.drawing=on
    ( # freshen in the background; tearing down rows makes the popup flash,
      # so only re-render when the data actually changed and it's still open
      before=$(cat "$CLAUDE_JSON" "$CODEX_JSON" 2>/dev/null | md5)
      fetch_claude
      fetch_codex
      recolor
      after=$(cat "$CLAUDE_JSON" "$CODEX_JSON" 2>/dev/null | md5)
      [ "$after" != "$before" ] &&
        [ "$(sketchybar --query ai 2>/dev/null | jq -r '.popup.drawing')" = "on" ] &&
        rebuild
    ) >/dev/null 2>&1 &
    ;;

  select-toggle)
    if [ "$(cat "$SEL" 2>/dev/null)" = "codex" ]; then
      echo claude >"$SEL"
    else
      echo codex >"$SEL"
    fi
    rebuild
    ;;

  refresh)
    fetch_claude force
    fetch_codex force
    recolor
    rebuild
    ;;
esac
exit 0
