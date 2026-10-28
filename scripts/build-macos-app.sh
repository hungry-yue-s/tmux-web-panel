#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PACKAGE_DIR="$PROJECT_DIR/macos/TmuxPanel"
DIST_DIR="${TMUX_PANEL_DIST_DIR:-$PROJECT_DIR/dist/macos}"
CONFIGURATION="${TMUX_PANEL_CONFIGURATION:-release}"
BUNDLE_RUNTIME="${TMUX_PANEL_BUNDLE_RUNTIME:-1}"
IDENTITY="${TMUX_PANEL_CODESIGN_IDENTITY:--}"
NOTARY_PROFILE="${TMUX_PANEL_NOTARY_PROFILE:-}"
DISTRIBUTION="${TMUX_PANEL_DISTRIBUTION:-0}"
ARCH="${TMUX_PANEL_ARCH:-$(uname -m)}"
[[ "$ARCH" == x86_64 ]] && ARCH=x64
case "$ARCH" in arm64) MACHINE=arm64;; x64) MACHINE=x86_64;; *) echo "Unsupported architecture: $ARCH" >&2; exit 1;; esac
if [[ "$(uname -m)" == arm64 && "$MACHINE" == x86_64 ]]; then
  /usr/bin/arch -x86_64 /usr/bin/true 2>/dev/null || { echo 'Intel packaging requires a native Intel runner or an already installed Rosetta.' >&2; exit 1; }
  exec /usr/bin/arch -x86_64 /bin/bash "$0" "$@"
fi
[[ "$(uname -s)" == Darwin && "$(uname -m)" == "$MACHINE" ]] || { echo "Build on a native $MACHINE macOS runner." >&2; exit 1; }
if [[ "$DISTRIBUTION" == 1 ]]; then
  [[ "$IDENTITY" == 'Developer ID Application:'* && -n "$NOTARY_PROFILE" && "$BUNDLE_RUNTIME" == 1 ]] || {
    echo 'Public distribution requires the full runtime, a Developer ID Application identity and a notarytool keychain profile.' >&2; exit 1;
  }
fi
MINIMUM_MACOS="${TMUX_PANEL_MINIMUM_MACOS:-13.5}"
export MACOSX_DEPLOYMENT_TARGET="$MINIMUM_MACOS"
mkdir -p "$DIST_DIR"
DIST_DIR="$(cd "$DIST_DIR" && pwd)"
WORK="$(mktemp -d "$DIST_DIR/.app-build.XXXXXX")"
APP_PATH="$WORK/Tmux Panel.app"
trap 'rm -rf "$WORK"' EXIT

swift build --package-path "$PACKAGE_DIR" --configuration "$CONFIGURATION" --triple "$MACHINE-apple-macosx$MINIMUM_MACOS"
BIN_DIR="$(swift build --package-path "$PACKAGE_DIR" --configuration "$CONFIGURATION" --triple "$MACHINE-apple-macosx$MINIMUM_MACOS" --show-bin-path)"
mkdir -p "$APP_PATH/Contents/MacOS" "$APP_PATH/Contents/Resources"
cp "$BIN_DIR/TmuxPanel" "$APP_PATH/Contents/MacOS/TmuxPanel"
/usr/bin/lipo "$APP_PATH/Contents/MacOS/TmuxPanel" -verify_arch "$MACHINE"
cp "$PACKAGE_DIR/Resources/Info.plist" "$APP_PATH/Contents/Info.plist"
plutil -replace LSMinimumSystemVersion -string "$MINIMUM_MACOS" "$APP_PATH/Contents/Info.plist"
if [[ -n "${TMUX_PANEL_APP_VERSION:-}" ]]; then plutil -replace CFBundleShortVersionString -string "$TMUX_PANEL_APP_VERSION" "$APP_PATH/Contents/Info.plist"; fi
if [[ -n "${TMUX_PANEL_BUILD_NUMBER:-}" ]]; then plutil -replace CFBundleVersion -string "$TMUX_PANEL_BUILD_NUMBER" "$APP_PATH/Contents/Info.plist"; fi
ICON_FILE="$(plutil -extract CFBundleIconFile raw "$APP_PATH/Contents/Info.plist")"
swift "$SCRIPT_DIR/generate-macos-icon.swift" "$WORK/AppIcon.iconset" "$PROJECT_DIR/public/app-icon.png"
iconutil --convert icns --output "$APP_PATH/Contents/Resources/$ICON_FILE" "$WORK/AppIcon.iconset"
plutil -lint "$APP_PATH/Contents/Info.plist" >/dev/null

