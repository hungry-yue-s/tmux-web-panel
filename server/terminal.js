/**
 * TerminalManager — manages PTY ↔ WebSocket connections for tmux panes.
 *
 * Each WebSocket client connects to a specific tmux pane via node-pty.
 * Multiple clients can share the same pane (up to maxConnectionsPerPane).
 */

import pty from 'node-pty';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { TMUX_BIN, msysExecArgs } from './msys.js';
import { ConsoleReaper, trackConsoleSpawn } from './terminal/console-reaper.js';

const execFileAsync = promisify(execFile);

const PANE_ID_PATTERN = /^%\d+$/;
const PING_INTERVAL_MS = 30_000;
const REAP_INTERVAL_MS = 60_000;

// A tmux client has started once it enters the alternate screen.
const CLIENT_STARTED_MARKER = '\x1b[?1049h';
const CLIENT_START_WAIT_MS = 1500;
// How long a Windows client stays after it has started before it may be replaced.
// With about 300ms to start, that is the 1100ms lifetime measured clean.
const CLIENT_SETTLE_MS = 800;

// Cap the carry-over buffer so a runaway/never-terminated OSC 52 can't grow
// unbounded. tmux's set-clipboard payload caps well under this.
const OSC52_MAX_PENDING = 1024 * 1024;

/**
 * Extract complete OSC 52 sequences from a stream chunk, supporting sequences
 * that span multiple chunks.
 *
 * Recognises `\x1b]52;<Pc>;<base64>\x07` and `\x1b]52;<Pc>;<base64>\x1b\\`.
 * Any tail starting with `\x1b]52;` but without its terminator is returned in
 * `pending` so the next call can complete it. A partial OSC 52 (no terminator
 * yet) is NOT forwarded to the client — that would render as garbage.
 *
 * @param {string} buf
 * @returns {{ clipboard: string[], cleaned: string, pending: string }}
 */
export function extractOsc52(buf) {
  const clipboard = [];
  let cleaned = '';
  let i = 0;
  while (i < buf.length) {
    const start = buf.indexOf('\x1b]52;', i);
    if (start === -1) {
      cleaned += buf.slice(i);
      return { clipboard, cleaned, pending: '' };
    }
    cleaned += buf.slice(i, start);

    // Find terminator: BEL (\x07) or ST (\x1b\\)
    const bel = buf.indexOf('\x07', start + 5);
    const st = buf.indexOf('\x1b\\', start + 5);
    let end = -1;
    let termLen = 0;
    if (bel !== -1 && (st === -1 || bel < st)) {
      end = bel;
      termLen = 1;
    } else if (st !== -1) {
      end = st;
      termLen = 2;
    }

    if (end === -1) {
      // Incomplete: keep tail as pending for next chunk. If absurdly large,
      // abandon and emit as output to avoid memory blow-up.
      const tail = buf.slice(start);
      if (tail.length > OSC52_MAX_PENDING) {
        cleaned += tail;
        return { clipboard, cleaned, pending: '' };
      }
      return { clipboard, cleaned, pending: tail };
    }

    const inner = buf.slice(start + 5, end);
    const semi = inner.indexOf(';');
    if (semi !== -1) {
      const payload = inner.slice(semi + 1);
      try {
        const decoded = Buffer.from(payload, 'base64').toString('utf8');
        if (decoded) clipboard.push(decoded);
      } catch {
        // ignore invalid base64
      }
    }
    i = end + termLen;
  }
  return { clipboard, cleaned, pending: '' };
}

// A redraw reaches node-pty as dozens of small chunks. Each would become its
// own WebSocket frame (and its own xterm write), which on a slow link costs
// more in framing and round trips than the bytes themselves.
const OUTPUT_IDLE_FLUSH_MS = 0;
const OUTPUT_BURST_FLUSH_MS = 4;
const OUTPUT_MAX_CHARS = 64 * 1024;
const OUTPUT_IDLE_AFTER_MS = 30;

