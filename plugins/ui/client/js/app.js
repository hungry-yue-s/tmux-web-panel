/* global Terminal, FitAddon, Auth, Theme */

// === Modal Dialog ===

/**
 * Show a styled prompt dialog.
 * @param {object} opts
 * @param {string} opts.title - Dialog title
 * @param {string} [opts.placeholder] - Input placeholder
 * @param {string} [opts.value] - Initial input value
 * @param {string} [opts.confirmText] - Confirm button text (default '确定')
 * @param {string} [opts.cancelText] - Cancel button text (default '取消')
 * @returns {Promise<string|null>} Resolved with input value, or null if cancelled
 */
function showPrompt(opts) {
  return new Promise(function (resolve) {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    var box = document.createElement('div');
    box.className = 'modal-box';

    var titleEl = document.createElement('div');
    titleEl.className = 'modal-title';
    titleEl.textContent = opts.title || '';
    box.appendChild(titleEl);

    var input = document.createElement('input');
    input.className = 'modal-input';
    input.type = opts.type || 'text';
    input.placeholder = opts.placeholder || '';
    input.value = opts.value || '';
    box.appendChild(input);

    var actions = document.createElement('div');
    actions.className = 'modal-actions';

    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'modal-btn modal-cancel';
    cancelBtn.textContent = opts.cancelText || '取消';
    actions.appendChild(cancelBtn);

    var confirmBtn = document.createElement('button');
    confirmBtn.className = 'modal-btn modal-btn-primary modal-confirm';
    confirmBtn.textContent = opts.confirmText || '确定';
    actions.appendChild(confirmBtn);

    box.appendChild(actions);
    overlay.appendChild(box);

    function close(val) {
      overlay.remove();
      resolve(val);
    }

    confirmBtn.addEventListener('click', function () { close(input.value); });
    cancelBtn.addEventListener('click', function () { close(null); });
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close(null);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') close(input.value);
      if (e.key === 'Escape') close(null);
    });

    document.body.appendChild(overlay);
    input.focus();
    input.select();
  });
}

/**
 * Show a styled confirm dialog.
 * @param {object} opts
 * @param {string} opts.title - Dialog title
 * @param {string} [opts.message] - Dialog message
 * @param {string} [opts.confirmText] - Confirm button text (default '确定')
 * @param {string} [opts.cancelText] - Cancel button text (default '取消')
 * @param {boolean} [opts.danger] - Use danger style for confirm button
 * @returns {Promise<boolean>}
 */
function showConfirm(opts) {
  return new Promise(function (resolve) {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    var box = document.createElement('div');
    box.className = 'modal-box';

    var titleEl = document.createElement('div');
    titleEl.className = 'modal-title';
    titleEl.textContent = opts.title || '';
    box.appendChild(titleEl);

    if (opts.message) {
      var msgEl = document.createElement('div');
      msgEl.className = 'modal-message';
      msgEl.textContent = opts.message;
      box.appendChild(msgEl);
    }

    var actions = document.createElement('div');
    actions.className = 'modal-actions';

    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'modal-btn modal-cancel';
    cancelBtn.textContent = opts.cancelText || '取消';
    actions.appendChild(cancelBtn);

    var confirmBtn = document.createElement('button');
    confirmBtn.className = 'modal-btn modal-confirm ' + (opts.danger ? 'modal-btn-danger' : 'modal-btn-primary');
    confirmBtn.textContent = opts.confirmText || '确定';
    actions.appendChild(confirmBtn);

    box.appendChild(actions);
    overlay.appendChild(box);

    function close(val) {
      overlay.remove();
      resolve(val);
    }

    confirmBtn.addEventListener('click', function () { close(true); });
    cancelBtn.addEventListener('click', function () { close(false); });
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close(false);
    });
    document.addEventListener('keydown', function handler(e) {
      if (e.key === 'Enter') { document.removeEventListener('keydown', handler); close(true); }
      if (e.key === 'Escape') { document.removeEventListener('keydown', handler); close(false); }
    });

    document.body.appendChild(overlay);
    confirmBtn.focus();
  });
}

