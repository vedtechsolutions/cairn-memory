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
  # USER-MANAGED installs beat system copies — a stale /usr/local copy
  # displacing the volta/npm-managed one is the split-brain class this
  # launcher exists to avoid (review).
  for candidate in \
    "${HOME:-/nonexistent}/.volta/bin/cairn" \
    "${HOME:-/nonexistent}/.local/bin/cairn" \
    /opt/homebrew/bin/cairn /usr/local/bin/cairn; do
    if [ -x "$candidate" ]; then BIN="$candidate"; break; fi
  done
fi
if [ -z "$BIN" ] && [ -d "${HOME:-/nonexistent}/.nvm/versions/node" ]; then
  # Newest→oldest, FIRST version that actually HAS cairn: glob order is
  # LEXICOGRAPHIC (v9 sorted after v22 — an abandoned tree served an
  # outdated install; review, executed), and checking only the newest
  # DIRECTORY hid a valid older install behind a fresh node without
  # cairn (both reviewers). sort -rV when available; the plain reverse
  # sort fallback still finds A cairn, at worst an older one.
  if sort -rV < /dev/null > /dev/null 2>&1; then NVSORT="sort -rV"; else NVSORT="sort -r"; fi
  for version in $(ls "${HOME}/.nvm/versions/node" 2>/dev/null | $NVSORT); do
    if [ -x "${HOME}/.nvm/versions/node/$version/bin/cairn" ]; then
      BIN="${HOME}/.nvm/versions/node/$version/bin/cairn"
      break
    fi
  done
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
