#!/usr/bin/env bash
set -euo pipefail

# tmux-web-panel service installer
# Supports: Linux (systemd user service) and macOS (launchd user agent)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- Defaults (override via env) ---
SERVICE_NAME="tmux-web-panel"
TMUX_SERVER_SERVICE="tmux-server"
PORT="${PORT:-7681}"
HOST="${HOST:-0.0.0.0}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
TMUX_BIN="${TMUX_BIN:-$(command -v tmux 2>/dev/null || true)}"

usage() {
  cat <<EOF
Usage: $0 <install|uninstall|status|logs>

Installs tmux-web-panel as a user-level auto-start service.
  Linux : systemd user service (~/.config/systemd/user/)
  macOS : launchd user agent   (~/Library/LaunchAgents/)

Environment variables:
  PORT      Listen port                 (default: 7681)
  HOST      Listen host                 (default: 0.0.0.0)
  AUTH      Auth user:password          (default: none — NO auth!)
  TLS_CERT  Path to TLS certificate     (default: none — plain HTTP)
  TLS_KEY   Path to TLS private key     (default: none — plain HTTP)
  HTTP_PORT HTTP->HTTPS redirect port   (default: 7680, only when TLS set)
  NODE_BIN  Path to node                (default: auto-detect)

Examples:
  $0 install
  PORT=8080 AUTH=user:secret $0 install
  # HTTPS + auth (recommended; run from repo root so \$PWD points at the certs):
  TLS_CERT=\$PWD/cert.pem TLS_KEY=\$PWD/key.pem AUTH=user:secret $0 install
  $0 uninstall
  $0 status
  $0 logs
EOF
  exit 1
}

# ---- Linux (systemd) ----

systemd_dir="$HOME/.config/systemd/user"
systemd_unit="$systemd_dir/${SERVICE_NAME}.service"
tmux_server_unit="$systemd_dir/${TMUX_SERVER_SERVICE}.service"
tmux_conf="$HOME/.tmux.conf"

# Idempotently ensure ~/.tmux.conf has `set -g exit-empty off`.
# Without this, the empty tmux server started by tmux-server.service can self-exit
# before tmux-continuum auto-restore kicks in, breaking session persistence.
ensure_tmux_exit_empty() {
  if [[ ! -f "$tmux_conf" ]]; then
    return 0
  fi
  if grep -qE '^[[:space:]]*set[[:space:]]+-g[[:space:]]+exit-empty[[:space:]]+off' "$tmux_conf"; then
    return 0
  fi
  printf '\n# Added by tmux-web-panel install-service.sh: keep server alive without sessions\nset -g exit-empty off\n' >> "$tmux_conf"
  echo "✓ Appended 'set -g exit-empty off' to $tmux_conf"
}

# Install tmux-server.service: bootstraps the user's tmux server on login so the
# web panel always has sessions to list. Pairs with tmux-continuum's
# @continuum-restore to recover sessions across reboots.
install_tmux_server_systemd() {
  if [[ -z "$TMUX_BIN" ]]; then
    echo "⚠ tmux not found in PATH — skipping tmux-server.service"
    echo "  Sessions will NOT auto-recover on reboot. Install tmux and re-run."
    return 0
  fi

  cat > "$tmux_server_unit" <<UNIT
[Unit]
Description=tmux server (keep-alive for tmux-web-panel)
Documentation=https://github.com/tmux-plugins/tmux-continuum
# Do NOT add After=default.target here. tmux-web-panel is WantedBy=default.target and
# After=tmux-server.service, so ordering this unit after default.target forms a cycle
# (web-panel -> tmux-server -> default.target -> web-panel) that systemd breaks at boot
# by DROPPING tmux-web-panel's start job. tmux-server must be ready BEFORE default.target.

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${TMUX_BIN} start-server
ExecStop=${TMUX_BIN} kill-server

[Install]
WantedBy=default.target
UNIT

  ensure_tmux_exit_empty

  systemctl --user daemon-reload
  systemctl --user enable "$TMUX_SERVER_SERVICE" 2>/dev/null || true
  systemctl --user start "$TMUX_SERVER_SERVICE" 2>/dev/null || true
  echo "✓ Installed tmux-server.service (keeps tmux alive for the web panel)"
}

uninstall_tmux_server_systemd() {
  systemctl --user stop "$TMUX_SERVER_SERVICE" 2>/dev/null || true
  systemctl --user disable "$TMUX_SERVER_SERVICE" 2>/dev/null || true
  rm -f "$tmux_server_unit"
  systemctl --user daemon-reload
  echo "✓ Removed tmux-server.service (~/.tmux.conf unchanged — keeping 'exit-empty off' is harmless)"
}

install_systemd() {
  mkdir -p "$systemd_dir"

  install_tmux_server_systemd

  local env_lines="Environment=PORT=${PORT}\nEnvironment=HOST=${HOST}"
  if [[ -n "${AUTH:-}" ]]; then
    env_lines+="\nEnvironment=AUTH=${AUTH}"
  fi
  # TLS is optional but must be a matched cert+key pair. When set, also wire up the
  # HTTP->HTTPS redirect port (server/index.js only starts the redirect when TLS is on).
  if [[ -n "${TLS_CERT:-}" || -n "${TLS_KEY:-}" ]]; then
    if [[ -z "${TLS_CERT:-}" || -z "${TLS_KEY:-}" ]]; then
      echo "⚠ TLS_CERT and TLS_KEY must BOTH be set — skipping TLS (serving plain HTTP)" >&2
    else
      env_lines+="\nEnvironment=TLS_CERT=${TLS_CERT}"
      env_lines+="\nEnvironment=TLS_KEY=${TLS_KEY}"
      env_lines+="\nEnvironment=HTTP_PORT=${HTTP_PORT:-7680}"
    fi
  fi

  cat > "$systemd_unit" <<UNIT
[Unit]
Description=tmux web panel
After=network.target ${TMUX_SERVER_SERVICE}.service
Wants=${TMUX_SERVER_SERVICE}.service

[Service]
Type=simple
WorkingDirectory=${PROJECT_DIR}
ExecStart=${NODE_BIN} server/index.js
KillMode=process
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
  uninstall_tmux_server_systemd
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
  if [[ -n "${TLS_CERT:-}" || -n "${TLS_KEY:-}" ]]; then
    if [[ -z "${TLS_CERT:-}" || -z "${TLS_KEY:-}" ]]; then
      echo "⚠ TLS_CERT and TLS_KEY must BOTH be set — skipping TLS (serving plain HTTP)" >&2
    else
      env_keys+=("TLS_CERT"); env_vals+=("$TLS_CERT")
      env_keys+=("TLS_KEY"); env_vals+=("$TLS_KEY")
      env_keys+=("HTTP_PORT"); env_vals+=("${HTTP_PORT:-7680}")
    fi
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
