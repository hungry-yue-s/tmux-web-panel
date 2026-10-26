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

    _legacyPanes: function (sessionName, windowIndex) {
      return '/api/sessions/' + encodeURIComponent(sessionName)
        + '/windows/' + encodeURIComponent(windowIndex) + '/panes';
    },

    /** Pane list for the current window: stable window id when known. */
    panesPath: function (sessionName, windowIndex) {
      if (!this.windowId) return this.url(this._legacyPanes(sessionName, windowIndex));
      return global.Api.workspaceUrl(this.serverId, '/windows/' + encodeURIComponent(this.windowId) + '/panes');
    },

    listPanes: function (sessionName, windowIndex) {
      if (!this.windowId) {
        return global.api.get(this.panesPath(sessionName, windowIndex)).then(function (result) {
          return (result && result.data) || [];
        });
      }
      return global.Api.get(this.panesPath(sessionName, windowIndex)).then(function (result) {
        return (result && result.panes) || [];
      });
    },

    splitPane: function (sessionName, windowIndex, paneId, direction) {
      if (!this.windowId) {
        return global.api.post(this.panesPath(sessionName, windowIndex), {
          paneId: paneId,
          direction: direction,
        });
      }
      // paneId matters for tmux: it splits the pane in view, not just the active one.
      return global.Api.post(this.panesPath(sessionName, windowIndex), {
        direction: direction,
        paneId: paneId || undefined,
      });
    },

    setPaneLabel: function (paneId, label) {
      if (!this.windowId) {
        return global.api.put(this.url('/api/panes/' + encodeURIComponent(paneId) + '/label'), { label: label });
      }
      return global.Api.patch(global.Api.workspaceUrl(this.serverId, '/panes/' + encodeURIComponent(paneId)), { label: label });
    },

    closePane: function (sessionName, windowIndex, paneId) {
      // Callers distinguish "cancelled" from "closed" by the resolved value, and
      // the workspace delete answers 204 with an empty body.
      if (!this.windowId) {
        return global.api
          .delete(this.panesPath(sessionName, windowIndex) + '/' + encodeURIComponent(paneId))
          .then(function () { return { ok: true }; });
      }
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

    /** Every server runs tmux behind its panel. */
    supportsTmuxActions: function () {
      return this.provider === 'tmux';
    },
  };

  global.TerminalTarget = TerminalTarget;
})(typeof window !== 'undefined' ? window : globalThis);
