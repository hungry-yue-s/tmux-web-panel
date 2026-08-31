(function (global) {
  var LOCAL = 'local';

  /**
   * Server-scoped addressing for the terminal renderer.
   *
   * The legacy renderer addresses panes through /api/sessions/... and
   * /ws/terminal/:paneId, which always mean the panel's own machine. Sending a
   * remote server's action down those paths would read and mutate the local
   * host instead — so every call site funnels through here, and only the local
   * server keeps the legacy paths.
   */
  var TerminalTarget = {
    serverId: LOCAL,
    provider: 'tmux',
    sessionId: null,
    windowId: null,

    set: function (target) {
      var next = target || {};
      this.serverId = next.serverId || LOCAL;
      this.provider = next.provider || 'tmux';
      this.sessionId = next.sessionId || null;
      this.windowId = next.windowId || null;
      return this;
    },

    reset: function () {
      return this.set({ serverId: LOCAL, provider: 'tmux' });
    },

    isRemote: function () {
      return this.serverId !== LOCAL;
    },

    /** Header that lets the backend reject a stale provider assumption. */
    headers: function () {
      return { 'X-Workspace-Provider': this.provider };
    },

    _serverBase: function () {
      return '/api/servers/' + encodeURIComponent(this.serverId);
    },

    /** Pane list for the current window. */
    panesPath: function (sessionName, windowIndex) {
      if (!this.windowId) {
        return '/api/sessions/' + encodeURIComponent(sessionName)
          + '/windows/' + encodeURIComponent(windowIndex) + '/panes';
      }
      return this._serverBase() + '/windows/' + encodeURIComponent(this.windowId) + '/panes';
    },

    /**
     * New-shell routes use a stable window id on local and remote servers. The
     * legacy name/index endpoint remains only for the hidden compatibility UI.
     */
    listPanes: function (sessionName, windowIndex) {
      if (!this.windowId) {
        if (this.isRemote()) return Promise.reject(new Error('No stable window id'));
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
        if (this.isRemote()) return Promise.reject(new Error('No window id for a remote split'));
        return global.api.post(this.panesPath(sessionName, windowIndex), {
          paneId: paneId,
          direction: direction,
        });
      }
      return global.Api.request(
        'POST',
        this._serverBase() + '/windows/' + encodeURIComponent(this.windowId) + '/panes',
        // paneId matters for tmux: it splits the pane in view, not just the active one.
        { direction: direction, paneId: paneId || undefined },
        { headers: this.headers() },
      );
    },

    setPaneLabel: function (paneId, label) {
      if (!this.windowId && !this.isRemote()) {
        return global.api.put('/api/panes/' + encodeURIComponent(paneId) + '/label', { label: label });
      }
      return global.Api.request(
        'PATCH',
        this._serverBase() + '/panes/' + encodeURIComponent(paneId),
        { label: label },
        { headers: this.headers() },
      );
    },

    closePane: function (sessionName, windowIndex, paneId) {
      // Callers distinguish "cancelled" from "closed" by the resolved value, and
      // a server-scoped delete answers 204 with an empty body.
      if (!this.windowId && !this.isRemote()) {
        return global.api
          .delete(this.panesPath(sessionName, windowIndex) + '/' + encodeURIComponent(paneId))
          .then(function () { return { ok: true }; });
      }
      return global.Api.request(
        'DELETE',
        this._serverBase() + '/panes/' + encodeURIComponent(paneId),
        undefined,
        { headers: this.headers() },
      ).then(function () { return { ok: true }; });
    },

    /**
     * Terminal socket address. The server-scoped form is required for a remote
     * host; the single-segment legacy form still means the local server.
     */
    wsUrl: function (paneId, nozoom, cols, rows) {
      var proto = global.location.protocol === 'https:' ? 'wss:' : 'ws:';
      var path = this.isRemote()
        ? '/ws/terminal/' + encodeURIComponent(this.serverId) + '/' + encodeURIComponent(paneId)
        : '/ws/terminal/' + encodeURIComponent(paneId);
      var url = proto + '//' + global.location.host + path;
      var query = [];
      if (nozoom) query.push('nozoom=1');
      if (cols) query.push('cols=' + encodeURIComponent(cols));
      if (rows) query.push('rows=' + encodeURIComponent(rows));
      var tokenParam = global.Auth && global.Auth.wsTokenParam ? global.Auth.wsTokenParam() : '';
      if (tokenParam) query.push(tokenParam);
      if (query.length > 0) url += '?' + query.join('&');
      return url;
    },

    /** tmux-only capabilities are hidden rather than failing at click time. */
    supportsTmuxActions: function () {
      return this.provider === 'tmux';
    },
  };

  global.TerminalTarget = TerminalTarget;
})(typeof window !== 'undefined' ? window : globalThis);
