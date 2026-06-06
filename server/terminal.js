/**
 * TerminalManager — manages PTY ↔ WebSocket connections for tmux panes.
 *
 * Each WebSocket client connects to a specific tmux pane via node-pty.
 * Multiple clients can share the same pane (up to maxConnectionsPerPane).
 */

import pty from 'node-pty';
import { randomUUID } from 'node:crypto';

const PANE_ID_PATTERN = /^%\d+$/;
const PING_INTERVAL_MS = 30_000;
const REAP_INTERVAL_MS = 60_000;

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

export class TerminalManager {
  /** @param {{ maxConnectionsPerPane?: number }} [options] */
  constructor(options = {}) {
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
   * @returns {string} connectionId
   */
  create(ws, paneId, cols = 80, rows = 24, nozoom = false) {
    // Validate paneId format
    if (!PANE_ID_PATTERN.test(paneId)) {
      ws.close(1008, `Invalid paneId format: ${paneId}`);
      return null;
    }

    // Check connection limit
    const currentCount = this.paneConnectionCount.get(paneId) ?? 0;
    if (currentCount >= this.maxConnectionsPerPane) {
      ws.close(1013, `Connection limit reached for pane ${paneId}`);
      return null;
    }

    const connectionId = randomUUID();

    let shellCmd;
    if (nozoom) {
      // No-zoom mode: show the full window with native tmux split layout.
      // Force unzoom first (previous tab-mode connection may have left it zoomed).
      shellCmd = [
        `tmux select-pane -t '${paneId}' 2>/dev/null`,
        `[ "$(tmux display-message -p -t '${paneId}' '#{window_zoomed_flag}' 2>/dev/null)" = "1" ] && tmux resize-pane -Z -t '${paneId}' 2>/dev/null`,
        // -d: detach other clients so the tmux window follows only this web
        // client's size (window-size=latest otherwise lets a stale/narrow
        // client shrink the shared window into a sliver — see CLAUDE.md).
        `tmux attach-session -d -t '${paneId}'`,
      ].join('; ');
    } else {
      // Zoom mode: zoom the target pane so only it is visible, then attach.
      // Trap TERM/HUP to attempt unzoom before exit. _killPty sends SIGTERM first
      // (giving the trap 500ms to run), then SIGKILL as a hard guarantee.
      shellCmd = [
        `tmux select-pane -t '${paneId}' 2>/dev/null`,
        `_WZ=$(tmux display-message -p -t '${paneId}' '#{window_zoomed_flag}' 2>/dev/null)`,
        `trap '[ "$_WZ" != "1" ] && tmux resize-pane -Z -t "'${paneId}'" 2>/dev/null; exit 0' TERM HUP`,
        `[ "$_WZ" != "1" ] && tmux resize-pane -Z -t '${paneId}' 2>/dev/null`,
        // -d: detach other clients so this web client alone dictates the
        // window size (see nozoom branch / CLAUDE.md for the why).
        `tmux attach-session -d -t '${paneId}'`,
        `[ "$_WZ" != "1" ] && tmux resize-pane -Z -t '${paneId}' 2>/dev/null`,
      ].join('; ');
    }
    const term = pty.spawn('sh', ['-c', shellCmd], {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
    });

    // Track connection
    const conn = {
      ws,
      pty: term,
      paneId,
      pingTimer: null,
      killTimer: null,
      dataDisposable: null,
      alive: true,
      osc52Pending: '', // carry-over for OSC 52 split across PTY chunks
    };
    this.connections.set(connectionId, conn);
    this.paneConnectionCount.set(paneId, currentCount + 1);

    // PTY → WebSocket
    // Also intercept OSC 52 clipboard sequences from tmux. Long selections can
    // span multiple PTY reads, so a stateful parser is needed instead of a
    // single-chunk regex.
    conn.dataDisposable = term.onData((data) => {
      if (ws.readyState !== ws.OPEN) return;

      const { clipboard, cleaned, pending } = extractOsc52(conn.osc52Pending + data);
      conn.osc52Pending = pending;

      for (const text of clipboard) {
        ws.send(JSON.stringify({ type: 'clipboard', data: text }));
      }
      if (cleaned.length > 0) {
        ws.send(JSON.stringify({ type: 'output', data: cleaned }));
      }
    });  // disposable stored in conn.dataDisposable

    // PTY exit → close WebSocket + cleanup
    term.onExit(({ exitCode }) => {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
        ws.close(1000, `PTY exited with code ${exitCode}`);
      }
      this._cleanup(connectionId);
    });

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
            term.write(msg.data);
          }
          break;
        case 'resize':
          if (
            typeof msg.cols === 'number' && msg.cols > 0 &&
            typeof msg.rows === 'number' && msg.rows > 0
          ) {
            term.resize(msg.cols, msg.rows);
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

    // Send SIGTERM first to give the shell trap a chance to run (unzoom cleanup).
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
        // Process group already dead — try individual PID
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already dead
        }
      }
    }, 500);
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

    // Clear SIGKILL timer
    if (conn.killTimer) {
      clearTimeout(conn.killTimer);
      conn.killTimer = null;
    }

    // Dispose PTY data listener
    if (conn.dataDisposable) {
      conn.dataDisposable.dispose();
      conn.dataDisposable = null;
    }

    // Decrement pane connection count
    const count = this.paneConnectionCount.get(conn.paneId) ?? 0;
    if (count <= 1) {
      this.paneConnectionCount.delete(conn.paneId);
    } else {
      this.paneConnectionCount.set(conn.paneId, count - 1);
    }

    this.connections.delete(connectionId);
  }
}
