#!/bin/sh
# Cairn thin-plugin launcher: locate the npm-installed cairn-memory
# package and exec its hook relay (compiled binary when runnable, shell
# relay otherwise). With --node <script>, exec the node-form hook. The
# plugin ships NO runtime — this script only finds the one install.
#
# Resolution order (result cached, revalidated on every run):
#   1. cached hook dir (still valid)
#   2. `cairn` bin symlink chain + package-layout suffix (classic npm)
#   3. `cairn locate hook-dir` — the CLI reports its own install; this
#      covers executable SHIMS (Volta, pnpm shim scripts) that are not
#      symlinks at all (review: suffix-strip alone silently no-opped
#      every hook on those layouts)
set -u
fail() {
  # A missing/broken install must not break the host agent's hook
  # pipeline: say why on stderr (hook debug output; `cairn doctor`
  # diagnoses the same condition loudly) and exit 0 as a no-op.
  echo "cairn plugin: $1 (npm install -g cairn-memory, then: cairn init)" >&2
  exit 0
}
# NEVER a world-writable fallback: with no HOME and no plugin-data dir
# there is NO cache — a /tmp cache let any local user plant a path and
# have the next hook exec it (review, demonstrated).
CACHE_DIR="${CLAUDE_PLUGIN_DATA:-${HOME:+$HOME/.cairn}}"
CACHE="${CACHE_DIR:+$CACHE_DIR/plugin-hook-dir}"
BIN="$(command -v cairn || true)"
[ -n "$BIN" ] || fail "cairn-memory is not installed or not on PATH"
HOOK_DIR=""
if [ -n "$CACHE" ] && [ -f "$CACHE" ]; then
  # Cache line: "<bin-path>|<hook-dir>". IDENTITY-validated, not just
  # existence-validated: after an nvm/Volta switch the old tree usually
  # still EXISTS, so an existence check would run outdated hooks
  # forever (review). The recorded bin must equal the current one.
  CACHED="$(cat "$CACHE" 2>/dev/null || true)"
  case "$CACHED" in
    "$BIN|"*)
      HOOK_DIR="${CACHED#*|}"
      [ -n "$HOOK_DIR" ] && [ -f "$HOOK_DIR/hook-relay.sh" ] || HOOK_DIR=""
      ;;
  esac
fi
if [ -z "$HOOK_DIR" ]; then
  TARGET="$BIN"
  HOPS=0
  while [ -L "$TARGET" ] && [ "$HOPS" -lt 40 ]; do
    LINK="$(readlink "$TARGET")"
    case "$LINK" in
      /*) TARGET="$LINK" ;;
      *) TARGET="$(dirname "$TARGET")/$LINK" ;;
    esac
    HOPS=$((HOPS + 1))
  done
  [ "$HOPS" -lt 40 ] || fail "the cairn bin symlink chain does not terminate"
  CANDIDATE="${TARGET%/dist/src/cli/index.js}/dist/src/hooks"
  if [ -f "$CANDIDATE/hook-relay.sh" ]; then
    HOOK_DIR="$CANDIDATE"
  else
    HOOK_DIR="$(cairn locate hook-dir 2>/dev/null || true)"
    [ -n "$HOOK_DIR" ] && [ -f "$HOOK_DIR/hook-relay.sh" ] || fail "could not locate the cairn-memory install"
  fi
  if [ -n "$CACHE" ]; then
    mkdir -p "$CACHE_DIR" 2>/dev/null || true
    printf '%s|%s\n' "$BIN" "$HOOK_DIR" > "$CACHE" 2>/dev/null || true
  fi
fi
if [ "${1:-}" = "--node" ]; then
  shift
  [ "$#" -ge 1 ] || fail "--node requires a hook script name"
  command -v node > /dev/null 2>&1 || fail "node is not on PATH"
  [ -f "$HOOK_DIR/$1" ] || fail "hook script missing: $1"
  exec node "$HOOK_DIR/$1"
fi
if [ -x "$HOOK_DIR/hook-relay" ] && [ "$("$HOOK_DIR/hook-relay" --cairn-probe < /dev/null 2>/dev/null || true)" = "cairn-relay" ]; then
  exec "$HOOK_DIR/hook-relay" "$@"
fi
exec "$HOOK_DIR/hook-relay.sh" "$@"
