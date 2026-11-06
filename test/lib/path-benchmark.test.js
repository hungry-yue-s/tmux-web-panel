import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';

import { comparePaths, interleave, summarize, pingOnce } from '../../lib/hub/path-benchmark.js';

describe('a path that stops answering', () => {
  afterEach(() => vi.useRealTimers());

  function socket() {
    return Object.assign(new EventEmitter(), { readyState: 1, ping: vi.fn() });
  }

  it('fails immediately on a closed path instead of counting hundreds of fake timeouts', async () => {
    const ws = socket();
    ws.readyState = 3;
    await expect(comparePaths({ paths: [{ name: 'closed', ws }], samples: 500, warmup: 0 }))
      .rejects.toMatchObject({ code: 'PATH_CLOSED' });
    expect(ws.ping).not.toHaveBeenCalled();
  });

  it.each(['close', 'error'])('settles on %s and removes its temporary listeners', async (event) => {
    const ws = socket();
    const pending = pingOnce(ws, 5000);
    const check = expect(pending).rejects.toMatchObject({ code: event === 'close' ? 'PATH_CLOSED' : 'PATH_ERROR' });
    ws.emit(event);
    await check;
    expect(ws.listenerCount('pong')).toBe(0);
    expect(ws.listenerCount('close')).toBe(0);
    expect(ws.listenerCount('error')).toBe(0);
  });

  it('can abort an in-flight ping without waiting for its timeout', async () => {
    const controller = new AbortController(), ws = socket();
    const pending = pingOnce(ws, 5000, { signal: controller.signal });
    const check = expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
    controller.abort();
    await check;
    expect(ws.listenerCount('pong')).toBe(0);
  });
});

describe('summaries', () => {
  it('reports nearest-rank percentiles, the maximum and the share over a second', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(summarize(values)).toEqual({ n: 100, p50: 50, p95: 95, p99: 99, max: 100, overOneSecond: 0, overOneSecondRatio: 0 });
    expect(summarize([10, 1000, 2500, 20])).toMatchObject({ n: 4, p50: 20, max: 2500, overOneSecond: 2, overOneSecondRatio: 0.5 });
    expect(summarize([])).toMatchObject({ n: 0, p50: null, max: null, overOneSecondRatio: null });
  });

  it('gives every way the same number of turns, shuffled together', () => {
    let seed = 7;
    const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const order = interleave(['ssh', 'direct'], 250, random);
    expect(order.filter((name) => name === 'ssh')).toHaveLength(250);
    expect(order.filter((name) => name === 'direct')).toHaveLength(250);
    // Not two blocks one after the other.
    expect(order.slice(0, 250).filter((name) => name === 'ssh').length).toBeLessThan(200);
  });
});

describe('comparing two ways to one server', () => {
  const cleanups = [];
  afterEach(() => { for (const clean of cleanups.splice(0)) clean(); });

  async function wsServer(options = {}) {
    const server = http.createServer();
    const wss = new WebSocketServer({ server, ...options });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => { for (const client of wss.clients) client.terminate(); server.close(); });
    return server.address().port;
  }

  /** A relay that holds every chunk `delayMs` in each direction. */
  async function slowRelay(targetPort, delayMs) {
    const server = net.createServer((client) => {
      const upstream = net.connect({ host: '127.0.0.1', port: targetPort });
      const late = (from, to) => from.on('data', (chunk) => setTimeout(() => { if (!to.destroyed) to.write(chunk); }, delayMs));
      late(client, upstream);
      late(upstream, client);
      for (const socket of [client, upstream]) socket.on('error', () => {});
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => server.close());
    return server.address().port;
  }

  const open = (port) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/status`, { perMessageDeflate: false });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    cleanups.push(() => ws.terminate());
  });

  it('tells a slower way from a faster one, ping by ping', async () => {
    const port = await wsServer();
    const fast = await open(port);
    const slow = await open(await slowRelay(port, 15));
    const report = await comparePaths({ paths: [{ name: 'fast', ws: fast }, { name: 'slow', ws: slow }], samples: 30, warmup: 2, intervalMs: 1 });

    expect(report.paths.fast).toMatchObject({ n: 30, lost: 0 });
    expect(report.paths.slow).toMatchObject({ n: 30, lost: 0 });
    expect(report.paths.slow.p50).toBeGreaterThanOrEqual(28);
    expect(report.paths.fast.p50).toBeLessThan(report.paths.slow.p50);
    expect(report.paths.slow.bytesOut).toBeGreaterThan(0);
    expect(report.measuringProcess.eventLoopDelayMs.p99).toBeGreaterThanOrEqual(0);
  });

  it('counts a ping with no answer as lost, not as a time', async () => {
    const answering = await open(await wsServer());
    const silent = await open(await wsServer({ autoPong: false }));
    const report = await comparePaths({
      paths: [{ name: 'answering', ws: answering }, { name: 'silent', ws: silent }],
      samples: 3, warmup: 0, intervalMs: 1, timeoutMs: 50,
    });
    expect(report.paths.silent).toMatchObject({ n: 0, lost: 3, p50: null });
    expect(report.paths.answering).toMatchObject({ n: 3, lost: 0 });
    expect(report.comparable).toBe(false);
  });
});
