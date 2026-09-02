#!/usr/bin/env bash
# Waykeep Hook Relay — thin client for the hook socket (embedded in MCP server).
# Fire-and-forget for async hooks; waits for response on sync hooks.
# Usage: bash /opt/cairn/dist/src/hooks/hook-relay.sh [--client <name>] <hook-type>

SCRIPT_DIR="${0%/*}"

# Namespace-derived names. This script ships beside identity.sh (written by
# scripts/gen-identity.mjs); without it we cannot know the socket path, so we
# fail open the way every other error path here does rather than guess.
# shellcheck source=/dev/null
if [ -r "$SCRIPT_DIR/identity.sh" ]; then
  . "$SCRIPT_DIR/identity.sh"
else
  exit 0
fi

SOCK="$HOME/$WK_DATA_DIR/$WK_SOCKET_FILE"

# Optional declared client identity (codex, …). Forwarded as a header on the
# socket path and as the client env var on direct-node paths; claude when absent.
CLIENT=""
if [ "$1" = "--client" ] && [ -n "$2" ]; then
  CLIENT="$2"
  shift 2
fi
CLIENT_HDR=()
[ -n "$CLIENT" ] && CLIENT_HDR=(-H "$WK_CLIENT_HEADER: $CLIENT")

HOOK_TYPE="$1"

# Buffer stdin to a temp file (M1): a shell variable strips NUL bytes and
# trailing newlines while double-buffering up to 256 KB in memory; a file
# preserves the exact bytes and lets the fallback replay the same input
# after a failed socket attempt. curl must use --data-binary — plain -d
# strips newlines from the payload.
INPUT_FILE=$(mktemp "${TMPDIR:-/tmp}/${WK_TMP_PREFIX}-XXXXXX") || exit 0
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
  env "$WK_ENV_CLIENT=$CLIENT" node "$SCRIPT_DIR/$HOOK_TYPE.js" < "$INPUT_FILE"
  exit 0
fi

if [ -S "$SOCK" ]; then
  if is_sync "$HOOK_TYPE"; then
    # Sync: wait for response, return it
    MAX_TIME=3
    [ "$HOOK_TYPE" = "governance-gate" ] && MAX_TIME=0.4
    RESULT=$(curl -sf --max-time "$MAX_TIME" --unix-socket "$SOCK" "http://localhost/$HOOK_TYPE" -H "Content-Type: application/json" "${CLIENT_HDR[@]}" --data-binary @"$INPUT_FILE" 2>/dev/null)
    CURL_RC=$?
    # Timeout (28) must NOT fall through to the direct-node rerun below:
    # the daemon may have processed the event (side effects landed) and a
    # rerun double-counts everything — same policy as the C relay's
    # empty-response case and this file's own async branch. The response
    # is lost either way; losing it once is the honest outcome.
    [ "$CURL_RC" = "28" ] && exit 0
    if [ "$CURL_RC" -eq 0 ]; then
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
    # Fall back to direct node ONLY on definite non-processing failures:
    # a refused connection (curl exit 7) or a 404/410 from a stale daemon
    # that predates this route — a SILENT capture loss otherwise. A 5xx or
    # a timeout does NOT fall back: the handler may have mutated state
    # before failing, and a re-run could double-process (the demux handler
    # also dedups on tool_use_id as a second line of defense).
    trap - EXIT
    (
      HTTP_CODE=$(curl -s --max-time 3 --unix-socket "$SOCK" "http://localhost/$HOOK_TYPE" -H "Content-Type: application/json" "${CLIENT_HDR[@]}" --data-binary @"$INPUT_FILE" -o /dev/null -w '%{http_code}' 2>/dev/null)
      if [ "$?" = "7" ] || [ "$HTTP_CODE" = "404" ] || [ "$HTTP_CODE" = "410" ]; then
        env "$WK_ENV_CLIENT=$CLIENT" node "$SCRIPT_DIR/$HOOK_TYPE.js" < "$INPUT_FILE" >/dev/null 2>&1
      fi
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
  [ "$HOOK_TYPE" != "governance-gate" ] && env "$WK_ENV_CLIENT=$CLIENT" node "$SCRIPT_DIR/$HOOK_TYPE.js" < "$INPUT_FILE"
else
  trap - EXIT
  (
    env "$WK_ENV_CLIENT=$CLIENT" node "$SCRIPT_DIR/$HOOK_TYPE.js" < "$INPUT_FILE" >/dev/null 2>&1
    rm -f "$INPUT_FILE"
  ) &
fi
