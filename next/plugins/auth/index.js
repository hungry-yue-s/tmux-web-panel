// `ctx.auth`: who may use this panel.
//
// - With AUTH (or desktop credentials): password + optional TOTP login at
//   /api/auth/login, opaque bearer tokens (24 h, or trusted = no expiry),
//   persisted owner-only across restarts, per-IP lockout before any scrypt.
// - A node-only install (NODE_ONLY=1) has no login: only the managing hub's
//   node token opens the API.
// - Either way every /api route and every WebSocket needs a token. The /n/
//   relay accepts login tokens only, so a node token cannot chain hubs.
//
// The logic is lib/auth.js and lib/totp.js, unchanged.

import { join } from 'node:path';
import express from 'express';
import {
  createLoginRateLimiter,
  createToken,
  deleteToken,
  flushTokenPersistence,
  initTokenPersistence,
  startTokenReaper,
  tokenAuth,
  verifyPassword,
  wsTokenAuth,
} from '../../lib/auth.js';
import { loadTotpSecret, totpFilePath, verifyTotp } from '../../lib/totp.js';
import { HttpError } from '../http/index.js';

export const name = 'auth';

export const inject = ['launch', 'http', 'node'];

function loginRouter({ tokens, credentials, configDir }) {
  const router = express.Router();
  const limiter = createLoginRateLimiter();

  router.post('/login', (req, res) => {
    const lockedUntil = limiter.isBlocked(req.ip);
    if (lockedUntil !== null) {
      const retryAfter = Math.max(1, Math.ceil((lockedUntil - Date.now()) / 1000));
      res.set('Retry-After', String(retryAfter));
      res.status(429).json({ success: false, data: null, error: `Too many failed attempts. Try again in ${retryAfter}s.` });
      return;
    }
    const { username, password, trusted, totp } = req.body || {};
    const passwordOk = username === credentials.username && password && verifyPassword(password, credentials.salt, credentials.hash);
    // Read per attempt so enrolling or removing MFA needs no restart.
    const totpSecret = loadTotpSecret(totpFilePath(configDir));
    const totpOk = !totpSecret || verifyTotp(totpSecret, String(totp ?? ''));
    if (passwordOk && totpOk) {
      limiter.recordSuccess(req.ip);
      const token = createToken(tokens, { trusted: !!trusted });
      res.json({ success: true, data: { token, trusted: !!trusted }, error: null });
      return;
    }
    limiter.recordFailure(req.ip);
    // One generic message: differing errors would reveal which factor matched.
    res.status(401).json({ success: false, data: null, error: 'Invalid credentials' });
  });

  router.post('/logout', (req, res) => {
    const parts = String(req.headers.authorization || '').split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer') deleteToken(tokens, parts[1]);
    res.json({ success: true, data: null, error: null });
  });

  return router;
}

export function apply(ctx) {
  const launch = ctx.launch;
  const node = ctx.node;
  const tokens = new Map();
  const enabled = Boolean(launch.auth);
  const guarded = Boolean(launch.auth || launch.nodeOnly);

  if (enabled) {
    // Restore persisted tokens (survives restarts); flushed again on unload.
    initTokenPersistence(tokens, join(launch.configDir, launch.tokenFileName));
    ctx.effect(() => {
      const timer = startTokenReaper(tokens);
      return () => {
        clearInterval(timer);
        flushTokenPersistence(tokens);
      };
    }, 'auth.tokens');
    ctx.http.mount('/api/auth', loginRouter({ tokens, credentials: launch.authCredentials, configDir: launch.configDir }));
  }

  const apiGuard = tokenAuth(tokens, { isServiceToken: node.isNodeToken });
  const loginOnly = tokenAuth(tokens);

  if (guarded) {
    // Everything under /api needs a token, except the login routes themselves.
    ctx.http.use((req, res, next) => {
      const path = req.path;
      if (!(path === '/api' || path.startsWith('/api/'))) return next();
      if (enabled && path.startsWith('/api/auth/')) return next();
      return apiGuard(req, res, next);
    });
    // Sockets that reach this panel itself (relayed ones were taken earlier).
    ctx.http.useUpgrade(({ req }) => {
      if (!wsTokenAuth(tokens, req, { isServiceToken: node.isNodeToken })) {
        throw new HttpError(401, 'AUTH_REQUIRED', 'Unauthorized');
      }
      return false;
    });
  }

  ctx.provide('auth', Object.freeze({
    enabled,
    guarded,
    tokens,
    /** Express middleware for routes that accept login tokens only (the /n/ relay). */
    loginOnly: guarded ? loginOnly : (_req, _res, next) => next(),
    /** A relayed WebSocket: login tokens only. */
    authorizeRelayUpgrade: (req) => !guarded || wsTokenAuth(tokens, req),
  }));
}
