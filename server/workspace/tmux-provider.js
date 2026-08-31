/**
 * tmux workspace provider.
 *
 * Projects real tmux state onto the unified Session/Window/Pane model. Works
 * identically for the local host and a remote host, because the only difference
 * is which executor the tmux API was built with.
 *
 * Identity rules: sessions use #{session_id} ($N), windows #{window_id} (@N) and
 * panes #{pane_id} (%N). These are stable across renames; index is display only.
 * None of them are globally unique, so callers must always pair them with a
 * serverId.
 */

import { AppError, ErrorCode } from '../servers/errors.js';
import {
  validateSessionId,
  validateWindowId,
  validatePaneId,
  validatePaneLabel,
  validateWindowName,
  validateSessionName,
} from '../tmux.js';
import { requireDirection, requireKnownFields } from './validators.js';

export const TMUX_ACTIONS = Object.freeze({
  createSession: true,
  renameSession: true,
  closeSession: true,
  createWindow: true,
  renameWindow: true,
  closeWindow: true,
  splitPane: true,
  closePane: true,
  renamePane: true,
  tmuxLayout: true,
  capturePane: true,
  persistentAfterRestart: true,
});

/**
 * Accepts a stable session id ($N) or a session name. Older tmux builds do not
 * report #{session_id}, and getTree falls back to the name for those; accepting
 * only $N here would make such sessions visible but impossible to act on.
 */
function requireSessionTarget(sessionId) {
  if (validateSessionId(sessionId) || validateSessionName(sessionId)) return sessionId;
  throw new AppError(ErrorCode.VALIDATION_ERROR, `Invalid session id: ${sessionId}`, {
    details: { field: 'sessionId' },
  });
}

function requireWindowId(windowId) {
  if (!validateWindowId(windowId)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, `Invalid window id: ${windowId}`, {
      details: { field: 'windowId' },
    });
  }
  return windowId;
}

function requirePaneId(paneId) {
  if (!validatePaneId(paneId)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, `Invalid pane id: ${paneId}`, {
      details: { field: 'paneId' },
    });
  }
  return paneId;
}

function requireName(name, field, validator) {
  if (!validator(name)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, `Invalid ${field}: ${name}`, { details: { field } });
  }
  return name;
}

export class TmuxProvider {
  /**
   * @param {object} options
   * @param {string} options.serverId
   * @param {ReturnType<import('../tmux.js').createTmuxApi>} options.tmux
   * @param {'local'|'ssh'} options.transport
   */
  constructor({ serverId, tmux, transport }) {
    this.serverId = serverId;
    this.tmux = tmux;
    this.transport = transport;
    this.provider = 'tmux';
    this.persistence = 'tmux';
    this.actions = TMUX_ACTIONS;
  }

  /**
   * Reads the whole tree. A session whose windows cannot be listed is reported
   * with an empty window list rather than failing the entire workspace: one
   * broken session must not blank the sidebar.
   */
  async getTree() {
    const sessions = await this.tmux.listSessions();
    if (this.transport === 'local') {
      return Promise.all(sessions.map((session) => this._sessionFor(session, true)));
    }
    const out = [];
    for (const session of sessions) out.push(await this._sessionFor(session, false));
    return out;
  }

  async _sessionFor(session, parallelPanes) {
    // Sessions from an older tmux without session_id cannot be addressed
    // stably; fall back to the name so they remain visible and usable.
    const sessionId = session.id || session.name;
    const entry = {
      id: sessionId,
      name: session.name,
      active: Boolean(session.attached),
      windowCount: Number.isFinite(session.windows) ? session.windows : 0,
      lastActivity: session.lastActivity || null,
      windows: [],
    };
    try {
      const windows = await this.tmux.listWindows(sessionId);
      const render = async (window) => ({
        id: window.id,
        index: window.index,
        name: window.name,
        active: window.active,
        bell: window.bell,
        activity: window.activity,
        panes: await this._panesFor(window),
      });
      if (parallelPanes) entry.windows = await Promise.all(windows.map(render));
      else for (const window of windows) entry.windows.push(await render(window));
    } catch {
      // Keep the session visible with no windows.
    }
    return entry;
  }

  async _panesFor(window) {
    try {
      const panes = await this.tmux.listPanesByWindowId(window.id);
      return panes.map((pane) => ({
        id: pane.id,
        name: pane.label || pane.command || 'shell',
        command: pane.command,
        label: pane.label || null,
        active: pane.active,
        geometry: { x: pane.x, y: pane.y, width: pane.width, height: pane.height },
      }));
    } catch {
      return [];
    }
  }

  /** One stable window lookup for terminal mounts; avoids a full tree scan. */
  async getWindowPanes(windowId) {
    requireWindowId(windowId);
    const panes = await this._mapMissing(
      () => this.tmux.listPanesByWindowId(windowId),
      ErrorCode.WINDOW_NOT_FOUND,
    );
    return panes.map((pane) => ({
      id: pane.id,
      name: pane.label || pane.command || 'shell',
      command: pane.command,
      label: pane.label || null,
      active: pane.active,
      geometry: { x: pane.x, y: pane.y, width: pane.width, height: pane.height },
    }));
  }

