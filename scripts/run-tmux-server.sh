#!/usr/bin/env bash
set -euo pipefail

TMUX_BIN="${1:-tmux}"

# A server may already have been started interactively before this LaunchAgent
# was installed. Do not kill it (and its sessions) just to put it under launchd.
# Wait for that server to exit, then take ownership; after a reboot the loop is
# skipped and launchd starts the server immediately.
while "$TMUX_BIN" show-options -gqv exit-empty >/dev/null 2>&1; do
  sleep 5
done

exec "$TMUX_BIN" -D start-server
