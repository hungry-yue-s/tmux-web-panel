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
// How long a relayed request may stall before its answer starts. Once bytes move
// there is no limit, so long downloads and uploads are fine. Writes get more room:
// generating a commit message or running a notebook is slow before it answers.
// Waiting for a free socket says nothing about the link, which may be busy streaming.
const QUEUE_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 10_000;
const READ_ANSWER_TIMEOUT_MS = 60_000;
const WRITE_ANSWER_TIMEOUT_MS = 5 * 60_000;
const UPGRADE_TIMEOUT_MS = 15_000;

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

const watchedSockets = new WeakSet();

/**
 * Makes a socket waiting on an upgrade notice its browser leaving. It only finds out
 * by reading, and that loses nothing: a WebSocket client may not send anything before
 * the handshake completes (RFC 6455). An HTTP server's sockets are half-open, so a
 * browser's FIN is only an `end`; a WebSocket has no use for half a connection, so
 * that ends it, before and after the upgrade alike. The HTTP server has dropped its
 * error handler by now, and a reset with nobody listening would take the whole
 * process down.
 */
export function watchUpgradeSocket(socket) {
  if (watchedSockets.has(socket)) return;
  watchedSockets.add(socket);
  socket.on('error', () => {});
  socket.once('end', () => socket.destroy());
  socket.resume();
}

/**
 * Ends a relayed request that stalls before its answer starts. Each wait has its
 * own limit: for a free socket in the agent's pool, for connecting (TCP and TLS
 * through the forward), and for the answer once the request has been sent. Sending
 * itself has no limit, so a big upload is not cut short. Only a connection that
 * cannot be made says the forward is dead; a full pool costs just this request.
 *
 * onStall is told directly: a request still queued for a socket reports its own
 * destruction only once it gets one, which may be never.
 */
function stallGuard(upstream, { queueMs, connectMs, answerMs, onStall, onConnectStall }) {
  let timer = null;
  const clear = () => {
    clearTimeout(timer);
    timer = null;
  };
  const arm = (ms, deadLink) => {
    clear();
    timer = setTimeout(() => {
      const err = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
      upstream.destroy(err);
      onStall(err);
      if (deadLink) deadLink();
    }, ms);
    if (timer.unref) timer.unref();
  };
  arm(queueMs);
  upstream.once('socket', (socket) => {
    clear();
    if (!socket.connecting) return;
    arm(connectMs, onConnectStall);
    socket.once(socket instanceof tls.TLSSocket ? 'secureConnect' : 'connect', clear);
  });
  upstream.once('finish', () => arm(answerMs));
  upstream.once('response', clear);
  upstream.once('upgrade', clear);
  upstream.once('close', clear);
  return clear;
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
  constructor({ connection, freePort = freeLoopbackPort, readyTimeoutMs = READY_TIMEOUT_MS, stallLimits = {} }) {
    this.connection = connection;
    this.serverId = connection.id;
    this._freePort = freePort;
    this._readyTimeoutMs = readyTimeoutMs;
    this._stallLimits = {
      queue: QUEUE_TIMEOUT_MS,
      connect: CONNECT_TIMEOUT_MS,
      read: READ_ANSWER_TIMEOUT_MS,
      write: WRITE_ANSWER_TIMEOUT_MS,
      upgrade: UPGRADE_TIMEOUT_MS,
      ...stallLimits,
    };
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
      req.on('error', (err) => {
        this._noteUpstreamError(err);
        reject(upstreamError(err));
      });
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

  /**
   * A forward nothing gets through is dead even if ssh has not noticed yet, and a
   * certificate that changed means the node was reinstalled. Each ends this link
   * only, and the next call pairs again; the certificate is still pinned to what
   * the pairing file, read over SSH, says.
   */
  _dropDeadTunnel(tunnel) {
    if (this._tunnel === tunnel) this._dropTunnel();
  }

  _noteUpstreamError(err) {
    if (err && err.code === ErrorCode.NODE_AUTH_FAILED) this.reset();
  }

  /** Streams one browser request to the node and the answer back. */
  async proxy(req, res, path) {
    await this.ensure();
    // The browser may have gone while the forward came up.
    if (res.destroyed || res.writableEnded) return;
    const tunnel = this._tunnel;
    const upstream = this._client().request(
      this._target(stripTokenParam(path), forwardRequestHeaders(req.headers, this._pairing.token), req.method),
      (answer) => {
        if (answer.statusCode === 401) this.reset();
        res.writeHead(answer.statusCode, forwardResponseHeaders(answer.headers));
        answer.pipe(res);
      },
    );
    const fail = (err) => {
      if (res.writableEnded) return;
      if (res.headersSent) { res.destroy(); return; }
      const appError = upstreamError(err);
      res.status(appError.status).json({ success: false, data: null, error: appError.toJSON(), meta: { requestId: null } });
    };
    stallGuard(upstream, {
      queueMs: this._stallLimits.queue,
      connectMs: this._stallLimits.connect,
      answerMs: /^(GET|HEAD)$/i.test(req.method) ? this._stallLimits.read : this._stallLimits.write,
      onStall: fail,
      onConnectStall: () => this._dropDeadTunnel(tunnel),
    });
    upstream.on('error', (err) => {
      this._noteUpstreamError(err);
      fail(err);
    });
    // Closing the browser side (e.g. an aborted download) ends the upstream too.
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    req.pipe(upstream);
  }

  /** Relays a WebSocket upgrade byte-for-byte after the node accepts it. */
  async proxyUpgrade(req, socket, head, path) {
    watchUpgradeSocket(socket);
    try {
      await this.ensure();
    } catch (err) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      throw err;
    }
    // The browser may have gone while the forward came up. Asking the node now
    // would start an attach client for nobody, and it would take the pane over.
    if (socket.destroyed) return;
    const headers = forwardRequestHeaders(req.headers, this._pairing.token);
    headers.connection = 'Upgrade';
    headers.upgrade = 'websocket';
    const tunnel = this._tunnel;
    const upstream = this._client().request({ ...this._target(stripTokenParam(path), headers, 'GET'), agent: this._upgradeAgent });
    const abandon = () => upstream.destroy();
    socket.once('close', abandon);
    stallGuard(upstream, {
      queueMs: this._stallLimits.queue,
      connectMs: this._stallLimits.connect,
      answerMs: this._stallLimits.upgrade,
      onStall: () => {
        if (!socket.destroyed) socket.end('HTTP/1.1 504 Gateway Timeout\r\nConnection: close\r\n\r\n');
      },
      onConnectStall: () => this._dropDeadTunnel(tunnel),
    });
    upstream.on('upgrade', (answer, upstreamSocket, upstreamHead) => {
      socket.off('close', abandon);
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
    upstream.on('error', (err) => {
      this._noteUpstreamError(err);
      // A stall has already answered, and ending that socket here would cut it off.
      if (!err || err.code !== 'ETIMEDOUT') socket.destroy();
    });
    upstream.end();
  }
}
