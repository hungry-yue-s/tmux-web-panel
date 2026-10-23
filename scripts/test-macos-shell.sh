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

SETUP_TEST_BINARY="$TEST_DIRECTORY/setup-self-test"
swiftc -parse-as-library \
  "$PACKAGE_DIR/Sources/TmuxPanel/PanelEndpoint.swift" \
  "$PACKAGE_DIR/Sources/TmuxPanel/ServiceInspector.swift" \
  "$PACKAGE_DIR/Sources/TmuxPanel/DesktopSetupManager.swift" \
  "$PACKAGE_DIR/Tests/DesktopSetupTests.swift" \
  -o "$SETUP_TEST_BINARY"
codesign --force --sign - "$SETUP_TEST_BINARY" >/dev/null
if "$SETUP_TEST_BINARY"; then
  :
else
  SETUP_EXIT_CODE=$?
  if [[ "$SETUP_EXIT_CODE" -eq 137 ]]; then
    echo "ERROR: compiled setup self-test received SIGKILL (137); compiled executable validation has not passed." >&2
    echo "Running the Swift source interpreter for supplemental logic checks; its result will not hide the execution failure." >&2
    SETUP_TEST_SOURCE="$TEST_DIRECTORY/setup-interpreted.swift"
    cat \
      "$PACKAGE_DIR/Sources/TmuxPanel/PanelEndpoint.swift" \
      "$PACKAGE_DIR/Sources/TmuxPanel/ServiceInspector.swift" \
      "$PACKAGE_DIR/Sources/TmuxPanel/DesktopSetupManager.swift" > "$SETUP_TEST_SOURCE"
    sed '/^@main$/d' "$PACKAGE_DIR/Tests/DesktopSetupTests.swift" >> "$SETUP_TEST_SOURCE"
    printf '\nTask { @MainActor in await DesktopSetupSelfTests.main(); exit(0) }\ndispatchMain()\n' >> "$SETUP_TEST_SOURCE"
    if ! swift "$SETUP_TEST_SOURCE"; then
      echo "ERROR: supplemental interpreted setup checks also failed." >&2
    fi
  fi
  exit "$SETUP_EXIT_CODE"
fi
