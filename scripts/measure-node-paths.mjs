#!/usr/bin/env node
/**
 * Interleaved A/B of the two ways this hub can reach one node: the SSH forward and
 * the node's own HTTPS listener ("direct"). Run on the hub machine:
 *
 *   node scripts/measure-node-paths.mjs <serverId> [--samples 500] [--interval-ms 20] [--cold 10] [--warmup 20]
 *
 * It opens a forward of its own (the running panel and its connections are not
 * touched), pins the node's certificate on both ways, keeps the node token in this
 * process and prints only timings and byte counts as JSON. Pings are WebSocket
 * control frames on /ws/status, one in flight at a time with a pause in between:
 * a few hundred bytes a second. No terminal is attached and nothing is typed, so
 * the result is the transport plus the node's event loop, not a keystroke's echo.
 */

import https from 'node:https';
import { execFile, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';

import { configDirectory, parseArgs } from '../server/runtime-config.js';
import { ServerRegistry } from '../server/servers/registry.js';
import { ErrorCode } from '../server/servers/errors.js';
import { SshConnection } from '../server/transport/ssh-connection.js';
import { NodeLink, createSessionCache, forwardRequestHeaders, freeLoopbackPort, pinnedAgent } from '../server/hub/node-link.js';
import { comparePaths, interleave, summarize } from '../server/hub/path-benchmark.js';

export function benchmarkOptions(argv) {
  const args = parseArgs(argv);
  const bound = (value, fallback, min, max) => Math.min(max, Math.max(min,
    value === undefined || !Number.isFinite(Number(value)) ? fallback : Math.trunc(Number(value))));
  return { serverId: argv[2], samples: bound(args.samples, 500, 10, 5000),
    intervalMs: bound(args['interval-ms'], 20, 5, 1000), cold: bound(args.cold, 10, 0, 50),
    warmup: bound(args.warmup, 20, 0, 100) };
}

/** A fixed, short reason; never an address or an error message. */
const reasonCodes = new Set([...Object.values(ErrorCode), 'ABORTED', 'REMOTE_REQUIRED', 'NO_TLS', 'PROXIED',
  'PATH_CLOSED', 'PATH_ERROR', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'EBADF',
  'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ENOENT', 'EACCES', 'EPERM']);
const reasonOf = (err) => (reasonCodes.has(err?.code) || /^HTTP_[1-5][0-9]{2}$/.test(err?.code || '') ? err.code : 'failed');
const failure = (code) => Object.assign(new Error(code), { code });

export function openStatus(host, port, pairing, sessions, { timeoutMs = 15_000, signal } = {}) {
  const target = host.includes(':') ? `[${host}]` : host;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(failure('ABORTED'));
    const agent = pinnedAgent(pairing.tlsFingerprint, { keepAlive: false, sessions });
    let ws;
    let settled = false;
    const timer = setTimeout(() => finish(failure('ETIMEDOUT')), timeoutMs);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { agent.destroy(); ws?.terminate(); reject(error); }
      else resolve(ws);
    }
    const onAbort = () => {
      if (!settled) finish(failure('ABORTED'));
      else { agent.destroy(); ws?.terminate(); }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      ws = new WebSocket(`wss://${target}:${port}/ws/status`, {
        agent, headers: forwardRequestHeaders({}, pairing.token), perMessageDeflate: false,
        handshakeTimeout: timeoutMs,
      });
      ws.once('open', () => finish());
      // Retain an error listener after open/terminate: a late transport error must
      // not bypass the runner's finally and leave its forward behind.
      ws.on('error', (err) => finish(err));
      ws.once('close', () => {
        agent.destroy();
        signal?.removeEventListener('abort', onAbort);
        finish(failure('PATH_CLOSED'));
      });
      ws.once('unexpected-response', (_req, res) => {
        res.on('error', () => {});
        res.destroy();
        finish(failure(`HTTP_${res.statusCode}`));
      });
    } catch (err) { signal?.removeEventListener('abort', onAbort); finish(err); }
  });
}