  async createSession({ name }) {
    requireName(name, 'name', validateSessionName);
    const id = await this.tmux.createSessionReturningId(name);
    return { id, name };
  }

  async renameSession(sessionId, { name }) {
    requireSessionTarget(sessionId);
    requireName(name, 'name', validateSessionName);
    await this._mapMissing(() => this.tmux.renameSession(sessionId, name), ErrorCode.SESSION_NOT_FOUND);
    return { id: sessionId, name };
  }

  async closeSession(sessionId) {
    requireSessionTarget(sessionId);
    await this._mapMissing(() => this.tmux.killSession(sessionId), ErrorCode.SESSION_NOT_FOUND);
  }

  async createWindow(sessionId, { name } = {}) {
    requireSessionTarget(sessionId);
    if (name !== undefined && name !== null && name !== '') requireName(name, 'name', validateWindowName);
    const id = await this._mapMissing(
      () => this.tmux.createWindowReturningId(sessionId, name || undefined),
      ErrorCode.SESSION_NOT_FOUND,
    );
    return { id, name: name || null };
  }

  async renameWindow(windowId, { name }) {
    requireWindowId(windowId);
    requireName(name, 'name', validateWindowName);
    await this._mapMissing(() => this.tmux.renameWindowById(windowId, name), ErrorCode.WINDOW_NOT_FOUND);
    return { id: windowId, name };
  }

  async closeWindow(windowId) {
    requireWindowId(windowId);
    await this._mapMissing(() => this.tmux.killWindowById(windowId), ErrorCode.WINDOW_NOT_FOUND);
  }

  /** Splits an explicit pane, or the window's active pane when none is given. */
  async splitPane(windowId, { paneId = null, direction } = {}) {
    requireWindowId(windowId);
    const splitDirection = requireDirection(direction);
    let target = paneId;
    if (target) {
      requirePaneId(target);
    } else {
      const panes = await this._mapMissing(
        () => this.tmux.listPanesByWindowId(windowId),
        ErrorCode.WINDOW_NOT_FOUND,
      );
      const active = panes.find((pane) => pane.active) || panes[0];
      if (!active) throw new AppError(ErrorCode.WINDOW_NOT_FOUND, `Window ${windowId} has no panes`);
      target = active.id;
    }
    const id = await this._mapMissing(
      () => this.tmux.splitPaneReturningId(target, splitDirection),
      ErrorCode.PANE_NOT_FOUND,
    );
    return { id };
  }

  async updatePane(paneId, patch = {}) {
    requirePaneId(paneId);
    requireKnownFields(patch, ['label', 'active'], 'pane');
    if (patch.label !== undefined) {
      // Validate here so a bad label is a 400, not an opaque tmux failure.
      const clearing = patch.label === null || (typeof patch.label === 'string' && patch.label.trim() === '');
      if (!clearing && !validatePaneLabel(patch.label)) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid pane label', { details: { field: 'label' } });
      }
      await this._mapMissing(() => this.tmux.setPaneLabel(paneId, patch.label), ErrorCode.PANE_NOT_FOUND);
    }
    if (patch.active !== undefined) {
      if (typeof patch.active !== 'boolean') {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 'active must be a boolean', { details: { field: 'active' } });
      }
      if (patch.active) {
        await this._mapMissing(() => this.tmux.selectPane(paneId), ErrorCode.PANE_NOT_FOUND);
      }
    }
    return { id: paneId };
  }

  async closePane(paneId) {
    requirePaneId(paneId);
    await this._mapMissing(() => this.tmux.killPane(paneId), ErrorCode.PANE_NOT_FOUND);
  }

  /**
   * Confirms a pane exists and returns what the terminal layer needs to attach.
   * The WebSocket layer must never take a pane id on trust from the client.
   */
  async resolvePane(paneId) {
    requirePaneId(paneId);
    const address = await this._mapMissing(
      () => this.tmux.getPaneAddress(paneId),
      ErrorCode.PANE_NOT_FOUND,
    );
    if (!address || address.paneId !== paneId) {
      throw new AppError(ErrorCode.PANE_NOT_FOUND, `Pane ${paneId} not found on ${this.serverId}`);
    }
    return {
      serverId: this.serverId,
      provider: 'tmux',
      transport: this.transport,
      persistence: 'tmux',
      ...address,
    };
  }

  /** Turns "can't find" stderr from tmux into the right structured error. */
  async _mapMissing(fn, code) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AppError) throw err;
      const stderr = String((err && err.stderr) || (err && err.message) || '');
      if (/can'?t find (?:session|window|pane)|no such|session not found|unknown pane/i.test(stderr)) {
        throw new AppError(code, 'The target no longer exists; refresh the workspace');
      }
      if (/no server running/i.test(stderr)) {
        throw new AppError(ErrorCode.WORKSPACE_UNAVAILABLE, 'No tmux server is running');
      }
      throw new AppError(ErrorCode.INTERNAL, 'tmux command failed');
    }
  }
}
