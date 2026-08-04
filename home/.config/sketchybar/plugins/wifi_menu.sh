#!/usr/bin/env bash
# macOS-style Wi-Fi menu. Dispatcher: wifi_menu.sh <action> [args]
#   toggle     — (re)build the menu and toggle the popup
#   power      — Wi-Fi on/off row
#   join <idx> — connect to network #idx from nets.tsv (known or scanned)
#   scan       — "Other Networks…": scan and append the results
#   settings   — open the Wi-Fi pane in System Settings
#
# Item tree: wifi → wifi.menu.power / wifi.menu.net.N / wifi.menu.scan /
#            wifi.menu.other.N (scan results) / wifi.menu.settings
# Rows are rebuilt from scratch on every open, so state never goes stale.
# Styling comes from design.sh; all rows share one width (menu_width).

BASE_DIR=$(cd "$(dirname "$0")/.." && pwd)
source "$BASE_DIR/design.sh"

PLUGIN="$BASE_DIR/plugins/wifi_menu.sh"
CACHE="$HOME/.cache/sketchybar-wifi"
mkdir -p "$CACHE"
NETS="$CACHE/nets.tsv" # idx <TAB> ssid, for click rows (SSIDs contain spaces)

WIFI_IF=$(networksetup -listallhardwareports 2>/dev/null | awk '/Wi-Fi/ { getline; print $2 }')
WIFI_IF="${WIFI_IF:-en0}"

MIN_CHARS=16 # "Wi-Fi Settings…" — floor for the shared row width

current_ssid() {
  ipconfig getsummary "$WIFI_IF" 2>/dev/null | awk -F ' SSID : ' '/ SSID :/ { print $2 }'
}

refresh_chip() { NAME=wifi SENDER=forced "$BASE_DIR/plugins/wifi.sh"; }

drop_rows() { sketchybar --remove '/wifi\.menu\..*/' 2>/dev/null; }

