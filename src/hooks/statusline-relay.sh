#!/usr/bin/env bash
# StatusLine relay — ultra-lightweight curl to daemon.
# Falls back to minimal display if daemon is unavailable.
# NEVER falls back to node cold-start (too expensive for status line).
SCRIPT_DIR="${0%/*}"
# shellcheck source=/dev/null
if [ -r "$SCRIPT_DIR/identity.sh" ]; then
  . "$SCRIPT_DIR/identity.sh"
else
  exit 0
fi
SOCK="$HOME/$WK_DATA_DIR/$WK_SOCKET_FILE"
INPUT=$(cat)

if [ -S "$SOCK" ]; then
  RESULT=$(printf '%s' "$INPUT" | curl -sf --max-time 1 --unix-socket "$SOCK" "http://localhost/statusline" -H "Content-Type: application/json" -d @- 2>/dev/null)
  if [ $? -eq 0 ] && [ -n "$RESULT" ]; then
    printf '%s' "$RESULT"
    exit 0
  fi
fi

# Minimal fallback — no node, no DB, just show something
printf 'Waykeep: ready'
