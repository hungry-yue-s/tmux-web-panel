/**
 * Mosh sessions on this node, for a hub that runs mosh-client next to the browser.
 *
 * A session is one `mosh-server new` whose command is the same tmux attach the
 * terminal gateway would start, so the pane, its zoom and `attach-session -d` work
 * as for any other terminal. mosh-server prints its UDP port and a one-time key and
 * detaches; only a hub, authenticated with the node token, ever receives that key
 * (see api/mosh.js). It is never logged.
 *
 * Timing that matters: mosh-server forks its command right away but lets it run
 * only once the first client packet arrives, so tmux attaches after the hub's
 * mosh-client has connected, well after CONNECT. On Windows, where tmux clients must
 * change one at a time (TerminalManager.whenClientCanStart), the session keeps the
 * client turn until tmux lists a client whose parent is this mosh-server, and a
 * settle after that, as the gateway does for its own clients. No such client in
 * time and the session is ended. The hub gets its answer at CONNECT meanwhile; it
 * needs the key before anything can attach.
 *
 * Ownership: the hub chooses the session id, so it can end a session whose answer
 * never reached it. A starting session counts against the limit. An id that was
 * ended is remembered for a while, and a late request for it is refused. Ending
 * signals only processes the system still describes as the ones recorded (see
 * processes.js): the command child first, while its parent is still known, then
 * mosh-server. A session whose processes are not known to be gone is reported as
 * not clean, and the hub then must not attach another terminal in its place.
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isIP } from 'node:net';
import { win32 } from 'node:path';

import { AppError, ErrorCode } from '../servers/errors.js';
import { CLIENT_SETTLE_MS, buildTmuxAttachArgs } from '../terminal.js';
import { MSYS_ROOT, TMUX_BIN, msysExecArgs, toPosixPath } from '../msys.js';
import { tmuxExec } from '../tmux.js';
import { createProcessTable, sameProcess, sameStart } from './processes.js';

// A listed process with unreadable birth is still present. It must neither be
// signalled without identity nor disappear from the cleanup/ownership checks.
function unknownPids(session, table) {
  const pids = new Set();
  for (const entry of [session.daemon, ...session.children]) {
    if (entry && table.has(entry.pid) && !table.get(entry.pid).start) pids.add(entry.pid);
  }
  if (sameProcess(session.daemon, table.get(session.daemon?.pid))) {
    for (const entry of table.values()) if (entry.ppid === session.daemon.pid && !entry.start) pids.add(entry.pid);
  }
  return pids;
}

function hasUnknownIdentity(session, table) {
  return unknownPids(session, table).size > 0;
}

/** A server no client has reached for this long ends itself, with its tmux client. */
export const NETWORK_TIMEOUT_S = 120;
export const MAX_SESSIONS = 16;
/** Recheck installed/removed components without keeping an unavailable result forever. */
export const CAPABILITY_CACHE_MS = 30_000;
/** From spawning mosh-server to its CONNECT line. */
const START_TIMEOUT_MS = 10_000;
/** From CONNECT to tmux listing the client: the hub's mosh-client must reach us first. */
export const ATTACH_TIMEOUT_MS = 20_000;
const ATTACH_POLL_MS = 150;
/** How long ended processes get to go, after TERM and again after KILL. */
const GONE_WAIT_MS = 3000;
const GONE_POLL_MS = 100;
const SWEEP_MS = 15_000;
/** A hub bridging a session asks about it every SESSION_WATCH_MS (15 s); this much silence means it is gone. */
export const HUB_SILENCE_MS = 60_000;
const TOMBSTONE_MS = 10 * 60_000;
export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Where mosh-server is. Windows looks in the MSYS2 that tmux comes from; elsewhere
 * the usual places. ANYMUX_MOSH_SERVER overrides.
 */
