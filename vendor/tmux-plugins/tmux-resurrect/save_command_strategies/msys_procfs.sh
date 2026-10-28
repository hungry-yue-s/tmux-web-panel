#!/usr/bin/env bash

# MSYS2/Cygwin: ps has no -o and there is no pgrep, but /proc lists every
# process (native Windows programs included) with its ppid and cmdline.

PANE_PID="$1"

[ -z "$PANE_PID" ] && exit 0

for dir in /proc/[0-9]*; do
	[ "$(cat "$dir/ppid" 2>/dev/null)" = "$PANE_PID" ] || continue
	xargs -0 bash -c 'printf "%q " "$0" "$@"' < "$dir/cmdline"
	exit 0
done
