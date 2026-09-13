#!/usr/bin/env bash
# Keep everything that depends on the LAN IP in sync. Run by launchd on network
# changes and on a coarse backstop interval.
#
#   1. Publish the current IP to Duck DNS so it can be read back over
#      DNS-over-HTTPS from elsewhere (see scripts/duckdns-update.sh).
#   2. Re-issue the panel's leaf certificate when the IP moved, then restart the
#      panel — otherwise the phone hits a name mismatch even though it trusts
#      the local CA.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PANEL_LABEL="${PANEL_LABEL:-com.tmux-web-panel}"
APP_BUNDLE_ID="${PANEL_APP_BUNDLE_ID:-com.tmux-web-panel.app}"

app_is_running() {
  [[ "$(osascript -e "application id \"$APP_BUNDLE_ID\" is running" 2>/dev/null)" == "true" ]]
}

# The Swift client pins the leaf certificate's DER at launch, so a re-issued
# certificate makes it reject every connection until it is relaunched. Only act
# when it is already running — do not launch an app the user chose to close.
restart_panel_app() {
  app_is_running || return 0
  osascript -e "tell application id \"$APP_BUNDLE_ID\" to quit" 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    app_is_running || break
    sleep 0.5
  done
  if ! open -b "$APP_BUNDLE_ID" 2>/dev/null; then
    echo "sync-lan-ip: could not relaunch the panel app" >&2
    return 1
  fi
  echo "sync-lan-ip: relaunched panel app so it re-pins the new certificate"
}

"$SCRIPT_DIR/duckdns-update.sh" || echo "sync-lan-ip: publish failed" >&2

"$SCRIPT_DIR/local-ca.sh"
rc=$?

case "$rc" in
  0)
    # Leaf already covers the current IP; nothing to restart.
    ;;
  10)
    echo "sync-lan-ip: certificate re-issued — restarting panel"
    if ! launchctl kickstart -k "gui/$(id -u)/${PANEL_LABEL}"; then
      echo "sync-lan-ip: panel restart failed" >&2
      exit 1
    fi
    restart_panel_app || exit 1
    ;;
  *)
    echo "sync-lan-ip: local-ca failed (exit $rc)" >&2
    exit 1
    ;;
esac
