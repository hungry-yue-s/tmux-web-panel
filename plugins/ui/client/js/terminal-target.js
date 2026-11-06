(function (global) {
  var LOCAL = 'local';

  /**
   * The server and window the terminal renderer is showing.
   *
   * Every machine runs the same panel, so a pane is addressed by the same path
   * everywhere; only the /n/:serverId prefix (Api.nodeUrl) says which machine.
   * Call sites funnel through here so a remote window can never act on the
   * panel's own host. Switching servers fires `terminal-target-server`, which
   * the status socket uses to follow the server in view.
   */
  var TerminalTarget = {
    serverId: LOCAL,
    provider: 'tmux',
    sessionId: null,
    windowId: null,

    set: function (target) {
      var next = target || {};
      var previous = this.serverId;
      this.serverId = next.serverId || LOCAL;
      this.provider = next.provider || 'tmux';
      this.sessionId = next.sessionId || null;
      this.windowId = next.windowId || null;
      if (previous !== this.serverId && typeof global.dispatchEvent === 'function' && typeof global.CustomEvent === 'function') {
        global.dispatchEvent(new global.CustomEvent('terminal-target-server', { detail: { serverId: this.serverId } }));
      }
      return this;
    },

    reset: function () {
      return this.set({ serverId: LOCAL, provider: 'tmux' });
    },

    isRemote: function () {
      return this.serverId !== LOCAL;
    },

    url: function (path) {
      return global.Api.nodeUrl(this.serverId, path);
    },

    /** The pane list of the window in view (workspace API, by its stable id). */
    panesPath: function () {
      return global.Api.workspaceUrl(this.serverId, '/windows/' + encodeURIComponent(this.windowId || '') + '/panes');
    },

    /** Resolves once a window is in view; before that there is nothing to act on. */
    _inWindow: function () {
      return this.windowId ? Promise.resolve() : Promise.reject(new Error('这个窗口还没打开好，稍后再试'));
    },

    // The session name and window index arguments are those of the callers'
    // older signature; the window in view is this target's windowId.
    listPanes: function () {
      var self = this;
      return this._inWindow()
        .then(function () { return global.Api.get(self.panesPath()); })
        .then(function (result) { return (result && result.panes) || []; });
    },

    splitPane: function (_sessionName, _windowIndex, paneId, direction) {
      var self = this;
      // paneId matters for tmux: it splits the pane in view, not just the active one.
      return this._inWindow().then(function () {
        return global.Api.post(self.panesPath(), { direction: direction, paneId: paneId || undefined });
      });
    },

    setPaneLabel: function (paneId, label) {
      return global.Api.patch(global.Api.workspaceUrl(this.serverId, '/panes/' + encodeURIComponent(paneId)), { label: label });
    },

    closePane: function (_sessionName, _windowIndex, paneId) {
      // Callers distinguish "cancelled" from "closed" by the resolved value, and
      // the workspace delete answers 204 with an empty body.
      return global.Api.del(global.Api.workspaceUrl(this.serverId, '/panes/' + encodeURIComponent(paneId)))
        .then(function () { return { ok: true }; });
    },

    /** Terminal socket address on the machine that owns the pane. */
    wsUrl: function (paneId, nozoom, cols, rows) {
      var proto = global.location.protocol === 'https:' ? 'wss:' : 'ws:';
      var url = proto + '//' + global.location.host + this.url('/ws/terminal/' + encodeURIComponent(paneId));
      var query = [];
      if (nozoom) query.push('nozoom=1');
      if (cols) query.push('cols=' + encodeURIComponent(cols));
      if (rows) query.push('rows=' + encodeURIComponent(rows));
      var tokenParam = global.Auth && global.Auth.wsTokenParam ? global.Auth.wsTokenParam() : '';
      if (tokenParam) query.push(tokenParam);
      if (query.length > 0) url += '?' + query.join('&');
      return url;
    },

    /** tmux-native actions (split view, layouts) need tmux behind the pane. */
    supportsTmuxActions: function () {
      return this.provider === 'tmux';
    },

    /**
     * False for a basic-mode server: reachable over SSH without the panel, so
     * files, uploads, metrics and agents are not available there.
     */
    hasNode: function () {
      if (!this.isRemote()) return true;
      var shell = global.AppShell;
      var health = shell && typeof shell.health === 'function' ? shell.health(this.serverId) : null;
      return !(health && health.node && health.node.installed === false);
    },
  };

  global.TerminalTarget = TerminalTarget;
})(typeof window !== 'undefined' ? window : globalThis);