/**
 * Coalesces output chunks into fewer messages. The first chunk after a quiet
 * spell goes out on the next timer tick, so a keystroke echo is not delayed;
 * chunks inside a burst are gathered for a few milliseconds.
 */
export function createOutputBatcher(send, { now = Date.now } = {}) {
  let buffer = '';
  let timer = null;
  let lastFlush = 0;
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!buffer) return;
    const data = buffer;
    buffer = '';
    lastFlush = now();
    send(data);
  }
  return {
    push(text) {
      if (!text) return;
      buffer += text;
      if (buffer.length >= OUTPUT_MAX_CHARS) { flush(); return; }
      if (timer) return;
      const idle = now() - lastFlush > OUTPUT_IDLE_AFTER_MS;
      timer = setTimeout(flush, idle ? OUTPUT_IDLE_FLUSH_MS : OUTPUT_BURST_FLUSH_MS);
    },
    flush,
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
      buffer = '';
    },
  };
}

/** Spots `marker` in a stream of chunks, also when it arrives split across two. */
export function createMarkerWatch(marker) {
  let tail = '';
  return (chunk) => {
    const text = tail + chunk;
    tail = text.slice(-(marker.length - 1));
    return text.includes(marker);
  };
}

/** Builds the tmux attach command line that runs under `sh -c` on Unix. */
export function buildTmuxAttachCommand(paneId, { nozoom = false } = {}) {
  // xterm.js supports UTF-8 even when SSH does not forward a UTF-8 locale.
  // Without -u, tmux replaces Chinese and prompt icons with underscores.
  // Apply selection, zoom and attach in one tmux command queue. An old
  // attachment must never toggle the shared window again when it exits.
  const toggle = `resize-pane -Z -t ${paneId}`;
  return [
    `tmux -u select-pane -t '${paneId}'`,
    `if-shell -F -t '${paneId}' '#{window_zoomed_flag}' '${nozoom ? toggle : ''}' '${nozoom ? '' : toggle}'`,
    `attach-session -d -t '${paneId}'`,
  ].join(' \\; ');
}

/**
 * The same command queue as buildTmuxAttachCommand, as tmux argv. Windows has
 * no `sh` to run the string, so the local PTY starts MSYS2's tmux directly;
 * keep both builders in step.
 */
export function buildTmuxAttachArgs(paneId, { nozoom = false } = {}) {
  const toggle = `resize-pane -Z -t ${paneId}`;
  return [
    '-u', 'select-pane', '-t', paneId, ';',
    'if-shell', '-F', '-t', paneId, '#{window_zoomed_flag}', nozoom ? toggle : '', nozoom ? '' : toggle, ';',
    'attach-session', '-d', '-t', paneId,
  ];
}

/**
 * A new client for a session that is already on screen. Unlike the first attach
 * it selects nothing, so the current window, pane and zoom stay as the user left them.
 */
export function buildTmuxReattachArgs(target) {
  return ['-u', 'attach-session', '-d', '-t', target];
}

/** Local attach PTY: `sh -c` on Unix, MSYS2 tmux itself on Windows. */
export function localAttachSpawnSpec(paneId, { nozoom = false, platform = process.platform } = {}) {
  if (platform === 'win32') return { file: TMUX_BIN, args: buildTmuxAttachArgs(paneId, { nozoom }) };
  return { file: 'sh', args: ['-c', buildTmuxAttachCommand(paneId, { nozoom })] };
}

