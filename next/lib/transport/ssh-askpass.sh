#!/bin/sh
# OpenSSH invokes this locally; never interpolate a password into a command.
[ "${SSH_ASKPASS_PROMPT:-}" != confirm ] || exit 1
exec "$TMUX_PANEL_NODE" "$TMUX_PANEL_SSH_ASKPASS"
