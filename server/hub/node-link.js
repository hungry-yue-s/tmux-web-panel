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
import { DEFAULT_TRANSPORT } from '../servers/registry.js';
import { NODE_PROTOCOL } from '../node/identity.js';
import { diagnostics } from '../diagnostics.js';

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
// A connection dropped under a request: what a pooled socket the node closed looks like.
const RETRYABLE_READ_ERRORS = new Set(['ECONNRESET', 'EPIPE']);
// Not worth a second attempt with less time than this left.
const MIN_RETRY_MS = 1000;
// The node's own listener: how long its check may take, and how long a failed one stands.
const DIRECT_CHECK_TIMEOUT_MS = 5_000;
const DIRECT_RECHECK_MS = 5 * 60_000;

/** True when a request may carry a body, which a retry could not send again. */
function hasRequestBody(headers) {
  if (headers['transfer-encoding']) return true;
  const length = headers['content-length'];
  return length !== undefined && length !== '0';
}

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

/**
 * TLS sessions a link may resume. It holds only sessions from connections whose
 * certificate passed the pin, lives in memory, and belongs to one forward of one
 * pairing: a new tunnel or pairing starts with an empty one.
 */
export function createSessionCache() {
  let session = null;
  return {
    get: () => session,
    set: (value) => { session = value; },
    clear: () => { session = null; },
  };
}

/**
 * An https.Agent that accepts exactly one certificate, by SHA-256 fingerprint.
 *
 * Every connection is checked before the request goes out. A full handshake shows
 * the certificate and it must match. A resumed one shows none at all (Node reports
 * an empty certificate), so it passes only when it resumed a session from `sessions`:
 * finishing a resumption proves the node holds the secret of a handshake that did
 * match. Resumption is never 0-RTT here; the request is sent after the handshake.
 */
