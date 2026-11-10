/**
 * Terminals over Mosh, for servers whose `transport.terminal` is 'mosh'.
 *
 * The browser keeps its WebSocket to this hub. The hub asks the node for a mosh
 * session (node token, never relayed: api/mosh.js), runs mosh-client in a PTY here
 * and bridges that PTY to the socket like any terminal. mosh's UDP crosses the
 * WAN; prediction happens in this mosh-client, so it helps only when this hub is
 * close to the browser, as the desktop app's own panel is. A phone that reaches a
 * remote hub gets that hub's predictions, not its own.
 *
 * The key stays in this process and the mosh-client's environment: it is not sent
 * to the browser and not logged. Anything missing or not answering — no
 * mosh-client here, no mosh-server there, a host behind a jump host, UDP that does
 * not get through — ends the mosh session and relays the socket to the node as
 * usual; that server is not tried over mosh again for a while. Input typed before
 * the switch never reaches mosh: the browser's socket only opens once mosh has
 * drawn the remote screen, and nothing sent to one transport is replayed on another.
 *
 * Windows is not offered as a client: there, mosh-client under ConPTY lost the last
 * of quick resizes and sometimes exited during them (docs/known-issues.md ENV-6).
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lookup as lookupAddress } from 'node:dns/promises';
import { execFile } from 'node:child_process';
import { isIP } from 'node:net';
import pty from 'node-pty';

import { createOutputBatcher, extractOsc52 } from '../terminal.js';
import { trackConsoleSpawn } from '../terminal/console-reaper.js';
import { ServerMessage, outputFrameOptions, parseClientMessage, parseTerminalPath, parseTerminalQuery } from '../terminal/protocol.js';

/** How long mosh may take to show the remote screen before the socket is relayed instead. */
export const CONTACT_TIMEOUT_MS = 8_000;
/** How long a server whose mosh failed is not tried over mosh again. */
export const RETRY_AFTER_MS = 10 * 60_000;
export const SETUP_TIMEOUT_MS = 15_000;
const PING_INTERVAL_MS = 30_000;
// Browsers resize in bursts while a window is dragged; mosh only needs the last size.
const RESIZE_SETTLE_MS = 80;
// Errors a node gives before it reserves a session (api/mosh.js): nothing there to end.
const NEVER_STARTED = new Set(['VALIDATION_ERROR', 'UNSUPPORTED', 'CONNECTION_LIMIT']);
/**
 * How often a bridged terminal asks the node whether its session still exists. mosh
 * tells its client when the server ends, but that message can be lost, and the
 * page would then show a frozen screen for good.
 */
export const SESSION_WATCH_MS = 15_000;
/**
 * How long this hub's own mosh-client gets to exit after each request to. One
 * that never reached its server ignored SIGTERM for over a second on macOS and
 * went only with SIGKILL; until its exit is seen, nothing else may start.
 */
const LOCAL_EXIT_WAIT_MS = 1500;

/**
 * Ends this hub's own mosh-client through its PTY, asking, then insisting, and
 * resolves true only once its exit was reported. A kill request alone proves nothing.
 */
export async function stopLocalClient(local, { waitMs = LOCAL_EXIT_WAIT_MS, platform = process.platform } = {}) {
  if (!local || local.exited) return true;
  const gone = () => new Promise((resolve) => {
    if (local.exited) { resolve(true); return; }
    const timer = setTimeout(() => resolve(false), waitMs);
    local.whenExited.then(() => { clearTimeout(timer); resolve(true); });
  });
  try { local.term.kill(); } catch { /* gone already */ }
  if (await gone()) return true;
  // node-pty takes no signal on Windows, where kill already ends the process.
  try { if (platform === 'win32') local.term.kill(); else local.term.kill('SIGKILL'); } catch { /* gone already */ }
  return gone();
}

/** This hub's mosh-client, and whether its exit has been reported. */
function trackLocal(term) {
  const local = { term, exited: false };
  local.whenExited = new Promise((resolve) => term.onExit((info) => { local.exited = true; resolve(info); }));
  return local;
}

