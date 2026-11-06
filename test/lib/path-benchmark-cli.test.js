import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import https from 'node:https';

const fake = vi.hoisted(() => ({ agents: [], sockets: [], links: [], autoOpen: false, directFailure: false, waitForSignal: false, rejectEnsure: null, failPhase: null, failCode: 'SSH_TIMEOUT' }));
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  class WebSocket extends EventEmitter {
    constructor(url) {
      super(); this.readyState = 0; this.url = url;
      this.terminate = vi.fn(() => { this.readyState = 3; queueMicrotask(() => this.emit('close')); });
      this.ping = vi.fn((data, callback) => queueMicrotask(() => {
        callback?.(); this.emit('pong', data);
      }));
      fake.sockets.push(this);
      if (fake.autoOpen) queueMicrotask(() => {
        if (fake.directFailure && url.includes('node.invalid')) this.emit('error', { code: 'ECONNREFUSED' });
        else { this.readyState = 1; this.emit('open'); }
      });
    }
  }
  return { WebSocket };
});
vi.mock('../../lib/hub/node-link.js', async (original) => {
  const actual = await original();
  return { ...actual,
    freeLoopbackPort: async () => 10000,
    pinnedAgent: () => { const agent = { destroy: vi.fn() }; fake.agents.push(agent); return agent; },
    NodeLink: class {
      constructor({ connection, freePort }) {
        this.connection = connection; this.freePort = freePort;
        fake.links.push(this);
        this._pairing = { tls: true, tlsFingerprint: 'fixture', token: 'PRIVATE_TEST_TOKEN', port: 7681 };
        this._tunnel = { port: 10000 };
        this.close = vi.fn(() => fake.rejectEnsure?.(Object.assign(new Error('aborted'), { code: 'ABORTED' })));
      }
      async ensure() {
        if (fake.waitForSignal) return new Promise((_, reject) => { fake.rejectEnsure = reject; });
        await this.connection.fetchPairing();
        if (fake.failPhase === 'link_connect') throw Object.assign(new Error('PRIVATE_TEST_TOKEN'), { code: fake.failCode });
        await this.freePort();
        this.connection.openForward();
        if (fake.failPhase === 'forward_ready') throw Object.assign(new Error('PRIVATE_TEST_TOKEN'), { code: fake.failCode });
      }
    },
  };
});
vi.mock('../../lib/servers/registry.js', () => ({ ServerRegistry: class {
  async load() {}
  require() { return { id: 'fixture', kind: 'remote' }; }
} }));
vi.mock('../../lib/transport/ssh-connection.js', () => ({ SshConnection: class {
  async fetchPairing() {
    if (fake.failPhase === 'pairing_sftp') throw Object.assign(new Error('PRIVATE_TEST_TOKEN'), { code: fake.failCode });
    return {};
  }
  openForward() {}
  async resolveTarget() { return { host: 'node.invalid', proxied: false }; }
} }));

import { benchmarkOptions, coldRequest, main, openStatus } from '../../scripts/measure-node-paths.mjs';

