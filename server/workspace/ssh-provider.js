/**
 * SSH workspace provider.
 *
 * Used when a reachable host has no usable tmux. The panel then owns the
 * Session/Window/Pane structure itself: these are panel objects presented in the
 * same shape as tmux objects, not forged tmux state. Each pane is one `ssh -tt`
 * PTY held by a PaneRuntime.
 *
 * Persistence is explicitly weaker than tmux — panes survive a browser
 * disconnect for a TTL, but not a panel restart. The UI must label this.
 */

import { AppError, ErrorCode } from '../servers/errors.js';
import {
  PaneRuntime,
  newPaneId,
  newSessionId,
  newWindowId,
} from '../terminal/pane-runtime.js';
import {
  LABEL_MAX,
  requireDirection,
  requireDisplayName,
  requireGeometryValue,
  requireKnownFields,
} from './validators.js';

export const SSH_ACTIONS = Object.freeze({
  createSession: true,
  renameSession: true,
  closeSession: true,
  createWindow: true,
  renameWindow: true,
  closeWindow: true,
  splitPane: true,
  closePane: true,
  renamePane: true,
  // No multiplexer on the remote side, so these tmux-only actions are absent.
  tmuxLayout: false,
  capturePane: false,
  persistentAfterRestart: false,
});

const MAX_SESSIONS_PER_SERVER = 16;
const MAX_PANES_PER_SERVER = 32;

export class SshProvider {
  /**
   * @param {object} options
   * @param {string} options.serverId
   * @param {(ctx: object) => object} options.spawnPty creates a node-pty for one pane
   */
  constructor({ serverId, spawnPty, shellName = 'shell', now = () => Date.now(), onChange = null, paneOptions = {} }) {
    if (typeof spawnPty !== 'function') {
      throw new Error('SshProvider requires a spawnPty function');
    }
    this.serverId = serverId;
    this.provider = 'ssh';
    this.transport = 'ssh';
    this.persistence = 'process-memory';
    this.actions = SSH_ACTIONS;
    this._spawnPty = spawnPty;
    this._shellName = shellName;
    this._now = now;
    this._onChange = onChange;
    this._paneOptions = paneOptions;
    /** sessionId -> { id, name, createdAt, windows: Map<windowId, window> } */
    this._sessions = new Map();
    /** paneId -> PaneRuntime, flattened for O(1) terminal lookups. */
    this._runtimes = new Map();
  }

  _changed() {
    if (typeof this._onChange === 'function') this._onChange(this.serverId);
  }