/** A request on a new connection each time: connect+TLS, and the whole answer. */
export function coldRequest(host, port, pairing, sessions, { timeoutMs = 15_000, signal } = {}) {
  return new Promise((resolve) => {
    const started = performance.now();
    let tlsMs = null;
    let resumed = null;
    if (signal?.aborted) return resolve({ ok: false, reason: 'ABORTED' });
    const agent = pinnedAgent(pairing.tlsFingerprint, { keepAlive: false, sessions });
    let req, response;
    let settled = false;
    // ClientRequest.setTimeout starts after TCP connect, so it cannot bound a
    // blackholed connect. This deadline covers connect, TLS and the response.
    const timer = setTimeout(() => finish({ ok: false, reason: 'ETIMEDOUT' }), timeoutMs);
    const onAbort = () => finish({ ok: false, reason: 'ABORTED' });
    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      response?.destroy(); req?.destroy(); agent.destroy();
      resolve(result);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      req = https.request({ host, port, path: '/api/node/info', method: 'GET',
        headers: forwardRequestHeaders({ accept: 'application/json' }, pairing.token), agent }, (res) => {
        response = res;
        res.once('end', () => finish({ ok: res.statusCode === 200, tlsMs, totalMs: performance.now() - started, resumed }));
        res.once('aborted', () => finish({ ok: false, reason: 'RESPONSE_ABORTED' }));
        res.on('error', (err) => finish({ ok: false, reason: reasonOf(err) }));
        res.once('close', () => { if (!settled) finish({ ok: false, reason: 'RESPONSE_CLOSED' }); });
        res.resume();
      });
      req.once('socket', (socket) => socket.once('secureConnect', () => {
        tlsMs = performance.now() - started;
        resumed = socket.isSessionReused();
      }));
      req.on('error', (err) => finish({ ok: false, reason: reasonOf(err) }));
      req.end();
    } catch (err) { finish({ ok: false, reason: reasonOf(err) }); }
  });
}