/**
 * Show a styled alert dialog.
 * @param {object} opts
 * @param {string} opts.title - Dialog title
 * @param {string} [opts.message] - Dialog message
 * @returns {Promise<void>}
 */
function showAlert(opts) {
  return new Promise(function (resolve) {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    var box = document.createElement('div');
    box.className = 'modal-box';

    var titleEl = document.createElement('div');
    titleEl.className = 'modal-title';
    titleEl.textContent = opts.title || '';
    box.appendChild(titleEl);

    if (opts.message) {
      var msgEl = document.createElement('div');
      msgEl.className = 'modal-message';
      msgEl.textContent = opts.message;
      box.appendChild(msgEl);
    }

    var actions = document.createElement('div');
    actions.className = 'modal-actions';
    var confirmBtn = document.createElement('button');
    confirmBtn.className = 'modal-btn modal-btn-primary modal-confirm';
    confirmBtn.textContent = '确定';
    actions.appendChild(confirmBtn);
    box.appendChild(actions);
    overlay.appendChild(box);

    function close() {
      overlay.remove();
      resolve();
    }

    confirmBtn.addEventListener('click', close);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close();
    });
    document.addEventListener('keydown', function handler(e) {
      if (e.key === 'Enter' || e.key === 'Escape') { document.removeEventListener('keydown', handler); close(); }
    });

    document.body.appendChild(overlay);
    confirmBtn.focus();
  });
}

// === API Client ===

class ApiClient {
  _handleAuth(res, path, headers) {
    if (res.status === 401) {
      return Api.handleUnauthorized(path, headers);
    }
  }

  async _throwWithBody(method, path, res) {
    let detail = '';
    try {
      const json = await res.json();
      if (json && json.error) detail = ': ' + json.error;
    } catch (_e) { /* ignore parse errors */ }
    throw new Error(`${method} ${path} failed: ${res.status}${detail}`);
  }

  async get(path) {
    const url = Api.activeUrl(path), headers = Auth.headers();
    const res = await fetch(url, { headers });
    await this._handleAuth(res, url, headers);
    if (!res.ok) {
      await this._throwWithBody('GET', path, res);
    }
    return res.json();
  }

  async post(path, body) {
    const url = Api.activeUrl(path), headers = Object.assign({ 'Content-Type': 'application/json' }, Auth.headers());
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    await this._handleAuth(res, url, headers);
    if (!res.ok) {
      await this._throwWithBody('POST', path, res);
    }
    return res.json();
  }

  async put(path, body) {
    const url = Api.activeUrl(path), headers = Object.assign({ 'Content-Type': 'application/json' }, Auth.headers());
    const res = await fetch(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify(body),
    });
    await this._handleAuth(res, url, headers);
    if (!res.ok) {
      await this._throwWithBody('PUT', path, res);
    }
    return res.json();
  }

  async delete(path) {
    const url = Api.activeUrl(path), headers = Auth.headers();
    const res = await fetch(url, {
      method: 'DELETE',
      headers,
    });
    await this._handleAuth(res, url, headers);
    if (!res.ok) {
      await this._throwWithBody('DELETE', path, res);
    }
    return res.json();
  }
}

var api = new ApiClient();

// === State ===

function _isValidWindowIndex(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0;
  }
  return typeof value === 'string' && /^\d+$/.test(value);
}

var state = {
  currentTab: 'windows',
  currentSession: null,
  currentWindow: null,
  currentPane: null,
  sessions: [],
  windows: [],
  panes: [],
  pinsById: {},                  // { '@5': true } — fetched once on init
};

// Restore navigation state from sessionStorage
(function restoreState() {
  try {
    var saved = sessionStorage.getItem('tmux_nav_state');
    if (!saved) return;
    var s = JSON.parse(saved);
    if (s.currentTab) state.currentTab = s.currentTab;
    if (s.currentSession) state.currentSession = s.currentSession;
    if (_isValidWindowIndex(s.currentWindow)) state.currentWindow = s.currentWindow;
    if (s.currentPane) state.currentPane = s.currentPane;
  } catch (_e) { /* ignore */ }
})();