export function findMoshServer({ platform = process.platform, env = process.env, exists = existsSync, msysRoot = MSYS_ROOT } = {}) {
  if (env.ANYMUX_MOSH_SERVER) return exists(env.ANYMUX_MOSH_SERVER) ? env.ANYMUX_MOSH_SERVER : null;
  const candidates = platform === 'win32'
    ? [win32.join(msysRoot, 'usr', 'bin', 'mosh-server.exe')]
    : ['/opt/homebrew/bin/mosh-server', '/usr/local/bin/mosh-server', '/usr/bin/mosh-server',
      ...String(env.PATH || '').split(':').filter(Boolean).map((dir) => `${dir}/mosh-server`)];
  return candidates.find((candidate) => exists(candidate)) || null;
}

function runVersion(file, execFileImpl, env, platform) {
  return new Promise((resolve) => {
    const childEnv = { ...env };
    if (platform === 'win32') {
      const bin = win32.join(MSYS_ROOT, 'usr', 'bin');
      childEnv.PATH = `${bin};${childEnv.PATH || ''}`;
    }
    execFileImpl(file, ['--version'], { env: childEnv, timeout: 5000, windowsHide: true }, (err, stdout) => {
      const match = /mosh-server \(mosh ([0-9][0-9A-Za-z.\-]*)\)/.exec(String(stdout || ''));
      resolve(err && !match ? null : match ? match[1] : null);
    });
  });
}

const cancelledError = () => new AppError(ErrorCode.TERMINAL_BUSY, 'The mosh session was cancelled', { retryable: true });

export class MoshService {
  /**
   * @param {object} deps
   * @param {{ resolvePane: (paneId: string) => Promise<{paneId: string, sessionId: string}> }} deps.workspace
   * @param {import('../terminal.js').TerminalManager} deps.terminalManager
   * @param {(args: string[]) => Promise<string>} [deps.tmux] queries the tmux server the sessions attach to
   * @param {string[]} [deps.tmuxSocketArgs] how the attach command names that server: none for the default
   */
  constructor({ workspace, terminalManager, platform = process.platform, env = process.env, find = findMoshServer,
    spawnImpl = spawn, execFileImpl = execFile, processes = null, tmux = tmuxExec, tmuxSocketArgs = [],
    now = () => Date.now(), attachTimeoutMs = ATTACH_TIMEOUT_MS, settleMs = CLIENT_SETTLE_MS, goneWaitMs = GONE_WAIT_MS, hubSilenceMs = HUB_SILENCE_MS }) {
    this.workspace = workspace;
    this.terminalManager = terminalManager;
    this._platform = platform;
    this._env = env;
    this._find = find;
    this._spawn = spawnImpl;
    this._execFile = execFileImpl;
    this._processes = processes || createProcessTable({ platform, execFileImpl });
    this._tmux = tmux;
    this._tmuxSocketArgs = tmuxSocketArgs;
    this._now = now;
    this._attachTimeoutMs = attachTimeoutMs;
    this._settleMs = settleMs;
    this._goneWaitMs = goneWaitMs;
    this._hubSilenceMs = hubSilenceMs;
    this._capability = null;
    this._capabilityPending = false;
    this._capabilityCheckedAt = null;
    this._closing = false;
    this._sweeper = null;
    /** @type {Map<string, object>} id -> session, starting ones included */
    this.sessions = new Map();
    /** @type {Map<string, { clean: boolean, at: number }>} ids that were ended */
    this._ended = new Map();
    terminalManager.addClientOwner?.(this);
  }

  /** Whether this node can start mosh sessions; concurrent callers share one check. */
  async refreshCapability() {
    const previous = this._capability;
    await Promise.resolve(previous).catch(() => {});
    if (this._capability === previous) {
      this._capability = null;
      this._capabilityCheckedAt = null;
    }
    return this.capability();
  }

  capability() {
    const age = this._capabilityCheckedAt === null ? Infinity : this._now() - this._capabilityCheckedAt;
    if (!this._capability || (!this._capabilityPending && (age < 0 || age >= CAPABILITY_CACHE_MS))) {
      this._capabilityPending = true;
      this._capability = (async () => {
        try {
          const path = this._find({ platform: this._platform, env: this._env });
          if (!path) return { available: false, version: null, reason: 'mosh_server_not_found' };
          const version = await runVersion(path, this._execFile, this._env, this._platform);
          if (!version) return { available: false, version: null, reason: 'mosh_server_unusable' };
          return { available: true, version, reason: null, path };
        } finally {
          this._capabilityPending = false;
          this._capabilityCheckedAt = this._now();
        }
      })();
    }
    return this._capability;
  }

