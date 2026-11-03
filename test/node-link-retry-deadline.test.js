import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

import { NodeLink } from '../server/hub/node-link.js';

// Only the HTTP client's events are simulated: no listener, SSH process or tmux.
// The real relay and stallGuard must account for time across all retry phases.
function relayFixture({ read = 5000, connect = 10000 } = {}) {
  const requests = [];
  const child = { exitCode: null, kill: vi.fn() };
  const agent = { destroy: vi.fn() };
  const upgradeAgent = { destroy: vi.fn() };
  const link = new NodeLink({ connection: { id: 'retry-fixture' }, stallLimits: { read, connect } });
  link._pairing = { token: 'synthetic-node-token', tls: false };
  link._tunnel = { port: 1, child };
  link._agent = agent;
  link._upgradeAgent = upgradeAgent;
  link._client = () => ({
    request(options, onResponse) {
      const upstream = new EventEmitter();
      upstream.options = options;
      upstream.destroyed = false;
      upstream.end = vi.fn();
      upstream.destroy = vi.fn((err) => {
        if (upstream.destroyed) return;
        upstream.destroyed = true;
        queueMicrotask(() => {
          if (err) upstream.emit('error', err);
          upstream.emit('close');
        });
      });
      upstream.once('response', onResponse);
      requests.push(upstream);
      return upstream;
    },
  });
  const browser = new EventEmitter();
  Object.assign(browser, {
    destroyed: false, writableEnded: false, writableFinished: false, headersSent: false,
    status: vi.fn(function (status) { this.statusCode = status; return this; }),
    json: vi.fn(function (body) { this.body = body; this.writableEnded = this.writableFinished = true; }),
    writeHead: vi.fn(function (status) { this.statusCode = status; this.headersSent = true; }),
    destroy: vi.fn(function () { this.destroyed = true; this.emit('close'); }),
  });
  const request = { method: 'GET', headers: {}, pipe(upstream) { upstream.end(); return upstream; } };
  return { link, requests, child, agent, upgradeAgent, browser,
    start: () => link.proxy(request, browser, '/api/git/status') };
}

function assignSocket(request, { connecting = false } = {}) {
  const socket = new EventEmitter();
  socket.connecting = connecting;
  request.emit('socket', socket);
  return socket;
}

function finishRequest(request) {
  request.emit('finish');
}

async function startRetry(fixture, elapsed = 1000) {
  await fixture.start();
  assignSocket(fixture.requests[0]);
  finishRequest(fixture.requests[0]);
  await vi.advanceTimersByTimeAsync(elapsed);
  fixture.requests[0].destroy(Object.assign(new Error('synthetic reset'), { code: 'ECONNRESET' }));
  await Promise.resolve();
  expect(fixture.requests).toHaveLength(2);
  expect(fixture.requests[1].options.agent).toBe(fixture.upgradeAgent);
  return fixture.requests[1];
}

function expectHealthyLink(fixture) {
  expect(fixture.link.ready).toBe(true);
  expect(fixture.child.kill).not.toHaveBeenCalled();
  expect(fixture.agent.destroy).not.toHaveBeenCalled();
  expect(fixture.upgradeAgent.destroy).not.toHaveBeenCalled();
}

describe('relayed read retry deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('charges a slow retry connection to the original answer deadline', async () => {
    const fixture = relayFixture();
    const retry = await startRetry(fixture);
    const socket = assignSocket(retry, { connecting: true });
    await vi.advanceTimersByTimeAsync(2500);
    socket.connecting = false;
    socket.emit('connect');
    finishRequest(retry);
    await vi.advanceTimersByTimeAsync(1499);
    expect(fixture.browser.writableEnded).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.browser.statusCode).toBe(504);
    expect(retry.destroyed).toBe(true);
    expectHealthyLink(fixture);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('charges both retry pool waiting and connecting before waiting for its answer', async () => {
    const fixture = relayFixture();
    const retry = await startRetry(fixture);
    await vi.advanceTimersByTimeAsync(1500);
    const socket = assignSocket(retry, { connecting: true });
    await vi.advanceTimersByTimeAsync(1000);
    socket.connecting = false;
    socket.emit('connect');
    finishRequest(retry);
    await vi.advanceTimersByTimeAsync(1500);
    expect(fixture.browser.statusCode).toBe(504);
    expect(retry.destroyed).toBe(true);
    expectHealthyLink(fixture);
  });

  it('ends only the retry when its short budget runs out while connecting', async () => {
    const fixture = relayFixture();
    const retry = await startRetry(fixture, 3500);
    assignSocket(retry, { connecting: true });
    await vi.advanceTimersByTimeAsync(1500);
    expect(fixture.browser.statusCode).toBe(504);
    expect(fixture.browser.json).toHaveBeenCalledOnce();
    expect(retry.destroyed).toBe(true);
    expectHealthyLink(fixture);
  });

  it('keeps the deadline while a connected retry has not finished sending', async () => {
    const fixture = relayFixture();
    const retry = await startRetry(fixture);
    assignSocket(retry);
    await vi.advanceTimersByTimeAsync(4000);
    expect(fixture.browser.statusCode).toBe(504);
    expect(retry.destroyed).toBe(true);
    expectHealthyLink(fixture);
  });

  it('stops the deadline once the retry answer starts, preserving a long response stream', async () => {
    const fixture = relayFixture();
    const retry = await startRetry(fixture);
    assignSocket(retry);
    finishRequest(retry);
    await vi.advanceTimersByTimeAsync(3500);
    const answer = new EventEmitter();
    Object.assign(answer, { statusCode: 200, headers: {}, pipe: vi.fn() });
    retry.emit('response', answer);
    await vi.advanceTimersByTimeAsync(10000);
    expect(fixture.browser.statusCode).toBe(200);
    expect(fixture.browser.json).not.toHaveBeenCalled();
    expect(retry.destroyed).toBe(false);
    expect(answer.pipe).toHaveBeenCalledWith(fixture.browser);
    expectHealthyLink(fixture);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains the original connection-failure policy for an initial attempt', async () => {
    const fixture = relayFixture({ connect: 2000 });
    await fixture.start();
    assignSocket(fixture.requests[0], { connecting: true });
    await vi.advanceTimersByTimeAsync(2000);
    expect(fixture.browser.statusCode).toBe(504);
    expect(fixture.child.kill).toHaveBeenCalledOnce();
    expect(fixture.link.ready).toBe(false);
    expect(fixture.requests).toHaveLength(1);
  });
});
