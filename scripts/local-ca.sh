#!/usr/bin/env bash
# Maintain a local CA plus a panel leaf certificate covering the current LAN IP.
#
# Install ca.crt on the phone once. The leaf is re-issued whenever DHCP moves
# the IP, so the browser never sees a name mismatch — the CA stays trusted.
#
# NOTE: this replaces install-service.sh's TLS_AUTO self-signed certificate as
# the source of truth for TLS_CERT/TLS_KEY. Re-running that installer with
# TLS_AUTO=1 will overwrite the CA-signed leaf; re-run this script afterwards.
#
# Exit codes: 0 = leaf already current, 10 = leaf re-issued (restart the panel),
#             1 = error.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CA_DIR="${CA_DIR:-$HOME/.config/tmux-web-panel/ca}"
TLS_DIR="${TLS_DIR:-$HOME/.config/tmux-web-panel/tls}"
CA_DAYS="${CA_DAYS:-3650}"
LEAF_DAYS="${LEAF_DAYS:-825}"
RENEW_MARGIN="${RENEW_MARGIN:-2592000}" # re-issue 30 days before expiry

CA_KEY="$CA_DIR/ca.key"
CA_CRT="$CA_DIR/ca.crt"
LEAF_KEY="$TLS_DIR/key.pem"
LEAF_CRT="$TLS_DIR/cert.pem"

ip="$("$SCRIPT_DIR/lan-ip.sh")"
if [[ -z "$ip" ]]; then
  echo "local-ca: no LAN IP (offline?) — nothing to do"
  exit 0
fi
host="$(hostname)"
short="${host%%.*}"

ensure_ca() {
  mkdir -p "$CA_DIR"
  chmod 700 "$CA_DIR"
  if [[ -f "$CA_KEY" && -f "$CA_CRT" ]] \
     && openssl x509 -in "$CA_CRT" -noout -checkend "$RENEW_MARGIN" &>/dev/null; then
    return 0
  fi
  if ! openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days "$CA_DAYS" \
      -keyout "$CA_KEY" -out "$CA_CRT" \
      -subj "/CN=tmux-web-panel local CA" \
      -addext "basicConstraints=critical,CA:TRUE" \
      -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null; then
    echo "local-ca: failed to generate CA" >&2
    return 1
  fi
  chmod 600 "$CA_KEY"
  echo "local-ca: generated CA — install this on the phone: $CA_CRT"
}

leaf_is_current() {
  [[ -f "$LEAF_CRT" && -f "$LEAF_KEY" ]] || return 1
  openssl x509 -in "$LEAF_CRT" -noout -checkend "$RENEW_MARGIN" &>/dev/null || return 1
  openssl verify -CAfile "$CA_CRT" "$LEAF_CRT" &>/dev/null || return 1
  local details
  details="$(openssl x509 -in "$LEAF_CRT" -noout -text 2>/dev/null)" || return 1
  grep -Fq "IP Address:${ip}" <<<"$details" || return 1
  grep -Fq "DNS:localhost" <<<"$details" || return 1
  [[ "$(openssl x509 -in "$LEAF_CRT" -noout -pubkey 2>/dev/null)" \
   == "$(openssl pkey -in "$LEAF_KEY" -pubout 2>/dev/null)" ]]
}

issue_leaf() {
  mkdir -p "$TLS_DIR"
  chmod 700 "$TLS_DIR"

  local cnf csr
  cnf="$(mktemp "${TMPDIR:-/tmp}/local-ca.XXXXXX")"
  csr="$TLS_DIR/.leaf.csr"
  {
    printf '%s\n' '[req]' 'distinguished_name = dn' 'req_extensions = v3_req' 'prompt = no'
    printf '%s\n' '[dn]' "CN = ${short}"
    printf '%s\n' '[v3_req]' 'basicConstraints = critical,CA:FALSE' \
      'keyUsage = critical,digitalSignature,keyEncipherment' \
      'extendedKeyUsage = serverAuth' 'subjectAltName = @alt_names'
    printf '%s\n' '[alt_names]' 'DNS.1 = localhost' "DNS.2 = ${host}" "DNS.3 = ${short}" \
      'IP.1 = 127.0.0.1' "IP.2 = ${ip}"
  } > "$cnf"

  if ! openssl req -new -newkey rsa:2048 -nodes \
        -keyout "$LEAF_KEY" -out "$csr" -config "$cnf" 2>/dev/null \
     || ! openssl x509 -req -in "$csr" -CA "$CA_CRT" -CAkey "$CA_KEY" -CAcreateserial \
          -out "$LEAF_CRT" -days "$LEAF_DAYS" -sha256 \
          -extfile "$cnf" -extensions v3_req 2>/dev/null; then
    rm -f "$cnf" "$csr"
    echo "local-ca: failed to issue leaf certificate" >&2
    return 1
  fi

  rm -f "$cnf" "$csr"
  chmod 600 "$LEAF_KEY"
  chmod 644 "$LEAF_CRT"
}

ensure_ca || exit 1

if [[ "${1:-}" != "--force" ]] && leaf_is_current; then
  exit 0
fi

issue_leaf || exit 1
echo "local-ca: issued leaf for $ip"
exit 10
