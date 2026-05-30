# Memory Map

A Mac browser for everything in your Claude Code setup — every custom skill, agent, slash command, hook, scheduled routine, recent plan, and persistent memory file. Grouped by scope, searchable, with rendered markdown previews.

<!--
  Drop a screenshot at docs/screenshot.png and uncomment:
  ![Memory Map screenshot](docs/screenshot.png)
-->

## Why

If you have a few Claude Code plugins installed plus a handful of memory files, it's hard to remember everything Claude has access to. Memory Map gives you a browsable inventory and a fast way to read any of it.

## Features

- **Tabbed inventory** — Global (`~/.claude/`), Memory, Workspace repos, Automations (hooks + routines), Plugins (grouped by marketplace)
- **Filter chips + live search** by name or description
- **Find-in-page** (`⌘F`) with match highlighting, prev/next, persists across navigation
- **Focus mode** for distraction-free reading
- **Pop out** any file into its own window (`⌘`-click in the tree)
- **Back / forward** navigation via buttons, `⌘[` / `⌘]`, or trackpad swipe
- **Default `.md` viewer** — set Memory Map as the default app for `.md` files and double-click any markdown anywhere on your machine
- **Light + dark mode** (follows system)
- **Zoom** with `⌘+` / `⌘-` / `⌘0`, plus trackpad pinch

## Install

1. Download `MemoryMap-vX.Y.dmg` (or `.zip`) from the [Releases page](https://github.com/cndwng/memory-map/releases/latest).
2. Open the DMG and drag **Memory Map** to your **Applications** folder.
3. **One-time gatekeeper workaround.** Memory Map isn't code-signed (notarization requires a paid Apple Developer account), so macOS Sequoia/Sonoma will show a misleading *"the application is damaged"* error on first launch. To fix, run this once in Terminal:

   ```bash
   xattr -dr com.apple.quarantine "/Applications/Memory Map.app"
   ```

4. Launch from Applications, Spotlight, or Launchpad.

On first launch you'll see a welcome screen that lets you pick a workspace folder and gives you the optional `~/.claude/settings.json` hooks for auto-refresh.

## Auto-refresh (recommended)

Memory Map shows whatever was in `~/.claude/` at the time the data file was last built. To keep it always fresh, add the hooks the in-app **⚙ Settings → 🪝 Suggested hooks** dialog shows. These trigger a rebuild on Claude Code session start and on any plan / memory file change.

You can also rebuild manually from **⚙ Settings → ↻ Regenerate directory**.

## Build from source

```bash
git clone https://github.com/cndwng/memory-map.git
cd memory-map
./build.sh
open "Memory Map.app"
```

`build.sh` recompiles the Swift launcher and zips + (optionally) builds a `.dmg` distribution. To get the DMG output:

```bash
brew install create-dmg
./build.sh   # now produces dist/MemoryMap-vX.Y.dmg too
```

**Requirements:**
- macOS 11+
- Python 3 (ships with macOS)
- Swift compiler (Xcode or Xcode Command Line Tools)

## Per-machine config

Memory Map reads `~/Library/Application Support/MemoryMap/config.local.json` (gitignored, optional):

```json
{
  "workspace_dirs": ["~/dev"],
  "data_file": "/absolute/path/to/someone-elses-memory-map.json"
}
```

- `workspace_dirs` — where to scan for `<repo>/.claude/` folders. Defaults to auto-detecting the first existing of `~/workspace`, `~/dev`, `~/code`, `~/Projects`, etc.
- `data_file` — point the viewer at someone else's exported `memory-map.json` (drop their file anywhere and select it via the gear menu).

Easier than editing the file: open the app → **⚙ Settings** → **📂 Choose workspace folder…** or **📄 Use external data file…**. **↺ Reset to defaults** clears overrides.

## How it works

`Memory Map.app/Contents/Resources/build.py` walks `~/.claude/` (and any workspace `.claude/` dirs) and writes a JSON inventory to `~/Library/Application Support/MemoryMap/memory-map.json`. A tiny native Cocoa launcher (`Contents/MacOS/MemoryMap`, ~150KB Swift binary) starts a localhost HTTP server (`server.py`) at launch and opens a `WKWebView` window on it. The viewer is HTML/CSS/JS served by that server.

```
Memory Map.app/
└── Contents/
    ├── MacOS/MemoryMap        # native launcher (Swift)
    └── Resources/
        ├── MemoryMap.swift     # launcher source
        ├── build.py            # ~/.claude/ → JSON
        ├── server.py           # localhost HTTP server
        ├── refresh-on-plan.sh  # hook helper
        ├── template.html
        ├── viewer.html         # standalone .md file viewer
        ├── welcome.html
        ├── styles.css
        ├── app.js
        └── marked.min.js       # vendored markdown parser
```

## Caveats

- macOS-only (uses `WKWebView`).
- Unsigned, not notarized — first install needs the `xattr` workaround above.
- Not in the Mac App Store.

## Releases

Each tag (`vX.Y` or `vX.Y.Z`) gets a GitHub Release with a `.zip` and `.dmg` attached. The release workflow lives at `.github/workflows/release.yml` and triggers on tag push. Bump `CFBundleShortVersionString` (and `CFBundleVersion`) in `Memory Map.app/Contents/Info.plist`, commit, `git tag vX.Y`, `git push --tags`.

## License

MIT. See [LICENSE](LICENSE).