  /**
   * Starts a session for the hub and answers once mosh-server printed CONNECT: what
   * a mosh-client needs, the UDP port and the key. The pane is checked like any
   * terminal's. On Windows the session then waits for its tmux client in the turn.
   */
  async start({ id, paneId, nozoom = false }) {
    if (!SESSION_ID_RE.test(String(id))) throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid session id', { details: { field: 'id' } });
    const capability = await this.capability();
    // Checked after every await and right before the session is entered, with
    // nothing in between: a DELETE, a shutdown or a second request for the id may
    // have come while the capability was looked up.
    this._forget();
    if (this._closing) throw new AppError(ErrorCode.TERMINAL_BUSY, 'Shutting down', { retryable: true });
    if (this.sessions.has(id) || this._ended.has(id)) throw new AppError(ErrorCode.VALIDATION_ERROR, 'This session id was used already');
    if (!capability.available) throw new AppError(ErrorCode.UNSUPPORTED, 'mosh-server is not available on this machine', { details: { reason: capability.reason } });
    if (this.sessions.size >= MAX_SESSIONS) throw new AppError(ErrorCode.CONNECTION_LIMIT, 'Too many mosh sessions', { retryable: true });

    let settled;
    const session = {
      id, state: 'starting', cancelled: false, paneId, sessionTarget: null,
      daemon: null, children: [], launch: null, teardown: null, queued: null, lastSeen: this._now(),
      settled: new Promise((resolve) => { settled = resolve; }),
    };
    this.sessions.set(id, session);
    this._sweep();
    let announce;
    const announced = new Promise((resolve) => { announce = resolve; });
    (async () => {
      const resolved = await this.workspace.resolvePane(paneId);
      if (session.cancelled) throw cancelledError();
      session.paneId = resolved.paneId;
      session.sessionTarget = resolved.sessionId;
      const result = await this.terminalManager.whenClientCanStart(resolved.sessionId,
        () => this._launch(session, capability.path, resolved, nozoom, announce),
        { cancelled: () => session.cancelled });
      if (result === null) throw cancelledError();
    })().catch(async (err) => {
      announce({ error: err });
      // Ended in the turn already when it got that far; otherwise there is little to end.
      await this._end(session);
    }).finally(settled);
    const answer = await announced;
    if (answer.error) throw answer.error;
    return { id, port: answer.port, key: answer.key, paneId: session.paneId };
  }

  /**
   * In the client turn: spawn, answer, then wait for the attach on Windows. Any way
   * out but an active session ends what was started before the turn is given up.
   */
  async _launch(session, path, resolved, nozoom, announce) {
    if (session.cancelled) return null;
    let active = false;
    try {
      session.launch = this._spawnServer(path, resolved, { nozoom });
      const started = await session.launch;
      session.daemon = await this._identify(started.pid);
      if (!session.daemon) throw new AppError(ErrorCode.INTERNAL, 'mosh-server could not be identified');
      // Its command child exists from the fork on: known now, it can be ended even after mosh-server is gone.
      const table = await this._processes.read().catch(() => null);
      if (table) this._noteChildren(session, table);
      if (session.cancelled) return null;
      announce({ port: started.port, key: started.key });
      if (this._platform === 'win32') {
        // Until the attach is seen and has settled, nothing of ours may leave (ENV-3).
        let over;
        this.terminalManager.holdStart?.(new Promise((resolve) => { over = resolve; }));
        try {
          const client = await this._waitForAttach(session);
          session.attached = Boolean(client);
          if (!client) {
            if (!session.cancelled) console.warn('[mosh] session', JSON.stringify({ at: new Date().toISOString(), status: 'not_attached' }));
            return null;
          }
          await pause(this._settleMs);
        } finally {
          over();
        }
      }
      if (session.cancelled) return null;
      session.state = 'active';
      // Elsewhere the attach is not watched: once active, assume a client may be there.
      session.attached = true;
      active = true;
      return session.id;
    } finally {
      if (!active) await this._end(session, { inTurn: true });
    }
  }

