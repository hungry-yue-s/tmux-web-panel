/**
 * WorkspaceService: this machine's tmux tree and the only thing the workspace
 * API, the terminal gateway and the tmux-agent plugin talk to.
 *
 * It is local by construction. Another machine's workspace is that machine's
 * own WorkspaceService, reached through the hub's /n/:serverId relay.
 *
 * Every mutation bumps a revision and reports it, so the status socket can
 * tell open pages to refetch instead of polling.
 */

import { TmuxProvider } from './tmux-provider.js';
import { AppError, ErrorCode } from '../servers/errors.js';

export class WorkspaceService {
  /**
   * @param {object} deps
   * @param {ReturnType<import('../tmux.js').createTmuxApi>} deps.tmux
   * @param {(revision: number) => void} [deps.onChange]
   */
  constructor({ tmux, onChange = null }) {
    if (!tmux) throw new Error('WorkspaceService requires a tmux API');
    this.provider = new TmuxProvider({ tmux });
    this._onChange = onChange;
    this._revision = 0;
    this._reading = null;
  }

  get revision() {
    return this._revision;
  }

  async _mutate(fn) {
    const result = await fn();
    this._revision += 1;
    // A read already under way may have missed this; whoever asks next gets a new one.
    this._reading = null;
    if (typeof this._onChange === 'function') this._onChange(this._revision);
    return result;
  }

  /** Full tree. `actions` is what the UI renders from. Callers at the same moment share one read. */
  getWorkspace() {
    if (this._reading) return this._reading;
    const reading = this._readWorkspace().finally(() => {
      if (this._reading === reading) this._reading = null;
    });
    this._reading = reading;
    return reading;
  }

  async _readWorkspace() {
    const { instanceId, sessions } = await this.provider.readSnapshot() || await this._readPieces();
    return {
      provider: this.provider.provider,
      persistence: this.provider.persistence,
      instanceId,
      complete: sessions.every((session) => session.windowsComplete !== false
        && session.windows.length === session.windowCount
        && session.windows.every((window) => window.panesComplete !== false)),
      revision: this._revision,
      actions: this.provider.actions,
      sessions,
    };
  }

  async _readPieces() {
    const instanceId = await this.provider.tmux.getServerInstance();
    const sessions = await this.provider.getTree();
    // A restart during the read must not stamp the old tree with a new identity.
    if (instanceId !== await this.provider.tmux.getServerInstance()) {
      throw new AppError(ErrorCode.WORKSPACE_UNAVAILABLE, 'tmux restarted while reading the workspace; retry');
    }
    return { instanceId, sessions };
  }

  /** One window by stable id, so opening it never walks the whole tree. */
  async getWindowPanes(windowId) {
    return { revision: this._revision, panes: await this.provider.getWindowPanes(windowId) };
  }

  createSession(body = {}) { return this._mutate(() => this.provider.createSession(body)); }

  renameSession(sessionId, body = {}) { return this._mutate(() => this.provider.renameSession(sessionId, body)); }

  async closeSession(sessionId) { await this._mutate(() => this.provider.closeSession(sessionId)); }

  createWindow(sessionId, body = {}) { return this._mutate(() => this.provider.createWindow(sessionId, body)); }

  renameWindow(windowId, body = {}) { return this._mutate(() => this.provider.renameWindow(windowId, body)); }

  async closeWindow(windowId) { await this._mutate(() => this.provider.closeWindow(windowId)); }

  splitPane(windowId, body = {}) { return this._mutate(() => this.provider.splitPane(windowId, body)); }

  updatePane(paneId, body = {}) { return this._mutate(() => this.provider.updatePane(paneId, body)); }

  async closePane(paneId) { await this._mutate(() => this.provider.closePane(paneId)); }

  /**
   * Verifies a pane really exists before the terminal layer attaches. The
   * WebSocket layer must never trust a client-supplied pane id.
   */
  resolvePane(paneId) {
    return this.provider.resolvePane(paneId);
  }
}