function saveNavState() {
  try {
    sessionStorage.setItem('tmux_nav_state', JSON.stringify({
      currentTab: state.currentTab,
      currentSession: state.currentSession,
      currentWindow: state.currentWindow,
      currentPane: state.currentPane,
    }));
  } catch (_e) { /* ignore */ }
}

// === Navigation state ===

function navigate(tab, params) {
  var newParams = params || {};

  // DOM attributes and old persisted state can turn null into the truthy string
  // "null". Never let an invalid value reach a window-scoped API path.
  if (
    Object.prototype.hasOwnProperty.call(newParams, 'currentWindow') &&
    !_isValidWindowIndex(newParams.currentWindow)
  ) {
    newParams.currentWindow = null;
    newParams.currentPane = null;
  }

  // Cleanup terminal when navigating away from terminal tab
  if (state.currentTab === 'terminal' && tab !== 'terminal') {
    if (typeof cleanupTerminal === 'function') {
      cleanupTerminal();
    }
  }

  // Opening a window marks its notifications read.
  var session = newParams.currentSession || state.currentSession;
  if (tab === 'terminal' && session && newParams.currentWindow != null) {
    _clearWindowNotification(session, newParams.currentWindow);
  }

  state.currentTab = tab;
  Object.assign(state, newParams);
  saveNavState();
}

// Marks the notification panel's items for this window as read.
function _clearWindowNotification(session, windowIndex) {
  if (typeof NotificationPanel !== 'undefined' && NotificationPanel._markReadByWindow) {
    NotificationPanel._markReadByWindow(session, windowIndex);
  }
}

function escapeHtml(str) {
  var div = document.createElement('div');
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}

// === Status WebSocket ===

class StatusSocket {
  constructor() {
    this._ws = null;
    this._reconnectDelay = 1000;
    this._maxReconnectDelay = 30000;
    this._currentDelay = this._reconnectDelay;
    this.connected = false;
  }

  connect() {
    this._started = true;
    var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // The status socket follows the server in view (see TerminalTarget).
    var url = protocol + '//' + location.host + Api.activeUrl('/ws/status');
    var tokenParam = Auth.wsTokenParam();
    if (tokenParam) url += '?' + tokenParam;

    this._ws = new WebSocket(url);
    var self = this;

    this._ws.onopen = function () {
      self._currentDelay = self._reconnectDelay;
      self.connected = true;
      // Fetch server-side notifications on connect/reconnect
      if (typeof NotificationPanel !== 'undefined' && NotificationPanel.refresh) {
        NotificationPanel.refresh();
      }
    };

    this._ws.onmessage = function (event) {
      try {
        var data = JSON.parse(event.data);
        if (data && data.type === 'notifications') {
          // Server-pushed notifications — forward to NotificationPanel
          if (typeof NotificationPanel !== 'undefined' && NotificationPanel.handleServerPush) {
            NotificationPanel.handleServerPush(data.data);
          }
          return;
        }
        if (data && (data.type === 'open-file' || data.type === 'open-url')) {
          // `anymux open` from a pane, handled by whichever plugin opens that kind
          // (PanelSlots.openers); only a visible tab acts so background tabs stay quiet.
          var opener = typeof PanelSlots !== 'undefined' ? PanelSlots.openers.get(data.type) : null;
          if (opener && document.visibilityState === 'visible') opener.run(data);
          return;
        }
        if (data && data.type === 'pane-cmd') {
          if (typeof FabScene !== 'undefined') {
            var scenes = FabScene.loadScenes();
            var sceneId = FabScene.matchScene(data.cmd, scenes);
            // Store for drawer mount (pane-cmd may arrive before drawer exists)
            if (!window._paneSceneMap) window._paneSceneMap = {};
            window._paneSceneMap[data.paneId] = sceneId;
            // Update drawer if already mounted
            if (window._fabDrawerInstance) {
              window._fabDrawerInstance.setScene(sceneId);
            }
          }
          return;
        }
        self._handleStatusUpdate(data);
      } catch (_e) {
        // Ignore parse errors
      }
    };

    this._ws.onclose = function () {
      self.connected = false;
      self._scheduleReconnect();
    };

    this._ws.onerror = function () {
      if (self._ws) {
        self._ws.close();
      }
    };
  }

