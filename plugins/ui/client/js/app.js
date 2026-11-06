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

var _recentWindows = (function () {
  var MAX = 8;
  var KEY = 'tmux_recent_windows';
  function _load() { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch (_e) { return []; } }
  function _save(list) { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (_e) { /* ignore */ } }
  return {
    add: function (session, windowIndex, windowName) {
      var list = _load().filter(function (r) { return !(r.session === session && String(r.windowIndex) === String(windowIndex)); });
      list.unshift({ session: session, windowIndex: windowIndex, windowName: windowName, timestamp: Date.now() });
      if (list.length > MAX) list = list.slice(0, MAX);
      _save(list);
    },
    get: function () { return _load(); },
  };
})();

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

// === Router (hash-based) ===

function _syncFilePreviewDockContext() {
  if (document.querySelector('.ms-app')) return;
  if (typeof FilePreview === 'undefined' || !FilePreview.switchDockContext) return;
  if (state.currentTab === 'terminal' && state.currentSession && _isValidWindowIndex(state.currentWindow)) {
    FilePreview.switchDockContext(
      'legacy-local',
      state.currentSession + '\u0000' + state.currentWindow,
    );
  } else {
    FilePreview.switchDockContext(null, null);
  }
}

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

  // Auto-clear notification when navigating to a window
  if (tab === 'terminal' && newParams.currentSession && newParams.currentWindow != null) {
    _clearWindowNotification(newParams.currentSession, newParams.currentWindow);
  } else if (tab === 'terminal' && state.currentSession && newParams.currentWindow != null) {
    _clearWindowNotification(state.currentSession, newParams.currentWindow);
  }

  state.currentTab = tab;
  Object.assign(state, newParams);
  saveNavState();
  render();
  updateSidebar();
  _syncFilePreviewDockContext();
}

// === Render ===

// The multi-server shell (ms-app.js) owns the page and renders every route;
// the legacy views behind this name are gone. Callers from before it still
// call render() and updateSidebar() after changing state: both do nothing.
function render() {}

// === Desktop Home (no window cards — use sidebar) ===

// === Placeholder Views ===


// renderTerminal is defined in terminal.js

// === Sidebar ===

// Track sidebar state to avoid unnecessary rebuilds
var _sidebarSessionKey = '';
var _sidebarWindowsLoaded = {};
var _windowNotifications = {};

// Pane-level completion tracking
var _paneCompletions = {}; // key: 'session:windowIndex:paneId' → true

function _handleCompletedPanes(completedPanes) {
  if (!Array.isArray(completedPanes) || completedPanes.length === 0) return;
  completedPanes.forEach(function (cp) {
    var key = cp.session + ':' + cp.windowIndex + ':' + cp.paneId;
    _paneCompletions[key] = true;
  });
}

function _clearPaneCompletions(session, windowIndex) {
  var prefix = session + ':' + windowIndex + ':';
  Object.keys(_paneCompletions).forEach(function (key) {
    if (key.indexOf(prefix) === 0) delete _paneCompletions[key];
  });
}

function _getPaneCompletionInfo(session, windowIndex) {
  var sessionData = state.sessions.find(function (s) { return s.name === session; });
  var wd = sessionData && sessionData.windowDetails
    ? sessionData.windowDetails.find(function (w) { return w.index === windowIndex; })
    : null;
  var total = wd && wd.panes ? wd.panes.length : 0;
  var completed = 0;
  if (wd && wd.panes) {
    wd.panes.forEach(function (p) {
      if (_paneCompletions[session + ':' + windowIndex + ':' + p.id]) completed++;
    });
  }
  return { total: total, completed: completed };
}

var _notifCoalescer = {
  pending: [],
  timerId: null,
  delay: 500,
  add: function (completedWindows) {
    this.pending = this.pending.concat(completedWindows);
    if (this.timerId) clearTimeout(this.timerId);
    var self = this;
    this.timerId = setTimeout(function () {
      var batch = self.pending;
      self.pending = [];
      self.timerId = null;
      _applyCompletedWindows(batch);
    }, this.delay);
  }
};

