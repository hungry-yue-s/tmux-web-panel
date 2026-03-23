import * as tmux from './tmux.js';

export class StatusMonitor {
  constructor() {
    this.subscribers = new Set();
    this.previousState = null;
    this.interval = null;
  }

  /**
   * Start polling at the given interval (ms).
   */
  start(intervalMs) {
    if (this.interval) {
      this.stop();
    }
    // Poll immediately on start
    this.poll();
    this.interval = setInterval(() => this.poll(), intervalMs);
  }

  /**
   * Stop polling.
   */
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /**
   * Subscribe a WebSocket client. Immediately sends current state if available.
   */
  subscribe(ws) {
    this.subscribers.add(ws);
    if (this.previousState) {
      this._send(ws, this.previousState);
    }
  }

  /**
   * Unsubscribe a WebSocket client.
   */
  unsubscribe(ws) {
    this.subscribers.delete(ws);
  }

  /**
   * Poll tmux for current session/window state and broadcast to subscribers.
   */
  async poll() {
    try {
      const sessions = await tmux.listSessions();
      const sessionsWithWindows = await Promise.all(
        sessions.map(async (session) => {
          const windows = await tmux.listWindows(session.name);
          return { ...session, windowDetails: windows };
        }),
      );

      const totalSessions = sessionsWithWindows.length;
      const totalWindows = sessionsWithWindows.reduce(
        (sum, s) => sum + s.windows,
        0,
      );

      const message = {
        type: 'status',
        data: {
          sessions: sessionsWithWindows,
          totalSessions,
          totalWindows,
        },
      };

      const serialized = JSON.stringify(message);

      // Only broadcast if state has changed
      if (serialized !== this.previousState) {
        this.previousState = serialized;
        this._broadcast(serialized);
      }
    } catch (err) {
      const errorMessage = {
        type: 'error',
        data: { message: err.message },
      };
      this._broadcast(JSON.stringify(errorMessage));
    }
  }

  /**
   * Send a serialized message to a single WebSocket client.
   */
  _send(ws, serialized) {
    if (ws.readyState === 1) {
      ws.send(serialized);
    }
  }

  /**
   * Broadcast a serialized message to all subscribers.
   */
  _broadcast(serialized) {
    for (const ws of this.subscribers) {
      this._send(ws, serialized);
    }
  }
}
