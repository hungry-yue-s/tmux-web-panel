#!/usr/bin/env node
/**
 * Interleaved A/B of the two ways this hub can reach one node: the SSH forward and
 * the node's own HTTPS listener ("direct"). Run on the hub machine:
 *
 *   node scripts/measure-node-paths.mjs <serverId> [--samples 500] [--interval-ms 20] [--cold 10]
 *
 * It opens a forward of its own (the running panel and its connections are not
 * touched), pins the node's certificate on both ways, keeps the node token in this
 * process and prints only timings and byte counts as JSON. Pings are WebSocket
 * control frames on /ws/status, one in flight at a time with a pause in between:
 * a few hundred bytes a second. No terminal is attached and nothing is typed, so
 * the result is the transport plus the node's event loop, not a keystroke's echo.
 */

import https from 'node:https';
import { WebSocket } from 'ws';

import { configDirectory, parseArgs } from '../server/runtime-config.js';
import { ServerRegistry } from '../server/servers/registry.js';
import { SshConnection } from '../server/transport/ssh-connection.js';
import { NodeLink, createSessionCache, forwardRequestHeaders, pinnedAgent } from '../server/hub/node-link.js';
import { comparePaths, interleave, summarize } from '../server/hub/path-benchmark.js';

const serverId = process.argv[2];
const args = parseArgs(process.argv.slice(1));
const samples = Math.min(Math.max(Number(args.samples) || 500, 10), 5000);
const intervalMs = Math.min(Math.max(Number(args['interval-ms']) || 20, 5), 1000);
const cold = Math.min(Math.max(Number(args.cold) || 10, 0), 50);

if (!serverId || serverId.startsWith('--')) {
  console.error('usage: node scripts/measure-node-paths.mjs <serverId> [--samples 500] [--interval-ms 20] [--cold 10]');
  process.exit(64);
}

/** A fixed, short reason; never an address or an error message. */
const reasonOf = (err) => (err && typeof err.code === 'string' ? err.code : 'failed');

function openStatus(host, port, pairing, sessions) {
  const target = host.includes(':') ? `[${host}]` : host;
  const ws = new WebSocket(`wss://${target}:${port}/ws/status`, {
    agent: pinnedAgent(pairing.tlsFingerprint, { keepAlive: false, sessions }),
    headers: forwardRequestHeaders({}, pairing.token),
    perMessageDeflate: false,
    handshakeTimeout: 15_000,
  });
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => { res.resume(); reject(Object.assign(new Error('refused'), { code: `HTTP_${res.statusCode}` })); });
  });
}

/** A request on a new connection each time: connect+TLS, and the whole answer. */
function coldRequest(host, port, pairing, sessions) {
  return new Promise((resolve) => {
    const started = performance.now();
    let tlsMs = null;
    let resumed = null;
    const req = https.request({
      host, port, path: '/api/node/info', method: 'GET',
      headers: forwardRequestHeaders({ accept: 'application/json' }, pairing.token),
      agent: pinnedAgent(pairing.tlsFingerprint, { keepAlive: false, sessions }),
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ ok: res.statusCode === 200, tlsMs, totalMs: performance.now() - started, resumed }));
    });
    req.once('socket', (socket) => socket.once('secureConnect', () => {
      tlsMs = performance.now() - started;
      resumed = socket.isSessionReused();
    }));
    req.setTimeout(15_000, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (err) => resolve({ ok: false, reason: reasonOf(err) }));
    req.end();
  });
}

const registry = new ServerRegistry({ configDir: configDirectory() });
await registry.load();
const server = registry.require(serverId);
if (server.kind !== 'remote') {
  console.error('only a remote server has two ways to compare');
  process.exit(64);
}
const connection = new SshConnection({ server, configDir: registry.configDir || configDirectory() });
const link = new NodeLink({ connection });
const sockets = [];
let exitCode = 0;
try {
  await link.ensure();
  const pairing = link._pairing;
  const forwardPort = link._tunnel.port;
  const report = { serverId, at: new Date().toISOString(), node: { tls: pairing.tls }, warning: null };
  if (!pairing.tls) throw Object.assign(new Error('no tls'), { code: 'NO_TLS' });
  const target = await connection.resolveTarget();
  report.direct = { proxied: target.proxied };
  if (target.proxied) throw Object.assign(new Error('proxied'), { code: 'PROXIED' });

  // Cold: a new connection per request, interleaved. The first of each way is a full
  // handshake, the rest may resume (TLS 1.3 resumes in the same one round trip).
  const ways = {
    ssh: { host: '127.0.0.1', port: forwardPort, sessions: createSessionCache(), results: [] },
    direct: { host: target.host, port: pairing.port, sessions: createSessionCache(), results: [] },
  };
  for (const name of interleave(Object.keys(ways), cold)) {
    const way = ways[name];
    way.results.push(await coldRequest(way.host, way.port, pairing, way.sessions));
  }
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
      const ws = await openStatus(way.host, way.port, pairing, way.sessions);
      sockets.push(ws);
      paths.push({ name, ws });
    } catch (err) {
      report[`${name}Unavailable`] = reasonOf(err);
    }
  }
  if (paths.length === 2) report.steady = await comparePaths({ paths, samples, intervalMs });
  else report.warning = 'steady comparison needs both ways';
  console.log(JSON.stringify(report, null, 2));
} catch (err) {
  console.log(JSON.stringify({ serverId, error: reasonOf(err) }));
  exitCode = 1;
} finally {
  for (const ws of sockets) ws.terminate();
  link.close();
}
process.exit(exitCode);