/** mosh-client on this machine, if any. ANYMUX_MOSH_CLIENT overrides the search. */
export function findMoshClient({ platform = process.platform, env = process.env, exists = existsSync } = {}) {
  if (platform === 'win32') return { available: false, path: null, reason: 'client_platform' };
  const override = env.ANYMUX_MOSH_CLIENT;
  const candidates = override ? [override] : ['/opt/homebrew/bin/mosh-client', '/usr/local/bin/mosh-client', '/usr/bin/mosh-client',
    ...String(env.PATH || '').split(':').filter(Boolean).map((dir) => `${dir}/mosh-client`)];
  const path = candidates.find((candidate) => exists(candidate));
  return path ? { available: true, path, reason: null } : { available: false, path: null, reason: 'mosh_client_not_found' };
}

/**
 * Watches mosh-client's output for the remote screen. mosh draws its own notices
 * ("Nothing received from server…") on the first row only, and redraws just what
 * changed, so text is not a signal; something printed below the first row is.
 */
export function createContactWatch() {
  let row = 1;
  let pending = '';
  return (chunk) => {
    const text = pending + chunk;
    pending = '';
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === '\x1b') {
        const rest = text.slice(i);
        const csi = /^\x1b\[([0-9;?]*)[ -\/]*([@-~])/.exec(rest);
        if (csi) {
          const params = csi[1].replace('?', '').split(';').map((value) => Number(value) || 0);
          const n = params[0] || 1;
          if (csi[2] === 'H' || csi[2] === 'f') row = params[0] || 1;
          else if (csi[2] === 'd') row = n;
          else if (csi[2] === 'A' || csi[2] === 'F') row = Math.max(1, row - n);
          else if (csi[2] === 'B' || csi[2] === 'E') row += n;
          i += csi[0].length - 1;
          continue;
        }
        const osc = /^\x1b[\]P_^][^\x07\x1b]*(\x07|\x1b\\)/.exec(rest);
        if (osc) { i += osc[0].length - 1; continue; }
        if (rest.length < 3 || (/^\x1b[\[\]P_^]/.test(rest) && !/[\x07@-~]/.test(rest.slice(2)))) {
          // A sequence cut off at the end of this chunk: finish it with the next one.
          pending = rest;
          return false;
        }
        i += 1;
        continue;
      }
      if (ch === '\n') { row += 1; continue; }
      if (row >= 2 && ch > ' ' && ch !== '\x7f') return true;
    }
    return false;
  };
}

function logMosh(serverId, status, reason) {
  console.warn('[mosh] terminal', JSON.stringify({ at: new Date().toISOString(), serverId, status, reason }));
}

export class MoshTerminals {
  /**
   * @param {object} deps
   * @param {import('../servers/registry.js').ServerRegistry} deps.registry
   * @param {import('./link-pool.js').LinkPool} deps.links
   * @param {import('ws').WebSocketServer} deps.wss
   */
  constructor({ registry, links, wss, client, findClient = findMoshClient,
    // Every pty this process starts is on the console reaper's record (CLAUDE.md).
    spawnPty = (file, args, options) => trackConsoleSpawn(() => pty.spawn(file, args, options)).term,
    now = () => Date.now(), contactTimeoutMs = CONTACT_TIMEOUT_MS, sessionWatchMs = SESSION_WATCH_MS, localExitWaitMs = LOCAL_EXIT_WAIT_MS,
    lookup = lookupAddress, lookupTimeoutMs = 5000, setupTimeoutMs = SETUP_TIMEOUT_MS, pingIntervalMs = PING_INTERVAL_MS,
    execFileImpl = execFile }) {
    this.registry = registry;
    this.links = links;
    this.wss = wss;
    this._findClient = client === undefined ? findClient : null;
    this.client = client === undefined ? findClient() : client;
    this._clientCheckedAt = now();
    this._execFile = execFileImpl;
    this._clientVersion = null;
    this._spawnPty = spawnPty;
    this._now = now;
    this._contactTimeoutMs = contactTimeoutMs;
    this._sessionWatchMs = sessionWatchMs;
    this._localExitWaitMs = localExitWaitMs;
    this._lookup = lookup;
    this._lookupTimeoutMs = lookupTimeoutMs;
    this._setupTimeoutMs = setupTimeoutMs;
    this._pingIntervalMs = pingIntervalMs;
    // Results belong to this link and pairing generation, never just its id.
    this._scopes = new Map();
    // Ownership outlives a failed attempt and its link's scope, until cleanup is confirmed.
    this._pendingCleanup = new Map();
    /** Attempts still coming up, and bridged terminals: both end on closeAll. */
    this._opening = new Set();
    this._active = new Set();
    this._closing = false;
  }

