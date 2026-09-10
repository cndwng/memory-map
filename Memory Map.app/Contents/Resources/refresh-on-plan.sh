#!/usr/bin/env bash
# Memory Map hook helper.
# Called from ~/.claude/settings.json PostToolUse hooks; rebuilds the data file
# if the affected file lives in ~/.claude/plans/ (or if the tool was ExitPlanMode).

set -e
INPUT=$(cat)

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_ONCE="$SELF_DIR/build-once.sh"

# build-once.sh owns the locking and the runtime cap for every spawner.
run_build() {
  bash "$BUILD_ONCE"
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
