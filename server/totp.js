/**
 * TOTP two-factor authentication (RFC 6238).
 *
 * Deliberately dependency-free: HMAC-SHA1, 30s step, 6 digits, ±1 step
 * tolerance — the profile every authenticator app uses by default.
 *
 * The shared secret lives in a 0600 JSON file and is read per login attempt,
 * so enabling/disabling MFA needs no server restart.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_WINDOW_STEPS = 1;

export const TOTP_FILE = join(homedir(), '.config', 'tmux-web-panel', 'totp.json');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * @param {number} [bytes]
 * @returns {string} base32-encoded shared secret
 */
export function generateSecret(bytes = 20) {
  return base32Encode(randomBytes(bytes));
}

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(encoded) {
  const clean = encoded.replace(/=+$/, '').toUpperCase().replace(/[\s-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`invalid base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * @param {string} secretBase32
 * @param {number} [step] unix time divided by the step, overridable for tests
 * @returns {string} zero-padded code
 */
export function totpCode(secretBase32, step = Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS)) {
  const key = base32Decode(secretBase32);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/**
 * Constant-time check of a submitted code against the ±window step range.
 * @param {string} secretBase32
 * @param {string} code
 * @param {number} [windowSteps]
 * @returns {boolean}
 */
export function verifyTotp(secretBase32, code, windowSteps = TOTP_WINDOW_STEPS) {
  if (typeof code !== 'string' || code.length !== TOTP_DIGITS || !/^\d+$/.test(code)) {
    return false;
  }
  const now = Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);
  const submitted = Buffer.from(code);
  for (let delta = -windowSteps; delta <= windowSteps; delta += 1) {
    const expected = Buffer.from(totpCode(secretBase32, now + delta));
    if (timingSafeEqual(submitted, expected)) return true;
  }
  return false;
}

/**
 * @param {string} secretBase32
 * @param {string} account
 * @param {string} [issuer]
 * @returns {string} otpauth:// URI for QR enrolment
 */
export function otpauthUri(secretBase32, account, issuer = 'tmux-web-panel') {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}

/**
 * Read the enrolled secret, or null when MFA is not enabled.
 * @param {string} [path]
 * @returns {string | null}
 */
export function loadTotpSecret(path = TOTP_FILE) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed?.secret === 'string' && parsed.secret ? parsed.secret : null;
  } catch (_e) {
    return null;
  }
}

/**
 * Enrol a fresh secret, writing the file owner-only.
 * @param {string} [path]
 * @returns {string} the new base32 secret
 */
export function enrollTotp(path = TOTP_FILE) {
  const secret = generateSecret();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ secret }), { mode: 0o600 });
  chmodSync(path, 0o600);
  return secret;
}