if [[ "$BUNDLE_RUNTIME" == 1 ]]; then
  TMUX_PANEL_ARCH="$ARCH" TMUX_PANEL_MINIMUM_MACOS="$MINIMUM_MACOS" \
    "$SCRIPT_DIR/bundle-macos-runtime.sh" "$APP_PATH/Contents/Resources/runtime"
fi

SIGN_FLAGS=(--force --sign "$IDENTITY")
if [[ "$IDENTITY" != - ]]; then SIGN_FLAGS+=(--timestamp --options runtime); fi
cat > "$WORK/node-entitlements.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>
PLIST
if [[ "$ARCH" == x64 ]]; then
  # V8's Intel memory-protection transition also needs this exception. Keep it
  # on the Node helper only; the app and native addons retain normal policy.
  /usr/libexec/PlistBuddy -c 'Add :com.apple.security.cs.allow-unsigned-executable-memory bool true' "$WORK/node-entitlements.plist"
fi
# Runtime checks have already executed these files. Install the signed bytes
# into new inodes before executing them again, avoiding macOS's old code cache.
sign_runtime_binary() {
  local binary="$1"
  shift
  codesign "${SIGN_FLAGS[@]}" "$@" "$binary"
  local signed_copy="${binary}.signed.$$"
  cp -p "$binary" "$signed_copy"
  mv -f "$signed_copy" "$binary"
}
if [[ "$BUNDLE_RUNTIME" == 1 ]]; then
  RUNTIME="$APP_PATH/Contents/Resources/runtime"
  # Sign nested executable code explicitly. All addons share the app's team.
  "$RUNTIME/bin/node" --input-type=module - "$RUNTIME" > "$WORK/macho-paths.txt" <<'JS'
import fs from 'node:fs'; import path from 'node:path';
const root=process.argv[2], manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
for(const name of manifest.machO) if(name!=='bin/node') console.log(path.join(root,name));
JS
  while IFS= read -r binary; do sign_runtime_binary "$binary"; done < "$WORK/macho-paths.txt"
  sign_runtime_binary "$RUNTIME/bin/node" --entitlements "$WORK/node-entitlements.plist"
  TMUX_PANEL_ARCH="$ARCH" TMUX_PANEL_MINIMUM_MACOS="$MINIMUM_MACOS" \
    "$RUNTIME/bin/node" "$SCRIPT_DIR/verify-macos-runtime.mjs" "$RUNTIME" --write-manifest
fi
codesign "${SIGN_FLAGS[@]}" "$APP_PATH"
codesign --verify --deep --strict "$APP_PATH"

LABEL=development
if [[ -n "$NOTARY_PROFILE" ]]; then
  [[ "$IDENTITY" != - ]] || { echo 'Notarization requires a Developer ID signature.' >&2; exit 1; }
  ditto -c -k --keepParent "$APP_PATH" "$WORK/notarize.zip"
  NOTARY_ARGS=(--keychain-profile "$NOTARY_PROFILE")
  if [[ -n "${TMUX_PANEL_NOTARY_KEYCHAIN:-}" ]]; then NOTARY_ARGS+=(--keychain "$TMUX_PANEL_NOTARY_KEYCHAIN"); fi
  xcrun notarytool submit "$WORK/notarize.zip" "${NOTARY_ARGS[@]}" --wait --output-format json > "$WORK/notary-result.json"
  /usr/bin/plutil -extract status raw "$WORK/notary-result.json" | /usr/bin/grep -qx Accepted || { echo 'Apple notarization was not accepted.' >&2; exit 1; }
  xcrun stapler staple "$APP_PATH"
  xcrun stapler validate "$APP_PATH"
  spctl --assess --type execute "$APP_PATH"
  LABEL=notarized
fi
FINAL_APP="$DIST_DIR/Tmux Panel.app"
rm -rf "$FINAL_APP"
mv "$APP_PATH" "$FINAL_APP"
ARCHIVE="$DIST_DIR/Tmux-Panel-macOS-$ARCH-$LABEL.zip"
rm -f "$ARCHIVE"
ditto -c -k --sequesterRsrc --keepParent "$FINAL_APP" "$ARCHIVE"
(cd "$DIST_DIR" && shasum -a 256 "$(basename "$ARCHIVE")" > "$(basename "$ARCHIVE").sha256")
echo "App: $FINAL_APP"
echo "Archive: $ARCHIVE"
if [[ "$LABEL" == development ]]; then
  echo 'Development artifact: not notarized; do not describe it as a Gatekeeper-ready public release.'
fi
