#!/usr/bin/env bash
# Agent-status section (center of the bar). Chips are created dynamically by
# plugins/agents.sh; this only registers the event and the hidden updater.

sketchybar --add event agents_update

sketchybar --add item agents_anchor center \
  --set agents_anchor \
    drawing=off \
    updates=on \
    update_freq=15 \
    script="$PLUGIN_DIR/agents.sh" \
  --subscribe agents_anchor agents_update system_woke
