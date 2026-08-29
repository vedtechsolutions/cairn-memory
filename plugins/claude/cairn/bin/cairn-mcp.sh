#!/bin/sh
# Cairn thin-plugin MCP launcher: find the npm-installed cairn-memory
# and exec `cairn serve` — WITHOUT requiring `cairn` on the launching
# app's PATH (GUI-launched agents never sourced nvm/volta init; a login
# shell was rejected because profile stdout corrupts the MCP handshake).
# stdout stays protocol-pure: this script writes nothing to it.
set -u
fail() { echo "cairn plugin: $1 (npm install -g cairn-memory)" >&2; exit 1; }
BIN="$(command -v cairn || true)"
if [ -z "$BIN" ]; then
  # The hook launcher's cache records the bin it resolved (identity-keyed).
  CACHE_DIR="${CLAUDE_PLUGIN_DATA:-${HOME:+$HOME/.cairn}}"
  if [ -n "$CACHE_DIR" ] && [ -f "$CACHE_DIR/plugin-hook-dir" ]; then
    CACHED_BIN="$(cut -d'|' -f1 "$CACHE_DIR/plugin-hook-dir" 2>/dev/null || true)"
    [ -n "$CACHED_BIN" ] && [ -x "$CACHED_BIN" ] && BIN="$CACHED_BIN"
  fi
fi
if [ -z "$BIN" ]; then
  # Common install locations, newest nvm last wins.
  for candidate in \
    /usr/local/bin/cairn /opt/homebrew/bin/cairn \
    "${HOME:-/nonexistent}/.local/bin/cairn" \
    "${HOME:-/nonexistent}/.volta/bin/cairn" \
    "${HOME:-/nonexistent}"/.nvm/versions/node/*/bin/cairn; do
    [ -x "$candidate" ] && BIN="$candidate"
  done
fi
[ -n "$BIN" ] || fail "cairn-memory not found on PATH or in common install locations"
exec "$BIN" serve
