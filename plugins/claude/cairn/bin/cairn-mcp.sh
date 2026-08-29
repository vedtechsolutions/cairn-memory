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
    CACHED="$(cat "$CACHE_DIR/plugin-hook-dir" 2>/dev/null || true)"
    # The dir is the LAST |segment; strip it to keep the full bin path
    # even when the bin path itself contains '|' (review).
    CACHED_BIN="${CACHED%|*}"
    [ -n "$CACHED_BIN" ] && [ -x "$CACHED_BIN" ] && BIN="$CACHED_BIN"
  fi
fi
if [ -z "$BIN" ]; then
  # Common install locations, first executable wins.
  for candidate in \
    /usr/local/bin/cairn /opt/homebrew/bin/cairn \
    "${HOME:-/nonexistent}/.local/bin/cairn" \
    "${HOME:-/nonexistent}/.volta/bin/cairn"; do
    if [ -x "$candidate" ]; then BIN="$candidate"; break; fi
  done
fi
if [ -z "$BIN" ] && [ -d "${HOME:-/nonexistent}/.nvm/versions/node" ]; then
  # NEWEST nvm version — glob order is LEXICOGRAPHIC, where v9 sorts
  # after v22 and an abandoned tree would silently win (review,
  # executed: SERVING FROM v9.11.2). sort -V when available; the plain
  # sort fallback is the old imperfect behavior, never worse.
  if sort -V < /dev/null > /dev/null 2>&1; then NVSORT="sort -V"; else NVSORT="sort"; fi
  NEWEST="$(ls "${HOME}/.nvm/versions/node" 2>/dev/null | $NVSORT | tail -1)"
  [ -n "$NEWEST" ] && [ -x "${HOME}/.nvm/versions/node/$NEWEST/bin/cairn" ] \
    && BIN="${HOME}/.nvm/versions/node/$NEWEST/bin/cairn"
fi
[ -n "$BIN" ] || fail "cairn-memory not found on PATH or in common install locations"
# Carry the bin's OWN directory on PATH: the npm bin is '#!/usr/bin/env
# node', and the PATH that failed to contain cairn is node-less too on
# a GUI-launched macOS (review, executed: exit 127). node sits beside
# cairn in every layout above, and this also keeps a version-manager
# install off a foreign system node (native-module ABI).
PATH="$(dirname "$BIN"):$PATH"
export PATH
exec "$BIN" serve