  _requireSession(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) throw new AppError(ErrorCode.SESSION_NOT_FOUND, `Session ${sessionId} not found`);
    return session;
  }

  _findWindow(windowId) {
    for (const session of this._sessions.values()) {
      const window = session.windows.get(windowId);
      if (window) return { session, window };
    }
    throw new AppError(ErrorCode.WINDOW_NOT_FOUND, `Window ${windowId} not found`);
  }

  _findPane(paneId) {
    for (const session of this._sessions.values()) {
      for (const window of session.windows.values()) {
        const pane = window.panes.get(paneId);
        if (pane) return { session, window, pane };
      }
    }
    throw new AppError(ErrorCode.PANE_NOT_FOUND, `Pane ${paneId} not found`);
  }

  get paneCount() {
    return this._runtimes.size;
  }

  hasActivePanes() {
    for (const runtime of this._runtimes.values()) {
      if (runtime.alive) return true;
    }
    return false;
  }

  async getTree() {
    const sessions = [];
    for (const session of this._sessions.values()) {
      const windows = [];
      for (const window of session.windows.values()) {
        const panes = [];
        for (const pane of window.panes.values()) {
          const runtime = this._runtimes.get(pane.id);
          panes.push({
            id: pane.id,
            name: pane.label || this._shellName,
            command: pane.label || this._shellName,
            label: pane.label || null,
            active: pane.active,
            geometry: { ...pane.geometry },
            // SSH panes carry lifecycle the UI has to explain to the user.
            runtime: runtime
              ? { attached: runtime.subscribers.size > 0, alive: runtime.alive, detachedAt: runtime.detachedAt }
              : { attached: false, alive: false, detachedAt: null },
          });
        }
        windows.push({
          id: window.id,
          index: window.index,
          name: window.name,
          active: window.active,
          bell: false,
          activity: window.updatedAt,
          splitDirection: window.splitDirection,
          panes,
        });
      }
      sessions.push({
        id: session.id,
        name: session.name,
        active: session.active,
        windowCount: windows.length,
        lastActivity: session.updatedAt,
        windows,
      });
    }
    return sessions;
  }

  async createSession({ name } = {}) {
    if (this._sessions.size >= MAX_SESSIONS_PER_SERVER) {
      throw new AppError(ErrorCode.CONNECTION_LIMIT, `At most ${MAX_SESSIONS_PER_SERVER} SSH sessions per server`);
    }
    const sessionName = requireDisplayName(name, 'name', { fallback: `session-${this._sessions.size + 1}` });
    const id = newSessionId();
    const session = {
      id,
      name: sessionName,
      active: this._sessions.size === 0,
      createdAt: this._now(),
      updatedAt: this._now(),
      windows: new Map(),
      nextWindowIndex: 0,
    };
    this._sessions.set(id, session);

    let window;
    try {
      // A session with no window would be a dead end in the UI.
      window = this._addWindow(session, {});
    } catch (err) {
      // Roll back rather than leaving an empty, unusable session behind.
      this._sessions.delete(id);
      throw err;
    }

    this._changed();
    return { id, name: sessionName, windowId: window.id, paneId: [...window.panes.keys()][0] };
  }

  async renameSession(sessionId, { name }) {
    const session = this._requireSession(sessionId);
    session.name = requireDisplayName(name, 'name');
    session.updatedAt = this._now();
    this._changed();
    return { id: sessionId, name: session.name };
  }

  async closeSession(sessionId) {
    const session = this._requireSession(sessionId);
    for (const window of session.windows.values()) {
      for (const paneId of window.panes.keys()) this._destroyPane(paneId, 'session_closed');
    }
    this._dropSession(session);
    this._changed();
  }

  /** Removes a session and hands "active" to a survivor. */
  _dropSession(session) {
    this._sessions.delete(session.id);
    if (session.active) {
      const next = this._sessions.values().next().value;
      if (next) next.active = true;
    }
  }

  _addWindow(session, { name }) {
    const windowName = requireDisplayName(name, 'name', { fallback: this._shellName });
    const window = {
      id: newWindowId(),
      index: session.nextWindowIndex,
      name: windowName,
      active: session.windows.size === 0,
      updatedAt: this._now(),
      splitDirection: 'vertical',
      panes: new Map(),
    };
    session.windows.set(window.id, window);
    try {
      this._addPane(session, window, {});
    } catch (err) {
      // A window with no pane cannot be attached to; undo it.
      session.windows.delete(window.id);
      throw err;
    }
    session.nextWindowIndex += 1;
    session.updatedAt = this._now();
    return window;
  }

  async createWindow(sessionId, { name } = {}) {
    const session = this._requireSession(sessionId);
    const window = this._addWindow(session, { name });
    this._changed();
    return { id: window.id, name: window.name, paneId: [...window.panes.keys()][0] };
  }

  async renameWindow(windowId, { name }) {
    const { window, session } = this._findWindow(windowId);
    window.name = requireDisplayName(name, 'name');
    window.updatedAt = this._now();
    session.updatedAt = this._now();
    this._changed();
    return { id: windowId, name: window.name };
  }

  async closeWindow(windowId) {
    const { session, window } = this._findWindow(windowId);
    for (const paneId of window.panes.keys()) this._destroyPane(paneId, 'window_closed');
    session.windows.delete(windowId);
    if (session.windows.size === 0) {
      // Same rule as closePane: an empty session is not a thing users can use.
      this._dropSession(session);
    } else {
      if (window.active) {
        const next = session.windows.values().next().value;
        if (next) next.active = true;
      }
      session.updatedAt = this._now();
    }
    this._changed();
  }

  _addPane(session, window, { label = null }) {
    if (this._runtimes.size >= MAX_PANES_PER_SERVER) {
      throw new AppError(ErrorCode.CONNECTION_LIMIT, `At most ${MAX_PANES_PER_SERVER} SSH panes per server`);
    }
    const paneId = newPaneId();
    const pane = {
      id: paneId,
      label,
      active: window.panes.size === 0,
      // Layout is ours to manage; nothing is sent to the remote host.
      geometry: { x: 0, y: 0, width: 100, height: 100 },
    };
    window.panes.set(paneId, pane);

    let runtime;
    try {
      runtime = new PaneRuntime({
        serverId: this.serverId,
        sessionId: session.id,
        windowId: window.id,
        paneId,
        now: this._now,
        spawn: ({ cols, rows }) => this._spawnPty({
          serverId: this.serverId,
          sessionId: session.id,
          windowId: window.id,
          paneId,
          cols,
          rows,
        }),
        onExit: () => {
          // A shell that ended on its own must leave the tree at once, or the
          // UI keeps offering a window that can no longer be attached to.
          // An explicit close already pruned it, so notify only if we did work.
          if (this._prunePane(paneId, 'remote_shell_exit')) this._changed();
        },
        ...this._paneOptions,
      });
    } catch (err) {
      window.panes.delete(paneId);
      this._relayout(window);
      throw err;
    }

    this._runtimes.set(paneId, runtime);
    this._relayout(window);
    return pane;
  }

  async splitPane(windowId, { direction } = {}) {
    const { session, window } = this._findWindow(windowId);
    const splitDirection = requireDirection(direction);
    const previousDirection = window.splitDirection;
    window.splitDirection = splitDirection;
    let pane;
    try {
      pane = this._addPane(session, window, {});
    } catch (err) {
      window.splitDirection = previousDirection;
      throw err;
    }
    window.updatedAt = this._now();
    this._changed();
    return { id: pane.id };
  }

  async updatePane(paneId, patch = {}) {
    const { window, pane } = this._findPane(paneId);
    requireKnownFields(patch, ['label', 'active', 'geometry'], 'pane');

    if (patch.label !== undefined) {
      pane.label = patch.label === null || patch.label === ''
        ? null
        : requireDisplayName(patch.label, 'label', { max: LABEL_MAX });
    }
    if (patch.active !== undefined) {
      if (typeof patch.active !== 'boolean') {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 'active must be a boolean', { details: { field: 'active' } });
      }
      if (patch.active) {
        for (const other of window.panes.values()) other.active = other.id === paneId;
      }
    }
    if (patch.geometry !== undefined) {
      if (!patch.geometry || typeof patch.geometry !== 'object' || Array.isArray(patch.geometry)) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 'geometry must be an object', {
          details: { field: 'geometry' },
        });
      }
      requireKnownFields(patch.geometry, ['x', 'y', 'width', 'height'], 'geometry');
      const next = { ...pane.geometry };
      for (const key of ['x', 'y', 'width', 'height']) {
        if (patch.geometry[key] !== undefined) {
          next[key] = requireGeometryValue(patch.geometry[key], `geometry.${key}`);
        }
      }
      pane.geometry = next;
    }
    this._changed();
    return { id: paneId };
  }

  /**
   * Removes one pane and prunes whatever became empty, so the tree never shows
   * a window that cannot be attached to. Returns false when the pane was
   * already gone, which lets callers skip a duplicate change notification.
   */
  _prunePane(paneId, reason) {
    let located;
    try {
      located = this._findPane(paneId);
    } catch {
      // Already removed; still make sure no runtime is left behind.
      const orphan = this._runtimes.get(paneId);
      if (orphan) {
        this._destroyPane(paneId, reason);
        return true;
      }
      return false;
    }

    const { session, window } = located;
    this._destroyPane(paneId, reason);
    window.panes.delete(paneId);

    if (window.panes.size === 0) {
      session.windows.delete(window.id);
      if (session.windows.size === 0) {
        this._dropSession(session);
      } else if (window.active) {
        const next = session.windows.values().next().value;
        if (next) next.active = true;
      }
    } else {
      if (![...window.panes.values()].some((pane) => pane.active)) {
        window.panes.values().next().value.active = true;
      }
      this._relayout(window);
    }
    session.updatedAt = this._now();
    return true;
  }

  async closePane(paneId) {
    this._findPane(paneId);
    this._prunePane(paneId, 'closed');
    this._changed();
  }

  /**
   * Percentage grid rendered by the browser; the remote host never learns about
   * it. A horizontal split puts panes side by side, a vertical split stacks them,
   * matching what `tmux split-window -h` / `-v` produce.
   */
  _relayout(window) {
    const panes = [...window.panes.values()];
    if (panes.length === 0) return;
    const share = Math.floor(100 / panes.length);
    const sideBySide = window.splitDirection === 'horizontal';
    panes.forEach((pane, index) => {
      pane.geometry = sideBySide
        ? { x: share * index, y: 0, width: share, height: 100 }
        : { x: 0, y: share * index, width: 100, height: share };
    });
  }

  _destroyPane(paneId, reason) {
    const runtime = this._runtimes.get(paneId);
    if (runtime) runtime.destroy(reason);
    this._runtimes.delete(paneId);
  }

  getRuntime(paneId) {
    return this._runtimes.get(paneId) || null;
  }

  async resolvePane(paneId) {
    const { session, window, pane } = this._findPane(paneId);
    return {
      serverId: this.serverId,
      provider: 'ssh',
      transport: 'ssh',
      persistence: 'process-memory',
      sessionId: session.id,
      sessionName: session.name,
      windowId: window.id,
      windowIndex: window.index,
      paneId: pane.id,
    };
  }

  /** Reaps panes whose detached TTL has elapsed. Returns the ids removed. */
  reap(now = this._now()) {
    const removed = [];
    for (const [paneId, runtime] of [...this._runtimes.entries()]) {
      if (!runtime.isExpired(now) && !(runtime.exited && runtime.subscribers.size === 0)) continue;
      this._prunePane(paneId, 'ttl_expired');
      removed.push(paneId);
    }
    if (removed.length > 0) this._changed();
    return removed;
  }

  /** Panel shutdown: nothing here survives a restart, so end every PTY. */
  destroyAll(reason = 'server_shutdown') {
    for (const paneId of [...this._runtimes.keys()]) this._destroyPane(paneId, reason);
    this._sessions.clear();
  }
}
