# Memory Map

A local Mac app that shows every custom skill, agent, slash command, hook, scheduled routine, recent plan, and persistent memory file in your Claude Code setup — grouped by scope, searchable, with rendered markdown previews.

## What's in this folder

```
memory-map/
├── data/
│   ├── memory-map.json                       # the data (generated)
│   └── routines.json                         # cached remote routines list
└── MemoryMap.app/
    └── Contents/Resources/
        ├── build.py                          # reads ~/.claude/ → writes data/memory-map.json
        ├── refresh-on-plan.sh                # hook helper; called from settings.json
        ├── server.py                         # tiny localhost HTTP server
        ├── template.html / styles.css / app.js   # the viewer
        └── marked.min.js                     # vendored markdown parser
```

Everything the viewer needs lives inside the `.app` bundle. The `data/` folder sits next to it as the only thing that varies per-machine.

## Quick start

```bash
# Generate the data file
python3 MemoryMap.app/Contents/Resources/build.py

# Open the app
open MemoryMap.app
```

The app launches a localhost-only HTTP server in the background and opens Chrome in `--app` mode pointed at it. No menu bar, no URL bar — just the map.

## Refresh

Three ways:

1. **In-app** — click the gear (⚙) in the top-right → "↻ Regenerate directory."
2. **Hooks** — if you've installed the `PostToolUse` and `SessionStart` hooks in `~/.claude/settings.json` (see below), the data file regenerates automatically on plan writes and session start.
3. **Manually** — run `python3 MemoryMap.app/Contents/Resources/build.py` then refresh the browser window.

## Setting up hooks (optional)

Add this to your `~/.claude/settings.json` under the existing `hooks` key. Replace `/Users/yourname/workspace/memory-map` with wherever you cloned this folder.

```json
"PostToolUse": [
  {
    "matcher": "Write|Edit|ExitPlanMode",
    "hooks": [
      { "type": "command", "command": "bash /Users/yourname/workspace/memory-map/MemoryMap.app/Contents/Resources/refresh-on-plan.sh" }
    ]
  }
],
"SessionStart": [
  {
    "matcher": "",
    "hooks": [
      { "type": "command", "command": "python3 /Users/yourname/workspace/memory-map/MemoryMap.app/Contents/Resources/build.py >/dev/null 2>&1 &" }
    ]
  }
]
```

## Moving to another Mac

1. Clone (or copy) this folder to the new machine.
2. Run `python3 MemoryMap.app/Contents/Resources/build.py` — it reads the **new machine's** `~/.claude/` and writes its own `data/memory-map.json`.
3. `open MemoryMap.app`.

The committed `data/memory-map.json` in the repo reflects whichever machine generated it last. The app shows that data until you re-run `build.py` on the new machine.

## Routines

Routines (remote scheduled agents via `/schedule`) live on Anthropic's servers, not on your Mac, so `build.py` can't fetch them directly. They're cached in `data/routines.json`. To refresh, ask Claude Code to run `RemoteTrigger list` and update the file.

## Requirements

- macOS with Python 3 (standard on modern macOS)
- Google Chrome at `/Applications/Google Chrome.app`
- Read access to your own `~/.claude/` directory
