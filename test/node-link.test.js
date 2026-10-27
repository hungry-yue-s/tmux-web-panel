import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';

import {
  NodeLink,
  forwardRequestHeaders,
  forwardResponseHeaders,
  stripTokenParam,
} from '../server/hub/node-link.js';
import { certificateFingerprint } from '../server/node/identity.js';
import { ErrorCode } from '../server/servers/errors.js';
import { listen } from './api-helpers.js';

const TOKEN = 'b'.repeat(64);

/**
 * A node stand-in: the real auth rule (Bearer node token), a JSON route that
 * echoes what arrived, and a WebSocket echo — enough to observe the relay.
 */
function nodeApp(seen) {
  const app = express();
  app.use((req, res, next) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.status(401).json({ success: false, data: null, error: 'Authentication required' });
      return;
    }
    next();
  });
  app.use(express.json());
  app.get('/api/node/info', (_req, res) => res.json({ success: true, data: { protocol: 1, hostname: 'node-1' } }));
  app.post('/api/echo', (req, res) => res.status(201).set('x-node', 'yes').json({ success: true, data: req.body }));
  app.get('/api/fail', (_req, res) => res.status(404).json({ success: false, error: { code: 'PANE_NOT_FOUND', message: 'gone' } }));
  return app;
}

function attachEcho(server) {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ type: 'hello', url: req.url }));
      ws.on('message', (data) => ws.send(String(data)));
    });
  });
}

/** An SshConnection stand-in whose "forward" is simply the node's real port. */
function fakeConnection(pairing, { fetchPairing } = {}) {
  const children = [];
  return {
    id: 'node-1',
    children,
    fetchPairing: fetchPairing || vi.fn(async () => pairing),
    openForward: vi.fn(() => {
      const child = new EventEmitter();
      child.exitCode = null;
      child.kill = vi.fn(() => { child.exitCode = 0; child.emit('exit', 0, null); });
      children.push(child);
      return { child, whenFailed: new Promise(() => {}) };
    }),
  };
}

function pairingFor(port, extra = {}) {
  return { protocol: 1, host: '127.0.0.1', port, tls: false, tlsFingerprint: null, token: TOKEN, ...extra };
}

/** A hub stand-in that relays everything under /n/node-1 through the link. */
async function hubFor(link) {
  const app = express();
  app.use((req, res) => link.proxy(req, res, req.url));
  const { server, port } = await listen(app);
  server.on('upgrade', (req, socket, head) => { link.proxyUpgrade(req, socket, head, req.url).catch(() => socket.destroy()); });
  return { server, port };
}

describe('header handling', () => {
  it('replaces the browser credentials with the node token and drops hop-by-hop headers', () => {
    const out = forwardRequestHeaders({
      Host: 'hub:7681', Authorization: 'Bearer login', Cookie: 'a=b', Origin: 'https://hub', Referer: 'https://hub/x',
      Connection: 'keep-alive', 'Keep-Alive': 'timeout=5', 'Content-Type': 'application/json', 'X-Request-Id': '1',
    }, TOKEN);
    expect(out).toEqual({ 'content-type': 'application/json', 'x-request-id': '1', authorization: `Bearer ${TOKEN}` });
  });

  it('drops hop-by-hop response headers only', () => {
    expect(forwardResponseHeaders({ 'transfer-encoding': 'chunked', 'content-type': 'text/plain', 'x-a': '1' }))
      .toEqual({ 'content-type': 'text/plain', 'x-a': '1' });
  });

  it('removes the browser token query parameter and keeps the rest', () => {
    expect(stripTokenParam('/api/files/raw?path=%2Ftmp%2Fa&token=abc')).toBe('/api/files/raw?path=%2Ftmp%2Fa');
    expect(stripTokenParam('/ws/terminal/%251?token=abc')).toBe('/ws/terminal/%251');
    expect(stripTokenParam('/api/workspace')).toBe('/api/workspace');
  });
});

