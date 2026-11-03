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
import { isIP } from 'node:net';
import pty from 'node-pty';

import { createOutputBatcher, extractOsc52 } from '../terminal.js';
import { trackConsoleSpawn } from '../terminal/console-reaper.js';
import { ServerMessage, outputFrameOptions, parseClientMessage, parseTerminalPath, parseTerminalQuery } from '../terminal/protocol.js';

/** How long mosh may take to show the remote screen before the socket is relayed instead. */
export const CONTACT_TIMEOUT_MS = 8_000;
/** How long a server whose mosh failed is not tried over mosh again. */
export const RETRY_AFTER_MS = 10 * 60_000;
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

/** mosh-client on this machine, if any. TMUX_PANEL_MOSH_CLIENT overrides the search. */
export function findMoshClient({ platform = process.platform, env = process.env, exists = existsSync } = {}) {
  if (platform === 'win32') return { available: false, path: null, reason: 'client_platform' };
  const override = env.TMUX_PANEL_MOSH_CLIENT;
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
  constructor({ registry, links, wss, client = findMoshClient(),
    // Every pty this process starts is on the console reaper's record (CLAUDE.md).
    spawnPty = (file, args, options) => trackConsoleSpawn(() => pty.spawn(file, args, options)).term,
    now = () => Date.now(), contactTimeoutMs = CONTACT_TIMEOUT_MS, sessionWatchMs = SESSION_WATCH_MS, localExitWaitMs = LOCAL_EXIT_WAIT_MS,
    lookup = lookupAddress, lookupTimeoutMs = 5000 }) {
    this.registry = registry;
    this.links = links;
    this.wss = wss;
    this.client = client;
    this._spawnPty = spawnPty;
    this._now = now;
    this._contactTimeoutMs = contactTimeoutMs;
    this._sessionWatchMs = sessionWatchMs;
    this._localExitWaitMs = localExitWaitMs;
    this._lookup = lookup;
    this._lookupTimeoutMs = lookupTimeoutMs;
    /** serverId -> { reason, at } for mosh that did not work, so it is not retried at once. */
    this._failed = new Map();
    /** Attempts still coming up, and bridged terminals: both end on closeAll. */
    this._opening = new Set();
    this._active = new Set();
    this._closing = false;
  }

  /** Whether this terminal socket should try mosh. */
  wants(serverId) {
    if (this.registry.get(serverId)?.transport?.terminal !== 'mosh') return false;
    if (!this.client.available) return false;
    const failed = this._failed.get(serverId);
    return !failed || this._now() - failed.at >= RETRY_AFTER_MS;
  }

  /** For the server's status: why mosh is not in use, if it is wanted. */
  status(serverId) {
    if (this.registry.get(serverId)?.transport?.terminal !== 'mosh') return null;
    if (!this.client.available) return { status: 'down', reason: this.client.reason };
    const failed = this._failed.get(serverId);
    if (failed && this._now() - failed.at < RETRY_AFTER_MS) return { status: 'down', reason: failed.reason };
    return { status: 'up', reason: null };
  }

  _fail(serverId, reason) {
    this._failed.set(serverId, { reason, at: this._now() });
    logMosh(serverId, 'down', reason);
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
    if (!pane || this._closing) return relay();
    const query = parseTerminalQuery(new URLSearchParams(target.path.includes('?') ? target.path.slice(target.path.indexOf('?') + 1) : ''));
    const id = randomUUID();
    // Set once the node may hold a session by this id; until it is confirmed gone, nothing else attaches.
    let posted = false;
    let term = null;
    let local = null;
    let generation = null;
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
    const stillWanted = () => !socket.destroyed && !aborted && link.generation === generation;
    const handlers = { data: null, exit: null };
    let earlier = '';
    try {
      await link.ensure();
      generation = link.generation;
      const where = await link.connection.resolveTarget();
      if (where.proxied) throw Object.assign(new Error('proxied'), { moshReason: 'proxied' });
      // Nothing may attach for a browser that already left.
      if (!stillWanted()) throw Object.assign(new Error('gone'), { moshReason: null });
      let address = where.host;
      if (!isIP(address)) {
        // Raw mosh-client requires AI_NUMERICHOST. Use one OS-selected address;
        // this does not claim multi-address/family failover or UDP reachability.
        address = await new Promise((resolve, reject) => {
          let finished = false;
          const finish = (reason, ip) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            socket.removeListener('close', cancelled);
            wake = () => {};
            if (reason) reject(Object.assign(new Error(reason), { moshReason: reason === 'gone' ? null : reason }));
            else resolve(ip);
          };
          const cancelled = () => finish('gone');
          const timer = setTimeout(() => finish('dns_timeout'), this._lookupTimeoutMs);
          wake = cancelled;
          socket.once('close', cancelled);
          Promise.resolve().then(() => this._lookup(where.host)).then(
            (result) => typeof result?.address === 'string' && isIP(result.address) ? finish(null, result.address) : finish('dns_failed'),
            () => finish('dns_failed'),
          );
        });
      }
      if (!stillWanted()) throw Object.assign(new Error('gone'), { moshReason: null });
      posted = true;
      let session;
      try {
        session = await link.requestJson('POST', '/api/mosh/sessions', { id, paneId: pane.paneId, nozoom: query.nozoom }, { timeout: 20_000 });
      } catch (err) {
        // Refused before the node reserved anything: there is nothing to end there.
        if (err && (NEVER_STARTED.has(err.code) || err.status === 404 || err.status === 403)) posted = false;
        throw err;
      }
      if (!stillWanted()) throw Object.assign(new Error('gone'), { moshReason: null });
      const env = { ...process.env, MOSH_KEY: session.key, TERM: 'xterm-256color', LANG: process.env.LANG || 'en_US.UTF-8' };
      delete env.TMUX;
      delete env.TMUX_PANE;
      term = this._spawnPty(this.client.path, [address, String(session.port)], { name: 'xterm-256color', cols: query.cols, rows: query.rows, env });
      session.key = null;
      local = trackLocal(term);
      term.onData((chunk) => handlers.data && handlers.data(chunk));
      term.onExit((info) => handlers.exit && handlers.exit(info));
      const contact = createContactWatch();
      const reached = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve('no_contact'), this._contactTimeoutMs);
        const finish = (value) => { clearTimeout(timer); resolve(value); };
        handlers.data = (chunk) => {
          earlier += chunk;
          if (contact(chunk)) finish(null);
        };
        handlers.exit = () => finish('client_exit');
        wake = () => finish('aborted');
        socket.once('close', () => finish('browser_gone'));
      });
      // Still kept until the socket takes over, a moment from now.
      handlers.data = (chunk) => { earlier += chunk; };
      handlers.exit = null;
      if (reached || !stillWanted()) {
        throw Object.assign(new Error(reached || 'gone'), { moshReason: reached === 'no_contact' || reached === 'client_exit' ? reached : null });
      }
    } catch (err) {
      // Ours first, so it stops talking to the session; then the node's. Both must be confirmed.
      const localGone = await stopLocalClient(local, { waitMs: this._localExitWaitMs });
      const clean = localGone && (posted ? await this._endRemote(link, id) : true);
      done();
      // The browser left, or the link or this hub moved on: nothing to fall back for.
      if (socket.destroyed || aborted || (generation !== null && link.generation !== generation) || err.moshReason === null) {
        refuse();
        return undefined;
      }
      this._fail(serverId, err.moshReason || (typeof err.code === 'string' ? err.code.toLowerCase() : 'failed'));
      if (!clean) {
        // The session may still be attached; a second client next to it is what -d would leave.
        logMosh(serverId, 'not_clean', localGone ? 'cleanup_unconfirmed' : 'local_client_unconfirmed');
        refuse();
        return undefined;
      }
      return relay();
    }
    done();
    this._failed.delete(serverId);
    this._upgrade(req, socket, head, { term, local, id, link, handlers, earlier: () => earlier }, pane.paneId);
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
    let ending = null;
    const end = () => {
      if (!ending) {
        ending = (async () => {
          const localGone = await stopLocalClient(owned.local, { waitMs: this._localExitWaitMs });
          const remote = await this._endRemote(owned.link, owned.id);
          if (!localGone || !remote) logMosh(owned.link.serverId, 'not_clean', localGone ? 'session_end' : 'local_client_unconfirmed');
          return localGone && remote;
        })();
      }
      return ending;
    };
    // A link reset or shutdown ends it like a close; the page reconnects.
    const active = {
      end: () => {
        if (owned.ws && owned.ws.readyState === owned.ws.OPEN) owned.ws.close(1011, 'link reset');
        else socket.destroy();
        return owned.finish();
      },
    };
    const release = typeof owned.link.adopt === 'function' ? owned.link.adopt(active) : () => {};
    this._active.add(active);
    owned.finish = () => { release(); this._active.delete(active); return end(); };
    const abandon = () => { if (!owned.ws) owned.finish(); };
    if (socket.destroyed) { abandon(); return; }
    socket.once('close', abandon);
    try {
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        socket.off('close', abandon);
        if (ending) { ws.terminate(); return; }
        owned.ws = ws;
        this._bridge(ws, owned, paneId);
      });
    } catch {
      abandon();
      socket.destroy();
    }
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
    const finish = () => {
      ended = true;
      clearTimeout(resizeTimer);
      clearInterval(watch);
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
    return this._opening.size > 0 || this._active.size > 0;
  }

  /** On shutdown: no new mosh terminals, and every one ended, the node's sessions too. */
  async closeAll() {
    this._closing = true;
    const opening = [...this._opening];
    for (const attempt of opening) attempt.end('closing');
    const results = await Promise.all([...this._active].map((active) => active.end()));
    await Promise.all(opening.map((attempt) => attempt.settled));
    return results.every(Boolean);
  }
}
