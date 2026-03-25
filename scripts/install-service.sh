#!/usr/bin/env bash
set -euo pipefail

# tmux-web-panel service installer
# Supports: Linux (systemd user service) and macOS (launchd user agent)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- Defaults (override via env) ---
SERVICE_NAME="tmux-web-panel"
PORT="${PORT:-7681}"
HOST="${HOST:-0.0.0.0}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"

usage() {
  cat <<EOF
Usage: $0 <install|uninstall|status|logs>

Installs tmux-web-panel as a user-level auto-start service.
  Linux : systemd user service (~/.config/systemd/user/)
  macOS : launchd user agent   (~/Library/LaunchAgents/)

Environment variables:
  PORT      Listen port        (default: 7681)
  HOST      Listen host        (default: 0.0.0.0)
  AUTH      Auth token         (default: none)
  NODE_BIN  Path to node       (default: auto-detect)

Examples:
  $0 install
  PORT=8080 AUTH=secret $0 install
  $0 uninstall
  $0 status
  $0 logs
EOF
  exit 1
}

# ---- Linux (systemd) ----

systemd_dir="$HOME/.config/systemd/user"
systemd_unit="$systemd_dir/${SERVICE_NAME}.service"

install_systemd() {
  mkdir -p "$systemd_dir"

  local env_lines="Environment=PORT=${PORT}\nEnvironment=HOST=${HOST}"
  if [[ -n "${AUTH:-}" ]]; then
    env_lines+="\nEnvironment=AUTH=${AUTH}"
  fi

  cat > "$systemd_unit" <<UNIT
[Unit]
Description=tmux web panel
After=network.target

[Service]
Type=simple
WorkingDirectory=${PROJECT_DIR}
ExecStart=${NODE_BIN} server/index.js
Restart=always
RestartSec=3
$(echo -e "$env_lines")

[Install]
WantedBy=default.target
UNIT

  systemctl --user daemon-reload
  systemctl --user enable "$SERVICE_NAME"
  systemctl --user start "$SERVICE_NAME"
  echo "✓ Installed and started systemd user service"
  echo "  Unit file: $systemd_unit"

  # enable lingering so service runs without active login session
  if command -v loginctl &>/dev/null; then
    loginctl enable-linger "$USER" 2>/dev/null || true
  fi
}

uninstall_systemd() {
  systemctl --user stop "$SERVICE_NAME" 2>/dev/null || true
  systemctl --user disable "$SERVICE_NAME" 2>/dev/null || true
  rm -f "$systemd_unit"
  systemctl --user daemon-reload
  echo "✓ Removed systemd user service"
}

status_systemd() {
  systemctl --user status "$SERVICE_NAME" --no-pager || true
}

logs_systemd() {
  journalctl --user -u "$SERVICE_NAME" --no-pager -n 50 -f
}

# ---- macOS (launchd) ----

launchd_dir="$HOME/Library/LaunchAgents"
launchd_plist="$launchd_dir/com.${SERVICE_NAME}.plist"
launchd_label="com.${SERVICE_NAME}"
launchd_log_dir="$HOME/Library/Logs/${SERVICE_NAME}"

install_launchd() {
  mkdir -p "$launchd_dir" "$launchd_log_dir"

  local env_keys=()
  local env_vals=()
  env_keys+=("PORT"); env_vals+=("$PORT")
  env_keys+=("HOST"); env_vals+=("$HOST")
  if [[ -n "${AUTH:-}" ]]; then
    env_keys+=("AUTH"); env_vals+=("$AUTH")
  fi

  local env_xml=""
  for i in "${!env_keys[@]}"; do
    env_xml+="        <key>${env_keys[$i]}</key>"$'\n'
    env_xml+="        <string>${env_vals[$i]}</string>"$'\n'
  done

  cat > "$launchd_plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${launchd_label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_BIN}</string>
        <string>server/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${PROJECT_DIR}</string>
    <key>EnvironmentVariables</key>
    <dict>
${env_xml}    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${launchd_log_dir}/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${launchd_log_dir}/stderr.log</string>
</dict>
</plist>
PLIST

  launchctl unload "$launchd_plist" 2>/dev/null || true
  launchctl load -w "$launchd_plist"
  echo "✓ Installed and started launchd user agent"
  echo "  Plist: $launchd_plist"
  echo "  Logs:  $launchd_log_dir/"
}

uninstall_launchd() {
  launchctl unload "$launchd_plist" 2>/dev/null || true
  rm -f "$launchd_plist"
  echo "✓ Removed launchd user agent"
}

status_launchd() {
  launchctl list | grep "$launchd_label" || echo "Service not loaded"
}

logs_launchd() {
  tail -n 50 -f "$launchd_log_dir/stderr.log" "$launchd_log_dir/stdout.log" 2>/dev/null \
    || echo "No logs found at $launchd_log_dir/"
}

# ---- Main ----

[[ $# -lt 1 ]] && usage
action="$1"

detect_platform() {
  case "$(uname -s)" in
    Linux*)  echo "linux" ;;
    Darwin*) echo "macos" ;;
    *)       echo "unsupported" ;;
  esac
}

platform="$(detect_platform)"
if [[ "$platform" == "unsupported" ]]; then
  echo "Error: unsupported platform $(uname -s)" >&2
  exit 1
fi

case "$action" in
  install)
    if [[ "$platform" == "linux" ]]; then install_systemd; else install_launchd; fi
    echo ""
    echo "Service will auto-start on login. Listening on ${HOST}:${PORT}"
    ;;
  uninstall)
    if [[ "$platform" == "linux" ]]; then uninstall_systemd; else uninstall_launchd; fi
    ;;
  status)
    if [[ "$platform" == "linux" ]]; then status_systemd; else status_launchd; fi
    ;;
  logs)
    if [[ "$platform" == "linux" ]]; then logs_systemd; else logs_launchd; fi
    ;;
  *)
    usage
    ;;
esac
