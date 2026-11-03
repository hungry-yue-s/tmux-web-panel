import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import https from 'node:https';

import { NodeLink } from '../server/hub/node-link.js';

// HTTP events and time only: these fixtures open no socket, service, SSH or tmux.
function fixture() {
  const requests = [];
  vi.spyOn(https, 'request').mockImplementation((options, onResponse) => {
    const req = new EventEmitter();
    Object.assign(req, { options, destroyed: false, end: vi.fn() });
    req.destroy = vi.fn((err) => {
      if (req.destroyed) return;
      req.destroyed = true;
      queueMicrotask(() => {
        if (err) req.emit('error', err);
        req.emit('close');
      });
    });
    req.respond = (status = 200) => {
      const res = new EventEmitter();
      Object.assign(res, { statusCode: status, destroyed: false });
      res.destroy = vi.fn(() => { res.destroyed = true; });
      onResponse(res);
      return res;
    };
    requests.push(req);
    return req;
  });
  const connection = { id: 'direct-check-fixture', resolveTarget: vi.fn(async () => ({ host: '127.0.0.1', proxied: false })) };
  const link = new NodeLink({ connection, directCheckTimeoutMs: 100 });
  const child = { exitCode: null, kill: vi.fn() };
  const agent = { destroy: vi.fn() };
  const upgradeAgent = { destroy: vi.fn() };
  link._pairing = { tls: true, tlsFingerprint: 'synthetic-pin', token: 'synthetic-node-token', port: 1 };
  link._tunnel = { child, port: 1 };
  link._agent = agent;
  link._upgradeAgent = upgradeAgent;
  return { link, requests, connection, child, agent, upgradeAgent };
}

async function flush() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

function answer(req, data = { protocol: 1 }) {
  const res = req.respond();
  res.emit('data', Buffer.from(JSON.stringify({ success: true, data })));
  res.emit('end');
  res.emit('close');
  return res;
}