  _scope(serverId, link = this.links.link(serverId)) {
    let scope = this._scopes.get(serverId);
    if (!scope || scope.link !== link || scope.generation !== link.generation) {
      scope = { link, generation: link.generation, verified: false, failed: null, trial: null, capability: null, unclean: new Map() };
      this._scopes.set(serverId, scope);
    }
    return scope;
  }

  _refreshClient(force = false) {
    if (!this._findClient || (!force && this._now() - this._clientCheckedAt < 30_000)) return;
    this.client = this._findClient();
    this._clientCheckedAt = this._now();
  }

  /** Component readiness on this Hub; it says nothing about a target's UDP path. */
  clientCapability({ force = false } = {}) {
    this._refreshClient(force);
    if (!this.client.available) return Promise.resolve({ available: false, version: null, reason: this.client.reason });
    const before = this._clientVersion;
    const age = before ? this._now() - before.at : Infinity;
    if (!force && before?.path === this.client.path && (before.pending || (age >= 0 && age < 30_000))) return before.promise;
    const entry = { path: this.client.path, at: this._now(), pending: true, promise: null };
    this._clientVersion = entry;
    entry.promise = new Promise((resolve) => {
      this._execFile(entry.path, ['--version'], { timeout: 5000, windowsHide: true }, (err, stdout, stderr) => {
        const version = /mosh-client \(mosh ([0-9][0-9A-Za-z.\-]*)\)/.exec(String(stdout || '') + '\n' + String(stderr || ''))?.[1];
        resolve(!err && version ? { available: true, version, reason: null }
          : { available: false, version: null, reason: 'mosh_client_unusable' });
      });
    }).finally(() => { entry.pending = false; entry.at = this._now(); });
    return entry.promise;
  }

  /** Retry a confirmed-clean negative result; never release ownership or a running trial. */
  retry(serverId) {
    this._refreshClient(true);
    const scope = this._scopes.get(serverId);
    if (!scope || scope.unclean.size || scope.trial) return;
    scope.failed = null;
    scope.verified = false;
    scope.capability = null;
  }

  _current(serverId, scope) {
    try { return this._scope(serverId) === scope; }
    catch { return false; }
  }

  _failure(scope) {
    return scope.failed && (scope.unclean.size || this._now() - scope.failed.at < RETRY_AFTER_MS) ? scope.failed : null;
  }

  /** Whether this terminal socket should try mosh. */
  wants(serverId) {
    this._refreshClient();
    const pending = this._scopes.get(serverId);
    if (pending && this._scope(serverId) === pending && (pending.unclean.size || pending.trial)) return true;
    if (this.registry.get(serverId)?.transport?.terminal !== 'mosh') return false;
    if (!this.client.available) return false;
    const scope = this._scope(serverId);
    // Unconfirmed cleanup must reach open(), which refuses or confirms it before any fallback.
    return Boolean(scope.unclean.size || scope.trial || (scope.capability?.available !== false && !this._failure(scope)));
  }

  /** For the server's status: why mosh is not in use, if it is wanted. */
  status(serverId, { link, capability } = {}) {
    if (this.registry.get(serverId)?.transport?.terminal !== 'mosh') return null;
    this._refreshClient();
    const current = this.links.link(serverId);
    if (link && link !== current) return { status: 'unknown', reason: null };
    const scope = this._scope(serverId, current);
    if (capability !== undefined) {
      const before = scope.capability;
      scope.capability = capability;
      if (before && (before.available !== capability?.available || before.version !== capability?.version || before.reason !== capability?.reason)
        && !scope.trial && !scope.unclean.size && ['unsupported', 'mosh_server_not_found', 'mosh_server_unusable'].includes(scope.failed?.reason)) scope.failed = null;
    }
    const failed = this._failure(scope);
    // A failed new attempt does not turn a still-bridged terminal into an SSH terminal.
    if ([...this._active].some((active) => active.bridged && active.scope.link === scope.link && active.scope.generation === scope.generation)) {
      const fallbackReason = scope.unclean.size ? 'cleanup_unconfirmed' : !this.client.available ? this.client.reason
        : scope.capability?.available === false ? scope.capability.reason || 'mosh_server_not_found' : failed?.reason;
      return { status: 'up', reason: null, ...(fallbackReason ? { fallbackReason } : {}) };
    }
    if (scope.unclean.size) return { status: 'down', reason: 'cleanup_unconfirmed' };
    if (!this.client.available) return { status: 'down', reason: this.client.reason };
    if (scope.trial) return { status: 'checking', reason: null };
    if (scope.capability?.available === false) return { status: 'down', reason: scope.capability.reason || 'mosh_server_not_found' };
    if (failed) return { status: 'down', reason: failed.reason };
    return { status: scope.verified ? 'up' : 'unknown', reason: null };
  }