export class TerminalManager {
  /** @param {{ maxConnectionsPerPane?: number, platform?: string, tmux?: (args: string[]) => Promise<string>, consoleReaper?: ConsoleReaper }} [options] */
  constructor(options = {}) {
    this.platform = options.platform ?? process.platform;
    this._consoleReaper = options.consoleReaper ?? new ConsoleReaper();
    this._tmux = options.tmux ?? (async (args) => String((await execFileAsync(
      TMUX_BIN, ...msysExecArgs(args, { timeout: 5000, windowsHide: true }),
    )).stdout));

    /** @type {Map<string, { ws: import('ws').WebSocket, pty: import('node-pty').IPty, paneId: string, pingTimer: ReturnType<typeof setInterval> | null, killTimer: ReturnType<typeof setTimeout> | null, dataDisposable: import('node-pty').IDisposable | null, alive: boolean }>} */
    this.connections = new Map();

    /** @type {Map<string, number>} paneId → active connection count */
    this.paneConnectionCount = new Map();

    this.maxConnectionsPerPane = options.maxConnectionsPerPane ?? 5;

    /** @type {ReturnType<typeof setInterval> | null} */
    this._reapTimer = null;
  }

  /**
   * Start periodic reaper that kills orphaned PTY processes.
   */
  startReaper() {
    if (this._reapTimer) return;
    this._reapTimer = setInterval(() => this._reapOrphans(), REAP_INTERVAL_MS);
  }

  stopReaper() {
    if (this._reapTimer) {
      clearInterval(this._reapTimer);
      this._reapTimer = null;
    }
  }

  /**
   * Kill any PTY whose WebSocket is no longer open.
   * @private
   */
  _reapOrphans() {
    for (const [connectionId, conn] of this.connections) {
      if (conn.ws.readyState !== conn.ws.OPEN && conn.ws.readyState !== conn.ws.CONNECTING) {
        this._killPty(connectionId);
        this._cleanup(connectionId);
      }
    }
  }

