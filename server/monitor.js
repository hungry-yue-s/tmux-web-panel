import * as tmux from './tmux.js';
import { scanPorts } from './ports.js';

const SHELL_COMMANDS = new Set(['zsh', 'bash', 'fish', 'sh', 'dash', 'ksh', 'csh', 'tcsh']);
const PORT_CACHE_TTL_MS = 10_000;

export class StatusMonitor {
  /**
   * @param {{ notificationStore?: import('./notifications.js').NotificationStore }} [options]
   */
  constructor(options = {}) {
    this.subscribers = new Set();
    this.previousState = null;
    this.interval = null;
    this._previousCommands = new Map();
    this._previousBellFlags = new Map();
    this._portCache = new Map(); // paneId → { pid, ports, timestamp }
    this._lastPaneCmds = new Map(); // paneId → cmd (for pane-cmd broadcasts)
    this._notificationStore = options.notificationStore || null;
    this._borderConfigEnsured = false;
  }

  start(intervalMs) {
    if (this.interval) {
      this.stop();
    }
    this.poll();
    this.interval = setInterval(() => this.poll(), intervalMs);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  subscribe(ws) {
    this.subscribers.add(ws);
    if (this.previousState) {
      this._send(ws, this.previousState);
    }
  }

  unsubscribe(ws) {
    this.subscribers.delete(ws);
  }

  async poll() {
    try {
      const sessions = await tmux.listSessions();

      // Re-apply the global pane-border config once whenever a tmux server
      // (re)appears — options are runtime-only and reset on tmux restart.
      if (sessions.length > 0) {
        if (!this._borderConfigEnsured) {
          this._borderConfigEnsured = true;
          // On a transient failure, re-arm so the next poll retries.
          tmux.ensurePaneBorderConfig().catch(() => { this._borderConfigEnsured = false; });
        }
      } else {
        this._borderConfigEnsured = false;
      }

      const sessionsWithWindows = await Promise.all(
        sessions.map(async (session) => {
          const windows = await tmux.listWindows(session.name);
          let paneCommands = [];
          try {
            paneCommands = await tmux.listPaneCommands(session.name);
          } catch {
            // Ignore — pane command fetch failure should not abort status
          }

          // Build panePids map for port scanning, with cache support
          const panePids = new Map();
          const now = Date.now();
          for (const pc of paneCommands) {
            const cached = this._portCache.get(pc.paneId);
            const isStale = !cached ||
              cached.pid !== pc.pid ||
              (now - cached.timestamp) >= PORT_CACHE_TTL_MS;
            if (isStale && pc.pid > 0) {
              panePids.set(pc.paneId, pc.pid);
            }
          }

          // Scan ports for panes that need refreshing
          let newPortMap = new Map();
          if (panePids.size > 0) {
            try {
              newPortMap = await scanPorts(panePids);
            } catch {
              // Port scan failure should not abort status
            }
            // Update cache with newly scanned results
            for (const [paneId, ports] of newPortMap) {
              const pid = panePids.get(paneId);
              this._portCache.set(paneId, { pid, ports, timestamp: now });
            }
          }

          const windowsWithPanes = windows.map((w) => {
            const panes = paneCommands
              .filter((pc) => pc.windowIndex === w.index)
              .map((pc) => {
                const cached = this._portCache.get(pc.paneId);
                const ports = cached ? cached.ports : [];
                return { id: pc.paneId, command: pc.command, path: pc.path, ports };
              });
            return { ...w, panes };
          });
          return { ...session, windowDetails: windowsWithPanes, _paneCommands: paneCommands };
        }),
      );

      const totalSessions = sessionsWithWindows.length;
      const totalWindows = sessionsWithWindows.reduce(
        (sum, s) => sum + s.windows,
        0,
      );

      // Prune _portCache entries for panes that no longer exist
      const livePaneIds = new Set(
        sessionsWithWindows.flatMap((s) => (s._paneCommands || []).map((pc) => pc.paneId)),
      );
      for (const cachedId of this._portCache.keys()) {
        if (!livePaneIds.has(cachedId)) {
          this._portCache.delete(cachedId);
        }
      }

      // Broadcast pane-cmd on any foreground process change
      const currentPaneCmds = new Map();
      for (const session of sessionsWithWindows) {
        for (const pc of (session._paneCommands || [])) {
          currentPaneCmds.set(pc.paneId, pc.command);
        }
      }
      const hasBaseline = this._lastPaneCmds.size > 0;
      if (hasBaseline) {
        for (const [paneId, cmd] of currentPaneCmds) {
          if (this._lastPaneCmds.get(paneId) !== cmd) {
            this._broadcast(JSON.stringify({ type: 'pane-cmd', paneId, cmd }));
          }
        }
        for (const paneId of this._lastPaneCmds.keys()) {
          if (!currentPaneCmds.has(paneId)) this._lastPaneCmds.delete(paneId);
        }
      }
      this._lastPaneCmds = currentPaneCmds;

      // Detect completions (using already-fetched paneCommands)
      const { completedWindows, completedPanes } = await this._detectCompletions(sessionsWithWindows);

      // Strip internal _paneCommands before broadcasting
      const sessionsForPayload = sessionsWithWindows.map(({ _paneCommands: _, ...rest }) => rest);

      // Build status message WITHOUT completedWindows/completedPanes for dedup
      const statusMessage = {
        type: 'status',
        data: { sessions: sessionsForPayload, totalSessions, totalWindows },
      };
      const serialized = JSON.stringify(statusMessage);
      const hasCompletions = completedWindows.length > 0 || completedPanes.length > 0;

      if (serialized !== this.previousState || hasCompletions) {
        this.previousState = serialized;
        if (hasCompletions) {
          statusMessage.data.completedWindows = completedWindows;
          statusMessage.data.completedPanes = completedPanes;

          // Persist notifications server-side and broadcast them
          if (this._notificationStore) {
            const added = [];
            for (const cw of completedWindows) {
              // Resolve window name from session data
              const sess = sessionsForPayload.find((s) => s.name === cw.session);
              const win = sess && sess.windowDetails
                ? sess.windowDetails.find((w) => w.index === cw.windowIndex)
                : null;
              const n = this._notificationStore.add({
                session: cw.session,
                windowIndex: cw.windowIndex,
                windowName: win ? (win.name || '') : '',
                prevCommand: cw.prevCommand,
              });
              added.push(n);
            }
            if (added.length > 0) {
              this._broadcast(JSON.stringify({ type: 'notifications', data: added }));
            }
          }
        }
        this._broadcast(JSON.stringify(statusMessage));
      }
    } catch (err) {
      const errorMessage = {
        type: 'error',
        data: { message: err.message },
      };
      this._broadcast(JSON.stringify(errorMessage));
    }
  }

  async _detectCompletions(sessionsWithWindows) {
    const completedWindows = [];
    const completedPanes = [];
    const newCommands = new Map();
    const newBellFlags = new Map();

    for (const session of sessionsWithWindows) {
      const paneCommands = session._paneCommands || [];

      // Check command transitions
      const completedInSession = new Set();
      for (const pc of paneCommands) {
        const key = `${session.name}:${pc.windowIndex}:${pc.paneId}`;
        newCommands.set(key, pc.command);

        const prev = this._previousCommands.get(key);
        if (
          prev !== undefined &&
          !SHELL_COMMANDS.has(prev) &&
          SHELL_COMMANDS.has(pc.command)
        ) {
          // Per-pane entry (no dedup)
          completedPanes.push({
            session: session.name,
            windowIndex: pc.windowIndex,
            paneId: pc.paneId,
            prevCommand: prev,
          });

          // Per-window entry (dedup by window)
          if (!completedInSession.has(pc.windowIndex)) {
            completedInSession.add(pc.windowIndex);
            const winForId = session.windowDetails.find((wd) => wd.index === pc.windowIndex);
            const windowId = winForId ? winForId.id : null;
            completedWindows.push({
              session: session.name,
              windowIndex: pc.windowIndex,
              windowId,
              prevCommand: prev,
              source: 'command',
            });
          }
        }
      }

      // Check bell flags (rising edge only)
      for (const w of session.windowDetails) {
        const bellKey = w.id;
        newBellFlags.set(bellKey, w.bell);

        const prevBell = this._previousBellFlags.get(bellKey);
        if (
          prevBell === false &&
          w.bell === true &&
          !completedInSession.has(w.index)
        ) {
          const activePc = paneCommands.find(
            (pc) => pc.windowIndex === w.index,
          );
          completedWindows.push({
            session: session.name,
            windowIndex: w.index,
            windowId: w.id,
            prevCommand: activePc ? activePc.command : '',
            source: 'bell',
          });
        }
      }
    }

    this._previousCommands = newCommands;
    this._previousBellFlags = newBellFlags;
    return { completedWindows, completedPanes };
  }

  _send(ws, serialized) {
    if (ws.readyState === 1) {
      ws.send(serialized);
    }
  }

  _broadcast(serialized) {
    for (const ws of this.subscribers) {
      if (ws.readyState > 1) {
        // CLOSING or CLOSED — remove stale subscriber
        this.subscribers.delete(ws);
        continue;
      }
      this._send(ws, serialized);
    }
  }
}