export function pinnedAgent(fingerprint, { keepAlive = true, sessions = createSessionCache() } = {}) {
  const agent = new https.Agent({ keepAlive, maxSockets: 16 });
  agent.createConnection = (options) => {
    const offered = sessions.get();
    const socket = tls.connect({ ...options, rejectUnauthorized: false, servername: undefined, ...(offered ? { session: offered } : {}) });
    let verified = false;
    // TLS 1.2 hands its session over before the handshake completes; keep it until the pin passed.
    let early = null;
    socket.on('session', (session) => {
      if (verified) sessions.set(session);
      else early = session;
    });
    // Runs before any buffered request bytes are flushed, so a wrong
    // certificate never sees the node token.
    socket.once('secureConnect', () => {
      const resumed = Boolean(offered) && socket.isSessionReused();
      if (!resumed && socket.getPeerCertificate()?.fingerprint256 !== fingerprint) {
        sessions.clear();
        socket.destroy(new AppError(ErrorCode.NODE_AUTH_FAILED, 'Node TLS certificate does not match its pairing file'));
        return;
      }
      verified = true;
      if (early) sessions.set(early);
      early = null;
    });
    // A handshake that failed may have failed on the session it offered.
    socket.once('close', (hadError) => {
      if (hadError && !verified && offered && sessions.get() === offered) sessions.clear();
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
  let phase = 'queue';
  const clear = () => {
    clearTimeout(timer);
    timer = null;
  };
  const arm = (ms, deadLink) => {
    clear();
    timer = setTimeout(() => {
      const err = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
      upstream.destroy(err);
      onStall(err, phase);
      if (deadLink) deadLink();
    }, ms);
    if (timer.unref) timer.unref();
  };
  arm(queueMs);
  upstream.once('socket', (socket) => {
    clear();
    if (!socket.connecting) return;
    phase = 'connect';
    arm(connectMs, onConnectStall);
    socket.once(socket instanceof tls.TLSSocket ? 'secureConnect' : 'connect', clear);
  });
  upstream.once('finish', () => { phase = 'answer'; arm(answerMs); });
  upstream.once('response', clear);
  upstream.once('upgrade', clear);
  upstream.once('close', clear);
  return clear;
}

function upstreamError(err) {
  if (err instanceof AppError) return err;
  if (err && (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' || err.code === 'EPIPE' || /socket hang up/i.test(err.message || ''))) {
    // The forward is up but nothing answers on the node's port.
    const notRunning = new AppError(ErrorCode.NODE_NOT_RUNNING, 'tmux-web-panel is not answering on that host');
    notRunning.transportCode = err.code;
    return notRunning;
  }
  if (err && err.code === 'ETIMEDOUT') return new AppError(ErrorCode.SSH_TIMEOUT, 'Node request timed out');
  return new AppError(ErrorCode.SERVER_OFFLINE, 'Node request failed');
}

/**
 * One line for every forward that goes down, so the next unexplained disconnect can
 * be traced. Fixed reasons, error codes and exit status only: no URL, header, token,
 * ssh argument or stderr.
 */
function logLinkLost(serverId, reason, { code = null, exitCode = null, signal = null } = {}) {
  console.warn('[node-link] link lost', JSON.stringify({ at: new Date().toISOString(), serverId, reason, code, exitCode, signal }));
}

export class NodeLink {
  /**
   * @param {object} deps
   * @param {import('../transport/ssh-connection.js').SshConnection} deps.connection
   */
  constructor({ connection, freePort = freeLoopbackPort, readyTimeoutMs = READY_TIMEOUT_MS, stallLimits = {},
    directCheckTimeoutMs = DIRECT_CHECK_TIMEOUT_MS, now = () => Date.now() }) {
    this.connection = connection;
    this.serverId = connection.id;
    this._freePort = freePort;
    this._readyTimeoutMs = readyTimeoutMs;
    this._directCheckTimeoutMs = directCheckTimeoutMs;
    this._now = now;
    /** The node's own listener, when the server asks for it: see _route. */
    this._direct = null;
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
    forward.child.once('exit', (exitCode, signal) => {
      if (this._tunnel === tunnel) this._dropTunnel('ssh-exit', { exitCode, signal });
    });
    this._pairing = pairing;
    this._tunnel = tunnel;
    // Both agents talk to the same node through the same forward, so a terminal's
    // handshake may resume what a request already negotiated. Never across tunnels.
    const sessions = createSessionCache();
    this._agent = pairing.tls ? pinnedAgent(pairing.tlsFingerprint, { sessions }) : new http.Agent({ keepAlive: true, maxSockets: 16 });
    // Upgraded sockets leave their agent for good, so they get one without a pool.
    this._upgradeAgent = pairing.tls ? pinnedAgent(pairing.tlsFingerprint, { keepAlive: false, sessions }) : new http.Agent({ keepAlive: false });
  }

  _dropTunnel(reason = 'reset', detail) {
    const tunnel = this._tunnel;
    if (tunnel) logLinkLost(this.serverId, reason, detail);
    this._tunnel = null;
    if (this._agent) this._agent.destroy();
    if (this._upgradeAgent) this._upgradeAgent.destroy();
    this._agent = null;
    this._upgradeAgent = null;
    if (tunnel && tunnel.child.exitCode === null) tunnel.child.kill();
  }

  /** Forget the pairing too, e.g. after the node rejected our token. */
  reset(reason, detail) {
    this._dropTunnel(reason, detail);
    this._closeDirect();
    this._pairing = null;
  }

  /**
   * reset, unless the link has moved on since `tunnel`: an answer from a forward
   * already replaced says nothing about the one running now.
   */
  _resetIfCurrent(tunnel, reason, detail) {
    if (this._tunnel === tunnel) this.reset(reason, detail);
  }

  close() {
    this._closed = true;
    this.reset('closed');
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

  // No listeners or extra request headers while diagnostics are disabled.
  _diagnosticHeaders(headers) {
    const context = diagnostics.currentContext();
    if (diagnostics.status().active && context?.requestId) headers['x-twp-diagnostic-id'] = context.requestId;
    return headers;
  }

  _traceRequest(request, path, began, ensureMs, via = 'ssh') {
    if (!diagnostics.status().active) return;
    const context = { ...diagnostics.currentContext(), serverId: this.serverId, path, provider: 'node-link', via };
    const queuedAt = performance.now();
    const note = (phase, fields = {}) => diagnostics.record('proxy', {
      ...context, phase, ensureMs, durationMs: performance.now() - began, ...fields,
    });
    request.once('socket', (socket) => {
      const assigned = performance.now();
      note('socket', { queueMs: assigned - queuedAt, reusedSocket: Boolean(request.reusedSocket) });
      if (socket.connecting) {
        socket.once('connect', () => note('connect', { connectMs: performance.now() - assigned }));
        if (socket instanceof tls.TLSSocket) socket.once('secureConnect', () => note('tls', { tlsMs: performance.now() - assigned }));
      }
    });
    request.once('finish', () => note('sent'));
    request.once('response', (answer) => note('headers', {
      status: answer.statusCode, headersMs: performance.now() - queuedAt,
      traceId: answer.headers['x-twp-diagnostic-id'],
    }));
    request.once('upgrade', (answer) => note('upgrade', { status: answer.statusCode, headersMs: performance.now() - queuedAt }));
    request.once('error', (err) => note('error', { transportCode: err.code, timedOut: err.code === 'ETIMEDOUT' }));
    request.once('close', () => note('close'));
  }

  /**
   * Small JSON call for the hub's own use (health, plugin forwarding).
   * freshConnection: on a new socket rather than one from the pool. The agent for
   * upgrades never keeps any, is pinned the same way and leaves the pool alone.
   */
  async requestJson(method, path, body = undefined, { timeout = REQUEST_TIMEOUT_MS, freshConnection = false } = {}) {
    const began = performance.now();
    await this.ensure();
    const ensureMs = performance.now() - began;
    const tunnel = this._tunnel;
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = this._diagnosticHeaders(forwardRequestHeaders({ accept: 'application/json' }, this._pairing.token));
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(payload.length);
    }
    const target = this._target(path, headers, method);
    if (freshConnection) target.agent = this._upgradeAgent;
    const { status, text } = await new Promise((resolve, reject) => {
      const req = this._client().request(target, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', (err) => reject(upstreamError(err)));
      });
      this._traceRequest(req, path, began, ensureMs);
      req.setTimeout(timeout, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
      req.on('error', (err) => {
        this._noteUpstreamError(tunnel, err);
        reject(upstreamError(err));
      });
      req.end(payload || undefined);
    });
    if (status === 401) {
      // The node was reinstalled or its token rotated: re-pair next time.
      this._resetIfCurrent(tunnel, 'auth-rejected', { code: 'HTTP_401' });
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

  /**
   * The health check, and its answer decides whether this link lives. One failed
   * request does not settle that: a pooled socket the node had just closed fails
   * exactly like a node that is gone, and ending the link for it would cut every
   * healthy stream on it. So it asks once more on a new connection. Only this read
   * is retried, and only once; a rejected token or certificate needs no second opinion.
   */
  async info() {
    await this.ensure();
    const tunnel = this._tunnel;
    try {
      return await this.requestJson('GET', '/api/node/info');
    } catch (first) {
      if (first.code !== ErrorCode.NODE_NOT_RUNNING || this._tunnel !== tunnel) throw first;
    }
    try {
      return await this.requestJson('GET', '/api/node/info', undefined, { freshConnection: true });
    } catch (err) {
      // A restarted node may listen elsewhere now; read the pairing file again.
      if (err.code === ErrorCode.NODE_NOT_RUNNING) this._resetIfCurrent(tunnel, 'health-failed', { code: err.transportCode || err.code });
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
    if (this._tunnel === tunnel) this._dropTunnel('connect-timeout', { code: 'ETIMEDOUT' });
  }

  _noteUpstreamError(tunnel, err) {
    if (err && err.code === ErrorCode.NODE_AUTH_FAILED) this._resetIfCurrent(tunnel, 'cert-changed', { code: err.code });
  }

  /**
   * Streams one browser request to the node and the answer back.
   *
   * A read the connection drops before any answer is asked once more, on a new
   * connection: a pooled socket the node had just closed fails exactly like that,
   * and the browser should not see an error for it. Only a GET or HEAD without a
   * body, only while the browser is still there and the forward is the same one,
   * and only within what is left of the first attempt's time. Writes, answers that
   * have started, timeouts and certificate or token failures are never repeated.
   *
   * On the direct way (see _route), that one second attempt takes the forward
   * instead, and any failure but a stale pooled socket sends the next requests
   * through the forward too until a later check.
   */
  async proxy(req, res, path) {
    const began = performance.now();
    await this.ensure();
    const ensureMs = performance.now() - began;
    // The browser may have gone while the forward came up.
    if (res.destroyed || res.writableEnded) return;
    const tunnel = this._tunnel;
    const read = /^(GET|HEAD)$/i.test(req.method);
    const replayable = read && !hasRequestBody(req.headers);
    const target = this._target(stripTokenParam(path), this._diagnosticHeaders(forwardRequestHeaders(req.headers, this._pairing.token)), req.method);
    const fail = (err) => {
      if (res.writableEnded) return;
      if (res.headersSent) { res.destroy(); return; }
      const appError = upstreamError(err);
      res.status(appError.status).json({ success: false, data: null, error: appError.toJSON(), meta: { requestId: null } });
    };
    let current = null;
    let browserGone = false;
    // Closing the browser side (e.g. an aborted download) ends the upstream too.
    res.on('close', () => {
      if (res.writableFinished) return;
      browserGone = true;
      current?.destroy();
    });

    /**
     * retry: false for the first attempt, 'fresh' for the same way on a new
     * connection, 'forward' for the forward after the direct way failed.
     */
    const send = ({ route, retry, limits }) => {
      const upstream = this._client().request({ ...target, host: route.host, port: route.port, agent: retry === 'fresh' ? route.upgradeAgent : route.agent }, (answer) => {
        if (answer.statusCode === 401) this._resetIfCurrent(tunnel, 'auth-rejected', { code: 'HTTP_401' });
        res.writeHead(answer.statusCode, forwardResponseHeaders(answer.headers));
        answer.pipe(res);
      });
      current = upstream;
      let sentAt = null;
      let settled = false;
      upstream.once('finish', () => { sentAt = performance.now(); });
      this._traceRequest(upstream, path, began, ensureMs, route.via);
      // Measured from the moment the first request went out, or from the start if it never did.
      const timeLeft = () => limits.answerMs - (performance.now() - (sentAt ?? began));
      const again = (nextRoute, kind, err) => {
        const left = timeLeft();
        if (retry || !replayable || res.headersSent || browserGone || this._tunnel !== tunnel || left < MIN_RETRY_MS) return false;
        diagnostics.record('proxy', { ...req.diagnosticContext, serverId: this.serverId, path, via: nextRoute.via,
          phase: 'retry', retry: kind, transportCode: err?.code, reusedSocket: Boolean(upstream.reusedSocket), durationMs: performance.now() - began });
        send({ route: nextRoute, retry: kind, limits: { queueMs: left, connectMs: Math.min(this._stallLimits.connect, left), answerMs: left } });
        return true;
      };
      const settle = (err) => {
        if (settled) return;
        settled = true;
        if (route.via === 'direct') {
          // A pooled socket the node closed is not the direct way failing; anything else is.
          if (!(RETRYABLE_READ_ERRORS.has(err?.code) && upstream.reusedSocket)) this._directFailed(route.direct, directFailureReason(err));
          // Either way the forward is known to work, so the one second attempt goes there.
          if (!again(this._forwardRoute(), 'forward', err)) fail(err);
          return;
        }
        this._noteUpstreamError(tunnel, err);
        if (RETRYABLE_READ_ERRORS.has(err?.code) && again(route, 'fresh', err)) return;
        fail(err);
      };
      stallGuard(upstream, {
        ...limits,
        onStall: (err, phase) => {
          diagnostics.record('proxy', { ...req.diagnosticContext, serverId: this.serverId, path, via: route.via,
            phase, timedOut: true, transportCode: err.code, retry, durationMs: performance.now() - began });
          // Nothing reached the node over a direct way that never connected: the forward may still answer.
          if (route.via === 'direct' && phase === 'connect') { settle(err); return; }
          settled = true;
          fail(err);
        },
        onConnectStall: route.via === 'ssh' ? () => this._dropDeadTunnel(tunnel) : undefined,
      });
      upstream.on('error', settle);
      if (retry) upstream.end();
      else req.pipe(upstream);
    };

    send({
      route: this._route('api'),
      retry: false,
      limits: {
        queueMs: this._stallLimits.queue,
        connectMs: this._stallLimits.connect,
        answerMs: read ? this._stallLimits.read : this._stallLimits.write,
      },
    });
  }

  /**
   * Relays a WebSocket upgrade byte-for-byte after the node accepts it. Terminals
   * take the way chosen for terminals; the status socket counts as monitoring. When
   * the direct way cannot even connect, nothing reached the node, so the forward is
   * asked instead; once the handshake was sent, a failure ends this socket only.
   */
  async proxyUpgrade(req, socket, head, path) {
    const began = performance.now();
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
    const ensureMs = performance.now() - began;
    const headers = this._diagnosticHeaders(forwardRequestHeaders(req.headers, this._pairing.token));
    headers.connection = 'Upgrade';
    headers.upgrade = 'websocket';
    const tunnel = this._tunnel;
    const kind = stripTokenParam(path).startsWith('/ws/terminal/') ? 'terminal' : 'api';
    this._openUpgrade({ req, socket, head, path, headers, tunnel, began, ensureMs, route: this._route(kind) });
  }

  _openUpgrade({ req, socket, head, path, headers, tunnel, began, ensureMs, route }) {
    const upstream = this._client().request({ ...this._target(stripTokenParam(path), headers, 'GET'), host: route.host, port: route.port, agent: route.upgradeAgent });
    this._traceRequest(upstream, path, began, ensureMs, route.via);
    const abandon = () => upstream.destroy();
    socket.once('close', abandon);
    // Connected: the handshake may be on its way to the node. A certificate the pin
    // refused has been destroyed by then and counts as never connected.
    let connected = false;
    upstream.once('socket', (raw) => {
      if (!raw.connecting) { connected = true; return; }
      raw.once(raw instanceof tls.TLSSocket ? 'secureConnect' : 'connect', () => { connected = !raw.destroyed; });
    });
    // The forward instead, only while nothing has reached the node and the browser waits.
    const fallBack = (err) => {
      if (route.via !== 'direct') return false;
      this._directFailed(route.direct, directFailureReason(err));
      if (connected || socket.destroyed || this._tunnel !== tunnel) return false;
      socket.off('close', abandon);
      upstream.destroy();
      diagnostics.record('proxy', { serverId: this.serverId, path, via: 'ssh', phase: 'retry', retry: 'forward',
        transportCode: err?.code, durationMs: performance.now() - began });
      this._openUpgrade({ req, socket, head, path, headers, tunnel, began, ensureMs, route: this._forwardRoute() });
      return true;
    };
    let fellBack = false;
    stallGuard(upstream, {
      queueMs: this._stallLimits.queue,
      connectMs: this._stallLimits.connect,
      answerMs: this._stallLimits.upgrade,
      onStall: (err, phase) => {
        diagnostics.record('proxy', { serverId: this.serverId, path, via: route.via, phase, timedOut: true,
          transportCode: err.code, durationMs: performance.now() - began });
        if (phase === 'connect' && fallBack(err)) { fellBack = true; return; }
        if (!socket.destroyed) socket.end('HTTP/1.1 504 Gateway Timeout\r\nConnection: close\r\n\r\n');
      },
      onConnectStall: route.via === 'ssh' ? () => this._dropDeadTunnel(tunnel) : undefined,
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
      if (answer.statusCode === 401) this._resetIfCurrent(tunnel, 'auth-rejected', { code: 'HTTP_401' });
      socket.end(`HTTP/1.1 ${answer.statusCode} ${answer.statusMessage || ''}\r\nConnection: close\r\n\r\n`);
      answer.resume();
    });
    upstream.on('error', (err) => {
      if (fellBack) return;
      if (route.via === 'ssh') this._noteUpstreamError(tunnel, err);
      else if (fallBack(err)) return;
      // A stall has already answered, and ending that socket here would cut it off.
      if (!err || err.code !== 'ETIMEDOUT') socket.destroy();
    });
    upstream.end();
  }

  /** The forward: always there once ensure() has resolved. */
  _forwardRoute() {
    return { via: 'ssh', host: '127.0.0.1', port: this._tunnel.port, agent: this._agent, upgradeAgent: this._upgradeAgent };
  }

  /**
   * The way to the node for `kind` ('api' or 'terminal'): the node's own listener
   * when the server asks for it and a check confirmed it, the forward otherwise. A
   * way wanted but not confirmed starts a check in the background; nothing waits.
   */
  _route(kind) {
    if (this.connection.server?.transport?.[kind] !== 'direct') return this._forwardRoute();
    const direct = this._directFor(this._pairing);
    if (direct.status !== 'up') return this._forwardRoute();
    return { via: 'direct', host: direct.host, port: direct.port, agent: direct.agent, upgradeAgent: direct.upgradeAgent, direct };
  }

  /** The current direct way for `pairing`, starting a check when there is none or a failed one is old. */
  _directFor(pairing) {
    const current = this._direct;
    if (current && current.pairing === pairing
      && (current.status !== 'down' || this._now() - current.checkedAt < DIRECT_RECHECK_MS)) return current;
    this._closeDirect({ idleOnly: true });
    const direct = { pairing, status: 'checking', reason: null, checkedAt: this._now(), host: null, port: pairing.port, agent: null, upgradeAgent: null };
    this._direct = direct;
    direct.checked = this._checkDirect(direct);
    return direct;
  }

  /**
   * Asks the node for its info on its own listener, at the address SSH uses for
   * the host. Only over TLS, pinned like the forward: the token never crosses a
   * network in the clear, and never reaches another certificate.
   */
  async _checkDirect(direct) {
    try {
      if (!direct.pairing.tls) throw Object.assign(new Error('no tls'), { directReason: 'no-tls' });
      const target = await this.connection.resolveTarget();
      if (target.proxied) throw Object.assign(new Error('proxied'), { directReason: 'proxied' });
      if (this._direct !== direct) return;
      const sessions = createSessionCache();
      direct.host = target.host;
      direct.agent = pinnedAgent(direct.pairing.tlsFingerprint, { sessions });
      direct.upgradeAgent = pinnedAgent(direct.pairing.tlsFingerprint, { keepAlive: false, sessions });
      await new Promise((resolve, reject) => {
        const headers = forwardRequestHeaders({ accept: 'application/json' }, direct.pairing.token);
        const req = https.request({ host: direct.host, port: direct.port, path: '/api/node/info', method: 'GET', headers, agent: direct.agent }, (res) => {
          res.resume();
          res.on('end', () => (res.statusCode === 200 ? resolve() : reject(Object.assign(new Error('status'), { directReason: `http-${res.statusCode}` }))));
          res.on('error', reject);
        });
        req.setTimeout(this._directCheckTimeoutMs, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
        req.on('error', reject);
        req.end();
      });
      if (this._direct !== direct) return;
      direct.status = 'up';
      direct.checkedAt = this._now();
      logDirect(this.serverId, 'up', null);
    } catch (err) {
      this._directFailed(direct, err.directReason || directFailureReason(err));
    }
  }

  /**
   * The direct way failed: new requests take the forward until a later check.
   * Streams already open on it go on; only idle sockets are closed.
   */
  _directFailed(direct, reason) {
    if (!direct || this._direct !== direct || direct.status === 'down') return;
    direct.status = 'down';
    direct.reason = reason;
    direct.checkedAt = this._now();
    closeIdle(direct.agent);
    closeIdle(direct.upgradeAgent);
    logDirect(this.serverId, 'down', reason);
  }

  _closeDirect({ idleOnly = false } = {}) {
    const direct = this._direct;
    this._direct = null;
    if (!direct) return;
    for (const agent of [direct.agent, direct.upgradeAgent]) {
      if (!agent) continue;
      if (idleOnly) closeIdle(agent);
      else agent.destroy();
    }
  }

  /**
   * Which way each kind of traffic takes right now, for the server's status. Also
   * keeps a wanted direct way checked: a failed one is tried again after a while.
   */
  paths() {
    const wanted = { ...DEFAULT_TRANSPORT, ...this.connection.server?.transport };
    const wantsDirect = Object.values(wanted).includes('direct');
    if (!wantsDirect && this._direct) this._closeDirect({ idleOnly: true });
    const direct = wantsDirect && this._pairing ? this._directFor(this._pairing) : null;
    const taken = (kind) => (wanted[kind] === 'direct' && direct?.status === 'up' ? 'direct' : 'ssh');
    return {
      wanted,
      api: taken('api'),
      terminal: taken('terminal'),
      direct: direct ? { status: direct.status, reason: direct.reason, checkedAt: new Date(direct.checkedAt).toISOString() } : null,
    };
  }
}

/** A short, fixed reason for a direct way that failed; never an address or message. */
function directFailureReason(err) {
  if (err instanceof AppError && err.code === ErrorCode.NODE_AUTH_FAILED) return 'cert-mismatch';
  if (err && typeof err.code === 'string' && /^E[A-Z_]+$/.test(err.code)) return err.code.toLowerCase();
  return 'failed';
}

function closeIdle(agent) {
  if (!agent) return;
  for (const sockets of Object.values(agent.freeSockets || {})) for (const socket of sockets) socket.destroy();
}

function logDirect(serverId, status, reason) {
  console.warn('[node-link] direct path', JSON.stringify({ at: new Date().toISOString(), serverId, status, reason }));
}