beforeEach(() => {
  fake.agents.length = fake.sockets.length = fake.links.length = 0;
  fake.autoOpen = fake.directFailure = fake.waitForSignal = false;
  fake.rejectEnsure = fake.failPhase = null;
  fake.failCode = 'SSH_TIMEOUT';
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const pairing = { tlsFingerprint: 'fixture', token: 'PRIVATE_TEST_TOKEN' };
function requestStub(callback, reply) {
  const req = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
  if (reply) queueMicrotask(() => callback(reply));
  return req;
}

describe('bounded benchmark connection helpers', () => {
  it('keeps an explicit zero cold count and integer bounds', () => {
    expect(benchmarkOptions(['node', 'measure', 'fixture', '--cold', '0', '--samples', '10', '--warmup', '0']))
      .toMatchObject({ cold: 0, samples: 10, warmup: 0 });
    expect(benchmarkOptions(['node', 'measure', 'fixture', '--samples', '12.8'])).toMatchObject({ samples: 12, cold: 10 });
  });

  it('bounds a TCP connect that never produces a socket or response', async () => {
    vi.useFakeTimers();
    let req;
    vi.spyOn(https, 'request').mockImplementation((_options, callback) => (req = requestStub(callback)));
    const pending = coldRequest('node.invalid', 7681, pairing, {}, { timeoutMs: 20 });
    await vi.advanceTimersByTimeAsync(20);
    await expect(pending).resolves.toEqual({ ok: false, reason: 'ETIMEDOUT' });
    expect(req.destroy).toHaveBeenCalled();
    expect(fake.agents[0].destroy).toHaveBeenCalled();
  });

  it.each(['aborted', 'error', 'close'])('settles a response %s and tolerates its late error', async (event) => {
    const res = Object.assign(new EventEmitter(), { statusCode: 200, destroy: vi.fn() });
    res.resume = () => res.emit(event, { code: 'ECONNRESET' });
    vi.spyOn(https, 'request').mockImplementation((_options, callback) => requestStub(callback, res));
    const result = await coldRequest('node.invalid', 7681, pairing, {});
    expect(result).toMatchObject({ ok: false, reason: event === 'error' ? 'ECONNRESET' : event === 'close' ? 'RESPONSE_CLOSED' : 'RESPONSE_ABORTED' });
    expect(() => res.emit('error', { code: 'ECONNRESET' })).not.toThrow();
    expect(res.destroy).toHaveBeenCalled();
    expect(fake.agents[0].destroy).toHaveBeenCalled();
  });

  it('terminates a refused WebSocket and its agent instead of leaving its handshake pending', async () => {
    const pending = openStatus('node.invalid', 7681, pairing, {});
    const checked = expect(pending).rejects.toMatchObject({ code: 'HTTP_401' });
    const res = Object.assign(new EventEmitter(), { statusCode: 401, destroy: vi.fn() });
    fake.sockets[0].emit('unexpected-response', {}, res);
    await checked;
    expect(fake.sockets[0].terminate).toHaveBeenCalled();
    expect(fake.agents[0].destroy).toHaveBeenCalled();
    expect(() => fake.sockets[0].emit('error', { code: 'ECONNRESET' })).not.toThrow();
  });

  it('bounds a WebSocket that never finishes opening', async () => {
    vi.useFakeTimers();
    const pending = openStatus('node.invalid', 7681, pairing, {}, { timeoutMs: 20 });
    const checked = expect(pending).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    await vi.advanceTimersByTimeAsync(20);
    await checked;
    expect(fake.sockets[0].terminate).toHaveBeenCalled();
    expect(fake.agents[0].destroy).toHaveBeenCalled();
  });
});

describe('benchmark runner ownership', () => {
  it('keeps a measured SSH-only baseline incomparable when direct is unavailable', async () => {
    fake.autoOpen = fake.directFailure = true;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await main(['node', 'measure', 'fixture', '--cold', '0', '--samples', '10', '--warmup', '2', '--interval-ms', '5'])).toBe(2);
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ comparable: false,
      reason: 'PATH_UNAVAILABLE', directUnavailable: 'ECONNREFUSED',
      warning: 'single-path baseline only; no A/B comparison',
      steady: { comparable: false, reason: 'PATH_UNAVAILABLE', samplesPerPath: 10, warmupPerPath: 2,
        paths: { ssh: { n: 10, lost: 0 } } } });
    expect(JSON.parse(log.mock.calls[0][0]).steady.paths).not.toHaveProperty('direct');
    expect(fake.sockets[0].ping).toHaveBeenCalledTimes(12);
    expect(JSON.parse(log.mock.calls[0][0]).phases).toEqual(expect.arrayContaining([
      { phase: 'pairing_sftp', phaseElapsedMs: expect.any(Number), code: 'OK' },
      { phase: 'local_forward_port', phaseElapsedMs: expect.any(Number), code: 'OK' },
      { phase: 'forward_ready', phaseElapsedMs: expect.any(Number), code: 'OK' },
      { phase: 'status_direct', phaseElapsedMs: expect.any(Number), code: 'ECONNREFUSED' },
    ]));
    expect(log.mock.calls[0][0]).not.toContain('PRIVATE_TEST_TOKEN');
    expect(fake.links[0].close).toHaveBeenCalledOnce();
    expect(fake.sockets.every((ws) => ws.terminate.mock.calls.length > 0)).toBe(true);
  });

  it.each(['pairing_sftp', 'forward_ready'])('identifies %s failure without exposing arbitrary error fields', async (phase) => {
    fake.failPhase = phase;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await main(['node', 'measure', 'fixture', '--cold', '0'])).toBe(1);
    const result = JSON.parse(log.mock.calls[0][0]);
    expect(result).toMatchObject({ phase, error: 'SSH_TIMEOUT', code: 'SSH_TIMEOUT', phaseElapsedMs: expect.any(Number) });
    expect(result.phases.at(-1)).toEqual({ phase, phaseElapsedMs: result.phaseElapsedMs, code: 'SSH_TIMEOUT' });
    expect(result.phaseElapsedMs).toBeGreaterThanOrEqual(0);
    expect(result.phases.filter((entry) => entry.phase === phase)).toHaveLength(1);
    expect(log.mock.calls[0][0]).not.toContain('PRIVATE_TEST_TOKEN');
    expect(fake.links[0].close).toHaveBeenCalledOnce();
    expect(fake.sockets).toHaveLength(0);
  });

  it('keeps a validation failure between connection stages separate from successful SFTP', async () => {
    fake.failPhase = 'link_connect'; fake.failCode = 'NODE_INCOMPATIBLE';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await main(['node', 'measure', 'fixture', '--cold', '0'])).toBe(1);
    const result = JSON.parse(log.mock.calls[0][0]);
    expect(result).toMatchObject({ phase: 'link_connect', code: 'NODE_INCOMPATIBLE', error: 'NODE_INCOMPATIBLE' });
    expect(result.phases).toContainEqual({ phase: 'pairing_sftp', phaseElapsedMs: expect.any(Number), code: 'OK' });
    expect(fake.links[0].close).toHaveBeenCalledOnce();
  });

  it.each(['PRIVATE_TEST_TOKEN:secret', 'PRIVATE_TEST_TOKEN'])('replaces an unknown error code with a fixed failure reason: %s', async (code) => {
    fake.failPhase = 'pairing_sftp'; fake.failCode = code;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await main(['node', 'measure', 'fixture', '--cold', '0'])).toBe(1);
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ phase: 'pairing_sftp', code: 'failed', error: 'failed' });
    expect(log.mock.calls[0][0]).not.toContain('PRIVATE_TEST_TOKEN');
  });

  it.each([['SIGINT', 130], ['SIGTERM', 143]])('cleans its own link once on %s, including an in-flight ensure', async (signal, code) => {
    fake.waitForSignal = true;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const handlers = {};
    const once = process.once;
    vi.spyOn(process, 'once').mockImplementation(function (event, fn) {
      if (event === 'SIGINT' || event === 'SIGTERM') { handlers[event] = fn; return this; }
      return once.call(this, event, fn);
    });
    const pending = main(['node', 'measure', 'fixture', '--cold', '0']);
    await vi.waitFor(() => expect(fake.links).toHaveLength(1));
    handlers[signal]();
    expect(await pending).toBe(code);
    expect(fake.links[0].close).toHaveBeenCalledOnce();
  });
});