function expectHealthyForward(f) {
  expect(f.link.ready).toBe(true);
  expect(f.child.kill).not.toHaveBeenCalled();
  expect(f.agent.destroy).not.toHaveBeenCalled();
  expect(f.upgradeAgent.destroy).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('direct health check wall deadline', () => {
  it.each(['queued', 'connecting'])('ends a check that stays %s without depending on a socket timeout', async (phase) => {
    const f = fixture();
    const direct = f.link._directFor(f.link._pairing);
    await flush();
    expect(f.requests).toHaveLength(1);
    if (phase === 'connecting') f.requests[0].emit('socket', { connecting: true });
    await vi.advanceTimersByTimeAsync(100);
    await direct.checked;
    expect(direct).toMatchObject({ status: 'down', reason: 'etimedout', cancelCheck: null });
    expect(f.requests[0].destroy).toHaveBeenCalledWith(expect.objectContaining({ code: 'ETIMEDOUT' }));
    expectHealthyForward(f);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['aborted', 'close'])('settles an interrupted response on %s without marking the path up', async (event) => {
    const f = fixture();
    const direct = f.link._directFor(f.link._pairing);
    await flush();
    const res = f.requests[0].respond();
    res.emit('data', Buffer.from('{'));
    res.emit(event);
    await direct.checked;
    expect(direct).toMatchObject({ status: 'down', reason: 'econnreset' });
    expect(res.destroy).toHaveBeenCalledOnce();
    res.emit('end');
    expect(direct.status).toBe('down');
    expectHealthyForward(f);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['reset', 'close'])('cancels a pending check on link %s and ignores a late answer', async (operation) => {
    const f = fixture();
    const direct = f.link._directFor(f.link._pairing);
    await flush();
    f.link[operation]();
    await direct.checked;
    expect(f.requests[0].destroyed).toBe(true);
    expect(f.link._direct).toBeNull();
    const late = f.requests[0].respond();
    expect(late.destroy).toHaveBeenCalledOnce();
    expect(() => late.emit('error', Object.assign(new Error('late response reset'), { code: 'ECONNRESET' }))).not.toThrow();
    expect(direct.status).not.toBe('up');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds target resolution too, without starting an HTTP check after the deadline', async () => {
    const f = fixture();
    let release;
    f.connection.resolveTarget.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const direct = f.link._directFor(f.link._pairing);
    await flush();
    await vi.advanceTimersByTimeAsync(100);
    await direct.checked;
    expect(direct.reason).toBe('etimedout');
    release({ host: '127.0.0.1', proxied: false });
    await flush();
    expect(f.requests).toHaveLength(0);
    expectHealthyForward(f);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses only the remaining wall budget after target resolution', async () => {
    const f = fixture();
    let release;
    f.connection.resolveTarget.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const direct = f.link._directFor(f.link._pairing);
    await flush();
    await vi.advanceTimersByTimeAsync(60);
    release({ host: '127.0.0.1', proxied: false });
    await flush();
    expect(f.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(40);
    await direct.checked;
    expect(direct.reason).toBe('etimedout');
    expectHealthyForward(f);
  });

  it('cancels a check still resolving its target without reviving it afterwards', async () => {
    const f = fixture();
    let release;
    f.connection.resolveTarget.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const direct = f.link._directFor(f.link._pairing);
    await flush();
    f.link.reset();
    await direct.checked;
    release({ host: '127.0.0.1', proxied: false });
    await flush();
    expect(f.requests).toHaveLength(0);
    expect(f.link._direct).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears its deadline after a complete successful answer', async () => {
    const f = fixture();
    const direct = f.link._directFor(f.link._pairing);
    await flush();
    answer(f.requests[0]);
    await direct.checked;
    expect(direct).toMatchObject({ status: 'up', cancelCheck: null });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(f.requests[0].destroyed).toBe(false);
    expectHealthyForward(f);
  });
});

describe('internal JSON request wall deadline', () => {
  it.each(['queued', 'connecting'])('bounds a %s request without dropping the shared forward', async (phase) => {
    const f = fixture();
    const result = f.link.requestJson('GET', '/api/node/info', undefined, { timeout: 100 }).catch((err) => err);
    await flush();
    if (phase === 'connecting') f.requests[0].emit('socket', { connecting: true });
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toMatchObject({ code: 'SSH_TIMEOUT' });
    expect(f.requests[0].destroy).toHaveBeenCalledWith(expect.objectContaining({ code: 'ETIMEDOUT' }));
    expectHealthyForward(f);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['aborted', 'close'])('rejects an interrupted JSON response on %s with its original transport classification', async (event) => {
    const f = fixture();
    const result = f.link.requestJson('GET', '/api/node/info', undefined, { timeout: 100 }).catch((err) => err);
    await flush();
    f.requests[0].respond().emit(event);
    expect(await result).toMatchObject({ code: 'NODE_NOT_RUNNING', transportCode: 'ECONNRESET' });
    expectHealthyForward(f);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles a request that closes before any response arrives', async () => {
    const f = fixture();
    const result = f.link.requestJson('GET', '/api/node/info', undefined, { timeout: 100 }).catch((err) => err);
    await flush();
    f.requests[0].emit('close');
    expect(await result).toMatchObject({ code: 'NODE_NOT_RUNNING' });
    expectHealthyForward(f);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('absorbs late TLS teardown errors after reporting the first transport failure', async () => {
    const f = fixture();
    const result = f.link.requestJson('GET', '/api/node/info', undefined, { timeout: 100 }).catch((err) => err);
    await flush();
    f.requests[0].emit('error', Object.assign(new Error('synthetic reset'), { code: 'ECONNRESET' }));
    expect(await result).toMatchObject({ code: 'NODE_NOT_RUNNING' });
    await flush();
    expect(() => f.requests[0].emit('error', Object.assign(new Error('late socket hang up'), { code: 'ECONNRESET' }))).not.toThrow();
    expectHealthyForward(f);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the existing fresh health confirmation after an interrupted first answer', async () => {
    const f = fixture();
    const result = f.link.info();
    await flush();
    expect(f.requests[0].options.agent).toBe(f.agent);
    f.requests[0].respond().emit('aborted');
    await flush();
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1].options.agent).toBe(f.upgradeAgent);
    answer(f.requests[1], { protocol: 1, hostname: 'fixture' });
    expect(await result).toEqual({ protocol: 1, hostname: 'fixture' });
    expectHealthyForward(f);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the timer on success rather than cutting off a healthy connection later', async () => {
    const f = fixture();
    const result = f.link.requestJson('GET', '/api/node/info', undefined, { timeout: 100 });
    await flush();
    answer(f.requests[0], { protocol: 1 });
    expect(await result).toEqual({ protocol: 1 });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(f.requests[0].destroyed).toBe(false);
    expectHealthyForward(f);
  });
});
