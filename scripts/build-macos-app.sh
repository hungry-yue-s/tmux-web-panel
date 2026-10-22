#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PACKAGE_DIR="$PROJECT_DIR/macos/TmuxPanel"
DIST_DIR="${TMUX_PANEL_DIST_DIR:-$PROJECT_DIR/dist/macos}"
CONFIGURATION="${TMUX_PANEL_CONFIGURATION:-release}"
APP_PATH="$DIST_DIR/Tmux Panel.app"

swift build --package-path "$PACKAGE_DIR" --configuration "$CONFIGURATION"
BIN_DIR="$(swift build --package-path "$PACKAGE_DIR" --configuration "$CONFIGURATION" --show-bin-path)"

rm -rf "$APP_PATH"
mkdir -p "$APP_PATH/Contents/MacOS" "$APP_PATH/Contents/Resources"
cp "$BIN_DIR/TmuxPanel" "$APP_PATH/Contents/MacOS/TmuxPanel"
cp "$PACKAGE_DIR/Resources/Info.plist" "$APP_PATH/Contents/Info.plist"
ICON_FILE="$(plutil -extract CFBundleIconFile raw "$APP_PATH/Contents/Info.plist")"
ICON_WORK_DIR="$(mktemp -d /tmp/tmux-panel-icon.XXXXXX)"
trap 'rm -rf "$ICON_WORK_DIR"' EXIT
swift "$SCRIPT_DIR/generate-macos-icon.swift" "$ICON_WORK_DIR/AppIcon.iconset" "$PROJECT_DIR/public/app-icon.png"
iconutil --convert icns --output "$APP_PATH/Contents/Resources/$ICON_FILE" "$ICON_WORK_DIR/AppIcon.iconset"

plutil -lint "$APP_PATH/Contents/Info.plist" >/dev/null
codesign --force --deep --sign - "$APP_PATH" >/dev/null
codesign --verify --deep --strict "$APP_PATH"

echo "$APP_PATH"
