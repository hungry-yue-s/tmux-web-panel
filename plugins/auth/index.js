// `ctx.auth`: who may use this panel.
//
// - With AUTH (or desktop credentials): password + optional TOTP login at
//   /api/auth/login, opaque bearer tokens (24 h, or trusted = no expiry),
//   persisted owner-only across restarts, per-IP lockout before any scrypt.
// - A node-only install (NODE_ONLY=1) has no login: only the managing hub's
//   node token opens the API.
// - Direct loopback Hub access may skip login; Node-only always requires a token.
//   All remote /api routes and WebSockets need a token. The /n/
//   relay accepts local access or login tokens, never a Node token.
//
// Shared checks live in lib/auth.js and lib/totp.js.

import { join } from 'node:path';
import express from 'express';
import {
  createLoginRateLimiter,
  createToken,
  deleteToken,
  flushTokenPersistence,
  initTokenPersistence,
  isTrustedLocalRequest,
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

export function apply(ctx, config = {}) {
  const launch = ctx.launch;
  const node = ctx.node;
  const tokens = new Map();
  const enabled = Boolean(launch.auth);
  const guarded = Boolean(launch.auth || launch.nodeOnly);
  const allowLocal = req => config.trustLocal !== false && !launch.nodeOnly
    && isTrustedLocalRequest(req, { isServiceToken: node.isNodeToken });

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

  const apiGuard = tokenAuth(tokens, { isServiceToken: node.isNodeToken, allowLocal });
  const loginOnly = tokenAuth(tokens, { allowLocal });

  // Whether this browser's login on this panel still holds: the page asks
  // when another server answered 401, which proves nothing about this login.
  const check = express.Router();
  check.get('/', (req, res, next) => (guarded ? loginOnly : (_req, _res, pass) => pass())(req, res, () => {
    res.json({ success: true, data: { authenticated: true }, error: null });
  }));
  ctx.http.mount('/api/auth/check', check);

  if (guarded) {
    // Everything under /api needs a token, except the login routes themselves.
    ctx.http.use((req, res, next) => {
      const path = req.path;
      if (req.method === 'GET' && path === '/login.html' && allowLocal(req)) return res.redirect('/');
      if (!(path === '/api' || path.startsWith('/api/'))) return next();
      if (enabled && path.startsWith('/api/auth/')) return next();
      return apiGuard(req, res, next);
    });
    // Sockets that reach this panel itself (relayed ones were taken earlier).
    ctx.http.useUpgrade(({ req }) => {
      if (!wsTokenAuth(tokens, req, { isServiceToken: node.isNodeToken, allowLocal })) {
        throw new HttpError(401, 'AUTH_REQUIRED', 'Unauthorized');
      }
      return false;
    });
  }

  // The login page and the script that keeps the token, where there are pages.
  ctx.inject(['ui'], (ctx) => ctx.ui.contribute(new URL('./client/page.json', import.meta.url)));

  ctx.provide('auth', Object.freeze({
    enabled,
    guarded,
    tokens,
    /** Hub users: trusted local requests or login tokens, never Node tokens. */
    loginOnly: guarded ? loginOnly : (_req, _res, next) => next(),
    /** Same Hub-user policy for relayed WebSockets. */
    authorizeRelayUpgrade: (req) => !guarded || wsTokenAuth(tokens, req, { allowLocal }),
  }));
}
