#!/bin/sh
# Cairn thin-plugin launcher: locate the npm-installed cairn-memory package
# from the `cairn` bin on PATH and exec its hook relay (compiled binary when
# runnable, shell relay otherwise). With --node <script>, exec the node-form
# hook instead. The plugin ships NO runtime — cairn-memory from npm is the
# one install; this script only finds it, so hook commands stay stable
# across machines and package upgrades.
set -u
fail() {
  # A missing install must not break the host agent's hook pipeline: say
  # why on stderr (visible in hook debug output; `cairn doctor` diagnoses
  # the same condition loudly) and exit 0 as a no-op.
  echo "cairn plugin: $1 (npm install -g cairn-memory, then: cairn init)" >&2
  exit 0
}
BIN="$(command -v cairn || true)"
[ -n "$BIN" ] || fail "cairn-memory is not installed or not on PATH"
TARGET="$BIN"
while [ -L "$TARGET" ]; do
  LINK="$(readlink "$TARGET")"
  case "$LINK" in
    /*) TARGET="$LINK" ;;
    *) TARGET="$(dirname "$TARGET")/$LINK" ;;
  esac
done
PKG_ROOT="${TARGET%/dist/src/cli/index.js}"
HOOK_DIR="$PKG_ROOT/dist/src/hooks"
[ -d "$HOOK_DIR" ] || fail "resolved install has no hook dir ($HOOK_DIR)"
if [ "${1:-}" = "--node" ]; then
  shift
  exec node "$HOOK_DIR/$1"
fi
if [ -x "$HOOK_DIR/hook-relay" ] && [ "$("$HOOK_DIR/hook-relay" --cairn-probe < /dev/null 2>/dev/null || true)" = "cairn-relay" ]; then
  exec "$HOOK_DIR/hook-relay" "$@"
fi
exec "$HOOK_DIR/hook-relay.sh" "$@"
