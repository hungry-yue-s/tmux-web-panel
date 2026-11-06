#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source_directory="${1:?Usage: apply-tmux-patches.sh SOURCE_DIRECTORY}"
for patch_file in "$SCRIPT_DIR/tmux-patches/startup-config-once.patch" \
                  "$SCRIPT_DIR/tmux-patches/local-workbench.patch" \
                  "$SCRIPT_DIR/tmux-patches/native-client.patch"; do
  patch -t -N -p1 -d "$source_directory" < "$patch_file"
done
