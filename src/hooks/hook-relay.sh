#!/usr/bin/env bash
# Cairn Hook Relay — thin client for the hook socket (embedded in MCP server).
# Fire-and-forget for async hooks; waits for response on sync hooks.
# Usage: bash /opt/cairn/dist/src/hooks/hook-relay.sh [--client <name>] <hook-type>

SOCK="$HOME/.cairn/hook-daemon.sock"

# Optional declared client identity (codex, …). Forwarded as a header on the
# socket path and as CAIRN_CLIENT env on direct-node paths; claude when absent.
CLIENT=""
if [ "$1" = "--client" ] && [ -n "$2" ]; then
  CLIENT="$2"
  shift 2
fi
CLIENT_HDR=()
[ -n "$CLIENT" ] && CLIENT_HDR=(-H "X-Cairn-Client: $CLIENT")

HOOK_TYPE="$1"
SCRIPT_DIR="${0%/*}"

# Buffer stdin to a temp file (M1): a shell variable strips NUL bytes and
# trailing newlines while double-buffering up to 256 KB in memory; a file
# preserves the exact bytes and lets the fallback replay the same input
# after a failed socket attempt. curl must use --data-binary — plain -d
# strips newlines from the payload.
INPUT_FILE=$(mktemp "${TMPDIR:-/tmp}/cairn-hook-XXXXXX") || exit 0
trap 'rm -f "$INPUT_FILE"' EXIT
cat > "$INPUT_FILE"

# Sync hooks that need a response (Claude Code waits for these). Must match the
# hooks the config registers WITHOUT an async flag — prompt-check and
# pitfall-check inject context/warnings the model consumes, so their response
# must be waited for and printed, never fire-and-forget.
SYNC_HOOKS="plan-bridge subagent-context postcompact session-start governance-gate prompt-check pitfall-check"
STANDALONE_HOOKS="precompact session-end"

is_sync() {
  for h in $SYNC_HOOKS; do [ "$h" = "$1" ] && return 0; done
  return 1
}

is_standalone() {
  for h in $STANDALONE_HOOKS; do [ "$h" = "$1" ] && return 0; done
  return 1
}

if is_standalone "$HOOK_TYPE"; then
  CAIRN_CLIENT="$CLIENT" node "$SCRIPT_DIR/$HOOK_TYPE.js" < "$INPUT_FILE"
  exit 0
fi

if [ -S "$SOCK" ]; then
  if is_sync "$HOOK_TYPE"; then
    # Sync: wait for response, return it
    MAX_TIME=3
    [ "$HOOK_TYPE" = "governance-gate" ] && MAX_TIME=0.4
    RESULT=$(curl -sf --max-time "$MAX_TIME" --unix-socket "$SOCK" "http://localhost/$HOOK_TYPE" -H "Content-Type: application/json" "${CLIENT_HDR[@]}" --data-binary @"$INPUT_FILE" 2>/dev/null)
    if [ $? -eq 0 ]; then
      if [ "$HOOK_TYPE" = "governance-gate" ]; then
        case "$RESULT" in
          *'"decision"'*) ;;
          '{"systemMessage":"'*'"}') printf '%s' "$RESULT" ;;
        esac
      else
        [ -n "$RESULT" ] && printf '%s' "$RESULT"
      fi
      exit 0
    fi
  else
    # Async: fire and forget. The subshell owns the temp file's lifetime —
    # the EXIT trap would otherwise race the backgrounded curl's open().
    # A 404 from a stale daemon that predates this route (curl exit 22)
    # or a refused connection (exit 7) would otherwise be a SILENT capture
    # loss — fall back to direct node. A timeout (exit 28) does NOT fall
    # back: the daemon may have processed the event (same policy as the
    # compiled relay's empty-response case).
    trap - EXIT
    (
      curl -sf --max-time 3 --unix-socket "$SOCK" "http://localhost/$HOOK_TYPE" -H "Content-Type: application/json" "${CLIENT_HDR[@]}" --data-binary @"$INPUT_FILE" >/dev/null 2>&1
      case "$?" in
        7|22) CAIRN_CLIENT="$CLIENT" node "$SCRIPT_DIR/$HOOK_TYPE.js" < "$INPUT_FILE" >/dev/null 2>&1 ;;
      esac
      rm -f "$INPUT_FILE"
    ) &
    exit 0
  fi
fi

# Socket missing — MCP server not yet started or restarting.
# Don't spawn standalone daemon; the MCP server owns the socket now.
# Sync hooks fall back to direct Node.js; async hooks do the same in the
# background (capture must not vanish just because the daemon is down).
if is_sync "$HOOK_TYPE"; then
  [ "$HOOK_TYPE" != "governance-gate" ] && CAIRN_CLIENT="$CLIENT" node "$SCRIPT_DIR/$HOOK_TYPE.js" < "$INPUT_FILE"
else
  trap - EXIT
  (
    CAIRN_CLIENT="$CLIENT" node "$SCRIPT_DIR/$HOOK_TYPE.js" < "$INPUT_FILE" >/dev/null 2>&1
    rm -f "$INPUT_FILE"
  ) &
fi
