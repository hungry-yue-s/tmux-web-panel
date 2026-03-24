/* global Terminal, FitAddon, WebLinksAddon, Auth */

// === API Client ===

class ApiClient {
  _handleAuth(res) {
    if (res.status === 401) {
      Auth.clearToken();
      window.location.href = '/login.html';
    }
  }

  async get(path) {
    const res = await fetch(path, { headers: Auth.headers() });
    this._handleAuth(res);
    if (!res.ok) {
      throw new Error(`GET ${path} failed: ${res.status}`);
    }
    return res.json();
  }

  async post(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, Auth.headers()),
      body: JSON.stringify(body),
    });
    this._handleAuth(res);
    if (!res.ok) {
      throw new Error(`POST ${path} failed: ${res.status}`);
    }
    return res.json();
  }

  async put(path, body) {
    const res = await fetch(path, {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, Auth.headers()),
      body: JSON.stringify(body),
    });
    this._handleAuth(res);
    if (!res.ok) {
      throw new Error(`PUT ${path} failed: ${res.status}`);
    }
    return res.json();
  }

  async delete(path) {
    const res = await fetch(path, {
      method: 'DELETE',
      headers: Auth.headers(),
    });
    this._handleAuth(res);
    if (!res.ok) {
      throw new Error(`DELETE ${path} failed: ${res.status}`);
    }
    return res.json();
  }
}

var api = new ApiClient();

// === State ===

var state = {
  currentTab: 'windows',
  currentSession: null,
  currentWindow: null,
  currentPane: null,
  sessions: [],
  windows: [],
  panes: [],
};

