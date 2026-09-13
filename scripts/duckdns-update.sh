#!/usr/bin/env bash
# Publish this machine's current LAN IP to Duck DNS.
#
# The record is NOT used as a resolvable name for connecting: this network's DNS
# (29.29.29.29) answers every external domain with a transparent proxy that
# cannot route back to the LAN. It is used as a key/value store read back over
# DNS-over-HTTPS from elsewhere, e.g.
#   https://dns.alidns.com/resolve?name=tmux-panel.duckdns.org&type=A
# which returns the real IP; the phone then connects to that IP directly.
#
# The HTTP call is skipped when the IP has not moved since the last successful
# push. Pass --force to push anyway.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="${DUCKDNS_CONFIG:-$HOME/.config/tmux-web-panel/duckdns.env}"
STATE_DIR="${DUCKDNS_STATE_DIR:-$HOME/.cache/tmux-web-panel}"
STATE_FILE="$STATE_DIR/duckdns-ip"

if [[ ! -r "$CONFIG" ]]; then
  echo "duckdns-update: missing config $CONFIG" >&2
  echo "  Create it with DUCKDNS_DOMAIN and DUCKDNS_TOKEN, then chmod 600." >&2
  exit 1
fi

# shellcheck source=/dev/null
set -a; . "$CONFIG"; set +a

if [[ -z "${DUCKDNS_DOMAIN:-}" || -z "${DUCKDNS_TOKEN:-}" ]]; then
  echo "duckdns-update: $CONFIG must set DUCKDNS_DOMAIN and DUCKDNS_TOKEN" >&2
  exit 1
fi

ip="$("$SCRIPT_DIR/lan-ip.sh")"
if [[ -z "$ip" ]]; then
  echo "duckdns-update: no LAN IP (offline?) — nothing to do"
  exit 0
fi

if [[ "${1:-}" != "--force" && -r "$STATE_FILE" ]] && [[ "$(cat "$STATE_FILE")" == "$ip" ]]; then
  exit 0
fi

response="$(curl -fsS --max-time 20 --get 'https://www.duckdns.org/update' \
  --data-urlencode "domains=$DUCKDNS_DOMAIN" \
  --data-urlencode "token=$DUCKDNS_TOKEN" \
  --data-urlencode "ip=$ip" 2>&1)"
curl_status=$?

if [[ $curl_status -ne 0 ]]; then
  echo "duckdns-update: request failed: $response" >&2
  exit 1
fi

if [[ "$response" != "OK" ]]; then
  echo "duckdns-update: Duck DNS rejected the update: $response" >&2
  exit 1
fi

mkdir -p "$STATE_DIR"
printf '%s\n' "$ip" > "$STATE_FILE"
echo "duckdns-update: ${DUCKDNS_DOMAIN}.duckdns.org -> $ip"