  _fail(serverId, reason, scope = this._scope(serverId)) {
    if (!this._current(serverId, scope)) return;
    scope.failed = { reason, at: this._now() };
    scope.verified = false;
    logMosh(serverId, 'down', reason);
  }

  async _cleanOwned(owned) {
    owned = this._pendingCleanup.get(owned.id) || owned;
    if (owned.cleaned) return { localGone: true, clean: true };
    if (owned.cleaning) return owned.cleaning;
    this._pendingCleanup.set(owned.id, owned);
    owned.cleaning = (async () => {
      const localGone = await stopLocalClient(owned.local, { waitMs: this._localExitWaitMs });
      const clean = localGone && (!owned.posted || await this._endRemote(owned.link, owned.id));
      if (clean) {
        owned.cleaned = true;
        this._pendingCleanup.delete(owned.id);
        owned.scope?.unclean.delete(owned.id);
      } else owned.scope?.unclean.set(owned.id, owned);
      return { localGone, clean };
    })();
    try { return await owned.cleaning; }
    finally { owned.cleaning = null; }
  }

  /**
   * Takes a terminal upgrade for a node. Never throws. The socket ends up bridged
   * to a mosh-client, relayed to the node, or refused: relayed only when the node
   * confirmed the mosh session it may have started is gone, so two clients never
   * share the terminal. Nothing typed is ever sent to both.
   */
  async open(req, socket, head, serverId, target) {
    const link = this.links.link(serverId);
    const relay = () => link.proxyUpgrade(req, socket, head, target.path).catch(() => socket.destroy());
    const refuse = () => { if (!socket.destroyed) socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); };
    const pane = parseTerminalPath(target.pathname);
    if (this._closing) return refuse();
    if (!pane) return relay();
    const query = parseTerminalQuery(new URLSearchParams(target.path.includes('?') ? target.path.slice(target.path.indexOf('?') + 1) : ''));
    const id = randomUUID();
    // Set once the node may hold a session by this id; until it is confirmed gone, nothing else attaches.
    let posted = false;
    let term = null;
    let local = null;
    const scope = this._scope(serverId, link);
    const deadline = performance.now() + this._setupTimeoutMs;
    let trial = null;
    let waitingTrial = false;
    let aborted = null;
    let wake = () => {};
    let settle;
    // A link reset or a hub shutting down ends this attempt wherever it is.
    const opening = {
      end: (reason) => { aborted = aborted || reason || 'aborted'; wake(); },
      settled: new Promise((resolve) => { settle = resolve; }),
    };
    const release = typeof link.adopt === 'function' ? link.adopt(opening) : () => {};
    this._opening.add(opening);
    const done = () => { release(); this._opening.delete(opening); settle(); };
    const sameScope = () => { try { return this._scope(serverId) === scope; } catch { return false; } };
    const stillWanted = () => !socket.destroyed && !aborted && sameScope();
    const finishTrial = (clean) => {
      if (!trial) return;
      if (scope.trial === trial) scope.trial = null;
      trial.resolve(clean);
      trial = null;
    };
    // A single absolute setup deadline, including any shared trial wait. Cleanup is separate.
    const wait = (start, limit = Infinity, reason = 'setup_timeout') => new Promise((resolve, reject) => {
      const left = deadline - performance.now();
      if (!stillWanted()) { reject(Object.assign(new Error('gone'), { moshReason: null })); return; }
      if (left <= 0) { reject(Object.assign(new Error('timeout'), { moshReason: 'setup_timeout' })); return; }
      const expires = performance.now() + Math.min(left, limit);
      const timedOut = () => Object.assign(new Error('timeout'), { moshReason: left <= limit ? 'setup_timeout' : reason });
      let finished = false;
      const finish = (error, value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        socket.removeListener('close', cancelled);
        wake = () => {};
        if (error) reject(error); else resolve(value);
      };
      const cancelled = () => finish(Object.assign(new Error('gone'), { moshReason: null }));
      const timer = setTimeout(() => finish(timedOut()), Math.min(left, limit));
      wake = cancelled;
      socket.once('close', cancelled);
      Promise.resolve().then(() => {
        if (!stillWanted()) throw Object.assign(new Error('gone'), { moshReason: null });
        if (performance.now() >= expires) throw timedOut();
        return start();
      }).then((value) => performance.now() >= expires ? finish(timedOut()) : finish(null, value), (err) => finish(err));
    });
    const handlers = { data: null, exit: null };
    let earlier = '';
    try {
      while (scope.trial) {
        waitingTrial = true;
        const pending = scope.trial;
        const clean = await wait(() => pending.settled);
        waitingTrial = false;
        if (!clean) throw Object.assign(new Error('unclean trial'), { moshReason: null });
      }
      if (!stillWanted()) throw Object.assign(new Error('gone'), { moshReason: null });
      // Recheck after the first trial; none of its waiters attaches beside an unconfirmed client.
      if (scope.unclean.size) {
        let resolve;
        trial = { settled: new Promise((done) => { resolve = done; }), resolve: (clean) => resolve(clean) };
        scope.trial = trial;
        await Promise.all([...scope.unclean.values()].map(async (owned) => {
          if ((await this._cleanOwned(owned)).clean) scope.unclean.delete(owned.id);
        }));
        const clean = scope.unclean.size === 0;
        finishTrial(clean);
        done();
        return clean && stillWanted() ? relay() : refuse();
      }
      if (this.registry.get(serverId)?.transport?.terminal !== 'mosh' || scope.capability?.available === false || this._failure(scope)) { done(); return relay(); }
      if (!scope.verified) {
        let resolve;
        trial = { settled: new Promise((done) => { resolve = done; }), resolve: (clean) => resolve(clean) };
        scope.trial = trial;
      }
      await wait(() => link.ensure());
      const where = await wait(() => link.connection.resolveTarget({ timeout: Math.max(1, Math.ceil(deadline - performance.now())) }));
      if (where.proxied) throw Object.assign(new Error('proxied'), { moshReason: 'proxied' });
      // Nothing may attach for a browser that already left.
      if (!stillWanted()) throw Object.assign(new Error('gone'), { moshReason: null });
      let address = where.host;
      if (!isIP(address)) {
        // Raw mosh-client requires AI_NUMERICHOST. Use one OS-selected address;
        // this does not claim multi-address/family failover or UDP reachability.
        const answer = await wait(() => Promise.resolve(this._lookup(where.host)).catch(() => {
          throw Object.assign(new Error('dns'), { moshReason: 'dns_failed' });
        }), this._lookupTimeoutMs, 'dns_timeout');
        if (typeof answer?.address !== 'string' || !isIP(answer.address)) throw Object.assign(new Error('dns'), { moshReason: 'dns_failed' });
        address = answer.address;
      }
      if (!stillWanted() || this.registry.get(serverId)?.transport?.terminal !== 'mosh') throw Object.assign(new Error('gone'), { moshReason: null });
      posted = true;
      let session;
      try {
        session = await wait(() => link.requestJson('POST', '/api/mosh/sessions', { id, paneId: pane.paneId, nozoom: query.nozoom },
          { timeout: Math.max(1, Math.ceil(deadline - performance.now())) }));
      } catch (err) {
        // Refused before the node reserved anything: there is nothing to end there.
        if (err && (NEVER_STARTED.has(err.code) || err.status === 404 || err.status === 403)) posted = false;
        throw err;
      }
      if (!stillWanted() || this.registry.get(serverId)?.transport?.terminal !== 'mosh') throw Object.assign(new Error('gone'), { moshReason: null });
      const env = { ...process.env, MOSH_KEY: session.key, TERM: 'xterm-256color', LANG: process.env.LANG || 'en_US.UTF-8' };
      delete env.TMUX;
      delete env.TMUX_PANE;
      term = this._spawnPty(this.client.path, [address, String(session.port)], { name: 'xterm-256color', cols: query.cols, rows: query.rows, env });
      session.key = null;
      local = trackLocal(term);
      term.onData((chunk) => handlers.data && handlers.data(chunk));
      term.onExit((info) => handlers.exit && handlers.exit(info));
      const contact = createContactWatch();
      const reached = await wait(() => new Promise((resolve) => {
        handlers.data = (chunk) => {
          earlier += chunk;
          if (contact(chunk)) resolve(null);
        };
        handlers.exit = () => resolve('client_exit');
      }), this._contactTimeoutMs, 'no_contact');
      // Still kept until the socket takes over, a moment from now.
      handlers.data = (chunk) => { earlier += chunk; };
      handlers.exit = null;
      if (reached || !stillWanted()) {
        throw Object.assign(new Error(reached || 'gone'), { moshReason: reached === 'no_contact' || reached === 'client_exit' ? reached : null });
      }
    } catch (err) {
      // Ours first, so it stops talking to the session; then the node's. Both must be confirmed.
      const owned = { local, link, id, posted, scope };
      const { localGone, clean } = await this._cleanOwned(owned);
      finishTrial(clean);
      done();
      // The browser left, or the link or this hub moved on: nothing to fall back for.
      if (!stillWanted() || waitingTrial || err.moshReason === null) {
        refuse();
        return undefined;
      }
      this._fail(serverId, err.moshReason || (typeof err.code === 'string' ? err.code.toLowerCase() : 'failed'), scope);
      if (!clean) {
        // The session may still be attached; a second client next to it is what -d would leave.
        logMosh(serverId, 'not_clean', localGone ? 'cleanup_unconfirmed' : 'local_client_unconfirmed');
        refuse();
        return undefined;
      }
      return relay();
    }
    const outcome = await this._upgrade(req, socket, head, { term, local, id, link, posted, scope, handlers, earlier: () => earlier }, pane.paneId);
    if (outcome.bridged && this._current(serverId, scope)) { scope.verified = true; scope.failed = null; }
    finishTrial(outcome.clean);
    done();
    return undefined;
  }

  /** Ends the node's session; true only when the node says nothing it started is left. */
  async _endRemote(link, id) {
    try {
      const answer = await link.requestJson('DELETE', `/api/mosh/sessions/${id}`, undefined, { timeout: 15_000 });
      return Boolean(answer && answer.clean === true);
    } catch {
      return false;
    }
  }

  /**
   * Hands the socket to the bridge. From here the terminal belongs to the link and
   * to this hub until it ends. A handshake ws refuses never calls back; the socket's
   * close then ends the client and the session all the same.
   */
  _upgrade(req, socket, head, owned, paneId) {
    let report;
    const result = new Promise((resolve) => { report = resolve; });
    let ending = null;
    const end = () => {
      if (!ending) {
        ending = (async () => {
          const { localGone, clean } = await this._cleanOwned(owned);
          if (!clean) logMosh(owned.link.serverId, 'not_clean', localGone ? 'session_end' : 'local_client_unconfirmed');
          return clean;
        })();
      }
      return ending;
    };
    // A link reset or shutdown ends it like a close; the page reconnects.
    const active = {
      scope: owned.scope,
      bridged: false,
      end: () => {
        if (owned.ws && owned.ws.readyState === owned.ws.OPEN) owned.ws.close(1011, 'link reset');
        else socket.destroy();
        return owned.finish();
      },
    };
    const release = typeof owned.link.adopt === 'function' ? owned.link.adopt(active) : () => {};
    this._active.add(active);
    owned.finish = () => {
      release(); this._active.delete(active);
      return end().then((clean) => {
        report({ bridged: false, clean });
        return clean;
      });
    };
    const abandon = () => { if (!owned.ws) owned.finish(); };
    if (socket.destroyed) { abandon(); return result; }
    socket.once('close', abandon);
    try {
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        socket.off('close', abandon);
        if (ending) { ws.terminate(); return; }
        owned.ws = ws;
        this._bridge(ws, owned, paneId);
        active.bridged = true;
        report({ bridged: true, clean: true });
      });
    } catch {
      abandon();
      socket.destroy();
    }
    return result;
  }

  /** The socket now owns the mosh-client; closing either ends both, and the node's session. */
  _bridge(ws, owned, paneId) {
    const { term, handlers, earlier } = owned;
    let osc52Pending = '';
    let ended = false;
    let resizeTimer = null;
    const output = createOutputBatcher((data) => {
      if (ws.readyState !== ws.OPEN) return;
      const frame = ServerMessage.output(data);
      ws.send(frame, outputFrameOptions(frame));
    });
    const deliver = (chunk) => {
      if (ws.readyState !== ws.OPEN) return;
      const { clipboard, cleaned, pending } = extractOsc52(osc52Pending + chunk);
      osc52Pending = pending;
      if (clipboard.length) output.flush();
      for (const text of clipboard) ws.send(ServerMessage.clipboard(text));
      if (cleaned) output.push(cleaned);
    };
    let watch = null;
    let heartbeat = null;
    const finish = () => {
      ended = true;
      clearTimeout(resizeTimer);
      clearInterval(watch);
      clearInterval(heartbeat);
      output.dispose();
      return owned.finish();
    };
    // The node decides whether the session still exists; a failed question decides nothing.
    watch = setInterval(async () => {
      const answer = await owned.link.requestJson('GET', `/api/mosh/sessions/${owned.id}`).catch(() => null);
      if (ended || !answer || (answer.state !== 'ended' && answer.state !== 'unknown')) return;
      output.flush();
      if (ws.readyState === ws.OPEN) {
        ws.send(ServerMessage.exit({ code: null, signal: null, reason: 'mosh_session_ended' }));
        // Taken over or gone on the node: like a tmux client that left, no reconnect.
        ws.close(1000, 'mosh session ended');
      }
      finish();
    }, this._sessionWatchMs);
    if (watch.unref) watch.unref();
    let alive = true;
    ws.on('pong', () => { alive = true; });
    heartbeat = setInterval(() => {
      if (!alive) { ws.terminate(); finish(); return; }
      alive = false;
      if (ws.readyState === ws.OPEN) ws.ping();
    }, this._pingIntervalMs);
    if (heartbeat.unref) heartbeat.unref();
    ws.on('error', finish);
    ws.on('close', finish);
    ws.send(ServerMessage.ready({ paneId, provider: 'mosh', persistence: 'tmux' }));
    deliver(earlier());
    handlers.data = deliver;
    handlers.exit = ({ exitCode, signal }) => {
      if (ended) return;
      output.flush();
      if (ws.readyState === ws.OPEN) {
        ws.send(ServerMessage.exit({ code: exitCode ?? null, signal: signal ?? null, reason: 'mosh_client_exit' }));
        // A clean exit is the tmux client leaving (detached, taken over): no reconnect.
        ws.close(exitCode === 0 ? 1000 : 1011, 'mosh exited');
      }
      finish();
    };
    ws.on('message', (raw) => {
      if (ended) return;
      const msg = parseClientMessage(raw);
      if (!msg) return;
      if (msg.type === 'input') term.write(msg.data);
      else if (msg.type === 'resize') {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => { if (!ended) term.resize(msg.cols, msg.rows); }, RESIZE_SETTLE_MS);
      }
    });
  }

  /** Whether any mosh terminal is coming up or running here. */
  busy() {
    return this._opening.size > 0 || this._active.size > 0 || this._pendingCleanup.size > 0;
  }

  /** On shutdown: no new mosh terminals, and every one ended, the node's sessions too. */
  async closeAll() {
    this._closing = true;
    const opening = [...this._opening];
    for (const attempt of opening) attempt.end('closing');
    await Promise.all([...this._active].map((active) => active.end()));
    await Promise.all(opening.map((attempt) => attempt.settled));
    const results = await Promise.all([...this._pendingCleanup.values()].map((owned) => this._cleanOwned(owned)));
    return results.every((result) => result.clean) && this._pendingCleanup.size === 0;
  }
}