function _handleCompletedWindows(completedWindows) {
  if (!Array.isArray(completedWindows) || completedWindows.length === 0) return;
  _notifCoalescer.add(completedWindows);
}

function _applyCompletedWindows(completedWindows) {
  if (!Array.isArray(completedWindows) || completedWindows.length === 0) return;

  var changed = false;
  completedWindows.forEach(function (cw) {
    // Skip current terminal window
    if (
      state.currentTab === 'terminal' &&
      state.currentSession === cw.session &&
      String(state.currentWindow) === String(cw.windowIndex)
    ) {
      return;
    }

    var key = cw.session + ':' + cw.windowIndex;
    var existing = _windowNotifications[key];

    // If already blinking, don't reset
    if (existing && existing.phase === 'blink') return;

    // Clear old timer if exists
    if (existing && existing.timerId) {
      clearTimeout(existing.timerId);
    }

    var timerId = setTimeout(function () {
      var n = _windowNotifications[key];
      if (n && n.phase === 'blink') {
        n.phase = 'badge';
        _updateSidebarNotifications();
      }
    }, 5000);

    _windowNotifications[key] = { phase: 'blink', timestamp: Date.now(), timerId: timerId };
    changed = true;
  });

  completedWindows.forEach(function (cw) {
    // Don't add to notification panel if it's the current terminal window
    if (
      state.currentTab === 'terminal' &&
      state.currentSession === cw.session &&
      String(state.currentWindow) === String(cw.windowIndex)
    ) {
      return;
    }
    if (typeof NotificationPanel !== 'undefined') NotificationPanel.add(cw);
  });

  if (changed) {
    _updateSidebarNotifications();
  }
}

function _clearWindowNotification(session, windowIndex) {
  var key = session + ':' + windowIndex;
  var existing = _windowNotifications[key];
  if (existing) {
    if (existing.timerId) clearTimeout(existing.timerId);
    delete _windowNotifications[key];
    _updateSidebarNotifications();
  }
  _clearPaneCompletions(session, windowIndex);

  // Also mark notification panel items as read for this window
  if (typeof NotificationPanel !== 'undefined' && NotificationPanel._markReadByWindow) {
    NotificationPanel._markReadByWindow(session, windowIndex);
  }
}

function updateSidebar() {}

