/**
 * NodeLink: one hub-to-node connection.
 *
 * A link pairs once (SFTP-read of the node's pairing file), then keeps a single
 * `ssh -N -L` forward open and talks plain HTTP(S) to the node through it. The
 * node is the same panel the browser would talk to; the hub only adds the node
 * token and pins the node's TLS certificate.
 *
 * Every caller — health probes, the /n/:serverId proxy, terminal sockets —
 * goes through ensure(), which collapses concurrent connects onto one attempt.
 */

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

import { AppError, ErrorCode } from '../servers/errors.js';
import { NODE_PROTOCOL } from '../node/identity.js';

const READY_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 15_000;

/** Headers that describe one hop and must not be forwarded (RFC 9110 §7.6.1). */
export const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection',
]);

/**
 * Request headers the hub must not pass to a node: the browser's own
 * credentials, and the browser's Host/Origin, which describe the hub.
 */
const STRIP_REQUEST = new Set(['host', 'authorization', 'cookie', 'origin', 'referer']);

export function forwardRequestHeaders(headers, token) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key) || STRIP_REQUEST.has(key)) continue;
    out[key] = value;
  }
  out.authorization = `Bearer ${token}`;
  return out;
}

export function forwardResponseHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  return out;
}

/** Drops the browser's `token` query parameter; the node gets its own token. */
export function stripTokenParam(path) {
  const q = path.indexOf('?');
  if (q < 0) return path;
  const params = new URLSearchParams(path.slice(q + 1));
  params.delete('token');
  const rest = params.toString();
  return path.slice(0, q) + (rest ? '?' + rest : '');
}

