#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
patch -t -N -p1 -d "${1:?Usage: apply-tmux-patches.sh SOURCE_DIRECTORY}" \
  < "$SCRIPT_DIR/tmux-patches/startup-config-once.patch"