# Longest label (chars) across a newline list, floored at MIN_CHARS
max_chars() {
  local max=$MIN_CHARS line
  while IFS= read -r line; do
    [ "${#line}" -gt "$max" ] && max=${#line}
  done
  echo "$max"
}

# Build the menu: power toggle, known networks, scan + settings actions
rebuild() {
  drop_rows
  : >"$NETS"

  local args=() power cur i ssid known maxc W
  power=$(networksetup -getairportpower "$WIFI_IF" 2>/dev/null | awk '{ print $NF }')
  cur=$(current_ssid)
  known=$(networksetup -listpreferredwirelessnetworks "$WIFI_IF" 2>/dev/null |
    tail -n +2 | sed 's/^[[:space:]]*//' | head -8)
  maxc=$(max_chars <<<"$known")
  W=$(menu_width "$maxc")

  if [ "$power" = "On" ]; then
    args+=(--add item wifi.menu.power popup.wifi
      --set wifi.menu.power
      "${MENU_ROW[@]}" width="$W"
      icon=󰔡 icon.color="$GREEN"
      label="Wi-Fi: On"
      click_script="$PLUGIN power"
      --subscribe wifi.menu.power mouse.entered mouse.exited)
  else
    args+=(--add item wifi.menu.power popup.wifi
      --set wifi.menu.power
      "${MENU_ROW[@]}" width="$W"
      icon=󰨙 icon.color="$OVERLAY"
      label="Wi-Fi: Off"
      click_script="$PLUGIN power"
      --subscribe wifi.menu.power mouse.entered mouse.exited)
  fi

  if [ "$power" = "On" ]; then
    args+=(--add item wifi.menu.sep1 popup.wifi
      --set wifi.menu.sep1 "${MENU_SEP[@]}" width="$W" label="$(menu_sep "$maxc")")
    args+=(--add item wifi.menu.header popup.wifi
      --set wifi.menu.header
      "${MENU_HEADER[@]}" width="$W"
      label="Known Networks")

    i=0
    while IFS= read -r ssid; do
      [ -z "$ssid" ] && continue
      printf '%s\t%s\n' "$i" "$ssid" >>"$NETS"
      local icon_color="$OVERLAY" label_color="$TEXT"
      # macOS redacts the SSID without location permission; when it is
      # readable, tint the row we're connected to
      if [ -n "$cur" ] && [ "$ssid" = "$cur" ]; then
        icon_color="$SAPPHIRE" label_color="$SAPPHIRE"
      fi
      args+=(--add item "wifi.menu.net.$i" popup.wifi
        --set "wifi.menu.net.$i"
        "${MENU_ROW[@]}" width="$W"
        icon=󰤨 icon.color="$icon_color"
        label="$ssid"
        label.color="$label_color"
        click_script="$PLUGIN join $i"
        --subscribe "wifi.menu.net.$i" mouse.entered mouse.exited)
      i=$((i + 1))
    done <<<"$known"

    args+=(--add item wifi.menu.sep2 popup.wifi
      --set wifi.menu.sep2 "${MENU_SEP[@]}" width="$W" label="$(menu_sep "$maxc")")
    args+=(--add item wifi.menu.scan popup.wifi
      --set wifi.menu.scan
      "${MENU_ROW[@]}" width="$W"
      icon=󰐷 icon.color="$SUBTEXT"
      label="Other Networks…"
      click_script="$PLUGIN scan"
      --subscribe wifi.menu.scan mouse.entered mouse.exited)
  fi

  args+=(--add item wifi.menu.settings popup.wifi
    --set wifi.menu.settings
    "${MENU_ROW[@]}" width="$W"
    icon=󰒓 icon.color="$SUBTEXT"
    label="Wi-Fi Settings…"
    click_script="$PLUGIN settings"
    --subscribe wifi.menu.settings mouse.entered mouse.exited)

  sketchybar "${args[@]}"
}

case "$1" in
  toggle)
    if [ "$(sketchybar --query wifi 2>/dev/null | jq -r '.popup.drawing')" = "on" ]; then
      sketchybar --set wifi popup.drawing=off
      exit 0
    fi
    rebuild
    sketchybar --set wifi popup.drawing=on
    ;;

  power)
    if [ "$(networksetup -getairportpower "$WIFI_IF" 2>/dev/null | awk '{ print $NF }')" = "On" ]; then
      networksetup -setairportpower "$WIFI_IF" off
    else
      networksetup -setairportpower "$WIFI_IF" on
    fi
    rebuild # popup stays open, rows reflect the new state
    refresh_chip
    ;;

  join)
    ssid=$(awk -F'\t' -v i="$2" '$1 == i { st = index($0, "\t"); print substr($0, st + 1); exit }' "$NETS" 2>/dev/null)
    sketchybar --set wifi popup.drawing=off
    [ -z "$ssid" ] && exit 0
    # Known networks join with the keychain password; new ones need System
    # Settings, so fall back to the Wi-Fi pane if networksetup refuses.
    # networksetup prints nothing on success and an error line on failure.
    out=$(networksetup -setairportnetwork "$WIFI_IF" "$ssid" 2>&1)
    if grep -qiE 'failed|could not|error' <<<"$out"; then
      open "x-apple.systempreferences:com.apple.wifi-settings-extension"
    fi
    refresh_chip
    ;;

  scan)
    sketchybar --set wifi.menu.scan label="Scanning…" click_script=""
    others=$(system_profiler SPAirPortDataType -json -timeout 15 2>/dev/null |
      jq -r --arg ifc "$WIFI_IF" '
        .SPAirPortDataType[0].spairport_airport_interfaces[]?
        | select(._name == $ifc)
        | .spairport_airport_other_local_wireless_networks[]?._name' 2>/dev/null |
      sort -fu | head -10)

    if [ -z "$others" ]; then
      sketchybar --set wifi.menu.scan label="No other networks found" click_script="$PLUGIN scan"
      exit 0
    fi

    # Widen every existing row if a found SSID is longer than the menu
    W=$(menu_width "$({ cut -f2- "$NETS"; echo "$others"; } | max_chars)")

    # Insert scan results before the settings row: drop it, append, re-add
    args=(--remove wifi.menu.settings
      --set '/wifi\.menu\..*/' width="$W"
      --set wifi.menu.scan label="Other Networks" click_script="$PLUGIN scan")
    i=$(($(cut -f1 "$NETS" 2>/dev/null | tail -1) + 1))
    while IFS= read -r ssid; do
      [ -z "$ssid" ] && continue
      cut -f2- "$NETS" | grep -qxF "$ssid" && continue # already listed as known
      printf '%s\t%s\n' "$i" "$ssid" >>"$NETS"
      args+=(--add item "wifi.menu.other.$i" popup.wifi
        --set "wifi.menu.other.$i"
        "${MENU_ROW[@]}" width="$W"
        icon=󰤟 icon.color="$OVERLAY"
        label="$ssid"
        click_script="$PLUGIN join $i"
        --subscribe "wifi.menu.other.$i" mouse.entered mouse.exited)
      i=$((i + 1))
    done <<<"$others"

    args+=(--add item wifi.menu.settings popup.wifi
      --set wifi.menu.settings
      "${MENU_ROW[@]}" width="$W"
      icon=󰒓 icon.color="$SUBTEXT"
      label="Wi-Fi Settings…"
      click_script="$PLUGIN settings"
      --subscribe wifi.menu.settings mouse.entered mouse.exited)

    sketchybar "${args[@]}"
    ;;

  settings)
    sketchybar --set wifi popup.drawing=off
    open "x-apple.systempreferences:com.apple.wifi-settings-extension"
    ;;
esac
exit 0
