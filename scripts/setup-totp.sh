#!/usr/bin/env bash
# Enrol (or re-enrol) TOTP two-factor for the panel login and print a QR code.
#
# The secret is written owner-only to ~/.config/tmux-web-panel/totp.json. The
# panel reads it on every login attempt, so enabling or disabling MFA needs no
# restart. To disable MFA, delete that file.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ACCOUNT="${TOTP_ACCOUNT:-${USER:-panel}}"

out="$(node --input-type=module -e "
import { enrollTotp, otpauthUri, totpCode } from '${PROJECT_DIR}/server/totp.js';
const secret = enrollTotp();
console.log(secret);
console.log(otpauthUri(secret, '${ACCOUNT}'));
console.log(totpCode(secret));
")"

secret="$(printf '%s\n' "$out" | sed -n 1p)"
uri="$(printf '%s\n' "$out" | sed -n 2p)"
code="$(printf '%s\n' "$out" | sed -n 3p)"

echo "Secret (base32, for manual entry): $secret"
echo ""
echo "otpauth URI:"
echo "  $uri"
echo ""
if command -v qrencode &>/dev/null; then
  echo "Scan with your authenticator app:"
  qrencode -t ANSIUTF8 -m 2 "$uri"
else
  echo "(install qrencode for a scannable code: brew install qrencode)"
fi
echo ""
echo "Self-check — the code valid right now is $code."
echo "Log in with password + this kind of code from now on."
