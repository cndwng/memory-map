#!/usr/bin/env bash
# Memory Map hook helper.
# Called from ~/.claude/settings.json PostToolUse hooks; rebuilds the data file
# if the affected file lives in ~/.claude/plans/ (or if the tool was ExitPlanMode).

set -e
INPUT=$(cat)

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD="$SELF_DIR/build.py"
LOCKDIR="${TMPDIR:-/tmp}/memorymap-build.lock"

# Runs across every concurrent Claude Code session/agent, so guard against
# piling up redundant rebuilds: skip if one is already in flight rather than
# queuing — the in-flight build already captures the latest state.
run_build() {
  (
    if mkdir "$LOCKDIR" 2>/dev/null; then
      trap 'rmdir "$LOCKDIR"' EXIT
      python3 "$BUILD" >/dev/null 2>&1
    fi
  ) &
}

# ExitPlanMode always means a plan event; rebuild unconditionally.
TOOL=$(printf '%s' "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_name',''))")
if [ "$TOOL" = "ExitPlanMode" ]; then
  run_build
  exit 0
fi

# Otherwise (Write/Edit), only rebuild if the file lives under ~/.claude/plans/
FILE_PATH=$(printf '%s' "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('file_path',''))")
case "$FILE_PATH" in
  "$HOME/.claude/plans/"*)
    run_build
    ;;
esac
