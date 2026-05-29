#!/usr/bin/env bash
# Build distributable Memory Map artifacts.
#
# Produces (in ./dist):
#   - MemoryMap-v<version>.zip — raw .app zipped with `ditto`
#   - MemoryMap-v<version>.dmg — drag-to-Applications disk image
#                                (if `create-dmg` is available)
#
# Used locally and by .github/workflows/release.yml.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$REPO_DIR/Memory Map.app"
PLIST_NOEXT="$APP/Contents/Info"   # `defaults read` wants the path WITHOUT .plist
SWIFT="$APP/Contents/Resources/MemoryMap.swift"
BINARY="$APP/Contents/MacOS/MemoryMap"
DIST_DIR="$REPO_DIR/dist"

VERSION=$(defaults read "$PLIST_NOEXT" CFBundleShortVersionString)
BUILD=$(defaults read "$PLIST_NOEXT" CFBundleVersion)

echo "Building Memory Map v${VERSION} (build ${BUILD})…"

swiftc -O "$SWIFT" -o "$BINARY"
echo "  ✓ Swift recompiled"

ZIP="$DIST_DIR/MemoryMap-v${VERSION}.zip"
mkdir -p "$DIST_DIR"
rm -f "$ZIP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
SIZE=$(du -h "$ZIP" | cut -f1)
echo "  ✓ Zipped → ${ZIP#$REPO_DIR/} ($SIZE)"

# DMG — drag-to-Applications disk image. Requires the create-dmg Homebrew
# tool. Skipped (with a warning) if it's not on PATH so the script still
# produces something usable locally without the brew dependency.
if command -v create-dmg >/dev/null 2>&1; then
  DMG="$DIST_DIR/MemoryMap-v${VERSION}.dmg"
  rm -f "$DMG"
  # --window-size + --icon positions are tuned for a 540×400 window with
  # the .app on the left and an Applications shortcut on the right.
  create-dmg \
    --volname "Memory Map" \
    --window-size 540 380 \
    --icon-size 96 \
    --icon "Memory Map.app" 130 170 \
    --app-drop-link 400 170 \
    --no-internet-enable \
    "$DMG" \
    "$APP" >/dev/null
  DSIZE=$(du -h "$DMG" | cut -f1)
  echo "  ✓ DMG    → ${DMG#$REPO_DIR/} ($DSIZE)"
else
  echo "  ⚠ Skipped DMG (install create-dmg to enable: brew install create-dmg)"
fi

echo "Done."