/** Grabs a free loopback port for the forward's local end. */
export function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function waitForListener(port, timeoutMs, failed) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    let done = false;
    failed.then((err) => { if (!done) { done = true; reject(err); } });
    const attempt = () => {
      if (done) return;
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); if (!done) { done = true; resolve(); } });
      socket.once('error', () => {
        socket.destroy();
        if (done) return;
        if (Date.now() > deadline) {
          done = true;
          reject(new AppError(ErrorCode.SSH_TIMEOUT, 'SSH port forward did not come up'));
          return;
        }
        setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

/** An https.Agent that accepts exactly one certificate, by SHA-256 fingerprint. */
export function pinnedAgent(fingerprint, { keepAlive = true } = {}) {
  const agent = new https.Agent({ keepAlive, maxSockets: 16 });
  agent.createConnection = (options) => {
    const socket = tls.connect({ ...options, rejectUnauthorized: false, servername: undefined });
    // Runs before any buffered request bytes are flushed, so a wrong
    // certificate never sees the node token.
    socket.once('secureConnect', () => {
      const presented = socket.getPeerCertificate()?.fingerprint256;
      if (presented !== fingerprint) socket.destroy(new AppError(ErrorCode.NODE_AUTH_FAILED, 'Node TLS certificate does not match its pairing file'));
    });
    return socket;
  };
  return agent;
}

function upstreamError(err) {
  if (err instanceof AppError) return err;
  if (err && (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' || err.code === 'EPIPE' || /socket hang up/i.test(err.message || ''))) {
    // The forward is up but nothing answers on the node's port.
    return new AppError(ErrorCode.NODE_NOT_RUNNING, 'tmux-web-panel is not answering on that host');
  }
  if (err && err.code === 'ETIMEDOUT') return new AppError(ErrorCode.SSH_TIMEOUT, 'Node request timed out');
  return new AppError(ErrorCode.SERVER_OFFLINE, 'Node request failed');
}

export class NodeLink {
  /**
   * @param {object} deps
   * @param {import('../transport/ssh-connection.js').SshConnection} deps.connection
   */
  constructor({ connection, freePort = freeLoopbackPort, readyTimeoutMs = READY_TIMEOUT_MS }) {
    this.connection = connection;
    this.serverId = connection.id;
    this._freePort = freePort;
    this._readyTimeoutMs = readyTimeoutMs;
    this._pairing = null;
    this._tunnel = null; // { child, port }
    this._agent = null;
    this._upgradeAgent = null;
    this._connecting = null;
    this._closed = false;
  }

  get ready() {
    return Boolean(this._tunnel && this._pairing);
  }

  /** Opens (or reuses) the forward. Concurrent callers share one attempt. */
  ensure() {
    if (this._closed) return Promise.reject(new AppError(ErrorCode.SERVER_NOT_FOUND, 'Link closed'));
    if (this.ready) return Promise.resolve();
    if (!this._connecting) {
      this._connecting = this._connect().finally(() => { this._connecting = null; });
    }
    return this._connecting;
  }

  async _connect() {
    const pairing = this._pairing || await this.connection.fetchPairing();
    if (pairing.protocol !== NODE_PROTOCOL) {
      throw new AppError(ErrorCode.NODE_INCOMPATIBLE, `Node speaks protocol ${pairing.protocol}, this panel ${NODE_PROTOCOL}`);
    }
    const port = await this._freePort();
    const forward = this.connection.openForward({ localPort: port, remoteHost: pairing.host, remotePort: pairing.port });
    try {
      await waitForListener(port, this._readyTimeoutMs, forward.whenFailed);
    } catch (err) {
      forward.child.kill();
      throw err;
    }
    if (this._closed) {
      forward.child.kill();
      throw new AppError(ErrorCode.SERVER_NOT_FOUND, 'Link closed');
    }
    const tunnel = { child: forward.child, port };
    forward.child.once('exit', () => {
      if (this._tunnel === tunnel) this._dropTunnel();
    });
    this._pairing = pairing;
    this._tunnel = tunnel;
    this._agent = pairing.tls ? pinnedAgent(pairing.tlsFingerprint) : new http.Agent({ keepAlive: true, maxSockets: 16 });
    // Upgraded sockets leave their agent for good, so they get one without a pool.
    this._upgradeAgent = pairing.tls ? pinnedAgent(pairing.tlsFingerprint, { keepAlive: false }) : new http.Agent({ keepAlive: false });
  }

  _dropTunnel() {
    const tunnel = this._tunnel;
    this._tunnel = null;
    if (this._agent) this._agent.destroy();
    if (this._upgradeAgent) this._upgradeAgent.destroy();
    this._agent = null;
    this._upgradeAgent = null;
    if (tunnel && tunnel.child.exitCode === null) tunnel.child.kill();
  }

  /** Forget the pairing too, e.g. after the node rejected our token. */
  reset() {
    this._dropTunnel();
    this._pairing = null;
  }

  close() {
    this._closed = true;
    this.reset();
  }

  _target(path, headers, method = 'GET') {
    return {
      host: '127.0.0.1',
      port: this._tunnel.port,
      method,
      path,
      headers,
      agent: this._agent,
    };
  }

  _client() {
    return this._pairing.tls ? https : http;
  }

  /** Small JSON call for the hub's own use (health, plugin forwarding). */
  async requestJson(method, path, body = undefined, { timeout = REQUEST_TIMEOUT_MS } = {}) {
    await this.ensure();
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = forwardRequestHeaders({ accept: 'application/json' }, this._pairing.token);
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(payload.length);
    }
    const { status, text } = await new Promise((resolve, reject) => {
      const req = this._client().request(this._target(path, headers, method), (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      });
      req.setTimeout(timeout, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
      req.on('error', (err) => reject(upstreamError(err)));
      req.end(payload || undefined);
    });
    if (status === 401) {
      // The node was reinstalled or its token rotated: re-pair next time.
      this.reset();
      throw new AppError(ErrorCode.NODE_AUTH_FAILED, 'The node rejected this panel\'s token');
    }
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (status < 200 || status >= 300 || (json && json.success === false)) {
      const error = json && json.error && typeof json.error === 'object' ? json.error : null;
      throw new AppError(ErrorCode[error?.code] ? error.code : ErrorCode.INTERNAL,
        (error && error.message) || (typeof json?.error === 'string' ? json.error : `Node answered HTTP ${status}`),
        { status });
    }
    return json && typeof json === 'object' && 'success' in json ? json.data : json;
  }

  async info() {
    try {
      return await this.requestJson('GET', '/api/node/info');
    } catch (err) {
      // A restarted node may listen elsewhere now; read the pairing file again.
      if (err.code === ErrorCode.NODE_NOT_RUNNING) this.reset();
      throw err;
    }
  }

  /** Streams one browser request to the node and the answer back. */
  async proxy(req, res, path) {
    await this.ensure();
    const upstream = this._client().request(
      this._target(stripTokenParam(path), forwardRequestHeaders(req.headers, this._pairing.token), req.method),
      (answer) => {
        if (answer.statusCode === 401) this.reset();
        res.writeHead(answer.statusCode, forwardResponseHeaders(answer.headers));
        answer.pipe(res);
      },
    );
    upstream.on('error', (err) => {
      if (res.headersSent) { res.destroy(); return; }
      const appError = upstreamError(err);
      res.status(appError.status).json({ success: false, data: null, error: appError.toJSON(), meta: { requestId: null } });
    });
    // Closing the browser side (e.g. an aborted download) ends the upstream too.
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    req.pipe(upstream);
  }

  /** Relays a WebSocket upgrade byte-for-byte after the node accepts it. */
  async proxyUpgrade(req, socket, head, path) {
    try {
      await this.ensure();
    } catch (err) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      throw err;
    }
    const headers = forwardRequestHeaders(req.headers, this._pairing.token);
    headers.connection = 'Upgrade';
    headers.upgrade = 'websocket';
    const upstream = this._client().request({ ...this._target(stripTokenParam(path), headers, 'GET'), agent: this._upgradeAgent });
    upstream.on('upgrade', (answer, upstreamSocket, upstreamHead) => {
      const lines = [`HTTP/1.1 ${answer.statusCode} ${answer.statusMessage || 'Switching Protocols'}`];
      for (let i = 0; i < answer.rawHeaders.length; i += 2) lines.push(`${answer.rawHeaders[i]}: ${answer.rawHeaders[i + 1]}`);
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      if (upstreamHead && upstreamHead.length) socket.write(upstreamHead);
      if (head && head.length) upstreamSocket.write(head);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
      const end = () => { upstreamSocket.destroy(); socket.destroy(); };
      upstreamSocket.on('error', end);
      socket.on('error', end);
      upstreamSocket.on('close', end);
      socket.on('close', end);
    });
    upstream.on('response', (answer) => {
      if (answer.statusCode === 401) this.reset();
      socket.end(`HTTP/1.1 ${answer.statusCode} ${answer.statusMessage || ''}\r\nConnection: close\r\n\r\n`);
      answer.resume();
    });
    upstream.on('error', () => socket.destroy());
    upstream.end();
  }
}
