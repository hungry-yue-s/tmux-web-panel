#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PACKAGE_DIR="$PROJECT_DIR/macos/TmuxPanel"
TEST_BINARY="$(mktemp -t tmux-panel-self-test)"

cleanup() {
  rm -f "$TEST_BINARY"
}
trap cleanup EXIT

swiftc \
  "$PACKAGE_DIR/Sources/TmuxPanel/PanelEndpoint.swift" \
  "$PACKAGE_DIR/Sources/TmuxPanel/ServiceInspector.swift" \
  "$PACKAGE_DIR/Tests/main.swift" \
  -o "$TEST_BINARY"

"$TEST_BINARY"
