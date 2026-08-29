#!/bin/sh
# Waykeep thin-plugin MCP launcher: find the npm-installed waykeep
# package and exec `serve` — WITHOUT requiring the bin on the launching
# app's PATH (GUI-launched agents never sourced nvm/volta init; a login
# shell was rejected because profile stdout corrupts the MCP handshake).
# stdout stays protocol-pure: this script writes nothing to it.
# `waykeep` is preferred over the legacy `cairn` alias everywhere below
# so a leftover cairn-memory install can never displace the current one.
set -u
fail() { echo "waykeep plugin: $1 (npm install -g waykeep)" >&2; exit 1; }
BIN="$(command -v waykeep || command -v cairn || true)"
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
  for dir in \
    "${HOME:-/nonexistent}/.volta/bin" \
    "${HOME:-/nonexistent}/.local/bin" \
    /opt/homebrew/bin /usr/local/bin; do
    for name in waykeep cairn; do
      if [ -x "$dir/$name" ]; then BIN="$dir/$name"; break 2; fi
    done
  done
fi
if [ -z "$BIN" ] && [ -d "${HOME:-/nonexistent}/.nvm/versions/node" ]; then
  # Newest→oldest, FIRST version that actually HAS the bin: glob order is
  # LEXICOGRAPHIC (v9 sorted after v22 — an abandoned tree served an
  # outdated install; review, executed), and checking only the newest
  # DIRECTORY hid a valid older install behind a fresh node without
  # the bin (both reviewers). sort -rV when available; the plain reverse
  # sort fallback still finds AN install, at worst an older one.
  if sort -rV < /dev/null > /dev/null 2>&1; then NVSORT="sort -rV"; else NVSORT="sort -r"; fi
  for version in $(ls "${HOME}/.nvm/versions/node" 2>/dev/null | $NVSORT); do
    for name in waykeep cairn; do
      if [ -x "${HOME}/.nvm/versions/node/$version/bin/$name" ]; then
        BIN="${HOME}/.nvm/versions/node/$version/bin/$name"
        break 2
      fi
    done
  done
fi
[ -n "$BIN" ] || fail "waykeep not found on PATH or in common install locations"
# Carry the bin's OWN directory on PATH: the npm bin is '#!/usr/bin/env
# node', and the PATH that failed to contain cairn is node-less too on
# a GUI-launched macOS (review, executed: exit 127). node sits beside
# cairn in every layout above, and this also keeps a version-manager
# install off a foreign system node (native-module ABI).
PATH="$(dirname "$BIN"):$PATH"
export PATH
exec "$BIN" serve
