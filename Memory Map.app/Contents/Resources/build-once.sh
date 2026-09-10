#!/usr/bin/env bash
# Memory Map rebuild entry point for hooks.
#
# Every spawner goes through here so there is one place that enforces the two
# invariants a fire-and-forget hook needs:
#
#   1. One rebuild at a time. Hooks fire per session and per agent, so without
#      a lock a busy day stacks up dozens of concurrent walks.
#   2. A hard runtime cap. A rebuild that wedges must not outlive the session
#      that started it. Orphaned builds reparent to launchd and are invisible
#      until the machine is out of swap.
set -e

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD="$SELF_DIR/build.py"
LOCKDIR="${TMPDIR:-/tmp}/memorymap-build.lock"
BUILD_TIMEOUT="${MEMORYMAP_BUILD_TIMEOUT:-180}"

# A lock left behind by a hard-killed shell would otherwise silence every
# future rebuild. Anything older than twice the timeout cannot be live.
if [ -d "$LOCKDIR" ]; then
  stale_after=$(( BUILD_TIMEOUT / 30 + 1 ))
  if [ -n "$(find "$LOCKDIR" -maxdepth 0 -mmin +"$stale_after" 2>/dev/null)" ]; then
    rmdir "$LOCKDIR" 2>/dev/null || true
  fi
fi

(
  if mkdir "$LOCKDIR" 2>/dev/null; then
    trap 'rmdir "$LOCKDIR" 2>/dev/null || true' EXIT

    python3 "$BUILD" >/dev/null 2>&1 &
    build_pid=$!

    # No `timeout` on a stock macOS, so run our own watchdog.
    ( sleep "$BUILD_TIMEOUT"; kill -9 "$build_pid" 2>/dev/null || true ) &
    watchdog_pid=$!

    wait "$build_pid" 2>/dev/null || true

    # Reap the watchdog's `sleep` before the watchdog itself. Killing only the
    # subshell strands the sleep on launchd, which is the same orphan pattern
    # this script exists to prevent.
    pkill -P "$watchdog_pid" 2>/dev/null || true
    kill "$watchdog_pid" 2>/dev/null || true
  fi
) &
