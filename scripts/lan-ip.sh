#!/usr/bin/env bash
# Print the LAN IP of the interface holding the default route.
# Prints nothing and still exits 0 when it cannot be determined, so callers
# (including launchd jobs) decide whether an offline machine is an error.
set -uo pipefail

if [[ "$(uname -s)" == "Darwin" ]]; then
  iface="$(route -n get default 2>/dev/null | awk '/interface:/{print $2; exit}')"
  if [[ -n "$iface" ]]; then
    ipconfig getifaddr "$iface" 2>/dev/null || true
  fi
else
  ip="$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}')"
  if [[ -z "$ip" ]] && command -v hostname &>/dev/null; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi
  if [[ -n "$ip" ]]; then
    printf '%s\n' "$ip"
  fi
fi

exit 0