  /**
   * Create a new PTY ↔ WebSocket bridge for the given pane.
   *
   * @param {import('ws').WebSocket} ws
   * @param {string} paneId - e.g. "%0", "%1"
   * @param {number} [cols=80]
   * @param {number} [rows=24]
   * @param {boolean} [nozoom=false]
   * @param {{onReject?: Function, onPtyExit?: Function, spawn?: {file: string, args: string[], env?: object}, scope?: string}} [options]
   *   onReject/onPtyExit report structured errors. spawn and scope exist for a
   *   hub attaching to a basic-mode host over ssh: its pane ids are another
   *   machine's, so they get their own quota scope.
   * @returns {string} connectionId
   */
  create(ws, paneId, cols = 80, rows = 24, nozoom = false, options = {}) {
    // A socket that has already closed never reports it again, so nothing would
    // end a client started now, and `attach-session -d` takes over the pane.
    if (ws.readyState > 1) return null;

    const reject = (code, closeCode, message) => {
      // Reported before the close so a caller can send a structured frame; the
      // legacy caller passes nothing and just sees the close.
      if (typeof options.onReject === 'function') {
        try {
          options.onReject({ code, message });
        } catch {
          // A reporting failure must not leave the socket open.
        }
      }
      ws.close(closeCode, message);
      return null;
    };

    // Validate paneId format
    if (!PANE_ID_PATTERN.test(paneId)) {
      return reject('VALIDATION_ERROR', 1008, `Invalid paneId format: ${paneId}`);
    }

    // Check connection limit
    const quotaKey = options.scope ? `${options.scope}:${paneId}` : paneId;
    const currentCount = this.paneConnectionCount.get(quotaKey) ?? 0;
    if (currentCount >= this.maxConnectionsPerPane) {
      return reject('CONNECTION_LIMIT', 1013, `Connection limit reached for pane ${paneId}`);
    }

    const connectionId = randomUUID();

    const spawnSpec = options.spawn || localAttachSpawnSpec(paneId, { nozoom, platform: this.platform });
    const spawnWindows = new WeakMap();
    const spawnPty = (args, size) => {
      const { term: spawned, spawnWindow } = trackConsoleSpawn(() => pty.spawn(spawnSpec.file, args, {
        name: 'xterm-256color',
        cols: size.cols || 80,
        rows: size.rows || 24,
        // launchd/systemd services often have no locale. tmux then treats the
        // attached client as non-UTF-8 and replaces wide characters with `_`
        // before they ever reach xterm.js.
        env: {
          ...process.env,
          ...spawnSpec.env,
          LANG: process.env.LANG || 'C.UTF-8',
          LC_CTYPE: process.env.LC_CTYPE || process.env.LANG || 'C.UTF-8',
        },
      }));
      spawnWindows.set(spawned, spawnWindow);
      return spawned;
    };
    let term;
    try {
      term = spawnPty(spawnSpec.args, { cols, rows });
    } catch {
      return reject('TERMINAL_SPAWN_FAILED', 1011, 'Terminal process could not be started');
    }

    // Track connection
    const conn = {
      ws,
      pty: term,
      paneId,
      quotaKey,
      pingTimer: null,
      killTimer: null,
      dataDisposable: null,
      alive: true,
      osc52Pending: '', // carry-over for OSC 52 split across PTY chunks
      output: createOutputBatcher((data) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'output', data }));
      }),
      onPtyExit: options.onPtyExit,
      spawnPty,
      spawnWindows,
      // See _setClientSize. A basic-mode host's ssh client is not an MSYS2 tmux client.
      replaceToResize: this.platform === 'win32' && !options.spawn,
      size: { cols: cols || 80, rows: rows || 24 },
      wantedSize: null,
      resizing: false,
      sessionTarget: options.sessionTarget || null,
    };
    this.connections.set(connectionId, conn);
    this.paneConnectionCount.set(quotaKey, currentCount + 1);

    conn.started = this._bindPty(connectionId, conn, term);

    // WebSocket → PTY
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return; // ignore malformed messages
      }

      switch (msg.type) {
        case 'input':
          if (typeof msg.data === 'string') {
            conn.pty.write(msg.data);
          }
          break;
        case 'resize':
          if (
            typeof msg.cols === 'number' && msg.cols > 0 &&
            typeof msg.rows === 'number' && msg.rows > 0
          ) {
            if (conn.replaceToResize) this._setClientSize(connectionId, conn, msg.cols, msg.rows);
            else conn.pty.resize(msg.cols, msg.rows);
          }
          break;
        default:
          break;
      }
    });

    // WebSocket close → kill PTY + cleanup
    ws.on('close', () => {
      this._killPty(connectionId);
      this._cleanup(connectionId);
    });

    // WebSocket error → same as close path
    ws.on('error', () => {
      this._killPty(connectionId);
      this._cleanup(connectionId);
    });

    // Ping/pong heartbeat
    conn.alive = true;

    ws.on('pong', () => {
      conn.alive = true;
    });

    conn.pingTimer = setInterval(() => {
      if (!conn.alive) {
        ws.terminate();
        return;
      }
      conn.alive = false;
      if (ws.readyState === ws.OPEN) {
        ws.ping();
      }
    }, PING_INTERVAL_MS);

    return connectionId;
  }

  /**
   * Connects a PTY to the connection's socket.
   * @returns {Promise<void>|undefined} when clients get replaced to resize,
   *   resolves once this one has started: the next may not race it to attach.
   * @private
   */
  _bindPty(connectionId, conn, term) {
    const { ws } = conn;
    let started = () => {};
    let startWait = null;
    let settle = null;
    let settleDone = () => {};
    let released = false;
    const startedPromise = conn.replaceToResize ? new Promise((resolve) => {
      started = () => {
        clearTimeout(startWait);
        resolve();
      };
      startWait = setTimeout(started, CLIENT_START_WAIT_MS);
      if (startWait.unref) startWait.unref();
    }) : undefined;
    // Replacing a client sooner than this can leak its terminal query replies into
    // the pane as typed text.
    conn.settled = startedPromise && startedPromise.then(() => new Promise((resolve) => {
      if (released) { resolve(); return; }
      settleDone = resolve;
      settle = setTimeout(resolve, CLIENT_SETTLE_MS);
      if (settle.unref) settle.unref();
    }));
    // A connection that ends stops waiting: nothing is left to replace.
    conn.releaseStartup = () => {
      released = true;
      started();
      clearTimeout(settle);
      settleDone();
    };
    const sawStart = createMarkerWatch(CLIENT_STARTED_MARKER);

    // PTY → WebSocket
    // Also intercept OSC 52 clipboard sequences from tmux. Long selections can
    // span multiple PTY reads, so a stateful parser is needed instead of a
    // single-chunk regex.
    conn.dataDisposable = term.onData((data) => {
      if (conn.replaceToResize && sawStart(data)) started();
      if (ws.readyState !== ws.OPEN) return;

      const { clipboard, cleaned, pending } = extractOsc52(conn.osc52Pending + data);
      conn.osc52Pending = pending;

      for (const text of clipboard) {
        // Output before the copy stays before it.
        conn.output.flush();
        ws.send(JSON.stringify({ type: 'clipboard', data: text }));
      }
      if (cleaned.length > 0) conn.output.push(cleaned);
    });  // disposable stored in conn.dataDisposable

    // PTY exit → close WebSocket + cleanup
    term.onExit(({ exitCode, signal }) => {
      started();
      if (conn.replaceToResize) {
        // Too late for this to close the console, which is safe: it releases
        // node-pty's reader, and the console gets ended once tmux has let go of it.
        try { term.kill(); } catch { /* already gone */ }
        const spawnWindow = conn.spawnWindows.get(term);
        if (spawnWindow) this._consoleReaper.clientEnded(spawnWindow);
      }
      // A client replaced at a new size is meant to leave; the connection goes on.
      if (conn.pty !== term) return;
      conn.ptyExited = true;
      conn.output.flush();
      // The new server-scoped entry point emits a structured exit frame here so
      // tmux and SSH panes speak the same protocol; the legacy caller passes
      // nothing and keeps the original close-only behavior.
      if (typeof conn.onPtyExit === 'function') {
        try {
          conn.onPtyExit({ code: exitCode ?? null, signal: signal ?? null, reason: 'tmux_client_exit' });
        } catch {
          // A reporting failure must not block cleanup.
        }
      }
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
        ws.close(1000, `PTY exited with code ${exitCode}`);
      }
      this._cleanup(connectionId);
    });

    return startedPromise;
  }

  /**
   * MSYS2 tmux on Windows: resizing the ConPTY under a running client can end the
   * tmux server and every session with it, and a resize that does arrive is lost
   * during client startup (docs/known-issues.md). So the size of a running client
   * never changes. A new one starts at the new size and `attach-session -d`
   * replaces the old. One at a time; the latest size wins.
   * @private
   */
  async _setClientSize(connectionId, conn, cols, rows) {
    conn.wantedSize = { cols, rows };
    if (conn.resizing) return;
    conn.resizing = true;
    try {
      await conn.settled;
      while (this.connections.get(connectionId) === conn
        && (conn.wantedSize.cols !== conn.size.cols || conn.wantedSize.rows !== conn.size.rows)) {
        await this._replaceClient(connectionId, conn, conn.wantedSize);
      }
    } finally {
      conn.resizing = false;
    }
  }

  /** @private */
  async _replaceClient(connectionId, conn, size) {
    // Once known it stays right: the client on screen is in that session, even if
    // the pane has closed since.
    if (!conn.sessionTarget) {
      try {
        const session = (await this._tmux(['display-message', '-p', '-t', conn.paneId, '#{session_id}'])).trim();
        if (session) conn.sessionTarget = session;
      } catch {
        // Fall back to the pane itself below.
      }
      if (this.connections.get(connectionId) !== conn) return;
    }

    const previous = conn.pty;
    let next;
    try {
      next = conn.spawnPty(buildTmuxReattachArgs(conn.sessionTarget || conn.paneId), size);
    } catch {
      conn.wantedSize = conn.size;
      conn.ws.close(1011, 'Terminal process could not be started');
      return;
    }

    if (conn.dataDisposable) conn.dataDisposable.dispose();
    conn.pty = next;
    conn.size = size;
    conn.osc52Pending = '';
    this._bindPty(connectionId, conn, next);
    this._endClient(previous);

    await conn.settled;
  }

  /**
   * Ends a Windows tmux client by its own process and nothing else. node-pty's
   * kill ends every process on the console and closes it, and the tmux server,
   * attached at that moment, goes with it and leaves no trace (docs/known-issues.md).
   * What is left of the client is released when it exits; see _bindPty.
   * @private
   */
  _endClient(term, attempts = 0) {
    if (term.pid > 0) {
      try { process.kill(term.pid); } catch { /* already gone */ }
      return;
    }
    // Still starting. The pid is 0 until then, and process.kill(0) ends this process.
    if (attempts >= 500) return;
    const retry = setTimeout(() => this._endClient(term, attempts + 1), 10);
    if (retry.unref) retry.unref();
  }

  /**
   * Destroy a single connection by ID.
   * @param {string} connectionId
   */
  destroy(connectionId) {
    this._killPty(connectionId);
    const conn = this.connections.get(connectionId);
    if (conn) {
      if (conn.ws.readyState === conn.ws.OPEN || conn.ws.readyState === conn.ws.CONNECTING) {
        // 1001 (going away), not 1000: destroy() only runs on graceful server
        // shutdown/restart. The client must auto-reconnect afterwards, so this
        // must stay distinct from the 1000 "PTY exited / detached by -d" path
        // that the client treats as "taken over, stop retrying".
        conn.ws.close(1001, 'Server shutting down');
      }
    }
    this._cleanup(connectionId);
  }

  /**
   * Destroy all connections (for graceful shutdown).
   */
  destroyAll() {
    this.stopReaper();
    for (const connectionId of [...this.connections.keys()]) {
      this.destroy(connectionId);
    }
  }

  /**
   * Kill the PTY process for a connection (if still alive).
   * @param {string} connectionId
   * @private
   */
  _killPty(connectionId) {
    const conn = this.connections.get(connectionId);
    if (!conn) return;

    const pid = conn.pty.pid;

    // Windows has no process groups or signals. A tmux client is ended on its
    // own; anything else (a hub's ssh client) has its ConPTY closed by node-pty.
    if (this.platform === 'win32') {
      if (conn.ptyExited) return;
      if (conn.replaceToResize) {
        this._endClient(conn.pty);
      } else {
        try { conn.pty.kill(); } catch { /* already gone */ }
      }
      return;
    }

    // Send SIGTERM first so the attached client can exit cleanly.
    // Then schedule SIGKILL after a short delay as a hard guarantee — SIGTERM alone
    // is unreliable because tmux attach-session may not propagate the signal,
    // leading to zombie tmux client processes accumulating.
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      // Process group may not exist
    }

    conn.killTimer = setTimeout(() => {
      conn.killTimer = null;
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Process group already exited.
      }
    }, 500);
    if (conn.killTimer.unref) conn.killTimer.unref();
  }

  /**
   * Remove connection from tracking maps and clear timers.
   * Idempotent — safe to call multiple times for the same connectionId.
   * @param {string} connectionId
   * @private
   */
  _cleanup(connectionId) {
    const conn = this.connections.get(connectionId);
    if (!conn) return;

    // Clear ping timer
    if (conn.pingTimer) {
      clearInterval(conn.pingTimer);
      conn.pingTimer = null;
    }

    // Dispose PTY data listener
    if (conn.dataDisposable) {
      conn.dataDisposable.dispose();
      conn.dataDisposable = null;
    }
    if (conn.output) conn.output.dispose();
    if (conn.releaseStartup) conn.releaseStartup();

    const key = conn.quotaKey || conn.paneId;
    const count = this.paneConnectionCount.get(key) ?? 0;
    if (count <= 1) {
      this.paneConnectionCount.delete(key);
    } else {
      this.paneConnectionCount.set(key, count - 1);
    }

    this.connections.delete(connectionId);
  }
}
