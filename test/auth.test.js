import { describe, it, expect, beforeEach } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  createToken,
  deleteToken,
  tokenAuth,
  wsTokenAuth,
  SESSION_TTL_MS,
} from '../server/auth.js';

describe('hashPassword', () => {
  it('returns an object with salt and hash', () => {
    const result = hashPassword('secret');
    expect(result).toHaveProperty('salt');
    expect(result).toHaveProperty('hash');
    expect(typeof result.salt).toBe('string');
    expect(typeof result.hash).toBe('string');
  });

  it('produces different salts for same password', () => {
    const a = hashPassword('secret');
    const b = hashPassword('secret');
    expect(a.salt).not.toBe(b.salt);
  });

  it('produces hex-encoded strings', () => {
    const { salt, hash } = hashPassword('test');
    expect(salt).toMatch(/^[0-9a-f]+$/);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });
});

describe('verifyPassword', () => {
  it('returns true for correct password', () => {
    const { salt, hash } = hashPassword('mypassword');
    expect(verifyPassword('mypassword', salt, hash)).toBe(true);
  });

  it('returns false for wrong password', () => {
    const { salt, hash } = hashPassword('mypassword');
    expect(verifyPassword('wrongpassword', salt, hash)).toBe(false);
  });

  it('returns false for empty password against non-empty', () => {
    const { salt, hash } = hashPassword('mypassword');
    expect(verifyPassword('', salt, hash)).toBe(false);
  });
});

describe('createToken / deleteToken', () => {
  let tokenMap;

  beforeEach(() => {
    tokenMap = new Map();
  });

  it('creates a hex token string', () => {
    const token = createToken(tokenMap);
    expect(typeof token).toBe('string');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stores the token in the map with expiresAt', () => {
    const token = createToken(tokenMap);
    expect(tokenMap.has(token)).toBe(true);
    const entry = tokenMap.get(token);
    expect(entry).toHaveProperty('expiresAt');
    expect(entry.expiresAt).toBeGreaterThan(Date.now());
  });

  it('deleteToken removes token from map', () => {
    const token = createToken(tokenMap);
    expect(tokenMap.has(token)).toBe(true);
    deleteToken(tokenMap, token);
    expect(tokenMap.has(token)).toBe(false);
  });

  it('deleteToken is a no-op for unknown token', () => {
    deleteToken(tokenMap, 'nonexistent');
    expect(tokenMap.size).toBe(0);
  });
});

describe('tokenAuth middleware', () => {
  let tokenMap;
  let middleware;
  let validToken;

  beforeEach(() => {
    tokenMap = new Map();
    middleware = tokenAuth(tokenMap);
    validToken = createToken(tokenMap);
  });

  function mockReq(headers = {}, accept) {
    return {
      headers: { ...headers, accept: accept || 'application/json' },
      query: {},
    };
  }

  function mockRes() {
    const res = {
      _status: 200,
      _body: null,
      _redirectUrl: null,
      status(code) { res._status = code; return res; },
      json(body) { res._body = body; return res; },
      redirect(url) { res._redirectUrl = url; return res; },
    };
    return res;
  }

  it('calls next() for valid Bearer token', () => {
    const req = mockReq({ authorization: `Bearer ${validToken}` });
    const res = mockRes();
    let called = false;
    middleware(req, res, () => { called = true; });
    expect(called).toBe(true);
  });

  it('returns 401 JSON for missing token', () => {
    const req = mockReq({});
    const res = mockRes();
    let called = false;
    middleware(req, res, () => { called = true; });
    expect(called).toBe(false);
    expect(res._status).toBe(401);
    expect(res._body).toHaveProperty('error');
  });

  it('returns 401 JSON for invalid token', () => {
    const req = mockReq({ authorization: 'Bearer badtoken' });
    const res = mockRes();
    let called = false;
    middleware(req, res, () => { called = true; });
    expect(called).toBe(false);
    expect(res._status).toBe(401);
  });

  it('redirects to /login.html for HTML requests without token', () => {
    const req = mockReq({}, 'text/html');
    const res = mockRes();
    let called = false;
    middleware(req, res, () => { called = true; });
    expect(called).toBe(false);
    expect(res._redirectUrl).toBe('/login.html');
  });

  it('rejects expired token', () => {
    const expiredToken = createToken(tokenMap);
    // Manually expire it
    tokenMap.get(expiredToken).expiresAt = Date.now() - 1000;
    const req = mockReq({ authorization: `Bearer ${expiredToken}` });
    const res = mockRes();
    let called = false;
    middleware(req, res, () => { called = true; });
    expect(called).toBe(false);
    expect(res._status).toBe(401);
    // Expired token should be cleaned up
    expect(tokenMap.has(expiredToken)).toBe(false);
  });
});

describe('wsTokenAuth', () => {
  let tokenMap;

  beforeEach(() => {
    tokenMap = new Map();
  });

  it('returns true for valid token in query', () => {
    const token = createToken(tokenMap);
    const req = { url: `/ws/status?token=${token}`, headers: { host: 'localhost' } };
    expect(wsTokenAuth(tokenMap, req)).toBe(true);
  });

  it('returns false for missing token', () => {
    const req = { url: '/ws/status', headers: { host: 'localhost' } };
    expect(wsTokenAuth(tokenMap, req)).toBe(false);
  });

  it('returns false for invalid token', () => {
    const req = { url: '/ws/status?token=badtoken', headers: { host: 'localhost' } };
    expect(wsTokenAuth(tokenMap, req)).toBe(false);
  });

  it('returns false for expired token', () => {
    const token = createToken(tokenMap);
    tokenMap.get(token).expiresAt = Date.now() - 1000;
    const req = { url: `/ws/status?token=${token}`, headers: { host: 'localhost' } };
    expect(wsTokenAuth(tokenMap, req)).toBe(false);
  });
});

describe('SESSION_TTL_MS', () => {
  it('is 24 hours in milliseconds', () => {
    expect(SESSION_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});
