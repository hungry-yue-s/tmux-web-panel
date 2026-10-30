import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';

import {
  NodeLink,
  forwardRequestHeaders,
  forwardResponseHeaders,
  pinnedAgent,
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

describe('NodeLink with a link that stalls', () => {
  const sockets = new Set();
  let stuck;

  /** Accepts connections and then never answers, like a forward gone dead. */
  async function deadForward() {
    stuck = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('data', () => { socket.gotRequest = true; });
    });
    await new Promise((resolve) => stuck.listen(0, '127.0.0.1', resolve));
    return stuck.address().port;
  }

  afterEach(() => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    stuck?.close();
    stuck = null;
  });

  function linkTo(port, stallLimits, connection = fakeConnection(pairingFor(port))) {
    return new NodeLink({ connection, freePort: async () => port, stallLimits });
  }

  function statusOf(port, path, method = 'GET') {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path, method }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.end();
    });
  }

  function upgrade(port, path) {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
      ws.on('open', () => { ws.close(); resolve('open'); });
      ws.on('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode); });
      ws.on('error', () => resolve('error'));
    });
  }

  it('answers an ordinary request that gets no answer with a timeout, not by hanging', async () => {
    const link = linkTo(await deadForward(), { read: 50 });
    const hub = await hubFor(link);
    expect(await statusOf(hub.port, '/api/workspace')).toBe(504);
    hub.server.close();
    link.close();
  });

  it('gives writes their own, longer limit', async () => {
    const link = linkTo(await deadForward(), { read: 50, write: 400 });
    const hub = await hubFor(link);
    const start = Date.now();
    expect(await statusOf(hub.port, '/api/git/commit-message', 'POST')).toBe(504);
    expect(Date.now() - start).toBeGreaterThanOrEqual(350);
    hub.server.close();
    link.close();
  });

  it('refuses a WebSocket whose handshake stalls', async () => {
    const link = linkTo(await deadForward(), { upgrade: 50 });
    const hub = await hubFor(link);
    expect(await upgrade(hub.port, '/ws/terminal/%251')).toBe(504);
    hub.server.close();
    link.close();
  });

  it('does not limit a slow download once its answer has started', async () => {
    const app = http.createServer((req, res) => {
      res.writeHead(200);
      res.write('start');
      setTimeout(() => res.end('end'), 150);
    });
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    const { port } = app.address();
    const link = linkTo(port, { read: 30 });
    const hub = await hubFor(link);
    const body = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: hub.port, path: '/api/files/raw' }, (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve(text));
      }).on('error', reject);
    });
    expect(body).toBe('startend');
    hub.server.close();
    app.close();
    link.close();
  });

  it('does not limit a slow upload while it is being sent', async () => {
    const app = http.createServer((req, res) => {
      let size = 0;
      req.on('data', (chunk) => { size += chunk.length; });
      req.on('end', () => { res.writeHead(200); res.end(String(size)); });
    });
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    const { port } = app.address();
    const link = linkTo(port, { read: 30, write: 30 });
    const hub = await hubFor(link);
    const answer = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: hub.port, path: '/api/upload', method: 'POST' }, (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, text }));
      });
      req.on('error', reject);
      req.write('aaaa');
      setTimeout(() => req.end('bbbb'), 150);
    });
    expect(answer).toEqual({ status: 200, text: '8' });
    hub.server.close();
    app.close();
    link.close();
  });

  it('asks the node for nothing when the browser left while the forward came up', async () => {
    const port = await deadForward();
    const link = linkTo(port);
    let release;
    link.ensure = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const browser = new EventEmitter();
    browser.destroyed = false;
    browser.end = vi.fn();
    browser.destroy = vi.fn();
    browser.resume = vi.fn();
    link._pairing = pairingFor(port);
    link._tunnel = { child: new EventEmitter(), port };
    link._upgradeAgent = new http.Agent();

    const relaying = link.proxyUpgrade({ headers: {} }, browser, Buffer.alloc(0), '/ws/terminal/%251');
    browser.destroyed = true;
    release();
    await relaying;
    await new Promise((resolve) => { setTimeout(resolve, 30); });

    expect([...sockets].filter((socket) => socket.gotRequest)).toEqual([]);
    link.close();
  });

  /** A browser's end of an upgrade, as raw TCP, so it can leave in each real way. */
  function rawUpgrade(port, path = '/ws/terminal/%251') {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.on('error', () => {});
    socket.write(`GET ${path} HTTP/1.1\r\nHost: hub\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n`
      + 'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
    return socket;
  }
  const handshakeAtNode = () => [...sockets].find((socket) => socket.gotRequest);

  describe.each([
    ['closing the connection with a FIN', (browser) => browser.end()],
    ['resetting the connection', (browser) => browser.destroy()],
  ])('the browser %s', (_how, leave) => {
    it('abandons a handshake under way, so nothing attaches for nobody', async () => {
      const port = await deadForward();
      const link = linkTo(port);
      const hub = await hubFor(link);
      const browser = rawUpgrade(hub.port);
      await vi.waitFor(() => expect(handshakeAtNode()).toBeTruthy());
      const upstream = handshakeAtNode();
      const gone = new Promise((resolve) => upstream.once('close', resolve));

      leave(browser);

      await gone;
      hub.server.close();
      link.close();
    });

    it('asks the node nothing when it happens while the forward is still coming up', async () => {
      const port = await deadForward();
      const link = linkTo(port);
      const { ensure } = link;
      let release;
      link.ensure = () => new Promise((resolve) => { release = resolve; }).then(() => ensure.call(link));
      const hub = await hubFor(link);
      const browser = rawUpgrade(hub.port);
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      const closed = new Promise((resolve) => browser.once('close', resolve));

      leave(browser);
      if (browser.writable) browser.resume();
      await closed;
      await new Promise((resolve) => { setTimeout(resolve, 30); });
      release();
      await new Promise((resolve) => { setTimeout(resolve, 80); });

      expect(handshakeAtNode()).toBeUndefined();
      hub.server.close();
      link.close();
    });
  });

  it('ends the node\'s side when a connected browser sends its FIN', async () => {
    const node = http.createServer();
    const upstreamClosed = new Promise((resolve) => {
      node.on('upgrade', (_req, socket) => {
        socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
        socket.on('error', () => {});
        // This is a half-open socket too, so all it ever sees of the hub leaving is the FIN.
        socket.once('end', () => { socket.destroy(); resolve(); });
        socket.resume();
      });
    });
    await new Promise((resolve) => node.listen(0, '127.0.0.1', resolve));
    const { port } = node.address();
    const link = linkTo(port);
    const hub = await hubFor(link);
    const browser = rawUpgrade(hub.port);
    await new Promise((resolve) => browser.once('data', resolve));

    browser.end();

    await upstreamClosed;
    hub.server.close();
    node.close();
    link.close();
  });

  it('drops the forward when TLS through it never completes, and only this link', async () => {
    const port = await deadForward();
    const connection = fakeConnection(pairingFor(port, { tls: true, tlsFingerprint: 'AA' }));
    const link = linkTo(port, { connect: 50 }, connection);
    const other = fakeConnection(pairingFor(port));
    const otherLink = linkTo(port, {}, other);
    await otherLink.ensure();
    const hub = await hubFor(link);

    expect(await statusOf(hub.port, '/api/workspace')).toBe(504);

    expect(link.ready).toBe(false);
    expect(connection.children[0].kill).toHaveBeenCalled();
    expect(otherLink.ready).toBe(true);
    expect(other.children[0].kill).not.toHaveBeenCalled();
    hub.server.close();
    link.close();
    otherLink.close();
  });

  it('opens a new forward on the next request after a dead one', async () => {
    const port = await deadForward();
    const connection = fakeConnection(pairingFor(port, { tls: true, tlsFingerprint: 'AA' }));
    const link = linkTo(port, { connect: 50 }, connection);
    const hub = await hubFor(link);
    await statusOf(hub.port, '/api/workspace');
    await statusOf(hub.port, '/api/workspace');
    expect(connection.openForward).toHaveBeenCalledTimes(2);
    hub.server.close();
    link.close();
  });

  describe('with every socket busy on a healthy stream', () => {
    /** A node with one slow download running, and a pool with room for just that. */
    async function fullPool(limits) {
      let finishStream;
      const node = http.createServer((req, res) => {
        if (req.url === '/stream') {
          res.writeHead(200);
          res.write('start');
          finishStream = () => res.end('end');
          return;
        }
        res.writeHead(200);
        res.end('quick');
      });
      await new Promise((resolve) => node.listen(0, '127.0.0.1', resolve));
      const { port } = node.address();
      const connection = fakeConnection(pairingFor(port));
      const link = linkTo(port, limits, connection);
      await link.ensure();
      link._agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
      const hub = await hubFor(link);
      const stream = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: hub.port, path: '/stream' }, (res) => {
          const state = { text: '', ended: false, closedEarly: false };
          res.on('data', (chunk) => { state.text += chunk; });
          res.on('end', () => { state.ended = true; });
          res.on('close', () => { if (!state.ended) state.closedEarly = true; });
          res.once('data', () => resolve(state));
        }).on('error', reject);
      });
      const finish = async () => {
        finishStream();
        await vi.waitFor(() => expect(stream.ended).toBe(true));
      };
      const close = () => { hub.server.close(); node.close(); link.close(); };
      return { link, connection, hub, stream, finish, close };
    }

    it('gives up on the queued request only, and leaves the stream and the forward alone', async () => {
      const { link, connection, hub, stream, finish, close } = await fullPool({ queue: 50, connect: 50, read: 50 });

      expect(await statusOf(hub.port, '/api/workspace')).toBe(504);

      expect(stream.closedEarly).toBe(false);
      expect(link.ready).toBe(true);
      expect(connection.children[0].kill).not.toHaveBeenCalled();
      await finish();
      expect(stream.text).toBe('startend');
      close();
    });

    it('serves a queued request that gets its turn in time', async () => {
      const { hub, stream, finish, close } = await fullPool({ queue: 2000, connect: 50, read: 2000 });
      const queued = statusOf(hub.port, '/api/quick');
      await new Promise((resolve) => { setTimeout(resolve, 100); });
      await finish();
      expect(await queued).toBe(200);
      expect(stream.closedEarly).toBe(false);
      close();
    });

    it('does not count the time in the queue against connecting', async () => {
      const { link, connection, hub, finish, close } = await fullPool({ queue: 2000, connect: 10, read: 2000 });
      const queued = statusOf(hub.port, '/api/quick');
      await new Promise((resolve) => { setTimeout(resolve, 150); });
      expect(link.ready).toBe(true);
      expect(connection.children[0].kill).not.toHaveBeenCalled();
      await finish();
      expect(await queued).toBe(200);
      close();
    });
  });
});