describe('NodeLink over plain HTTP', () => {
  let node;
  let seen;
  let link;
  let connection;
  let hub;

  beforeAll(async () => {
    seen = [];
    node = await listen(nodeApp(seen));
    attachEcho(node.server);
  });

  afterAll(() => node.server.close());

  afterEach(() => {
    if (hub) hub.server.close();
    hub = null;
    if (link) link.close();
    seen.length = 0;
  });

  function makeLink(overrides = {}) {
    connection = fakeConnection(pairingFor(node.port), overrides);
    link = new NodeLink({ connection, freePort: async () => node.port });
    return link;
  }

  it('pairs once, opens one forward and reuses it', async () => {
    makeLink();
    await expect(link.info()).resolves.toEqual({ protocol: 1, hostname: 'node-1' });
    await Promise.all([link.info(), link.info()]);

    expect(connection.fetchPairing).toHaveBeenCalledTimes(1);
    expect(connection.openForward).toHaveBeenCalledTimes(1);
    expect(connection.openForward).toHaveBeenCalledWith({ localPort: node.port, remoteHost: '127.0.0.1', remotePort: node.port });
    expect(seen.every((r) => r.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('refuses a node that speaks another protocol', async () => {
    makeLink({ fetchPairing: vi.fn(async () => pairingFor(node.port, { protocol: 2 })) });
    await expect(link.info()).rejects.toMatchObject({ code: ErrorCode.NODE_INCOMPATIBLE });
    expect(connection.openForward).not.toHaveBeenCalled();
  });

  it('re-pairs after the node rejects the token', async () => {
    const stale = pairingFor(node.port, { token: 'c'.repeat(64) });
    const fresh = pairingFor(node.port);
    const fetchPairing = vi.fn().mockResolvedValueOnce(stale).mockResolvedValueOnce(fresh);
    makeLink({ fetchPairing });

    await expect(link.info()).rejects.toMatchObject({ code: ErrorCode.NODE_AUTH_FAILED });
    // The forward was torn down with the pairing, so the next call starts over.
    expect(connection.children[0].kill).toHaveBeenCalled();
    await expect(link.info()).resolves.toMatchObject({ hostname: 'node-1' });
    expect(fetchPairing).toHaveBeenCalledTimes(2);
  });

  it('maps a structured node error onto the same code', async () => {
    makeLink();
    await expect(link.requestJson('GET', '/api/fail')).rejects.toMatchObject({ code: 'PANE_NOT_FOUND', message: 'gone' });
  });

  it('reports a forward with nothing listening behind it as the panel not running', async () => {
    const closed = await listen(express());
    const deadPort = closed.port;
    closed.server.close();
    connection = fakeConnection(pairingFor(deadPort));
    // The local end answers (it is the hub's own listener) but the far side is gone.
    link = new NodeLink({ connection, freePort: async () => node.port });
    link._pairing = pairingFor(deadPort);
    link._tunnel = { child: new EventEmitter(), port: deadPort };
    link._tunnel.child.exitCode = null;
    link._tunnel.child.kill = vi.fn();
    link._agent = new http.Agent();
    await expect(link.info()).rejects.toMatchObject({ code: ErrorCode.NODE_NOT_RUNNING });
    // A restarted node may listen elsewhere, so the pairing is read again next time.
    expect(link._pairing).toBeNull();
  });

  it('drops the forward when the ssh process exits, and reopens it on demand', async () => {
    makeLink();
    await link.info();
    connection.children[0].emit('exit', 255, null);
    expect(link.ready).toBe(false);

    await link.info();
    expect(connection.openForward).toHaveBeenCalledTimes(2);
  });

  it('streams a relayed request: method, body, status and headers, with the token swapped', async () => {
    makeLink();
    hub = await hubFor(link);

    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: hub.port, method: 'POST', path: '/api/echo?token=browser-token&x=1',
        headers: { 'content-type': 'application/json', authorization: 'Bearer browser-login', cookie: 'sid=1' },
      }, (answer) => {
        let raw = '';
        answer.on('data', (c) => { raw += c; });
        answer.on('end', () => resolve({ status: answer.statusCode, headers: answer.headers, body: JSON.parse(raw) }));
      });
      req.on('error', reject);
      req.end(JSON.stringify({ text: '你好' }));
    });

    expect(res.status).toBe(201);
    expect(res.headers['x-node']).toBe('yes');
    expect(res.body.data).toEqual({ text: '你好' });
    const arrived = seen.find((r) => r.url.startsWith('/api/echo'));
    expect(arrived.url).toBe('/api/echo?x=1');
    expect(arrived.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(arrived.headers.cookie).toBeUndefined();
  });

  it('relays a WebSocket both ways', async () => {
    makeLink();
    hub = await hubFor(link);

    const frames = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/ws/terminal/%251?cols=80&token=browser`);
      const got = [];
      ws.on('message', (data) => {
        got.push(JSON.parse(String(data)));
        if (got.length === 1) ws.send(JSON.stringify({ type: 'input', data: 'ls\r' }));
        if (got.length === 2) { ws.close(); resolve(got); }
      });
      ws.on('error', reject);
    });

    expect(frames[0]).toEqual({ type: 'hello', url: '/ws/terminal/%251?cols=80' });
    expect(frames[1]).toEqual({ type: 'input', data: 'ls\r' });
  });
});

/** Finds an openssl binary, including MSYS2's on Windows. */
function findOpenssl() {
  for (const candidate of ['openssl', 'C:\\msys64\\usr\\bin\\openssl.exe', '/usr/bin/openssl']) {
    try {
      execFileSync(candidate, ['version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // try the next one
    }
  }
  return null;
}

const OPENSSL = findOpenssl();

describe.skipIf(!OPENSSL)('NodeLink over HTTPS', () => {
  let dir;
  let tls;
  let node;

  beforeAll(async () => {
    // Generated per run: no key or certificate is ever committed.
    dir = mkdtempSync(join(tmpdir(), 'node-link-tls-'));
    const key = join(dir, 'key.pem');
    const cert = join(dir, 'cert.pem');
    execFileSync(OPENSSL, ['req', '-x509', '-nodes', '-newkey', 'rsa:2048', '-sha256', '-days', '1',
      '-subj', '/CN=localhost', '-keyout', key, '-out', cert], { stdio: 'ignore' });
    tls = { key: readFileSync(key), cert: readFileSync(cert, 'utf8') };
    const seen = [];
    const server = https.createServer({ key: tls.key, cert: tls.cert }, nodeApp(seen));
    attachEcho(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    node = { server, port: server.address().port };
  });

  afterAll(() => {
    node?.server.close();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  function linkWith(fingerprint) {
    const connection = fakeConnection(pairingFor(node.port, { tls: true, tlsFingerprint: fingerprint }));
    return new NodeLink({ connection, freePort: async () => node.port });
  }

  it('accepts the self-signed certificate named in the pairing file', async () => {
    const link = linkWith(certificateFingerprint(tls.cert));
    await expect(link.info()).resolves.toMatchObject({ hostname: 'node-1' });
    link.close();
  });

  it('refuses any other certificate before sending the token', async () => {
    const link = linkWith('00:' + 'AA:'.repeat(30) + 'FF');
    await expect(link.info()).rejects.toMatchObject({ code: ErrorCode.NODE_AUTH_FAILED });
    link.close();
  });

  it('pins the certificate for relayed WebSockets too', async () => {
    const good = linkWith(certificateFingerprint(tls.cert));
    const hub = await hubFor(good);
    const frame = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/ws/status`);
      ws.on('message', (data) => { ws.close(); resolve(JSON.parse(String(data))); });
      ws.on('error', reject);
    });
    expect(frame).toEqual({ type: 'hello', url: '/ws/status' });
    hub.server.close();
    good.close();

    const bad = linkWith('00:' + 'AA:'.repeat(30) + 'FF');
    await bad.ensure();
    const badHub = await hubFor(bad);
    await expect(new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${badHub.port}/ws/status`);
      ws.on('open', () => resolve('opened'));
      ws.on('error', reject);
    })).rejects.toThrow();
    badHub.server.close();
    bad.close();
  });
});
