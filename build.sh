#!/usr/bin/env bash
# Build a distributable Memory Map .app zip.
#
# Reads the version from Info.plist, recompiles the Swift launcher, and zips
# the .app bundle into dist/MemoryMap-v<version>.zip using `ditto` (which
# preserves macOS metadata better than plain `zip`).
#
# Used locally and by .github/workflows/release.yml.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$REPO_DIR/MemoryMap.app"
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

echo "Done."
