import * as tmux from './tmux.js';
import { scanPorts } from './ports.js';

const SHELL_COMMANDS = new Set(['zsh', 'bash', 'fish', 'sh', 'dash', 'ksh', 'csh', 'tcsh']);
const PORT_CACHE_TTL_MS = 10_000;

export class StatusMonitor {
  constructor() {
    this.subscribers = new Set();
    this.previousState = null;
    this.interval = null;
    this._previousCommands = new Map();
    this._previousBellFlags = new Map();
    this._portCache = new Map(); // paneId → { pid, ports, timestamp }
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
            completedWindows.push({
              session: session.name,
              windowIndex: pc.windowIndex,
              prevCommand: prev,
              source: 'command',
            });
          }
        }
      }

      // Check bell flags (rising edge only)
      for (const w of session.windowDetails) {
        const bellKey = `${session.name}:${w.index}`;
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
      this._send(ws, serialized);
    }
  }
}
