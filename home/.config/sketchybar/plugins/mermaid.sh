#!/usr/bin/env bash
# Build and toggle the standalone Mermaid diagram viewer.

BASE_DIR=$(cd "$(dirname "$0")/.." && pwd)
CACHE="$HOME/Library/Caches/hanif-sketchybar"
APP_SOURCE="$BASE_DIR/helpers/mermaid_viewer.swift"
APP_PLIST="$BASE_DIR/helpers/mermaid_viewer.plist"
APP_HTML="$BASE_DIR/helpers/mermaid_viewer.html"
APP_SCRIPT="$BASE_DIR/helpers/mermaid.min.js"
APP_MERMAN="$BASE_DIR/helpers/merman.min.js"
APP_DATABASE="$BASE_DIR/helpers/database-renderer.min.js"
APP_BUNDLE="$CACHE/Mermaid Studio.app"
APP_BIN="$APP_BUNDLE/Contents/MacOS/mermaid-viewer"
APP_RESOURCES="$APP_BUNDLE/Contents/Resources"
APP_PID="$CACHE/mermaid-viewer.pid"

app_pid() {
  local pid
  pid=$(cat "$APP_PID" 2>/dev/null)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    echo "$pid"
    return
  fi
  pgrep -f "$APP_BIN" | head -1
}

build_app() {
  mkdir -p "$APP_BUNDLE/Contents/MacOS" "$APP_RESOURCES"
  if [ ! -x "$APP_BIN" ] || [ "$APP_SOURCE" -nt "$APP_BIN" ] || [ "$APP_PLIST" -nt "$APP_BIN" ] || [ "$APP_HTML" -nt "$APP_BIN" ] || [ "$APP_SCRIPT" -nt "$APP_BIN" ] || [ "$APP_MERMAN" -nt "$APP_BIN" ] || [ "$APP_DATABASE" -nt "$APP_BIN" ]; then
    sketchybar --set mermaid icon.color=0xffeed49f
    swiftc -parse-as-library -O -framework Cocoa -framework WebKit \
      "$APP_SOURCE" -o "$APP_BIN" || {
      sketchybar --set mermaid icon.color=0xffed8796
      return 1
    }
    cp "$APP_PLIST" "$APP_BUNDLE/Contents/Info.plist"
    cp "$APP_HTML" "$APP_RESOURCES/mermaid_viewer.html"
    cp "$APP_SCRIPT" "$APP_RESOURCES/mermaid.min.js"
    cp "$APP_MERMAN" "$APP_RESOURCES/merman.min.js"
    cp "$APP_DATABASE" "$APP_RESOURCES/database-renderer.min.js"
    codesign --force --deep --sign - "$APP_BUNDLE" >/dev/null 2>&1 || return 1
    /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
      -f "$APP_BUNDLE"
    sketchybar --set mermaid icon.color=0xffc6a0f6
  fi
}

toggle() {
  local pid
  build_app || return
  pid=$(app_pid)
  if [ -n "$pid" ]; then
    kill -USR1 "$pid"
    return
  fi

  open "$APP_BUNDLE"
}

case "$1" in
  toggle) toggle ;;
esac
