#!/usr/bin/env bash
# Install/remove the LAN IP sync job as a macOS launchd user agent.
#
# The job keeps the two things that break when DHCP moves this machine's IP in
# sync: the IP published to Duck DNS (read back over DNS-over-HTTPS from
# elsewhere), and the panel's leaf certificate (re-issued and the panel
# restarted, so the phone never sees a name mismatch).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_NAME="tmux-web-panel"
LABEL="com.${SERVICE_NAME}.lan-ip-sync"
PANEL_LABEL="com.${SERVICE_NAME}"
LEGACY_LABEL="com.${SERVICE_NAME}.duckdns"
CONFIG="${DUCKDNS_CONFIG:-$HOME/.config/tmux-web-panel/duckdns.env}"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LEGACY_PLIST="$HOME/Library/LaunchAgents/${LEGACY_LABEL}.plist"
LOG_DIR="$HOME/Library/Logs/${SERVICE_NAME}"
DOMAIN="${DUCKDNS_DOMAIN:-}"
if [[ -z "$DOMAIN" && -r "$CONFIG" ]]; then
  # shellcheck source=/dev/null
  set -a; . "$CONFIG"; set +a
  DOMAIN="${DUCKDNS_DOMAIN:-}"
fi
DOMAIN="${DOMAIN:-your-domain}"
PORT="${PORT:-7681}"
# WatchPaths fires on real network changes; this is only the backstop, and both
# steps no-op when the IP is unchanged, so a coarse interval costs nothing.
INTERVAL="${SYNC_INTERVAL:-1800}"

usage() {
  cat <<EOF
Usage: $0 <install|uninstall|status|run>

  install    Generate the local CA + leaf certificate, publish the IP once, and
             add the LaunchAgent that keeps both current.
  uninstall  Remove the LaunchAgent. Certificates and the Duck DNS record stay.
  status     Compare the current IP against the published one and the leaf cert.
  run        Run scripts/sync-lan-ip.sh once in the foreground, forcing a push.

Environment variables:
  DUCKDNS_CONFIG Credentials file (default: ~/.config/tmux-web-panel/duckdns.env)
  DUCKDNS_DOMAIN Name used by \`status\` for the DoH lookup (default: tmux-panel)
  SYNC_INTERVAL  Backstop poll seconds (default: 1800)
  PORT           Panel port used in the URLs below (default: 7681)

From the phone, bookmark the redirect page (see the GitHub Pages repo) or read
the IP directly:
  https://dns.alidns.com/resolve?name=${DOMAIN}.duckdns.org&type=A
EOF
  exit 1
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Error: $0 supports macOS only." >&2
  echo "On Linux, run scripts/sync-lan-ip.sh from a systemd timer or cron." >&2
  exit 1
fi

write_plist() {
  mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${SCRIPT_DIR}/sync-lan-ip.sh</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>DUCKDNS_CONFIG</key>
        <string>${CONFIG}</string>
        <key>PANEL_LABEL</key>
        <string>${PANEL_LABEL}</string>
    </dict>
    <key>WatchPaths</key>
    <array>
        <string>/Library/Preferences/SystemConfiguration</string>
    </array>
    <key>StartInterval</key>
    <integer>${INTERVAL}</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/lan-ip-sync.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/lan-ip-sync.stderr.log</string>
</dict>
</plist>
PLIST
}

doh_lookup() {
  curl -fsS --max-time 12 \
    "https://dns.alidns.com/resolve?name=${DOMAIN}.duckdns.org&type=A" 2>/dev/null \
    | sed -n 's/.*"type":1,"data":"\([0-9.]*\)".*/\1/p'
}

[[ $# -lt 1 ]] && usage
action="$1"

case "$action" in
  install)
    [[ -r "$CONFIG" ]] || {
      echo "Error: missing config $CONFIG" >&2
      echo "Create it with DUCKDNS_DOMAIN and DUCKDNS_TOKEN (see --help)." >&2
      exit 1
    }
    # Retire the narrower predecessor agent so two jobs do not publish the IP.
    if [[ -f "$LEGACY_PLIST" ]]; then
      launchctl unload "$LEGACY_PLIST" 2>/dev/null || true
      rm -f "$LEGACY_PLIST"
      echo "✓ Removed legacy agent ${LEGACY_LABEL}"
    fi

    # local-ca.sh reports a successful re-issue as exit 10, which `set -e`
    # would otherwise treat as a failure and abort before the agent is written.
    rc=0
    "$SCRIPT_DIR/local-ca.sh" --force || rc=$?
    if [[ $rc -ne 0 && $rc -ne 10 ]]; then
      echo "Error: local-ca.sh failed (exit $rc)" >&2
      exit 1
    fi
    echo ""
    write_plist
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load -w "$PLIST"
    echo "✓ Installed LaunchAgent ${LABEL}"
    echo "  Plist: $PLIST"
    echo "  Logs:  ${LOG_DIR}/lan-ip-sync.*.log"
    echo ""
    echo "Restart the panel to load the new certificate:"
    echo "  launchctl kickstart -k gui/\$(id -u)/${PANEL_LABEL}"
    echo ""
    echo "Install this CA on the phone once (Settings → Security → Install a"
    echo "certificate → CA certificate):"
    echo "  $HOME/.config/${SERVICE_NAME}/ca/ca.crt"
    ;;
  uninstall)
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "✓ Removed LaunchAgent ${LABEL}"
    ;;
  status)
    launchctl list | grep "$LABEL" || echo "Agent not loaded"
    ip="$("$SCRIPT_DIR/lan-ip.sh")"
    echo "Current LAN IP:    $ip"
    echo "Published (DoH):   $(doh_lookup || echo '(lookup failed)')"
    leaf="$HOME/.config/${SERVICE_NAME}/tls/cert.pem"
    ca="$HOME/.config/${SERVICE_NAME}/ca/ca.crt"
    if [[ -f "$leaf" ]]; then
      echo "Leaf cert IP:      $(openssl x509 -in "$leaf" -noout -text 2>/dev/null \
        | sed -n 's/.*IP Address:\([0-9.]*\)$/\1/p' | tail -1)"
      echo "Leaf cert expires: $(openssl x509 -in "$leaf" -noout -enddate 2>/dev/null | cut -d= -f2)"
      echo "Signed by our CA:  $(openssl verify -CAfile "$ca" "$leaf" &>/dev/null && echo yes || echo no)"
    else
      echo "Leaf cert:         (none at $leaf)"
    fi
    ;;
  run)
    exec "$SCRIPT_DIR/sync-lan-ip.sh"
    ;;
  *)
    usage
    ;;
esac
