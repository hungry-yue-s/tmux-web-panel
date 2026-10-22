#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PACKAGE_DIR="$PROJECT_DIR/macos/TmuxPanel"
TEST_DIRECTORY="$(mktemp -d /tmp/tmux-panel-self-test.XXXXXX)"
TEST_BINARY="$TEST_DIRECTORY/self-test"

cleanup() {
  rm -rf "$TEST_DIRECTORY"
}
trap cleanup EXIT

swiftc \
  "$PACKAGE_DIR/Sources/TmuxPanel/PanelEndpoint.swift" \
  "$PACKAGE_DIR/Sources/TmuxPanel/ServiceInspector.swift" \
  "$PACKAGE_DIR/Sources/TmuxPanel/PanelTitlebarDragView.swift" \
  "$PACKAGE_DIR/Tests/main.swift" \
  -o "$TEST_BINARY"

codesign --force --sign - "$TEST_BINARY" >/dev/null
"$TEST_BINARY"