// Restore navigation state from sessionStorage
(function restoreState() {
  try {
    var saved = sessionStorage.getItem('tmux_nav_state');
    if (!saved) return;
    var s = JSON.parse(saved);
    if (s.currentTab) state.currentTab = s.currentTab;
    if (s.currentSession) state.currentSession = s.currentSession;
    if (s.currentWindow != null) state.currentWindow = s.currentWindow;
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

function navigate(tab, params) {
  var newParams = params || {};

  // Cleanup terminal when navigating away from terminal tab
  if (state.currentTab === 'terminal' && tab !== 'terminal') {
    if (typeof cleanupTerminal === 'function') {
      cleanupTerminal();
    }
  }

  state.currentTab = tab;
  Object.assign(state, newParams);
  saveNavState();
  render();
  updateSidebar();
}

// === Render ===

function render() {
  var content = document.getElementById('content');
  if (!content) return;

  switch (state.currentTab) {
    case 'sessions':
    case 'windows':
      if (window.innerWidth >= 768) {
        renderDesktopHome(content);
      } else {
        renderWindows(content);
      }
      break;
    case 'terminal':
      renderTerminal(content);
      break;
    case 'more':
      renderMore(content);
      break;
    default:
      content.innerHTML = '<p>Unknown tab</p>';
  }
}

// === Desktop Home (no window cards — use sidebar) ===

function renderDesktopHome(container) {
  var lastStatus = statusSocket.getLastStatus();
  var sc = lastStatus ? lastStatus.sessionCount : 0;
  var wc = lastStatus ? lastStatus.windowCount : 0;

  container.innerHTML =
    '<div class="desktop-home">' +
    '<div class="desktop-home-inner">' +
    '<div class="desktop-home-icon">tmux</div>' +
    '<div class="desktop-home-hint">Select a window from the sidebar</div>' +
    '<div class="desktop-home-stats">' +
    '<span>' + sc + ' session' + (sc !== 1 ? 's' : '') + '</span>' +
    '<span class="desktop-home-dot">&middot;</span>' +
    '<span>' + wc + ' window' + (wc !== 1 ? 's' : '') + '</span>' +
    '</div>' +
    '</div>' +
    '</div>';
}

// === Placeholder Views ===

// renderSessions is defined in sessions.js
// renderWindows is defined in windows.js

// renderTerminal is defined in terminal.js

function renderMore(container) {
  var isConnected = statusSocket.connected;
  var lastStatus = statusSocket.getLastStatus();
  var sessionCount = lastStatus ? lastStatus.sessionCount : 0;
  var windowCount = lastStatus ? lastStatus.windowCount : 0;

  var html = '<div class="more-view">';

  // Server Status
  html += '<div class="more-section">';
  html += '<div class="more-section-title">Server Status</div>';
  html += '<div class="card more-status-card">';
  html += '<div class="more-status-row">';
  html += '<span class="more-status-dot ' + (isConnected ? 'more-dot-green' : 'more-dot-red') + '"></span>';
  html += '<span>' + (isConnected ? 'Connected' : 'Disconnected') + '</span>';
  html += '</div>';
  html += '<div class="more-status-row">';
  html += '<span class="more-status-label">Sessions</span>';
  html += '<span class="more-status-value">' + sessionCount + '</span>';
  html += '</div>';
  html += '<div class="more-status-row">';
  html += '<span class="more-status-label">Windows</span>';
  html += '<span class="more-status-value">' + windowCount + '</span>';
  html += '</div>';
  html += '<div class="more-status-row">';
  html += '<span class="more-status-label">Host</span>';
  html += '<span class="more-status-value">' + escapeHtml(location.host) + '</span>';
  html += '</div>';
  html += '</div>';
  html += '</div>';

  // About
  html += '<div class="more-section">';
  html += '<div class="more-section-title">About</div>';
  html += '<div class="card more-about-card">';
  html += '<div class="more-about-name">Tmux Web Panel v1.0.0</div>';
  html += '<div class="more-about-desc">A mobile-friendly web UI for tmux session management.</div>';
  html += '<a class="more-about-link" href="https://github.com" target="_blank" rel="noopener">GitHub &rarr;</a>';
  html += '</div>';
  html += '</div>';

  // Logout button (only if authenticated)
  if (Auth.getToken()) {
    html += '<div class="more-section">';
    html += '<div class="more-section-title">Account</div>';
    html += '<div class="card more-status-card">';
    html += '<button id="btn-logout" style="' +
      'width:100%;padding:10px;font-size:0.95rem;font-weight:600;' +
      'border:1px solid #f7768e;border-radius:8px;background:transparent;' +
      'color:#f7768e;cursor:pointer;"' +
      '>Sign Out</button>';
    html += '</div>';
    html += '</div>';
  }

  html += '</div>';
  container.innerHTML = html;

  // Bind logout button
  var logoutBtn = document.getElementById('btn-logout');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', function () { Auth.logout(); });
  }

  // Update More page when status changes
  statusSocket.onStatusChange = function () {
    if (state.currentTab === 'more') {
      renderMore(container);
    }
  };
}

// === Sidebar ===

// Track sidebar state to avoid unnecessary rebuilds
var _sidebarSessionKey = '';
var _sidebarWindowsLoaded = {};

function updateSidebar() {
  var sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  if (state.sessions.length === 0) {
    sidebar.innerHTML =
      '<div class="sidebar-section">' +
      '<div class="sidebar-section-title">Sessions</div>' +
      '<div style="color: var(--text-muted); font-size: 0.85rem; padding: 8px 12px;">No sessions</div>' +
      '</div>';
    _sidebarSessionKey = '';
    _sidebarWindowsLoaded = {};
    return;
  }

  // Build a key to detect if sessions changed
  var newKey = state.sessions.map(function (s) { return s.name + ':' + s.windows; }).join('|')
    + '||' + (state.currentSession || '');

  if (newKey === _sidebarSessionKey) {
    // Sessions unchanged — just update active highlights
    _updateSidebarHighlights(sidebar);
    return;
  }
  _sidebarSessionKey = newKey;

  _rebuildSidebar(sidebar);
}

function _rebuildSidebar(sidebar) {
  _sidebarWindowsLoaded = {};

  var html = '<div class="sidebar-section">';
  html += '<div class="sidebar-section-title">Sessions</div>';
  state.sessions.forEach(function (session) {
    var isActive = state.currentSession === session.name;
    html += '<div class="sidebar-session-group' + (isActive ? ' expanded' : '') + '" data-session="' + escapeHtml(session.name) + '">';
    html +=
      '<div class="sidebar-item sidebar-session-header' +
      (isActive ? ' active' : '') +
      '" data-session="' +
      escapeHtml(session.name) + '">' +
      '<span class="sidebar-expand-icon">' + (isActive ? '&#9662;' : '&#9656;') + '</span>' +
      '<span class="badge badge-green">&#x25cf;</span>' +
      '<span class="sidebar-session-name">' + escapeHtml(session.name) + '</span>' +
      '<span class="tag" style="margin-left: auto;">' + session.windows + 'w</span>' +
      '</div>';
    html += '<div class="sidebar-windows" style="' + (isActive ? '' : 'display:none;') + '"></div>';
    html += '</div>';
  });
  html += '</div>';

  sidebar.innerHTML = html;

  // Attach session click handlers
  sidebar.querySelectorAll('.sidebar-session-header').forEach(function (el) {
    el.addEventListener('click', function () {
      var name = el.getAttribute('data-session');
      var wasActive = state.currentSession === name;

      state.currentSession = name;
      updateTopbarSession();

      if (!wasActive) {
        _sidebarSessionKey = ''; // force rebuild
        updateSidebar();
        if (state.currentTab === 'windows' || state.currentTab === 'sessions') {
          render();
        }
      } else {
        // Toggle collapse
        var group = el.closest('.sidebar-session-group');
        var windowsEl = group ? group.querySelector('.sidebar-windows') : null;
        var icon = el.querySelector('.sidebar-expand-icon');
        if (windowsEl) {
          var isHidden = windowsEl.style.display === 'none';
          windowsEl.style.display = isHidden ? '' : 'none';
          if (icon) icon.innerHTML = isHidden ? '&#9662;' : '&#9656;';
        }
      }
    });
  });

  // Load windows for active session
  if (state.currentSession) {
    _loadSidebarWindows(state.currentSession);
  }
}

function _updateSidebarHighlights(sidebar) {
  sidebar.querySelectorAll('.sidebar-session-header').forEach(function (el) {
    var name = el.getAttribute('data-session');
    var isActive = state.currentSession === name;
    el.classList.toggle('active', isActive);
    var icon = el.querySelector('.sidebar-expand-icon');
    if (icon) icon.innerHTML = isActive ? '&#9662;' : '&#9656;';
  });
  sidebar.querySelectorAll('.sidebar-window-item').forEach(function (el) {
    var sess = el.getAttribute('data-session');
    var winIdx = el.getAttribute('data-window-index');
    var isActive = state.currentTab === 'terminal' &&
      state.currentSession === sess &&
      String(state.currentWindow) === String(winIdx);
    el.classList.toggle('active', isActive);
  });
}

function _loadSidebarWindows(sessionName) {
  var sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  // Use attribute selector with the raw value via a manual DOM search
  var groups = sidebar.querySelectorAll('.sidebar-session-group');
  var group = null;
  for (var i = 0; i < groups.length; i++) {
    if (groups[i].getAttribute('data-session') === sessionName) {
      group = groups[i];
      break;
    }
  }
  if (!group) return;
  var windowsEl = group.querySelector('.sidebar-windows');
  if (!windowsEl) return;

  windowsEl.innerHTML = '<div style="color: var(--text-muted); font-size: 0.75rem; padding: 4px 12px 4px 36px;">Loading...</div>';
  windowsEl.style.display = '';

  api.get('/api/sessions/' + encodeURIComponent(sessionName) + '/windows')
    .then(function (result) {
      var windows = result.data || [];
      if (windows.length === 0) {
        windowsEl.innerHTML = '<div style="color: var(--text-muted); font-size: 0.75rem; padding: 4px 12px 4px 36px;">No windows</div>';
        return;
      }
      var html = '';
      windows.forEach(function (w) {
        var isCurrentWindow = state.currentTab === 'terminal' &&
          state.currentSession === sessionName &&
          String(state.currentWindow) === String(w.index);
        html +=
          '<div class="sidebar-item sidebar-window-item' +
          (isCurrentWindow ? ' active' : '') +
          '" data-session="' + escapeHtml(sessionName) +
          '" data-window-index="' + w.index + '">' +
          '<span class="sidebar-window-index">' + w.index + '</span>' +
          '<span class="sidebar-window-name">' + escapeHtml(w.name || 'window') + '</span>' +
          '<span class="sidebar-window-cmd">' + escapeHtml(w.command || '') + '</span>' +
          '</div>';
      });
      windowsEl.innerHTML = html;

      // Attach window click handlers
      windowsEl.querySelectorAll('.sidebar-window-item').forEach(function (el) {
        el.addEventListener('click', function (e) {
          e.stopPropagation();
          var winIdx = el.getAttribute('data-window-index');
          var sess = el.getAttribute('data-session');
          // Fetch first pane, then navigate to terminal
          api.get('/api/sessions/' + encodeURIComponent(sess) + '/windows/' + encodeURIComponent(winIdx) + '/panes')
            .then(function (result) {
              var panes = result.data || [];
              var firstPaneId = panes.length > 0 ? panes[0].id : null;
              navigate('terminal', { currentSession: sess, currentWindow: winIdx, currentPane: firstPaneId });
            })
            .catch(function () {
              navigate('terminal', { currentSession: sess, currentWindow: winIdx, currentPane: null });
            });
        });
      });
    })
    .catch(function () {
      windowsEl.innerHTML = '<div style="color: var(--accent-red); font-size: 0.75rem; padding: 4px 12px 4px 36px;">Failed</div>';
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
    var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var url = protocol + '//' + location.host + '/ws/status';
    var tokenParam = Auth.wsTokenParam();
    if (tokenParam) url += '?' + tokenParam;

    this._ws = new WebSocket(url);
    var self = this;

    this._ws.onopen = function () {
      self._currentDelay = self._reconnectDelay;
      self.connected = true;
      updateTopbarDot(true);
      if (typeof self.onStatusChange === 'function') {
        self.onStatusChange();
      }
    };

    this._ws.onmessage = function (event) {
      try {
        var data = JSON.parse(event.data);
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

      var sessionCount = Array.isArray(data.sessions) ? data.sessions.length : 0;
      var windowCount = Array.isArray(data.sessions)
        ? data.sessions.reduce(function (sum, s) { return sum + (s.windows || 0); }, 0)
        : 0;

      this._lastStatus = {
        sessionCount: sessionCount,
        windowCount: windowCount,
      };

      if (statusEl) {
        statusEl.textContent = sessionCount + 's · ' + windowCount + 'w';
        statusEl.style.color = '';
      }

      // Auto-select session if none selected
      if (!state.currentSession && sessionCount > 0) {
        state.currentSession = data.sessions[0].name;
      }
      updateTopbarSession();
      updateSidebar();

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
    setTimeout(function () {
      self._currentDelay = Math.min(
        self._currentDelay * 2,
        self._maxReconnectDelay
      );
      self.connect();
    }, this._currentDelay);
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
  var dot = document.getElementById('status-dot');
  if (!dot) return;
  dot.className = 'topbar-dot ' + (connected ? 'connected' : 'disconnected');
}

function toggleSessionDropdown() {
  var dropdown = document.getElementById('session-dropdown');
  if (!dropdown) return;

  if (_dropdownOpen) {
    _closeDropdown();
    return;
  }

  var btn = document.getElementById('session-switcher');
  if (!btn) return;

  var rect = btn.getBoundingClientRect();
  dropdown.style.top = (rect.bottom + 4) + 'px';
  dropdown.style.left = rect.left + 'px';

  var sessions = state.sessions || [];
  var html = '';

  sessions.forEach(function (s) {
    var isActive = s.name === state.currentSession;
    html += '<div class="session-dropdown-item' + (isActive ? ' active' : '') + '" data-session="' + escapeHtml(s.name) + '">';
    html += '<span class="session-dropdown-item-name">' + escapeHtml(s.name) + '</span>';
    html += '<span class="session-dropdown-item-count">' + s.windows + 'w</span>';
    html += '</div>';
  });

  html += '<div class="session-dropdown-divider"></div>';
  html += '<div class="session-dropdown-action" data-action="new">&#43; New Session</div>';

  if (state.currentSession) {
    html += '<div class="session-dropdown-action" data-action="rename">&#9998; Rename</div>';
    html += '<div class="session-dropdown-action danger" data-action="delete">&#10005; Delete</div>';
  }

  dropdown.innerHTML = html;
  dropdown.style.display = 'block';
  _dropdownOpen = true;

  // Bind clicks
  dropdown.querySelectorAll('.session-dropdown-item').forEach(function (el) {
    el.addEventListener('click', function () {
      var name = el.getAttribute('data-session');
      if (name !== state.currentSession) {
        state.currentSession = name;
        updateTopbarSession();
        if (state.currentTab === 'windows' || state.currentTab === 'sessions') {
          render();
        }
      }
      _closeDropdown();
    });
  });

  dropdown.querySelectorAll('.session-dropdown-action').forEach(function (el) {
    el.addEventListener('click', function () {
      var action = el.getAttribute('data-action');
      _closeDropdown();
      _handleSessionAction(action);
    });
  });
}

function _closeDropdown() {
  var dropdown = document.getElementById('session-dropdown');
  if (dropdown) dropdown.style.display = 'none';
  _dropdownOpen = false;
}

function _handleSessionAction(action) {
  if (action === 'new') {
    var name = prompt('Session name (leave empty for default):');
    if (name === null) return;
    var body = {};
    if (name.trim()) body.name = name.trim();
    api.post('/api/sessions', body)
      .then(function () { navigate('windows'); })
      .catch(function (err) { alert('Failed to create session: ' + err.message); });
  } else if (action === 'rename' && state.currentSession) {
    var newName = prompt('New name for "' + state.currentSession + '":');
    if (!newName || !newName.trim()) return;
    api.put('/api/sessions/' + encodeURIComponent(state.currentSession), { name: newName.trim() })
      .then(function () {
        state.currentSession = newName.trim();
        updateTopbarSession();
        render();
      })
      .catch(function (err) { alert('Failed to rename: ' + err.message); });
  } else if (action === 'delete' && state.currentSession) {
    if (!confirm('Delete session "' + state.currentSession + '"?')) return;
    api.delete('/api/sessions/' + encodeURIComponent(state.currentSession))
      .then(function () {
        state.currentSession = null;
        updateTopbarSession();
        navigate('windows');
      })
      .catch(function (err) { alert('Failed to delete: ' + err.message); });
  }
}

function initTopbar() {
  var switcher = document.getElementById('session-switcher');
  if (switcher) {
    switcher.addEventListener('click', toggleSessionDropdown);
  }

  var addWindowBtn = document.getElementById('btn-add-window');
  if (addWindowBtn) {
    addWindowBtn.addEventListener('click', function () {
      if (!state.currentSession) {
        alert('Please select a session first.');
        return;
      }
      api.post('/api/sessions/' + encodeURIComponent(state.currentSession) + '/windows', {})
        .then(function () { navigate('windows'); })
        .catch(function (err) { alert('Failed to create window: ' + err.message); });
    });
  }

  var moreBtn = document.getElementById('btn-more');
  if (moreBtn) {
    moreBtn.addEventListener('click', function () {
      if (state.currentTab === 'more') {
        navigate('windows');
      } else {
        navigate('more');
      }
    });
  }

  // Close dropdown on outside click
  document.addEventListener('click', function (e) {
    if (!_dropdownOpen) return;
    var dropdown = document.getElementById('session-dropdown');
    var switcher = document.getElementById('session-switcher');
    if (dropdown && !dropdown.contains(e.target) && switcher && !switcher.contains(e.target)) {
      _closeDropdown();
    }
  });
}

// === Init ===

var statusSocket = new StatusSocket();

function init() {
  // Auth check: if we have a token, verify it; if 401, redirect to login
  if (Auth.getToken()) {
    fetch('/api/status', { headers: Auth.headers() })
      .then(function (res) {
        if (res.status === 401) {
          Auth.clearToken();
          window.location.href = '/login.html';
          return;
        }
        _startApp();
      })
      .catch(function () {
        _startApp();
      });
  } else {
    _startApp();
  }
}

function _startApp() {
  initTopbar();
  updateTopbarSession();
  statusSocket.connect();
  render();
  updateSidebar();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
