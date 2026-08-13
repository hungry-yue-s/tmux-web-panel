#!/usr/bin/env bash
set -euo pipefail

TMUX_BIN="${1:-tmux}"

# launchd starts user agents with a minimal PATH. Theme and persistence
# plugins commonly invoke `tmux` by name, so make the selected binary visible
# to every run-shell command started by the server.
if [[ "$TMUX_BIN" == */* ]]; then
  TMUX_BIN_DIR="${TMUX_BIN%/*}"
else
  TMUX_BIN_PATH="$(command -v "$TMUX_BIN")"
  TMUX_BIN_DIR="${TMUX_BIN_PATH%/*}"
fi
export PATH="$TMUX_BIN_DIR:${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"

# A server may already have been started interactively before this LaunchAgent
# was installed. Do not kill it (and its sessions) just to put it under launchd.
# Wait for that server to exit, then take ownership; after a reboot the loop is
# skipped and launchd starts the server immediately.
while "$TMUX_BIN" show-options -gqv exit-empty >/dev/null 2>&1; do
  sleep 5
done

# -D keeps the server in the foreground for launchd and disables exit-empty.
# tmux explicitly forbids combining -D with a command such as start-server.
exec "$TMUX_BIN" -D
