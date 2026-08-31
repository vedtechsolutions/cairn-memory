#!/bin/sh
# codex exec with a startup-deadlock watchdog (dual-review ops helper).
#
# codex-cli (observed on 0.150.1) intermittently deadlocks BEFORE doing
# anything: no session rollout file, no child processes, no sockets, all
# threads parked at 0% CPU. A healthy run creates its rollout under
# ~/.codex/sessions/YYYY/MM/DD/ within seconds, so "no new session file
# within STARTUP_TIMEOUT while the process is still alive" is a reliable
# deadlock signature. On trip: kill, retry once. A run that passes
# startup gets RUN_TIMEOUT total before being killed as a lost cause.
set -u
STARTUP_TIMEOUT="${CODEX_STARTUP_TIMEOUT:-90}"
RUN_TIMEOUT="${CODEX_RUN_TIMEOUT:-2400}"

SESS_DIR="$HOME/.codex/sessions/$(date +%Y/%m/%d)"

attempt() {
  before=$(ls "$SESS_DIR" 2>/dev/null | wc -l)
  codex exec "$@" &
  pid=$!
  elapsed=0
  started=0
  while [ "$elapsed" -lt "$STARTUP_TIMEOUT" ]; do
    sleep 3
    elapsed=$((elapsed + 3))
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid"
      return $?
    fi
    # Re-resolve the dir each poll: a run straddling midnight writes to
    # the new date directory.
    SESS_DIR="$HOME/.codex/sessions/$(date +%Y/%m/%d)"
    after=$(ls "$SESS_DIR" 2>/dev/null | wc -l)
    if [ "$after" -gt "$before" ]; then
      started=1
      break
    fi
  done

  if [ "$started" -eq 0 ] && kill -0 "$pid" 2>/dev/null; then
    echo "codex-review: startup deadlock (no session file in ${STARTUP_TIMEOUT}s) — killing pid $pid" >&2
    kill "$pid" 2>/dev/null
    sleep 2
    kill -9 "$pid" 2>/dev/null
    return 99
  fi

  ( sleep "$RUN_TIMEOUT" && kill "$pid" 2>/dev/null ) &
  watcher=$!
  wait "$pid"
  rc=$?
  kill "$watcher" 2>/dev/null
  return "$rc"
}

attempt "$@"
rc=$?
if [ "$rc" -eq 99 ]; then
  echo "codex-review: retrying once after startup deadlock" >&2
  attempt "$@"
  rc=$?
  [ "$rc" -eq 99 ] && echo "codex-review: deadlocked twice — giving up (fall back to a Claude reviewer)" >&2
fi
exit "$rc"
