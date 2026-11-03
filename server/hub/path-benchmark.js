/**
 * Compares ways to the same node with small WebSocket pings, interleaved at random
 * so that drift in the network or in either machine hits every way alike. Only
 * control frames on already open status sockets: nothing attaches to tmux and
 * nothing is typed, so this measures the transport and the node's event loop, not
 * a keystroke's echo. One ping is in flight at a time, across all ways.
 */

import { monitorEventLoopDelay } from 'node:perf_hooks';

/** p50/p95/p99 by nearest rank, the maximum, and how many took a second or more. */
export function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p) => (sorted.length ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] : null);
  const slow = sorted.filter((value) => value >= 1000).length;
  const round = (value) => (value === null ? null : Math.round(value * 100) / 100);
  return {
    n: sorted.length,
    p50: round(rank(0.5)),
    p95: round(rank(0.95)),
    p99: round(rank(0.99)),
    max: round(sorted.length ? sorted[sorted.length - 1] : null),
    overOneSecond: slow,
    overOneSecondRatio: sorted.length ? Math.round((slow / sorted.length) * 10_000) / 10_000 : null,
  };
}

/** `perPath` turns for each name, shuffled together. */
export function interleave(names, perPath, random = Math.random) {
  const order = [];
  for (const name of names) for (let i = 0; i < perPath; i += 1) order.push(name);
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

let pingSeq = 0;

/** One ping on an open socket: its round trip in ms, or null when no pong came in time. */
export function pingOnce(ws, timeoutMs) {
  return new Promise((resolve) => {
    pingSeq += 1;
    const tag = Buffer.from(`twp-${pingSeq}`);
    const started = performance.now();
    const onPong = (data) => {
      if (!tag.equals(data)) return;
      done(performance.now() - started);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    function done(value) {
      clearTimeout(timer);
      ws.off('pong', onPong);
      resolve(value);
    }
    ws.on('pong', onPong);
    try {
      ws.ping(tag);
    } catch {
      done(null);
    }
  });
}

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * @param {object} options
 * @param {{name: string, ws: import('ws').WebSocket}[]} options.paths open sockets, one per way
 * @param {number} [options.samples] measured pings per way
 * @param {number} [options.warmup] unmeasured pings per way first
 * @param {number} [options.intervalMs] pause between pings, which bounds the traffic
 */
export async function comparePaths({ paths, samples = 500, warmup = 20, intervalMs = 20, timeoutMs = 5000, random = Math.random }) {
  const byName = new Map(paths.map((path) => [path.name, path.ws]));
  for (const name of interleave([...byName.keys()], warmup, random)) {
    await pingOnce(byName.get(name), timeoutMs);
    await pause(intervalMs);
  }
  const results = new Map([...byName.keys()].map((name) => [name, { times: [], lost: 0 }]));
  const bytes = (ws) => ({ out: ws._socket?.bytesWritten ?? 0, in: ws._socket?.bytesRead ?? 0 });
  const before = new Map([...byName].map(([name, ws]) => [name, bytes(ws)]));
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const cpu = process.cpuUsage();
  const began = Date.now();
  for (const name of interleave([...byName.keys()], samples, random)) {
    const value = await pingOnce(byName.get(name), timeoutMs);
    if (value === null) results.get(name).lost += 1;
    else results.get(name).times.push(value);
    await pause(intervalMs);
  }
  loop.disable();
  const used = process.cpuUsage(cpu);
  const report = {
    samplesPerPath: samples,
    intervalMs,
    durationMs: Date.now() - began,
    measuringProcess: {
      cpuMs: Math.round((used.user + used.system) / 1000),
      eventLoopDelayMs: { p50: loop.percentile(50) / 1e6, p99: loop.percentile(99) / 1e6, max: loop.max / 1e6 },
    },
    paths: {},
  };
  for (const [name, ws] of byName) {
    const after = bytes(ws);
    report.paths[name] = {
      ...summarize(results.get(name).times),
      lost: results.get(name).lost,
      // Bytes the socket handed to or got from its stream: WebSocket framing included,
      // TLS records and anything the node pushed on the status socket meanwhile too.
      bytesOut: after.out - before.get(name).out,
      bytesIn: after.in - before.get(name).in,
    };
  }
  return report;
}
