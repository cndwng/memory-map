# Memory Map

A local Mac app that shows every custom skill, agent, slash command, hook, scheduled routine, recent plan, and persistent memory file in your Claude Code setup — grouped by scope, searchable, with rendered markdown previews.

## What's in this folder

```
memory-map/
└── Memory Map.app/
    └── Contents/Resources/
        ├── build.py                          # reads ~/.claude/ → writes the data file
        ├── refresh-on-plan.sh                # hook helper; called from settings.json
        ├── server.py                         # tiny localhost HTTP server
        ├── welcome.html                      # first-launch onboarding
        ├── template.html / styles.css / app.js   # the viewer
        └── marked.min.js                     # vendored markdown parser
```

Everything the viewer needs lives inside the `.app` bundle. Runtime data
(the built JSON, per-machine config) lives in
`~/Library/Application Support/MemoryMap/` so the bundle stays portable
and survives reinstalls.

## Quick start

```bash
# Generate the data file
python3 "Memory Map.app/Contents/Resources/build.py"

# Open the app
open "Memory Map.app"
```

The app is a small native Cocoa wrapper (`Contents/MacOS/MemoryMap`, ~110 KB Swift binary) that starts the localhost HTTP server in the background and opens a WKWebView window on it. One Dock tile, custom icon, single-window behavior. The Swift source is in `Contents/Resources/MemoryMap.swift` if you want to rebuild (`swiftc -O MemoryMap.swift -o ../MacOS/MemoryMap`).

## Refresh

Three ways:

1. **In-app** — click the gear (⚙) in the top-right → "↻ Regenerate directory."
2. **Hooks** — if you've installed the `PostToolUse` and `SessionStart` hooks in `~/.claude/settings.json` (see below), the data file regenerates automatically on plan writes and session start.
3. **Manually** — run `python3 "Memory Map.app/Contents/Resources/build.py"` then refresh the browser window.

## Setting up hooks (optional)

Add this to your `~/.claude/settings.json` under the existing `hooks` key. Replace `/Users/yourname/workspace/memory-map` with wherever you cloned this folder.

```json
"PostToolUse": [
  {
    "matcher": "Write|Edit|ExitPlanMode",
    "hooks": [
      { "type": "command", "command": "bash '/Users/yourname/workspace/memory-map/Memory Map.app/Contents/Resources/refresh-on-plan.sh'" }
    ]
  }
],
"SessionStart": [
  {
    "matcher": "",
    "hooks": [
      { "type": "command", "command": "python3 '/Users/yourname/workspace/memory-map/Memory Map.app/Contents/Resources/build.py' >/dev/null 2>&1 &" }
    ]
  }
]
```

## Moving to another Mac

1. Clone (or copy) this folder to the new machine.
2. Run `python3 "Memory Map.app/Contents/Resources/build.py"` — it reads the **new machine's** `~/.claude/` and writes `~/Library/Application Support/MemoryMap/memory-map.json`.
3. `open "Memory Map.app"`.

The committed `data/memory-map.json` in the repo reflects whichever machine generated it last. The app shows that data until you re-run `build.py` on the new machine.

## Routines

Routines (remote scheduled agents via `/schedule`) live on Anthropic's servers, not on your Mac, so `build.py` can't fetch them directly. They're cached in `data/routines.json`. To refresh, ask Claude Code to run `RemoteTrigger list` and update the file.

## Per-machine config

`data/config.local.json` (gitignored, optional) lets you override two things:

```json
{
  "workspace_dirs": ["~/dev"],
  "data_file": "/absolute/path/to/someone-elses-memory-map.json"
}
```

- `workspace_dirs` — replaces the auto-detected workspace path. If absent, the build script tries `~/workspace`, `~/dev`, `~/code`, `~/Projects`, etc., in order and uses the first existing one.
- `data_file` — points the viewer at a different JSON than `data/memory-map.json`. Useful for viewing someone else's exported map (drop their JSON anywhere and select it).

Easier than editing the file: open the app, click the ⚙ gear, then **"📂 Choose workspace folder…"** or **"📄 Use external data file…"** to open a native picker. **"↺ Reset to defaults"** clears overrides.

## Requirements

- macOS with Python 3 (standard on modern macOS)
- Google Chrome at `/Applications/Google Chrome.app`
- Read access to your own `~/.claude/` directory
