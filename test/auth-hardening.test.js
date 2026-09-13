import { describe, it, expect } from 'vitest';
import { createToken, createLoginRateLimiter, tokenAuth } from '../server/auth.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('createLoginRateLimiter', () => {
  it('allows attempts until the failure budget is spent', () => {
    const limiter = createLoginRateLimiter({ maxFailures: 3, lockMs: 5000 });
    expect(limiter.isBlocked('1.2.3.4')).toBeNull();
    limiter.recordFailure('1.2.3.4');
    limiter.recordFailure('1.2.3.4');
    expect(limiter.isBlocked('1.2.3.4')).toBeNull();
    limiter.recordFailure('1.2.3.4');
    expect(typeof limiter.isBlocked('1.2.3.4')).toBe('number');
  });

  it('tracks IPs independently', () => {
    const limiter = createLoginRateLimiter({ maxFailures: 1, lockMs: 5000 });
    limiter.recordFailure('1.1.1.1');
    expect(typeof limiter.isBlocked('1.1.1.1')).toBe('number');
    expect(limiter.isBlocked('2.2.2.2')).toBeNull();
  });

  it('clears the record on success', () => {
    const limiter = createLoginRateLimiter({ maxFailures: 2, lockMs: 5000 });
    limiter.recordFailure('1.2.3.4');
    limiter.recordSuccess('1.2.3.4');
    limiter.recordFailure('1.2.3.4');
    expect(limiter.isBlocked('1.2.3.4')).toBeNull();
  });

  it('unlocks after the lock period', async () => {
    const limiter = createLoginRateLimiter({ maxFailures: 1, lockMs: 40 });
    limiter.recordFailure('1.2.3.4');
    expect(typeof limiter.isBlocked('1.2.3.4')).toBe('number');
    await sleep(60);
    expect(limiter.isBlocked('1.2.3.4')).toBeNull();
  });
});

function runTokenAuth(req, tokenMap) {
  const res = {
    statusCode: null,
    redirectedTo: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    redirect(url) { this.redirectedTo = url; return this; },
    set() { return this; },
  };
  let nextCalled = false;
  tokenAuth(tokenMap)(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

describe('tokenAuth query-token narrowing', () => {
  it('still accepts ?token= for subresource requests', () => {
    const tokenMap = new Map();
    const token = createToken(tokenMap);
    const res = {
      statusCode: null,
      redirectedTo: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; },
      redirect(url) { this.redirectedTo = url; return this; },
      set() { return this; },
    };
    let nextCalled = false;
    tokenAuth(tokenMap)(
      { headers: { accept: 'image/png' }, query: { token } },
      res,
      () => { nextCalled = true; },
    );
    expect(nextCalled).toBe(true);
  });

  it('refuses ?token= for HTML navigation so tokens stay out of page URLs', () => {
    const tokenMap = new Map();
    const token = createToken(tokenMap);
    const { res, nextCalled } = runTokenAuth({
      headers: { accept: 'text/html,application/xhtml+xml' },
      query: { token },
    }, tokenMap);
    expect(nextCalled).toBe(false);
    expect(res.redirectedTo).toBe('/login.html');
  });

  it('keeps accepting the Authorization header for HTML navigation', () => {
    const tokenMap = new Map();
    const token = createToken(tokenMap);
    const { nextCalled } = runTokenAuth({
      headers: { accept: 'text/html', authorization: `Bearer ${token}` },
      query: {},
    }, tokenMap);
    expect(nextCalled).toBe(true);
  });
});
