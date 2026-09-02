#!/bin/sh
# Waykeep thin-plugin launcher: locate the npm-installed waykeep
# package and exec its hook relay (compiled binary when runnable, shell
# relay otherwise). With --node <script>, exec the node-form hook. The
# plugin ships NO runtime — this script only finds the one install.
# `waykeep` is preferred over the legacy `cairn` alias so a leftover
# cairn-memory install can never displace the current one.
#
# Resolution order (result cached, revalidated on every run):
#   1. cached hook dir (still valid)
#   2. bin symlink chain + package-layout suffix (classic npm)
#   3. `locate hook-dir` via the resolved bin — the CLI reports its own
#      install; this covers executable SHIMS (Volta, pnpm shim scripts)
#      that are not symlinks at all (review: suffix-strip alone silently
#      no-opped every hook on those layouts)
set -u
# SECURITY: never derive a cache/hook dir from a RELATIVE HOME — a planted
# `<cwd>/.waykeep/plugin-hook-dir` in an untrusted project could redirect
# execution to an attacker-controlled hook directory or executable. Resolve the
# passwd home when HOME is not absolute; if that fails, drop HOME so no
# CWD-relative cache is ever used (codex B1 review).
case "${HOME:-}" in
  /*) : ;;
  *)
    _wk_u="$(id -un 2>/dev/null)"
    _wk_h=""
    [ -n "$_wk_u" ] && eval "_wk_h=~$_wk_u" 2>/dev/null
    case "${_wk_h:-}" in /*) HOME="$_wk_h" ;; *) HOME="" ;; esac
    export HOME
    ;;
esac
fail() {
  # A missing/broken install must not break the host agent's hook
  # pipeline: say why on stderr (hook debug output; `waykeep doctor`
  # diagnoses the same condition loudly) and exit 0 as a no-op.
  echo "waykeep plugin: $1 (npm install -g waykeep, then: waykeep init)" >&2
  exit 0
}
# NEVER a world-writable fallback: with no HOME and no plugin-data dir
# there is NO cache — a /tmp cache let any local user plant a path and
# have the next hook exec it (review, demonstrated).
# Cache dir mirrors resolveStateRoot(): the current dir is authoritative
# only with the migration marker; otherwise an EXISTING legacy DB FILE
# wins (un-migrated window); otherwise current. NEVER mkdir the legacy dir
# for a fresh install — that would define the store under the retired name.
if [ -n "${CLAUDE_PLUGIN_DATA:-}" ]; then
  CACHE_DIR="$CLAUDE_PLUGIN_DATA"
elif [ -n "${HOME:-}" ] && [ ! -f "$HOME/.waykeep/waykeep-migrated.json" ] \
     && [ -f "$HOME/.cairn/cairn.db" ]; then
  CACHE_DIR="$HOME/.cairn"
elif [ -n "${HOME:-}" ]; then
  CACHE_DIR="$HOME/.waykeep"
else
  CACHE_DIR=""
fi
CACHE="${CACHE_DIR:+$CACHE_DIR/plugin-hook-dir}"
BIN="$(command -v waykeep || command -v cairn || true)"
[ -n "$BIN" ] || fail "waykeep is not installed or not on PATH"
HOOK_DIR=""
if [ -n "$CACHE" ] && [ -f "$CACHE" ]; then
  # Cache line: "<bin-path>|<hook-dir>". IDENTITY-validated, not just
  # existence-validated: after an nvm/Volta switch the old tree usually
  # still EXISTS, so an existence check would run outdated hooks
  # forever (review). The recorded bin must equal the current one.
  CACHED="$(cat "$CACHE" 2>/dev/null || true)"
  case "$CACHED" in
    "$BIN|"*)
      # Exact-prefix strip, not first-pipe split — a bin path containing
      # '|' must not shear the recorded dir (review).
      HOOK_DIR="${CACHED#"$BIN|"}"
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
  [ "$HOPS" -lt 40 ] || fail "the waykeep bin symlink chain does not terminate"
  CANDIDATE="${TARGET%/dist/src/cli/index.js}/dist/src/hooks"
  if [ -f "$CANDIDATE/hook-relay.sh" ]; then
    HOOK_DIR="$CANDIDATE"
  else
    HOOK_DIR="$("$BIN" locate hook-dir 2>/dev/null || true)"
    [ -n "$HOOK_DIR" ] && [ -f "$HOOK_DIR/hook-relay.sh" ] || fail "could not locate the waykeep install"
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
# Probe values are generated beside the binary (dist/src/hooks/identity.sh).
# They MUST come from there: if this launcher and the relay disagree on the
# handshake, the probe silently fails and every hook falls back to the slower
# shell relay with nothing reporting it.
WK_PROBE_FLAG=""; WK_PROBE_SENTINEL=""
# shellcheck source=/dev/null
[ -r "$HOOK_DIR/identity.sh" ] && . "$HOOK_DIR/identity.sh"
if [ -n "$WK_PROBE_FLAG" ] && [ -x "$HOOK_DIR/hook-relay" ] \
   && [ "$("$HOOK_DIR/hook-relay" "$WK_PROBE_FLAG" < /dev/null 2>/dev/null || true)" = "$WK_PROBE_SENTINEL" ]; then
  exec "$HOOK_DIR/hook-relay" "$@"
fi
exec "$HOOK_DIR/hook-relay.sh" "$@"
