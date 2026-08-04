#!/usr/bin/env bash
# Dock-style "Programs" menu. Dispatcher: programs.sh <action> [args]
#   toggle          — (re)build the running-app list and toggle the dropdown
#   app <idx>       — app row click: left = focus/launch the app,
#                     right = open/close its submenu (windows + actions)
#   win <wid>       — window row click: left = focus the window,
#                     right = "Close" context popup next to the row
#   winclose <wid>  — close one window
#   closeall <idx>  — close every window of app #idx
#   quit <idx>      — quit app #idx
#   autohide        — event hook ($SENDER routing) for closing the tree
#
# Left click always activates; context menus only ever open on right click.
# Item tree: programs → programs.app.N (popup) → programs.sub.* (nested popup)
#            → programs.wc.<wid> ("Close" row, popup of a window row)
# Rows are rebuilt from scratch on every open, so state never goes stale.
# Note: minimized windows aren't listed (aerospace doesn't manage them).

BASE_DIR=$(cd "$(dirname "$0")/.." && pwd)
source "$BASE_DIR/design.sh" # PATH, palette, APP_FONT + design tokens
source "$BASE_DIR/helpers/icon_map.sh"

CACHE="$HOME/.cache/sketchybar-programs"
mkdir -p "$CACHE"
APPS="$CACHE/apps.tsv"    # idx <TAB> app name, written on each toggle-on
OPEN_SUB="$CACHE/open_sub" # idx of the submenu currently open (if any)

PLUGIN="$BASE_DIR/plugins/programs.sh"

# align=right pushes nested popups to the item's right side (dock-like);
# the default opens them leftward, off-screen for a left-anchored item.
POPUP_STYLE=("${POPUP_PROPS[@]}" popup.align=right)

# NB: sketchybar's regex matcher chokes on (a|b) alternation and optional
# groups — stick to simple prefix patterns, one per class of item.
hide_all() {
  sketchybar --set programs popup.drawing=off \
    --set '/programs\..*/' popup.drawing=off 2>/dev/null
  rm -f "$OPEN_SUB"
}

drop_rows() { # remove submenu rows (window rows, separators, actions, close)
  sketchybar --remove '/programs\.wc\..*/' 2>/dev/null
  sketchybar --remove '/programs\.sub\..*/' 2>/dev/null
}

# Apps with windows (aerospace, canonical names) first, then windowless
# regular apps from System Events; case-insensitive dedupe keeps the former.
running_apps() {
  {
    aerospace list-windows --all --format '%{app-name}' 2>/dev/null
    osascript -e 'tell application "System Events" to get name of every application process whose background only is false' 2>/dev/null |
      tr ',' '\n' | sed 's/^ *//;s/ *$//'
  } | awk 'NF && !seen[tolower($0)]++' | sort -f
}

app_windows() { # $1 = app name → "wid|title" lines
  aerospace list-windows --all --format '%{window-id}|%{app-name}|%{window-title}' 2>/dev/null |
    awk -F'|' -v a="$1" '$2 == a { t=$3; for (i=4; i<=NF; i++) t=t "|" $i; print $1 "|" t }'
}

app_for() { awk -F'\t' -v i="$1" '$1 == i { print $2; exit }' "$APPS" 2>/dev/null; }

