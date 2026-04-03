/**
 * Token-based session authentication.
 *
 * Replaces HTTP Basic Auth with opaque bearer tokens stored in an
 * in-memory Map with configurable TTL.
 */

import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const TOKEN_REAP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const TOKEN_LENGTH = 32;

/**
 * Hash a password with a random salt using scrypt.
 * @param {string} password
 * @returns {{ salt: string, hash: string }} hex-encoded salt and hash
 */
export function hashPassword(password) {
  const salt = randomBytes(SALT_LENGTH).toString('hex');
  const hash = scryptSync(password, salt, KEY_LENGTH).toString('hex');
  return { salt, hash };
}

/**
 * Verify a password against a stored salt+hash using timing-safe comparison.
 * @param {string} password
 * @param {string} salt - hex-encoded
 * @param {string} hash - hex-encoded
 * @returns {boolean}
 */
export function verifyPassword(password, salt, hash) {
  const derived = scryptSync(password, salt, KEY_LENGTH);
  const expected = Buffer.from(hash, 'hex');
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/**
 * Create a new session token and store it in the map.
 * @param {Map} tokenMap
 * @returns {string} hex-encoded token
 */
export function createToken(tokenMap) {
  const token = randomBytes(TOKEN_LENGTH).toString('hex');
  tokenMap.set(token, {
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return token;
}

/**
 * Delete a token from the map.
 * @param {Map} tokenMap
 * @param {string} token
 */
export function deleteToken(tokenMap, token) {
  tokenMap.delete(token);
}

/**
 * Validate a token: exists and not expired.
 * Removes expired tokens as a side effect.
 * @param {Map} tokenMap
 * @param {string} token
 * @returns {boolean}
 */
function isValidToken(tokenMap, token) {
  if (!token || !tokenMap.has(token)) return false;
  const entry = tokenMap.get(token);
  if (Date.now() >= entry.expiresAt) {
    tokenMap.delete(token);
    return false;
  }
  return true;
}

/**
 * Extract Bearer token from Authorization header.
 * @param {string|undefined} header
 * @returns {string|null}
 */
function parseBearerToken(header) {
  if (!header || typeof header !== 'string') return null;
  const parts = header.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null;
  return parts[1];
}

/**
 * Express middleware that requires a valid Bearer token.
 * For HTML requests (Accept: text/html), redirects to /login.html.
 * For API requests, returns 401 JSON.
 *
 * @param {Map} tokenMap
 * @returns {import('express').RequestHandler}
 */
export function tokenAuth(tokenMap) {
  return (req, res, next) => {
    const token = parseBearerToken(req.headers.authorization);

    if (isValidToken(tokenMap, token)) {
      next();
      return;
    }

    const accept = req.headers.accept || '';
    if (accept.includes('text/html')) {
      res.redirect('/login.html');
      return;
    }

    res.status(401).json({
      success: false,
      data: null,
      error: 'Authentication required',
    });
  };
}

/**
 * Validate a WebSocket upgrade request by checking the ?token= query param.
 *
 * @param {Map} tokenMap
 * @param {import('http').IncomingMessage} req
 * @returns {boolean}
 */
export function wsTokenAuth(tokenMap, req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  return isValidToken(tokenMap, token);
}

/**
 * Start a periodic reaper that removes expired tokens from the map.
 * @param {Map} tokenMap
 * @returns {ReturnType<typeof setInterval>} timer handle (for cleanup)
 */
export function startTokenReaper(tokenMap) {
  return setInterval(() => {
    const now = Date.now();
    for (const [token, entry] of tokenMap) {
      if (now >= entry.expiresAt) {
        tokenMap.delete(token);
      }
    }
  }, TOKEN_REAP_INTERVAL_MS);
}
