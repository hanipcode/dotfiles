#!/usr/bin/env bash

cores=$(sysctl -n hw.ncpu)
usage=$(ps -A -o %cpu | awk -v c="$cores" '{ s += $1 } END { printf "%.0f", s / c }')

sketchybar --set "$NAME" label="$usage%"
