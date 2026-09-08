#!/usr/bin/env bash
# Now-playing chip and standalone YouTube Music mini-player dispatcher.

BASE_DIR=$(cd "$(dirname "$0")/.." && pwd)
source "$BASE_DIR/colors.sh"
export LC_ALL=en_US.UTF-8

NOWPLAYING=${NOWPLAYING:-nowplaying-cli}
CACHE="$HOME/Library/Caches/hanif-sketchybar"
APP_SOURCE="$BASE_DIR/helpers/youtube_music.swift"
APP_HTML="$BASE_DIR/helpers/youtube_music.html"
APP_BIN="$CACHE/youtube-music"
APP_PID="$CACHE/youtube-music.pid"
COOKIE_FILE="$CACHE/youtube-cookies.txt"
MARQUEE_FILE="$CACHE/youtube-marquee"

app_pid() {
  local pid
  pid=$(cat "$APP_PID" 2>/dev/null)
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && echo "$pid"
}

update() {
  local data title artist rate label icon pid state custom="$CACHE/youtube-now-playing.json"

  pid=$(app_pid)
  if [ -n "$pid" ]; then
    if [ -s "$custom" ]; then
      title=$(jq -r '.title // empty' "$custom" 2>/dev/null)
      artist=$(jq -r '.artist // empty' "$custom" 2>/dev/null)
      state=$(cat "$CACHE/youtube-player-state" 2>/dev/null)
      if [ -n "$title" ]; then
        label="$title"
        [ -n "$artist" ] && label="$title · $artist"
        if [ "$state" = "PLAYING" ]; then icon=󰏤; else icon=󰐊; fi
        set_chip "$label" "$icon"
        return
      fi
    fi
    set_chip "Nothing playing" 󰐊
    return
  fi

  if ! command -v "$NOWPLAYING" >/dev/null 2>&1; then
    set_chip "Install nowplaying-cli" 󰐊
    return
  fi

  data=$($NOWPLAYING get --json title artist playbackRate 2>/dev/null)
  title=$(jq -r '.title // empty' <<<"$data" 2>/dev/null)
  artist=$(jq -r '.artist // empty' <<<"$data" 2>/dev/null)
  rate=$(jq -r '.playbackRate // 0' <<<"$data" 2>/dev/null)

  if [ -z "$title" ]; then
    set_chip "Nothing playing" 󰐊
    return
  fi

  label="$title"
  [ -n "$artist" ] && label="$title · $artist"
  if awk "BEGIN { exit !($rate > 0) }"; then icon=󰏤; else icon=󰐊; fi
  set_chip "$label" "$icon"
}

set_chip() {
  local text="$1" icon="$2" limit=26 old offset padded doubled shown
  text=${text//$'\n'/ }
  if [ "${#text}" -le "$limit" ]; then
    shown="$text"
    printf '0\n%s' "$text" >"$MARQUEE_FILE"
  else
    old=$(tail -n +2 "$MARQUEE_FILE" 2>/dev/null)
    offset=$(head -1 "$MARQUEE_FILE" 2>/dev/null)
    case "$offset" in ''|*[!0-9]*) offset=0 ;; esac
    if [ "$old" != "$text" ]; then offset=0; else offset=$((offset + 1)); fi
    padded="$text   •   "
    [ "$offset" -ge "${#padded}" ] && offset=0
    doubled="$padded$padded"
    shown=${doubled:$offset:$limit}
    printf '%s\n%s' "$offset" "$text" >"$MARQUEE_FILE"
  fi
  sketchybar --set media.title label="$shown" --set media.play icon="$icon"
}

build_app() {
  mkdir -p "$CACHE"
  if [ ! -x "$APP_BIN" ] || [ "$APP_SOURCE" -nt "$APP_BIN" ]; then
    sketchybar --set media.title label="Building Music…"
    swiftc -parse-as-library -O -framework Cocoa -framework WebKit \
      "$APP_SOURCE" -o "$APP_BIN" || {
      sketchybar --set media.title label="Music build failed"
      return 1
    }
  fi
}

refresh_cookies() {
  local all_cookies="$CACHE/youtube-cookies.all.$$"
  if [ -s "$COOKIE_FILE" ] && [ -z "$(find "$COOKIE_FILE" -mmin +60 -print 2>/dev/null)" ]; then
    return
  fi
  command -v yt-dlp >/dev/null 2>&1 || return
  yt-dlp --cookies-from-browser chrome --cookies "$all_cookies" \
    --skip-download --no-warnings "https://www.youtube.com/watch?v=dQw4w9WgXcQ" \
    >/dev/null 2>&1 || {
    rm -f "$all_cookies"
    return
  }
  {
    echo '# Netscape HTTP Cookie File'
    awk -F'\t' '$1 ~ /(^#HttpOnly_)?\.?youtube\.com$/ { print }' "$all_cookies"
  } >"$COOKIE_FILE"
  chmod 600 "$COOKIE_FILE"
  rm -f "$all_cookies"
}

open_app() {
  local pid
  pid=$(app_pid)
  if [ -n "$pid" ]; then
    kill -USR1 "$pid"
  else
    build_app || return
    refresh_cookies
    nohup "$APP_BIN" "$APP_HTML" "$COOKIE_FILE" >/dev/null 2>&1 &
    echo $! >"$APP_PID"
    update
  fi
}

case "$1" in
  update) update ;;
  playback)
    pid=$(app_pid)
    if [ -n "$pid" ]; then
      if [ "${BUTTON:-left}" = "right" ]; then kill -INFO "$pid"; else kill -USR2 "$pid"; fi
    elif [ "${BUTTON:-left}" = "right" ]; then
      "$NOWPLAYING" next >/dev/null 2>&1
    else
      "$NOWPLAYING" togglePlayPause >/dev/null 2>&1
    fi
    sleep 0.2
    update
    ;;
  previous)
    pid=$(app_pid)
    if [ -n "$pid" ]; then kill -WINCH "$pid"; else "$NOWPLAYING" previous >/dev/null 2>&1; fi
    ;;
  next)
    pid=$(app_pid)
    if [ -n "$pid" ]; then kill -INFO "$pid"; else "$NOWPLAYING" next >/dev/null 2>&1; fi
    ;;
  popup) open_app ;;
esac

exit 0