  _handleStatusUpdate(raw) {
    // Server sends { type, data: { sessions, ... } } — unwrap if needed
    var data = (raw && raw.data && raw.data.sessions !== undefined) ? raw.data : raw;

    if (data && data.sessions !== undefined) {
      // Build pane scene map from status data (pane-cmd only fires on change,
      // but status arrives every poll with current commands for all panes)
      if (typeof FabScene !== 'undefined') {
        if (!window._paneSceneMap) window._paneSceneMap = {};
        var allScenes = FabScene.loadScenes();
        data.sessions.forEach(function (s) {
          (s.windowDetails || []).forEach(function (w) {
            (w.panes || []).forEach(function (p) {
              if (p.id && p.command) {
                window._paneSceneMap[p.id] = FabScene.matchScene(p.command, allScenes);
              }
            });
          });
        });
      }

      // Blocks read pane commands and listening ports from the latest snapshot.
      window.__anymuxStatus = data;
    }
  }

  _scheduleReconnect() {
    var self = this;
    this._reconnectTimer = setTimeout(function () {
      self._reconnectTimer = null;
      self._currentDelay = Math.min(
        self._currentDelay * 2,
        self._maxReconnectDelay
      );
      self.connect();
    }, this._currentDelay);
  }

  /** Reconnects at once to the server now in view (fired by TerminalTarget). */
  retarget() {
    if (!this._started) return;
    var old = this._ws;
    this._ws = null;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (old) {
      old.onopen = null;
      old.onclose = null;
      old.onerror = null;
      old.onmessage = null;
      try { old.close(); } catch (_e) { /* already closed */ }
    }
    this._currentDelay = this._reconnectDelay;
    this.connect();
  }
}

// === Init ===

var statusSocket = new StatusSocket();
window.addEventListener('terminal-target-server', function () { statusSocket.retarget(); });

function init() {
  // Auth check: verify token (or detect if auth is enabled)
  var headers = Auth.headers();
  fetch('/api/auth/check', { headers: headers })
    .then(async function (res) {
      if (res.status === 401) {
        if (!await Api.handleUnauthorized('/api/auth/check', headers)) _startApp();
        return;
      }
      _startApp();
    })
    .catch(function () {
      _startApp();
    });
}

function _startApp() {
  // Fetch pinned window ids once on startup (non-fatal), from the server in view when it runs pins.
  if ((typeof PanelSlots === 'undefined' || PanelSlots.hasPlugin('pins', Api.activeServerId()))) api.get('/api/pins').then(function (res) {
    state.pinsById = {};
    var pins = res && res.data && res.data.pins ? res.data.pins : [];
    pins.forEach(function (id) { state.pinsById[id] = true; });
  }).catch(function () { /* non-fatal */ });
  statusSocket.connect();
}

document.addEventListener('keydown', function (e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    if (typeof CommandPalette !== 'undefined') CommandPalette.open();
  }
  // Ctrl+Shift+O: open file from tmux paste buffer
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'O') {
    e.preventDefault();
    if (typeof _openFilePreviewFromBuffer === 'function') {
      _openFilePreviewFromBuffer();
    } else if (typeof FilePreview !== 'undefined' && state.currentPane) {
      FilePreview.openFromBuffer(state.currentPane);
    }
  }
  // Ctrl+L: toggle layout picker (terminal view only)
  if ((e.ctrlKey || e.metaKey) && e.key === 'l' && !e.shiftKey && !e.altKey) {
    if (state.currentTab === 'terminal' && state.currentSession && _isValidWindowIndex(state.currentWindow)) {
      e.preventDefault();
      if (typeof LayoutPicker !== 'undefined') LayoutPicker.toggle();
    }
  }
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
