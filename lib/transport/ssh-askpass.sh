#!/bin/sh
# OpenSSH invokes this locally; never interpolate a password into a command.
[ "${SSH_ASKPASS_PROMPT:-}" != confirm ] || exit 1
exec "$ANYMUX_NODE" "$ANYMUX_SSH_ASKPASS"
