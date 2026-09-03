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
# Resolve the authoritative socket the SAME marker-aware way as
# resolveStateRoot()/hook-relay.sh (Phase B): the DIR override FIRST (current
# name, else legacy CAIRN_DIR) — it needs no HOME, so an explicit dir works even
# with an unresolvable HOME (container, unmapped uid); else current when the
# migration marker exists; else an existing legacy store; else current. -f
# mirrors resolveStateRoot's isFile. Removed with the legacy namespace at Phase D.
DIR_OVERRIDE="$(printenv "$WK_ENV_DIR" 2>/dev/null || true)"
[ -z "$DIR_OVERRIDE" ] && DIR_OVERRIDE="$(printenv "$WK_LEGACY_ENV_DIR" 2>/dev/null || true)"
if [ -n "$DIR_OVERRIDE" ]; then
  SOCK="$DIR_OVERRIDE/$WK_SOCKET_FILE"
else
  # No override: the socket lives under HOME, so resolve the passwd home when
  # HOME is not absolute (mirrors robustHomedir); if it still cannot be made
  # absolute, print the minimal status and stop rather than probe a CWD-relative
  # socket that misses the daemon (codex B1 review).
  case "${HOME:-}" in
    /*) : ;;
    *)
      _wk_u="$(id -un 2>/dev/null)"
      _wk_h=""
      [ -n "$_wk_u" ] && eval "_wk_h=~$_wk_u" 2>/dev/null
      case "${_wk_h:-}" in /*) HOME="$_wk_h"; export HOME ;; esac
      ;;
  esac
  case "${HOME:-}" in /*) : ;; *) printf 'Waykeep: ready'; exit 0 ;; esac
  if [ -f "$HOME/$WK_DATA_DIR/$WK_MIGRATION_MARKER" ]; then
    SOCK="$HOME/$WK_DATA_DIR/$WK_SOCKET_FILE"
  elif [ -f "$HOME/$WK_LEGACY_DATA_DIR/$WK_LEGACY_DB_FILE" ]; then
    SOCK="$HOME/$WK_LEGACY_DATA_DIR/$WK_SOCKET_FILE"
  else
    SOCK="$HOME/$WK_DATA_DIR/$WK_SOCKET_FILE"
  fi
fi
INPUT=$(cat)

# The route comes from identity.sh (one spelling shared with the server). A
# stale identity.sh — a partial rebuild that copied this relay beside an old
# one — would post to the bare root and be 404'd every refresh; take the
# minimal fallback outright instead (Codex review).
if [ -S "$SOCK" ] && [ -n "${WK_ROUTE_STATUSLINE:-}" ]; then
  RESULT=$(printf '%s' "$INPUT" | curl -sf --max-time 1 --unix-socket "$SOCK" "http://localhost$WK_ROUTE_STATUSLINE" -H "Content-Type: application/json" -d @- 2>/dev/null)
  if [ $? -eq 0 ] && [ -n "$RESULT" ]; then
    printf '%s' "$RESULT"
    exit 0
  fi
fi

# Minimal fallback — no node, no DB, just show something
printf 'Waykeep: ready'