export async function main(argv = process.argv) {
  const { serverId, samples, intervalMs, cold, warmup } = benchmarkOptions(argv);
  if (!serverId || serverId.startsWith('--')) {
    console.error('usage: node scripts/measure-node-paths.mjs <serverId> [--samples 500] [--interval-ms 20] [--cold 10] [--warmup 20]');
    return 64;
  }
  const controller = new AbortController();
  const signal = controller.signal;
  const sockets = new Set(), children = new Set();
  let link;
  let cleaned = false, exitCode = 0;
  const phases = [];
  let phase;
  const startPhase = (name) => { phase = { name, started: performance.now(), result: null }; };
  const finishPhase = (code) => {
    if (!phase.result) {
      phase.result = { phase: phase.name, phaseElapsedMs: performance.now() - phase.started, code };
      phases.push(phase.result);
    }
    return phase.result;
  };
  const during = async (name, work) => {
    startPhase(name);
    try { const value = await work(); finishPhase('OK'); return value; }
    catch (err) { finishPhase(reasonOf(err)); throw err; }
  };
  startPhase('setup');
  const track = (child) => {
    children.add(child);
    child.once('close', () => children.delete(child));
    if (signal.aborted && child.exitCode === null && !child.killed) child.kill();
    return child;
  };
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    controller.abort();
    for (const ws of sockets) ws.terminate();
    link?.close();
    // Only children created by this connection, including an in-flight SFTP
    // pairing read. Never kill by process name or touch the running panel.
    for (const child of children) if (child.exitCode === null && child.signalCode === null && !child.killed) child.kill();
  };
  const onInt = () => { exitCode = 130; cleanup(); };
  const onTerm = () => { exitCode = 143; cleanup(); };
  process.once('SIGINT', onInt); process.once('SIGTERM', onTerm);
  try {
    const registry = new ServerRegistry({ configDir: configDirectory() });
    await during('registry_load', async () => {
      await registry.load();
      if (signal.aborted) throw failure('ABORTED');
    });
    const server = await during('registry_lookup', () => {
      const value = registry.require(serverId);
      if (value.kind !== 'remote') throw failure('REMOTE_REQUIRED');
      return value;
    });
    startPhase('connection_setup');
    const connection = new SshConnection({ server, configDir: registry.configDir || configDirectory(),
      execFileImpl: (...args) => track(execFile(...args)), spawnImpl: (...args) => track(spawn(...args)) });
    // Observe only our connection wrapper. Production NodeLink still owns its
    // normal readiness check and deadlines; no stderr or pairing data is logged.
    const fetchPairing = connection.fetchPairing.bind(connection);
    const openForward = connection.openForward.bind(connection);
    connection.fetchPairing = (...args) => during('pairing_sftp', () => fetchPairing(...args));
    connection.openForward = (...args) => { startPhase('forward_ready'); return openForward(...args); };
    link = new NodeLink({ connection,
      freePort: () => during('local_forward_port', freeLoopbackPort) });
    finishPhase('OK');
    startPhase('link_connect');
    const linkStarted = phase.started;
    try { await link.ensure(); }
    catch (err) {
      // NodeLink may fail between observed operations (for example protocol
      // validation after SFTP). Do not report the prior successful phase as failed.
      if (phase.result?.code === 'OK') phase = { name: 'link_connect', started: linkStarted, result: null };
      throw err;
    }
    finishPhase('OK');
    startPhase('link_ready');
    if (signal.aborted) throw failure('ABORTED');
    const pairing = link._pairing;
    const forwardPort = link._tunnel.port;
    finishPhase('OK');
    const report = { serverId, at: new Date().toISOString(), node: { tls: pairing.tls }, phases, warning: null };
    const target = await during('target_resolve', async () => {
      if (!pairing.tls) throw failure('NO_TLS');
      const value = await connection.resolveTarget();
      if (value.proxied) throw failure('PROXIED');
      return value;
    });
    report.direct = { proxied: target.proxied };

    // Cold: a new connection per request, interleaved. The first of each way is a full
    // handshake, the rest may resume (TLS 1.3 resumes in the same one round trip).
    const ways = {
      ssh: { host: '127.0.0.1', port: forwardPort, sessions: createSessionCache(), results: [] },
      direct: { host: target.host, port: pairing.port, sessions: createSessionCache(), results: [] },
    };
    startPhase('cold_requests');
    for (const name of interleave(Object.keys(ways), cold)) {
      const way = ways[name];
      if (signal.aborted) throw failure('ABORTED');
      way.results.push(await coldRequest(way.host, way.port, pairing, way.sessions, { signal }));
    }
    finishPhase('OK');
    report.cold = {};
    for (const [name, way] of Object.entries(ways)) {
      const ok = way.results.filter((r) => r.ok);
      report.cold[name] = {
        failed: way.results.filter((r) => !r.ok).map((r) => r.reason || 'status'),
        full: summarize(ok.filter((r) => !r.resumed).map((r) => r.totalMs)),
        resumed: summarize(ok.filter((r) => r.resumed).map((r) => r.totalMs)),
        tlsFull: summarize(ok.filter((r) => !r.resumed).map((r) => r.tlsMs)),
        tlsResumed: summarize(ok.filter((r) => r.resumed).map((r) => r.tlsMs)),
      };
    }

    // Steady: two status sockets, already open, compared ping by ping.
    const paths = [];
    for (const [name, way] of Object.entries(ways)) {
      try {
        if (signal.aborted) throw failure('ABORTED');
        const ws = await during(`status_${name}`, () => openStatus(way.host, way.port, pairing, way.sessions, { signal }));
        sockets.add(ws);
        paths.push({ name, ws });
      } catch (err) {
        report[`${name}Unavailable`] = reasonOf(err);
      }
    }
    const bothWays = paths.length === 2;
    report.comparable = bothWays;
    if (!bothWays) {
      report.reason = 'PATH_UNAVAILABLE';
      report.warning = paths.length ? 'single-path baseline only; no A/B comparison' : 'steady comparison needs both ways';
      exitCode ||= 2;
    }
    if (paths.length) {
      try {
        report.steady = await during(bothWays ? 'steady_compare' : 'steady_baseline',
          () => comparePaths({ paths, samples, intervalMs, warmup, signal }));
        // comparePaths can measure one socket, but one way cannot establish an
        // A/B benefit. Keep the useful baseline without claiming comparability.
        report.steady.comparable = bothWays && report.steady.comparable;
        if (!bothWays) report.steady.reason = 'PATH_UNAVAILABLE';
        report.comparable = report.steady.comparable;
        if (bothWays && !report.comparable) { report.warning = 'a way returned no measured pong'; exitCode ||= 2; }
      }
      catch (err) {
        report.comparable = false;
        report.steady = { comparable: false, reason: bothWays ? reasonOf(err) : 'PATH_UNAVAILABLE', error: reasonOf(err) };
        exitCode ||= 2;
      }
    } else report.steady = { comparable: false, reason: 'PATH_UNAVAILABLE' };
    console.log(JSON.stringify(report, null, 2));
  } catch (err) {
    console.log(JSON.stringify({ serverId, error: reasonOf(err), ...finishPhase(reasonOf(err)), phases }));
    exitCode ||= 1;
  } finally {
    cleanup();
    process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
  }
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
