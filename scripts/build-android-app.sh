#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
if [[ ! -d "$ANDROID_HOME" ]]; then
  echo "Android SDK not found; set ANDROID_HOME." >&2
  exit 1
fi
if [[ -z "${TMUX_PANEL_URL:-}" && -f "$PROJECT_DIR/public/js/relay-config.js" ]]; then
  TMUX_PANEL_URL="$(node --input-type=module - "$PROJECT_DIR/public/js/relay-config.js" <<'JS'
import { readFileSync } from 'node:fs';
const match = readFileSync(process.argv[2], 'utf8').match(/PANEL_RELAY_PAGE\s*=\s*['"]([^'"]+)['"]/);
if (match) process.stdout.write(match[1]);
JS
)"
  export TMUX_PANEL_URL
fi
if [[ -z "${JAVA_HOME:-}" && -x /usr/libexec/java_home ]]; then
  export JAVA_HOME="$(/usr/libexec/java_home -v '17+')"
fi
# Bundle only the public CA, never the CA key. Override with an empty value to omit it.
export TMUX_PANEL_CA_CERT="${TMUX_PANEL_CA_CERT-$HOME/.config/tmux-web-panel/ca/ca.crt}"
if [[ ! -f "$TMUX_PANEL_CA_CERT" ]]; then export TMUX_PANEL_CA_CERT=""; fi

"$PROJECT_DIR/android/gradlew" -p "$PROJECT_DIR/android" testDebugUnitTest lintDebug assembleDebug "$@"
DIST_DIR="${TMUX_PANEL_ANDROID_DIST_DIR:-$PROJECT_DIR/dist/android}"
mkdir -p "$DIST_DIR"
cp "$PROJECT_DIR/android/app/build/outputs/apk/debug/app-debug.apk" "$DIST_DIR/Tmux-Panel.apk"
echo "$DIST_DIR/Tmux-Panel.apk"
