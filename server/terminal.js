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

export class TerminalManager {
  /** @param {{ maxConnectionsPerPane?: number }} [options] */
  constructor(options = {}) {
    /** @type {Map<string, { ws: import('ws').WebSocket, pty: import('node-pty').IPty, paneId: string, pingTimer: ReturnType<typeof setInterval> | null, alive: boolean }>} */
    this.connections = new Map();

    /** @type {Map<string, number>} paneId → active connection count */
    this.paneConnectionCount = new Map();

    this.maxConnectionsPerPane = options.maxConnectionsPerPane ?? 5;
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
        `tmux attach-session -t '${paneId}'`,
      ].join('; ');
    } else {
      // Zoom mode: zoom the target pane so only it is visible, then attach.
      // Use trap TERM HUP to guarantee unzoom runs when pty.kill() sends SIGTERM.
      // The trap handler calls `exit 0` so the post-attach unzoom is skipped
      // (avoids double toggle which would re-zoom the pane).
      shellCmd = [
        `tmux select-pane -t '${paneId}' 2>/dev/null`,
        `_WZ=$(tmux display-message -p -t '${paneId}' '#{window_zoomed_flag}' 2>/dev/null)`,
        `trap '[ "$_WZ" != "1" ] && tmux resize-pane -Z -t "'${paneId}'" 2>/dev/null; exit 0' TERM HUP`,
        `[ "$_WZ" != "1" ] && tmux resize-pane -Z -t '${paneId}' 2>/dev/null`,
        `tmux attach-session -t '${paneId}'`,
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
      alive: true,
    };
    this.connections.set(connectionId, conn);
    this.paneConnectionCount.set(paneId, currentCount + 1);

    // PTY → WebSocket
    // Also intercept OSC 52 clipboard sequences from tmux
    term.onData((data) => {
      if (ws.readyState !== ws.OPEN) return;

      // Detect OSC 52 sequence: \x1b]52;...;base64\x07 or \x1b]52;...;base64\x1b\\
      const osc52Re = /\x1b\]52;([^;]*);([^\x07\x1b]*?)(?:\x07|\x1b\\)/g;
      let match;
      while ((match = osc52Re.exec(data)) !== null) {
        try {
          const decoded = Buffer.from(match[2], 'base64').toString('utf8');
          if (decoded) {
            ws.send(JSON.stringify({ type: 'clipboard', data: decoded }));
          }
        } catch {
          // ignore invalid base64
        }
      }



      ws.send(JSON.stringify({ type: 'output', data }));
    });

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
        conn.ws.close(1000, 'Connection destroyed');
      }
    }
    this._cleanup(connectionId);
  }

  /**
   * Destroy all connections (for graceful shutdown).
   */
  destroyAll() {
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
    try {
      conn.pty.kill();
    } catch {
      // PTY may already be dead
    }
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