case "$1" in
  toggle)
    if [ "$(sketchybar --query programs 2>/dev/null | jq -r '.popup.drawing')" = "on" ]; then
      hide_all
      exit 0
    fi
    drop_rows
    sketchybar --remove '/programs\.app\..*/' 2>/dev/null
    : >"$APPS"
    rm -f "$OPEN_SUB"

    # Uniform row width from the longest app name, so hover pills span the menu
    apps=$(running_apps)
    maxlen=0
    while IFS= read -r app; do
      [ "${#app}" -gt "$maxlen" ] && maxlen=${#app}
    done <<<"$apps"
    W=$(menu_width "$maxlen")

    args=()
    i=0
    while IFS= read -r app; do
      [ -z "$app" ] && continue
      printf '%s\t%s\n' "$i" "$app" >>"$APPS"
      __icon_map "$app"
      args+=(--add item "programs.app.$i" popup.programs
        --set "programs.app.$i"
        "${MENU_ROW[@]}"
        width="$W"
        icon="$icon_result"
        icon.font="$APP_FONT"
        label="$app"
        "${POPUP_STYLE[@]}"
        click_script="$PLUGIN app $i"
        --subscribe "programs.app.$i" mouse.entered mouse.exited)
      i=$((i + 1))
    done <<<"$apps"

    [ "$i" -gt 0 ] && sketchybar "${args[@]}" --set programs popup.drawing=on
    ;;

  app)
    idx="$2"
    app=$(app_for "$idx")
    [ -z "$app" ] && exit 0
    item="programs.app.$idx"

    # Left click activates the app: focus its first window, or launch it
    if [ "${BUTTON:-}" != "right" ]; then
      hide_all
      wid=$(app_windows "$app" | head -1 | cut -d'|' -f1)
      if [ -n "$wid" ]; then
        aerospace focus --window-id "$wid" 2>/dev/null
      else
        osascript -e "tell application \"$app\" to activate" 2>/dev/null
      fi
      exit 0
    fi

    # Right click on the same app folds its submenu back up
    if [ "$(cat "$OPEN_SUB" 2>/dev/null)" = "$idx" ]; then
      sketchybar --set "$item" popup.drawing=off
      drop_rows
      rm -f "$OPEN_SUB"
      exit 0
    fi

    sketchybar --set '/programs\.app\..*/' popup.drawing=off 2>/dev/null
    drop_rows

    wins=$(app_windows "$app")
    count=0
    [ -n "$wins" ] && count=$(wc -l <<<"$wins" | tr -d ' ')

    # Uniform submenu width: longest of window titles + action labels
    maxlen=$((${#app} + 5)) # "Quit $app"
    [ "$maxlen" -lt 17 ] && maxlen=17 # "Close All Windows"
    while IFS='|' read -r _ title; do
      [ "${#title}" -gt 45 ] && title="${title:0:45}…"
      [ "${#title}" -gt "$maxlen" ] && maxlen=${#title}
    done <<<"$wins"
    W=$(menu_width "$maxlen")

    args=()
    add_sep() {
      args+=(--add item "programs.sub.sep.$1" popup."$item"
        --set "programs.sub.sep.$1"
        "${MENU_SEP[@]}"
        width="$W"
        label="$(menu_sep "$maxlen")")
    }
    add_quit() {
      args+=(--add item programs.sub.quit popup."$item"
        --set programs.sub.quit
        "${MENU_ROW[@]}"
        width="$W"
        icon=󰗼 icon.color="$RED"
        label="Quit $app"
        click_script="$PLUGIN quit $idx"
        --subscribe programs.sub.quit mouse.entered mouse.exited)
    }

    if [ "$count" -eq 0 ]; then
      add_quit
    else
      solo_wid=""
      # Window rows: left-click focuses, right-click opens a "Close" popup
      while IFS='|' read -r wid title; do
        [ -z "$wid" ] && continue
        solo_wid="$wid"
        [ -z "$title" ] && title="$app"
        short="${title:0:45}"
        [ "${#title}" -gt 45 ] && short="${short}…"
        args+=(--add item "programs.sub.win.$wid" popup."$item"
          --set "programs.sub.win.$wid"
          "${MENU_ROW[@]}"
          width="$W"
          icon=󰖯 icon.color="$SAPPHIRE"
          label="$short"
          "${POPUP_STYLE[@]}"
          click_script="$PLUGIN win $wid"
          --subscribe "programs.sub.win.$wid" mouse.entered mouse.exited)
      done <<<"$wins"

      add_sep 1
      if [ "$count" -eq 1 ]; then
        args+=(--add item programs.sub.close popup."$item"
          --set programs.sub.close
          "${MENU_ROW[@]}"
          width="$W"
          icon=󰅖 icon.color="$PEACH"
          label="Close Window"
          click_script="$PLUGIN winclose $solo_wid"
          --subscribe programs.sub.close mouse.entered mouse.exited)
      else
        args+=(--add item programs.sub.closeall popup."$item"
          --set programs.sub.closeall
          "${MENU_ROW[@]}"
          width="$W"
          icon=󰩹 icon.color="$PEACH"
          label="Close All Windows"
          click_script="$PLUGIN closeall $idx"
          --subscribe programs.sub.closeall mouse.entered mouse.exited)
      fi
      add_quit
    fi

    sketchybar "${args[@]}" --set "$item" popup.drawing=on
    echo "$idx" >"$OPEN_SUB"
    ;;

  win)
    wid="$2"
    if [ "${BUTTON:-}" = "right" ]; then
      row="programs.sub.win.$wid"
      if [ "$(sketchybar --query "$row" 2>/dev/null | jq -r '.popup.drawing')" = "on" ]; then
        sketchybar --set "$row" popup.drawing=off
        exit 0
      fi
      sketchybar --set '/programs\.sub\.win\..*/' popup.drawing=off 2>/dev/null
      sketchybar --remove '/programs\.wc\..*/' 2>/dev/null
      sketchybar --add item "programs.wc.$wid" popup."$row" \
        --set "programs.wc.$wid" \
        "${MENU_ROW[@]}" \
        icon=󰅖 icon.color="$PEACH" \
        label="Close" \
        click_script="$PLUGIN winclose $wid" \
        --subscribe "programs.wc.$wid" mouse.entered mouse.exited \
        --set "$row" popup.drawing=on
      exit 0
    fi
    hide_all
    aerospace focus --window-id "$wid" 2>/dev/null
    ;;

  winclose)
    hide_all
    aerospace close --window-id "$2" 2>/dev/null
    ;;

  closeall)
    app=$(app_for "$2")
    hide_all
    [ -z "$app" ] && exit 0
    while IFS='|' read -r wid _; do
      [ -n "$wid" ] && aerospace close --window-id "$wid" 2>/dev/null
    done < <(app_windows "$app")
    ;;

  quit)
    app=$(app_for "$2")
    hide_all
    [ -n "$app" ] && osascript -e "tell application \"$app\" to quit" 2>/dev/null
    ;;

  autohide)
    case "${SENDER:-}" in
      front_app_switched) hide_all ;;
      mouse.exited.global)
        # Keep the tree while a submenu is open — the pointer is likely
        # travelling between popup windows, not leaving the menu.
        [ -f "$OPEN_SUB" ] || hide_all
        ;;
    esac
    ;;
esac
exit 0