  /** The recorded identity of mosh-server's daemon, once ps shows it. */
  async _identify(pid) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const table = await this._processes.read().catch(() => null);
      const entry = table && table.get(Number(pid));
      if (entry?.start) return entry;
      await pause(50);
    }
    return null;
  }

  /** tmux lists a client whose parent is this session's mosh-server: the attach happened. */
  async _waitForAttach(session) {
    const deadline = this._now() + this._attachTimeoutMs;
    while (this._now() < deadline && !session.cancelled) {
      const [clients, table] = await Promise.all([
        this._tmux(['list-clients', '-F', '#{client_pid}']).catch(() => ''),
        this._processes.read().catch(() => null),
      ]);
      if (table) {
        const daemon = table.get(session.daemon.pid);
        if (daemon && !daemon.start) { await pause(ATTACH_POLL_MS); continue; }
        if (!sameProcess(session.daemon, daemon)) return null;
        this._noteChildren(session, table);
        const pids = new Set(String(clients).split('\n').map((line) => Number(line.trim())).filter(Boolean));
        const client = session.children.find((child) => pids.has(child.pid));
        if (client) return client;
      }
      await pause(ATTACH_POLL_MS);
    }
    return null;
  }

  /** Children of the daemon as they are now, kept so they can be ended after it. */
  _noteChildren(session, table) {
    for (const entry of table.values()) {
      if (entry.ppid !== session.daemon.pid || !entry.start) continue;
      const index = session.children.findIndex((child) => child.pid === entry.pid);
      if (index >= 0) session.children[index] = entry;
      else session.children.push(entry);
    }
  }

  _spawnServer(path, resolved, { nozoom }) {
    const windows = this._platform === 'win32';
    const tmux = windows ? toPosixPath(TMUX_BIN) : TMUX_BIN;
    const ports = /^\d{1,5}(:\d{1,5})?$/.test(this._env.ANYMUX_MOSH_PORTS || '') ? this._env.ANYMUX_MOSH_PORTS : '60000:61000';
    // One address to listen on, when not every interface should take UDP from anyone holding a key.
    const bind = isIP(this._env.ANYMUX_MOSH_BIND || '') ? ['-i', this._env.ANYMUX_MOSH_BIND] : [];
    const argv = ['new', '-c', '256', '-l', 'LANG=C.UTF-8', '-p', ports, ...bind, '--',
      tmux, ...this._tmuxSocketArgs, ...buildTmuxAttachArgs(resolved.paneId, { nozoom })];
    const env = {
      ...this._env,
      LANG: this._env.LANG || 'C.UTF-8',
      LC_CTYPE: this._env.LC_CTYPE || this._env.LANG || 'C.UTF-8',
      MOSH_SERVER_NETWORK_TMOUT: String(NETWORK_TIMEOUT_S),
    };
    // An inherited TMUX would point tmux at that server instead (docs/known-issues.md ENV-5).
    delete env.TMUX;
    delete env.TMUX_PANE;
    if (windows) {
      // mosh-server outside MSYS2's own bin still needs its runtime, and the same one as tmux.
      const bin = win32.join(MSYS_ROOT, 'usr', 'bin');
      env.PATH = `${bin};${env.PATH || ''}`;
    }
    const [args, options] = msysExecArgs(argv, { argv0: path, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }, windows);
    return new Promise((resolve, reject) => {
      let out = '';
      let err = '';
      let done = false;
      const child = this._spawn(path, args, options);
      const finish = (error, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        finish(new AppError(ErrorCode.INTERNAL, 'mosh-server did not start'));
      }, START_TIMEOUT_MS);
      const connect = () => /MOSH CONNECT (\d{1,5}) ([A-Za-z0-9/+]{22})\s/.exec(out);
      const check = () => {
        const detached = /detached, pid = (\d+)/.exec(err);
        const line = connect();
        if (line && detached) finish(null, { port: Number(line[1]), key: line[2], pid: Number(detached[1]) });
      };
      child.stdout.on('data', (chunk) => { out += chunk; check(); });
      child.stderr.on('data', (chunk) => { err = (err + chunk).slice(-4096); check(); });
      child.once('error', () => finish(new AppError(ErrorCode.INTERNAL, 'mosh-server could not be started')));
      // Only a fixed message: there is no need to pass mosh-server's own output on.
      child.once('exit', () => setTimeout(() => {
        check();
        // CONNECT is printed just before the fork: without the pid, what it forked is unknown.
        finish(Object.assign(new AppError(ErrorCode.INTERNAL, 'mosh-server exited without a session'), { forked: Boolean(connect()) }));
      }, 50));
    });
  }

  /**
   * Ends a session, starting or active: whatever it started goes, the tmux server
   * stays. `clean` is false when something it started may still be running.
   */
  async stop(id) {
    if (!SESSION_ID_RE.test(String(id))) return { stopped: false, clean: true };
    const session = this.sessions.get(id);
    if (!session) {
      // Ended already, or never started here: either way a late start must not happen.
      const ended = this._ended.get(id);
      if (!ended) this._ended.set(id, { clean: true, at: this._now() });
      return { stopped: false, clean: ended ? ended.clean : true };
    }
    session.cancelled = true;
    // A start under way ends itself once it sees the cancel; ending it twice could race.
    if (session.state === 'starting') await session.settled;
    if (this.sessions.get(id) === session) return { stopped: true, clean: await this._end(session) };
    return { stopped: true, clean: this._ended.get(id)?.clean ?? false };
  }

  /**
   * What became of a session: starting, active, ending, or ended (clean or not). A
   * hub asks this to learn that a session it bridges was taken over or went away,
   * which its mosh-client may never be told if the last packets are lost.
   */
  state(id) {
    const session = this.sessions.get(id);
    if (session) {
      // The hub that bridges it is still there (see reap).
      session.lastSeen = this._now();
      return { state: session.state };
    }
    const ended = this._ended.get(id);
    return ended ? { state: 'ended', clean: ended.clean } : { state: 'unknown' };
  }

  /** TerminalManager, in the client turn: a new client is starting on this session. */
  async endClientsOn(sessionTarget) {
    const ending = [...this.sessions.values()]
      .filter((session) => (session.state === 'active' || session.state === 'ending') && session.sessionTarget === sessionTarget)
      .map((session) => { session.cancelled = true; return this._end(session, { inTurn: true }); });
    return (await Promise.all(ending)).every(Boolean);
  }

  /** On shutdown: no new sessions, and every session ended before the process goes. */
  async stopAll() {
    this._closing = true;
    clearInterval(this._sweeper);
    this._sweeper = null;
    const results = await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)));
    return results.every((result) => result.clean);
  }

  /**
   * Ends what the session started, once. A caller already in the client turn runs
   * it now. Anyone else, on Windows, waits for a turn in which nothing is starting;
   * that queued turn finds it done if a caller in an earlier turn got there first.
   * A caller in the turn never waits for a queued one: it would wait for itself.
   */
  _end(session, { inTurn = false } = {}) {
    if (!session.teardown) {
      let result = null;
      session.teardown = () => {
        if (!result) {
          result = (async () => {
            session.state = 'ending';
            // A spawn under way finishes first, so its processes are known.
            if (session.launch) await session.launch.catch(() => {});
            const clean = await this._terminate(session);
            if (clean) {
              this.sessions.delete(session.id);
              this._ended.set(session.id, { clean, at: this._now() });
            } else {
              // Keep ownership: a later attach must not mistake unconfirmed
              // cleanup for absence. It may retry only with a fresh identity read.
              session.teardown = null;
              session.queued = null;
              console.warn('[mosh] session', JSON.stringify({ at: new Date().toISOString(), status: 'not_clean' }));
            }
            return clean;
          })();
        }
        return result;
      };
    }
    const teardown = session.teardown;
    if (inTurn) return teardown();
    if (!session.queued) session.queued = this.terminalManager.inClientTurn(teardown);
    return session.queued;
  }

  async _terminate(session) {
    if (session.launch && !session.daemon) {
      // Started but unidentified, or printed CONNECT and so forked: what it left is unknown.
      const outcome = await session.launch.then(() => ({ ok: true }), (err) => ({ ok: false, forked: Boolean(err && err.forked) }));
      return !outcome.ok && !outcome.forked;
    }
    if (!session.daemon) return true;
    const table = await this._processes.read().catch(() => null);
    // Before anything is signalled, any unreadable birth keeps ownership: nothing is sent.
    if (!table || hasUnknownIdentity(session, table)) return false;
    if (sameProcess(session.daemon, table.get(session.daemon.pid))) this._noteChildren(session, table);
    const ours = [...session.children, session.daemon];
    const isOurs = (entry, current) => (entry === session.daemon ? sameProcess(entry, current) : sameStart(entry, current));
    const alive = (current) => ours.filter((entry) => isOurs(entry, current.get(entry.pid)));
    // Once this end has sent a signal, its processes go: the one signalled, and
    // mosh-server after its tmux client. On the way out a process can stay listed for
    // a moment after its birth stops being readable (seen on Windows). Such a row is
    // waited for, never signalled (alive() needs the birth) and never counted as
    // gone; still there after every step, the end is not clean. Before any signal, an
    // unreadable birth stops the end at once, with nothing sent.
    let signalled = false;
    const check = (current) => {
      const unknown = unknownPids(session, current).size > 0;
      if (unknown && !signalled) return 'unknown';
      return alive(current).length === 0 && !unknown ? 'done' : 'waiting';
    };
    // First only the command child, the tmux client: mosh-server then tells the
    // client it is over and waits for its answer before it exits, so the browser's
    // mosh-client exits too instead of waiting for a server that is gone. Then
    // mosh-server itself, then KILL for whatever is left. A session that never
    // attached has no client to tell.
    const steps = [{ signal: 'TERM', who: () => true }, { signal: 'KILL', who: () => true }];
    if (session.attached) steps.unshift({ signal: 'TERM', who: (entry) => entry !== session.daemon });
    for (const step of steps) {
      const now = await this._processes.read().catch(() => null);
      if (!now) return false;
      const state = check(now);
      if (state !== 'waiting') return state === 'done';
      for (const entry of alive(now).filter(step.who)) {
        signalled = true;
        await this._processes.signal(entry.pid, step.signal);
      }
      for (let waited = 0; waited < this._goneWaitMs; waited += GONE_POLL_MS) {
        await pause(GONE_POLL_MS);
        const after = await this._processes.read().catch(() => null);
        if (!after) continue;
        const next = check(after);
        if (next !== 'waiting') return next === 'done';
      }
    }
    return false;
  }

  /** Sessions whose mosh-server went by itself (client gone, tmux detached) are dropped. */
  _sweep() {
    if (this._sweeper || this._closing) return;
    this._sweeper = setInterval(() => { this.reap().catch(() => {}); }, SWEEP_MS);
    if (this._sweeper.unref) this._sweeper.unref();
  }

  /**
   * Drops sessions whose processes went by themselves, and ends those whose hub has
   * not asked about them for HUB_SILENCE_MS: through the guarded path, well before
   * mosh-server's own NETWORK_TIMEOUT_S would end them at a moment nobody chose.
   */
  async reap() {
    const table = await this._processes.read();
    for (const session of [...this.sessions.values()]) {
      if (session.state !== 'active' || session.teardown) continue;
      if (hasUnknownIdentity(session, table)) continue;
      if (sameProcess(session.daemon, table.get(session.daemon.pid))) this._noteChildren(session, table);
      if (sameProcess(session.daemon, table.get(session.daemon.pid))
        || session.children.some((entry) => sameStart(entry, table.get(entry.pid)))) {
        if (this._now() - session.lastSeen > this._hubSilenceMs) {
          session.cancelled = true;
          this._end(session).catch(() => {});
        }
        continue;
      }
      this.sessions.delete(session.id);
      this._ended.set(session.id, { clean: true, at: this._now() });
    }
    if (this.sessions.size === 0) {
      clearInterval(this._sweeper);
      this._sweeper = null;
    }
    this._forget();
  }

  _forget() {
    for (const [id, ended] of this._ended) if (this._now() - ended.at > TOMBSTONE_MS) this._ended.delete(id);
  }
}