function _updateSidebarNotifications() {
  var sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  sidebar.querySelectorAll('.sidebar-window-item').forEach(function (el) {
    var sess = el.getAttribute('data-session');
    var winIdx = el.getAttribute('data-window-index');
    var key = sess + ':' + winIdx;
    var notif = _windowNotifications[key];

    // Update classes
    el.classList.remove('notification-blink', 'notification-badge');
    if (notif) {
      el.classList.add(notif.phase === 'blink' ? 'notification-blink' : 'notification-badge');
    }

    // Update dot element
    var dot = el.querySelector('.notification-dot');
    if (notif && !dot) {
      dot = document.createElement('span');
      dot.className = 'notification-dot';
      var nameEl = el.querySelector('.sidebar-window-name');
      if (nameEl && nameEl.nextSibling) {
        el.insertBefore(dot, nameEl.nextSibling);
      } else {
        el.appendChild(dot);
      }
    } else if (!notif && dot) {
      dot.remove();
    }

    // Update pane completion ratio
    var ratioEl = el.querySelector('.sidebar-pane-ratio');
    var info = _getPaneCompletionInfo(sess, winIdx);
    if (info.total > 0 && info.completed > 0) {
      if (!ratioEl) {
        ratioEl = document.createElement('span');
        ratioEl.className = 'sidebar-pane-ratio';
        el.appendChild(ratioEl);
      }
      ratioEl.textContent = info.completed + '/' + info.total;
    } else if (ratioEl) {
      ratioEl.remove();
    }
  });
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
    this.onStatusChange = null;
    this._lastStatus = null;
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
      updateTopbarDot(true);
      // Fetch server-side notifications on connect/reconnect
      if (typeof NotificationPanel !== 'undefined' && NotificationPanel.refresh) {
        NotificationPanel.refresh();
      }
      if (typeof self.onStatusChange === 'function') {
        self.onStatusChange();
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
          // `twp open` from a pane, handled by whichever plugin opens that kind
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
      updateTopbarDot(false);
      var statusEl = document.getElementById('status-info');
      if (statusEl) {
        statusEl.textContent = 'Reconnecting...';
        statusEl.style.color = 'var(--accent-yellow)';
      }
      var sidebarInfo = document.getElementById('sidebar-status-info');
      if (sidebarInfo) {
        sidebarInfo.textContent = 'Reconnecting...';
        sidebarInfo.style.color = 'var(--accent-yellow)';
      }
      if (typeof self.onStatusChange === 'function') {
        self.onStatusChange();
      }
      self._scheduleReconnect();
    };

    this._ws.onerror = function () {
      if (self._ws) {
        self._ws.close();
      }
    };
  }

  _handleStatusUpdate(raw) {
    var statusEl = document.getElementById('status-info');
    // Server sends { type, data: { sessions, ... } } — unwrap if needed
    var data = (raw && raw.data && raw.data.sessions !== undefined) ? raw.data : raw;

    if (data && data.sessions !== undefined) {
      state.sessions = data.sessions;

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

      var sessionCount = Array.isArray(data.sessions) ? data.sessions.length : 0;
      var windowCount = Array.isArray(data.sessions)
        ? data.sessions.reduce(function (sum, s) { return sum + (s.windows || 0); }, 0)
        : 0;

      this._lastStatus = {
        sessionCount: sessionCount,
        windowCount: windowCount,
      };
      // Blocks read pane commands and listening ports from the latest snapshot.
      window.__twpStatus = data;

      var statusText = sessionCount + 's · ' + windowCount + 'w';
      if (statusEl) {
        statusEl.textContent = statusText;
        statusEl.style.color = '';
      }
      var sidebarInfo = document.getElementById('sidebar-status-info');
      if (sidebarInfo) {
        sidebarInfo.textContent = statusText;
        sidebarInfo.style.color = '';
      }

      // Auto-select session if none selected
      if (!state.currentSession && sessionCount > 0) {
        state.currentSession = data.sessions[0].name;
      }
      updateTopbarSession();
      updateSidebar();

      // Handle completion notifications
      if (data.completedWindows) {
        _handleCompletedWindows(data.completedWindows);
      }
      if (data.completedPanes) {
        _handleCompletedPanes(data.completedPanes);
      }

      if (typeof this.onStatusChange === 'function') {
        this.onStatusChange();
      }
    }
  }

  getLastStatus() {
    return this._lastStatus;
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

// === Topbar Session Dropdown ===

var _dropdownOpen = false;

function updateTopbarSession() {
  var nameEl = document.getElementById('session-name');
  if (!nameEl) return;
  nameEl.textContent = state.currentSession || '—';
}

function updateTopbarDot(connected) {
  var cls = 'topbar-dot ' + (connected ? 'connected' : 'disconnected');
  var dot = document.getElementById('status-dot');
  if (dot) dot.className = cls;
  var sidebarDot = document.getElementById('sidebar-dot');
  if (sidebarDot) sidebarDot.className = cls;
}

// The legacy top bar (session switcher, new window, more) sits in the hidden
// legacy tree; the multi-server shell has its own. Only fullscreen is shared.
function initTopbar() {
  if (typeof AppFullscreen !== 'undefined') {
    AppFullscreen.init();
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
  initTopbar();
  updateTopbarSession();
  // Fetch pinned window ids once on startup (non-fatal).
  api.get('/api/pins').then(function (res) {
    state.pinsById = {};
    var pins = res && res.data && res.data.pins ? res.data.pins : [];
    pins.forEach(function (id) { state.pinsById[id] = true; });
  }).catch(function () { /* non-fatal */ });
  statusSocket.connect();
  render();
  updateSidebar();
  _syncFilePreviewDockContext();
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