describe('NodeLink health checks on a link in use', () => {
  const INFO = JSON.stringify({ success: true, data: { protocol: 1, hostname: 'node-1' } });
  let warn;
  const cleanups = [];
  afterEach(() => {
    warn.mockRestore();
    for (const clean of cleanups.splice(0)) clean();
  });
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  /**
   * A real node that can break one request at a time: `failNext` resets the TCP
   * connection the next probe arrived on, `holdNext` keeps it waiting. /stream stays
   * open until told otherwise, as a terminal or a download would.
   */
  async function startNode() {
    const state = { probes: [], failNext: 0, holdNext: false, held: [], answer401: false };
    const server = http.createServer((req, res) => {
      if (req.url === '/stream') {
        res.writeHead(200);
        res.write('start');
        state.finishStream = () => res.end('end');
        return;
      }
      state.probes.push({ method: req.method, socket: req.socket });
      if (state.failNext > 0) {
        state.failNext -= 1;
        req.socket.resetAndDestroy();
        return;
      }
      if (state.holdNext) {
        state.holdNext = false;
        state.held.push({ req, res });
        return;
      }
      if (state.answer401) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: false }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(INFO);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    state.server = server;
    state.port = server.address().port;
    cleanups.push(() => { server.closeAllConnections(); server.close(); });
    return state;
  }

  function linkOn(node, connection = fakeConnection(pairingFor(node.port))) {
    const link = new NodeLink({ connection, freePort: async () => node.port });
    cleanups.push(() => link.close());
    return { link, connection };
  }

  async function hubOn(link) {
    const hub = await hubFor(link);
    cleanups.push(() => hub.server.close());
    return hub;
  }

  /** A long download through the hub, already flowing. */
  function openStream(hub) {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: hub.port, path: '/stream' }, (res) => {
        const stream = { text: '', ended: false, cut: false };
        res.on('data', (chunk) => { stream.text += chunk; });
        res.on('end', () => { stream.ended = true; });
        res.on('close', () => { if (!stream.ended) stream.cut = true; });
        res.on('error', () => { stream.cut = true; });
        res.once('data', () => resolve(stream));
      });
      req.on('error', reject);
    });
  }

  const linkLostLines = () => warn.mock.calls
    .filter(([tag]) => tag === '[node-link] link lost')
    .map(([, line]) => JSON.parse(line));

  it('survives a probe failing on a reused socket: the stream goes on and the fresh probe answers', async () => {
    const node = await startNode();
    const { link, connection } = linkOn(node);
    const hub = await hubOn(link);
    const stream = await openStream(hub);
    await link.info();

    node.failNext = 1;
    await expect(link.info()).resolves.toMatchObject({ hostname: 'node-1' });

    // Real reuse, and a really new connection for the second opinion.
    expect(node.probes).toHaveLength(3);
    expect(node.probes[1].socket).toBe(node.probes[0].socket);
    expect(node.probes[2].socket).not.toBe(node.probes[1].socket);

    await new Promise((resolve) => { setTimeout(resolve, 50); });
    expect(stream.cut).toBe(false);
    expect(link.ready).toBe(true);
    expect(connection.children[0].kill).not.toHaveBeenCalled();
    expect(connection.fetchPairing).toHaveBeenCalledOnce();
    expect(linkLostLines()).toEqual([]);

    node.finishStream();
    await vi.waitFor(() => expect(stream.ended).toBe(true));
    expect(stream.text).toBe('startend');
  });

  it('keeps using the normal pool afterwards', async () => {
    const node = await startNode();
    const { link } = linkOn(node);
    await link.info();
    const agent = link._agent;
    node.failNext = 1;
    await link.info();
    expect(link._agent).toBe(agent);
    await link.info();
    expect(link._agent).toBe(agent);
  });

  it('gives up after one more try when the new connection fails too, and only then', async () => {
    const node = await startNode();
    const { link, connection } = linkOn(node);
    await link.info();

    node.failNext = 100;
    const before = node.probes.length;
    await expect(link.info()).rejects.toMatchObject({ code: ErrorCode.NODE_NOT_RUNNING });

    expect(node.probes.length - before).toBe(2);
    expect(link.ready).toBe(false);
    expect(link._pairing).toBeNull();
    expect(connection.children[0].kill).toHaveBeenCalledOnce();
    const [lost] = linkLostLines();
    expect(lost).toMatchObject({ serverId: 'node-1', reason: 'health-failed', code: 'ECONNRESET' });
  });

  it('finds a node that really moved: stopped here, reinstalled on another port', async () => {
    const moved = await startNode();
    const first = await startNode();
    let port = first.port;
    const pairings = [pairingFor(first.port), pairingFor(moved.port)];
    const connection = fakeConnection(null, { fetchPairing: vi.fn(async () => pairings.shift()) });
    const link = new NodeLink({ connection, freePort: async () => port });
    cleanups.push(() => link.close());
    await expect(link.info()).resolves.toMatchObject({ hostname: 'node-1' });

    first.server.closeAllConnections();
    first.server.close();
    await expect(link.info()).rejects.toMatchObject({ code: ErrorCode.NODE_NOT_RUNNING });
    expect(link.ready).toBe(false);

    port = moved.port;
    await expect(link.info()).resolves.toMatchObject({ hostname: 'node-1' });
    expect(connection.fetchPairing).toHaveBeenCalledTimes(2);
    expect(connection.openForward.mock.calls[1][0]).toMatchObject({ remotePort: moved.port });
  });

  it('never repeats a write, and one failing leaves the link alone', async () => {
    const node = await startNode();
    const { link, connection } = linkOn(node);
    await link.info();
    const before = node.probes.length;

    node.failNext = 1;
    await expect(link.requestJson('POST', '/api/plugins/x/tools/y', { go: true })).rejects.toMatchObject({ code: ErrorCode.NODE_NOT_RUNNING });

    expect(node.probes.length - before).toBe(1);
    expect(link.ready).toBe(true);
    expect(connection.children[0].kill).not.toHaveBeenCalled();
  });

  it('does not repeat a relayed request either', async () => {
    const node = await startNode();
    const { link } = linkOn(node);
    const hub = await hubOn(link);
    await link.ensure();
    const before = node.probes.length;

    node.failNext = 1;
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: hub.port, path: '/api/x', method: 'POST' }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end('{}');
    });

    expect(status).toBe(503);
    expect(node.probes.length - before).toBe(1);
    expect(link.ready).toBe(true);
  });

  it('takes a rejected token at its word, with no second try', async () => {
    const node = await startNode();
    const { link, connection } = linkOn(node);
    await link.info();
    const before = node.probes.length;

    node.answer401 = true;
    await expect(link.info()).rejects.toMatchObject({ code: ErrorCode.NODE_AUTH_FAILED });

    expect(node.probes.length - before).toBe(1);
    expect(link._pairing).toBeNull();
    expect(connection.children[0].kill).toHaveBeenCalledOnce();
    expect(linkLostLines()[0]).toMatchObject({ reason: 'auth-rejected', code: 'HTTP_401' });
  });

  it('does not count a probe that times out as the node being gone', async () => {
    const node = await startNode();
    const { link } = linkOn(node);
    await link.info();
    node.holdNext = true;
    const original = link.requestJson.bind(link);
    link.requestJson = (method, path, body, options) => original(method, path, body, { ...options, timeout: 30 });
    await expect(link.info()).rejects.toMatchObject({ code: ErrorCode.SSH_TIMEOUT });
    expect(link.ready).toBe(true);
  });

  describe('an answer from a forward already replaced', () => {
    /**
     * A probe waiting on tunnel A, and the link since moved to tunnel B. A's agent
     * is kept out of the drop so its socket really lives on to answer late.
     */
    async function replacedWhileWaiting(call) {
      const node = await startNode();
      const { link, connection } = linkOn(node);
      await link.ensure();
      node.holdNext = true;
      const pending = call(link).catch((err) => err);
      await vi.waitFor(() => expect(node.held).toHaveLength(1));

      link._agent = new http.Agent();
      link._upgradeAgent = new http.Agent();
      link.reset('test');
      await link.ensure();
      expect(connection.openForward).toHaveBeenCalledTimes(2);
      warn.mockClear();
      return { node, link, connection, pending, held: node.held[0] };
    }

    const stillOnB = ({ link, connection }) => {
      expect(link.ready).toBe(true);
      expect(connection.children[1].kill).not.toHaveBeenCalled();
      expect(connection.fetchPairing).toHaveBeenCalledTimes(2);
      expect(linkLostLines()).toEqual([]);
    };

    it('does not reset the new link when the old probe fails, and does not retry on it', async () => {
      const replaced = await replacedWhileWaiting((link) => link.info());
      const before = replaced.node.probes.length;
      replaced.held.req.socket.resetAndDestroy();
      expect((await replaced.pending).code).toBe(ErrorCode.NODE_NOT_RUNNING);
      expect(replaced.node.probes).toHaveLength(before);
      stillOnB(replaced);
    });

    it('does not reset the new link on a late 401', async () => {
      const replaced = await replacedWhileWaiting((link) => link.requestJson('GET', '/api/node/info'));
      replaced.held.res.writeHead(401, { 'content-type': 'application/json' });
      replaced.held.res.end('{}');
      expect((await replaced.pending).code).toBe(ErrorCode.NODE_AUTH_FAILED);
      stillOnB(replaced);
    });

    it('does not reset the new link on a late 401 to a relayed request or upgrade', async () => {
      for (const relay of [
        (link, hub) => new Promise((resolve) => {
          http.get({ host: '127.0.0.1', port: hub.port, path: '/api/x' }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', () => resolve('error'));
        }),
        (link, hub) => new Promise((resolve) => {
          const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/ws/status`);
          ws.on('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode); });
          ws.on('error', () => resolve('error'));
        }),
      ]) {
        const node = await startNode();
        const { link, connection } = linkOn(node);
        const hub = await hubOn(link);
        await link.ensure();
        node.holdNext = true;
        // Upgrades reach the server's `upgrade` event, not the request handler.
        node.server.on('upgrade', (req, socket) => {
          node.held.push({ req, res: { writeHead() {}, end() { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); } } });
        });
        const pending = relay(link, hub);
        await vi.waitFor(() => expect(node.held).toHaveLength(1));

        link._agent = new http.Agent();
        link._upgradeAgent = new http.Agent();
        link.reset('test');
        await link.ensure();
        warn.mockClear();

        node.held[0].res.writeHead(401);
        node.held[0].res.end('{}');
        await pending;
        expect(link.ready).toBe(true);
        expect(connection.children[1].kill).not.toHaveBeenCalled();
        expect(linkLostLines()).toEqual([]);
      }
    });

    it('does not reset the new link when the second opinion fails late', async () => {
      const node = await startNode();
      const { link, connection } = linkOn(node);
      await link.info();
      node.failNext = 1;
      // The first attempt fails, the fresh one then waits.
      const original = link.requestJson.bind(link);
      link.requestJson = (method, path, body, options) => {
        if (options && options.freshConnection) node.holdNext = true;
        return original(method, path, body, options);
      };
      const pending = link.info().catch((err) => err);
      await vi.waitFor(() => expect(node.held).toHaveLength(1));

      link._agent = new http.Agent();
      link._upgradeAgent = new http.Agent();
      link.reset('test');
      await link.ensure();
      warn.mockClear();

      node.held[0].req.socket.resetAndDestroy();
      expect((await pending).code).toBe(ErrorCode.NODE_NOT_RUNNING);
      expect(link.ready).toBe(true);
      expect(connection.children[1].kill).not.toHaveBeenCalled();
      expect(linkLostLines()).toEqual([]);
    });

    it('fails cleanly when the link is closed during the second opinion', async () => {
      const node = await startNode();
      const { link } = linkOn(node);
      await link.info();
      node.failNext = 1;
      const original = link.requestJson.bind(link);
      link.requestJson = (method, path, body, options) => {
        if (options && options.freshConnection) node.holdNext = true;
        return original(method, path, body, options);
      };
      const pending = link.info().catch((err) => err);
      await vi.waitFor(() => expect(node.held).toHaveLength(1));
      link.close();
      expect((await pending).code).toBe(ErrorCode.NODE_NOT_RUNNING);
      expect(link.ready).toBe(false);
    });
  });

  describe('what is written down when a link goes', () => {
    const SECRET_PATH = '/api/files/raw?path=%2Fetc%2Fsecret&token=browser-token';

    it('records an ssh exit with its status', async () => {
      const node = await startNode();
      const { link, connection } = linkOn(node);
      await link.ensure();
      connection.children[0].emit('exit', 255, null);
      const [lost] = linkLostLines();
      expect(lost).toMatchObject({ serverId: 'node-1', reason: 'ssh-exit', exitCode: 255, signal: null });
      expect(new Date(lost.at).toISOString()).toBe(lost.at);
    });

    it('records a signal too', async () => {
      const node = await startNode();
      const { link, connection } = linkOn(node);
      await link.ensure();
      connection.children[0].emit('exit', null, 'SIGPIPE');
      expect(linkLostLines()[0]).toMatchObject({ reason: 'ssh-exit', exitCode: null, signal: 'SIGPIPE' });
    });

    it('records a forward that cannot connect', async () => {
      const server = net.createServer((socket) => { socket.on('error', () => {}); socket.resume(); });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();
      cleanups.push(() => server.close());
      const connection = fakeConnection(pairingFor(port, { tls: true, tlsFingerprint: 'AA' }));
      const link = new NodeLink({ connection, freePort: async () => port, stallLimits: { connect: 30 } });
      cleanups.push(() => link.close());
      const hub = await hubOn(link);
      await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: hub.port, path: SECRET_PATH }, (res) => { res.resume(); resolve(); }).on('error', reject);
      });
      expect(linkLostLines()[0]).toMatchObject({ reason: 'connect-timeout', code: 'ETIMEDOUT' });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
    });

    it('records a deliberate close once, and nothing for a link that was never up', async () => {
      const node = await startNode();
      const { link } = linkOn(node);
      link.close();
      expect(linkLostLines()).toEqual([]);

      const { link: used } = linkOn(node);
      await used.ensure();
      used.close();
      used.close();
      expect(linkLostLines().map((line) => line.reason)).toEqual(['closed']);
    });

    it('never writes a token, a path, a host or a message', async () => {
      const node = await startNode();
      const { link, connection } = linkOn(node);
      const hub = await hubOn(link);
      await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: hub.port, path: SECRET_PATH, headers: { authorization: 'Bearer browser-token' } }, (res) => { res.resume(); res.on('end', resolve); }).on('error', reject);
      });
      node.failNext = 100;
      await link.info().catch(() => {});
      connection.children[0].emit('exit', 1, null);

      const written = JSON.stringify(warn.mock.calls);
      expect(linkLostLines().length).toBeGreaterThan(0);
      for (const forbidden of [TOKEN, 'browser-token', 'secret', '/api/', '127.0.0.1', String(node.port), 'not answering']) {
        expect(written).not.toContain(forbidden);
      }
      const [lost] = linkLostLines();
      expect(Object.keys(lost).sort()).toEqual(['at', 'code', 'exitCode', 'reason', 'serverId', 'signal']);
    });
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

    // A certificate that no longer matches never sees the token, and the next
    // attempt reads the pairing file again: the node may have been reinstalled.
    const rotated = linkWith('00:' + 'AA:'.repeat(30) + 'FF');
    await rotated.ensure();
    const rotatedHub = await hubFor(rotated);
    await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${rotatedHub.port}/ws/status`);
      ws.on('error', resolve);
    });
    expect(rotated._pairing).toBeNull();
    expect(rotated.ready).toBe(false);
    rotatedHub.server.close();
    rotated.close();

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

  describe('a health check over TLS', () => {
    /** A pinned node that can reset the connection of one chosen request. */
    async function pinnedNode() {
      const state = { requests: [], failNext: 0 };
      const server = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
        state.requests.push(req.socket);
        if (state.failNext > 0) {
          state.failNext -= 1;
          req.socket.destroy();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: { protocol: 1, hostname: 'node-1' } }));
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      state.port = server.address().port;
      state.close = () => { server.closeAllConnections(); server.close(); };
      return state;
    }

    function pinnedLink(port) {
      const connection = fakeConnection(pairingFor(port, { tls: true, tlsFingerprint: certificateFingerprint(tls.cert) }));
      return { link: new NodeLink({ connection, freePort: async () => port }), connection };
    }

    it('confirms on a new connection, still pinned, and keeps the link', async () => {
      const node = await pinnedNode();
      const { link, connection } = pinnedLink(node.port);
      await link.info();
      node.failNext = 1;

      await expect(link.info()).resolves.toMatchObject({ hostname: 'node-1' });

      expect(node.requests).toHaveLength(3);
      expect(node.requests[1]).toBe(node.requests[0]);
      expect(node.requests[2]).not.toBe(node.requests[1]);
      expect(link.ready).toBe(true);
      expect(connection.children[0].kill).not.toHaveBeenCalled();
      link.close();
      node.close();
    });

    it('still sends no token to a certificate that changed, and pairs again', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const node = await pinnedNode();
      const { link, connection } = pinnedLink(node.port);
      await link.info();
      link._upgradeAgent = pinnedAgent('00:' + 'AA:'.repeat(30) + 'FF', { keepAlive: false });
      node.failNext = 1;
      const before = node.requests.length;

      await expect(link.info()).rejects.toMatchObject({ code: ErrorCode.NODE_AUTH_FAILED });

      // Only the request that failed: the one on the wrong certificate never arrived.
      expect(node.requests.length - before).toBe(1);
      expect(link._pairing).toBeNull();
      expect(connection.children[0].kill).toHaveBeenCalledOnce();
      expect(JSON.parse(warn.mock.calls.find(([tag]) => tag === '[node-link] link lost')[1]))
        .toMatchObject({ reason: 'cert-changed', code: ErrorCode.NODE_AUTH_FAILED });
      warn.mockRestore();
      link.close();
      node.close();
    });
  });
});
