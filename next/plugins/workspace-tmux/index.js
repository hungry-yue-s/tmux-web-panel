// Provides `ctx.workspace` from this machine's tmux.
//
// The workspace seam (docs/architecture.md): whoever provides `workspace`
// answers read() with the same tree. Consumers (the API, the views, later the
// terminal gateway) never call tmux themselves, so a different provider — a
// host reached over plain SSH, a test double — swaps in by changing one
// profile entry.

import { Service } from 'cordis';
import { NO_SERVER_RE, parseInstance, parseTree, SNAPSHOT_COMMANDS } from '../tmux/format.js';

export const name = 'workspace-tmux';

function paneView(pane) {
  return {
    id: pane.id,
    name: pane.label || pane.command || 'shell',
    command: pane.command,
    label: pane.label || null,
    active: pane.active,
    geometry: { x: pane.x, y: pane.y, width: pane.width, height: pane.height },
  };
}

function windowView(window) {
  const view = {
    id: window.id,
    index: window.index,
    name: window.name,
    active: window.active,
    bell: window.bell,
    activity: window.activity,
    panes: window.panes.map(paneView),
  };
  // tmux has no window without a pane, so none listed means the read missed it.
  if (view.panes.length === 0) view.panesComplete = false;
  return view;
}

function sessionView(session) {
  return {
    id: session.id || session.name,
    name: session.name,
    active: session.attached,
    windowCount: Number.isFinite(session.windows) ? session.windows : 0,
    lastAttached: session.lastAttached,
    windows: session.windowList.map(windowView),
  };
}

export default class TmuxWorkspace extends Service {
  static inject = ['tmux'];

  constructor(ctx) {
    super(ctx, 'workspace');
    this.provider = 'tmux';
    this._reading = null;
  }

  /**
   * The whole tree and the tmux server instance it came from, read in one tmux
   * call so a server restart cannot fall between the two. Callers at the same
   * moment share one read.
   *
   * `complete` is false when part of the tree is missing (a window without
   * panes): anything that garbage-collects per-window state must not act on
   * an incomplete read.
   *
   * @returns {Promise<{ provider: string, instanceId: string | null, complete: boolean, sessions: object[] }>}
   */
  read() {
    if (this._reading) return this._reading;
    const reading = this._read().finally(() => {
      if (this._reading === reading) this._reading = null;
    });
    this._reading = reading;
    return reading;
  }

  async _read() {
    let stdout;
    try {
      stdout = await this.ctx.tmux.exec(SNAPSHOT_COMMANDS);
    } catch (error) {
      // No server is not an error: the panel never starts one (root CLAUDE.md).
      if (NO_SERVER_RE.test(error?.stderr || '')) {
        return { provider: this.provider, instanceId: null, complete: true, sessions: [] };
      }
      throw error;
    }
    const instanceId = parseInstance(stdout);
    const sessions = parseTree(stdout).map(sessionView);
    const complete = instanceId !== null
      && sessions.every((session) => session.id && session.windows.every((window) => window.panesComplete !== false));
    return { provider: this.provider, instanceId, complete, sessions };
  }
}
