/* global Terminal, FitAddon, WebLinksAddon */

// === API Client ===

class ApiClient {
  async get(path) {
    const res = await fetch(path);
    if (!res.ok) {
      throw new Error(`GET ${path} failed: ${res.status}`);
    }
    return res.json();
  }

  async post(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`POST ${path} failed: ${res.status}`);
    }
    return res.json();
  }

  async put(path, body) {
    const res = await fetch(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`PUT ${path} failed: ${res.status}`);
    }
    return res.json();
  }

  async delete(path) {
    const res = await fetch(path, { method: 'DELETE' });
    if (!res.ok) {
      throw new Error(`DELETE ${path} failed: ${res.status}`);
    }
    return res.json();
  }
}

var api = new ApiClient();

// === State ===

var state = {
  currentTab: 'sessions',
  currentSession: null,
  currentWindow: null,
  currentPane: null,
  sessions: [],
  windows: [],
  panes: [],
};

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
  render();
  updateTabBar();
  updateSidebar();
}

function updateTabBar() {
  var tabs = document.querySelectorAll('#tab-bar .tab');
  tabs.forEach(function (tab) {
    if (tab.getAttribute('data-tab') === state.currentTab) {
      tab.classList.add('active');
    } else {
      tab.classList.remove('active');
    }
  });
}

// === Render ===

function render() {
  var content = document.getElementById('content');
  if (!content) return;

  switch (state.currentTab) {
    case 'sessions':
      renderSessions(content);
      break;
    case 'windows':
      renderWindows(content);
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

// === Placeholder Views ===

// renderSessions is defined in sessions.js
// renderWindows is defined in windows.js

// renderTerminal is defined in terminal.js

function renderMore(container) {
  var isConnected = statusSocket.connected;
  var lastStatus = statusSocket.getLastStatus();
  var sessionCount = lastStatus ? lastStatus.sessionCount : 0;
  var windowCount = lastStatus ? lastStatus.windowCount : 0;
  var hasSession = state.currentSession !== null;

  var html = '<div class="more-view">';

  // Quick Actions
  html += '<div class="more-section">';
  html += '<div class="more-section-title">Quick Actions</div>';
  html += '<div class="more-actions">';
  html += '<button class="btn btn-primary more-action-btn" id="more-new-session">';
  html += '&#x2795; New Session</button>';
  html += '<button class="btn more-action-btn' + (hasSession ? '' : ' more-btn-disabled') + '" id="more-new-window"';
  html += hasSession ? '' : ' disabled';
  html += '>&#x2795; New Window</button>';
  html += '</div>';
  html += '</div>';

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

  html += '</div>';
  container.innerHTML = html;

  // Attach event handlers
  var newSessionBtn = document.getElementById('more-new-session');
  if (newSessionBtn) {
    newSessionBtn.addEventListener('click', function () {
      var name = prompt('Session name (leave empty for default):');
      if (name === null) return;
      var body = {};
      if (name.trim()) {
        body.name = name.trim();
      }
      api.post('/api/sessions', body)
        .then(function () { navigate('sessions'); })
        .catch(function (err) { alert('Failed to create session: ' + err.message); });
    });
  }

  var newWindowBtn = document.getElementById('more-new-window');
  if (newWindowBtn && hasSession) {
    newWindowBtn.addEventListener('click', function () {
      api.post('/api/sessions/' + encodeURIComponent(state.currentSession) + '/windows', {})
        .then(function () { navigate('windows', { currentSession: state.currentSession }); })
        .catch(function (err) { alert('Failed to create window: ' + err.message); });
    });
  }

  // Update More page when status changes
  statusSocket.onStatusChange = function () {
    if (state.currentTab === 'more') {
      renderMore(container);
    }
  };
}

// === Sidebar ===

function updateSidebar() {
  var sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  if (state.sessions.length === 0) {
    sidebar.innerHTML =
      '<div class="sidebar-section">' +
      '<div class="sidebar-section-title">Sessions</div>' +
      '<div style="color: var(--text-muted); font-size: 0.85rem; padding: 8px 12px;">No sessions</div>' +
      '</div>';
    return;
  }

  var html = '<div class="sidebar-section">';
  html += '<div class="sidebar-section-title">Sessions</div>';
  state.sessions.forEach(function (session) {
    var isActive = state.currentSession === session.name;
    html +=
      '<div class="sidebar-item' +
      (isActive ? ' active' : '') +
      '" data-session="' +
      escapeHtml(session.name) +
      '">' +
      '<span class="badge badge-green">&#x25cf;</span>' +
      '<span>' +
      escapeHtml(session.name) +
      '</span>' +
      '<span class="tag" style="margin-left: auto;">' +
      session.windows +
      'w</span>' +
      '</div>';
  });
  html += '</div>';

  sidebar.innerHTML = html;

  // Attach click handlers
  sidebar.querySelectorAll('.sidebar-item[data-session]').forEach(function (el) {
    el.addEventListener('click', function () {
      navigate('windows', { currentSession: el.getAttribute('data-session') });
    });
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

    this._ws = new WebSocket(url);
    var self = this;

    this._ws.onopen = function () {
      self._currentDelay = self._reconnectDelay;
      self.connected = true;
      var statusEl = document.getElementById('status-info');
      if (statusEl) {
        statusEl.textContent = 'Connected';
        statusEl.style.color = 'var(--accent-green)';
      }
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
      var statusEl = document.getElementById('status-info');
      if (statusEl) {
        statusEl.textContent = 'Disconnected — reconnecting...';
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

  _handleStatusUpdate(data) {
    var statusEl = document.getElementById('status-info');

    if (data.sessions !== undefined) {
      state.sessions = data.sessions;
      updateSidebar();

      var sessionCount = Array.isArray(data.sessions) ? data.sessions.length : 0;
      var windowCount = Array.isArray(data.sessions)
        ? data.sessions.reduce(function (sum, s) { return sum + (s.windows || 0); }, 0)
        : 0;

      this._lastStatus = {
        sessionCount: sessionCount,
        windowCount: windowCount,
      };

      if (statusEl) {
        statusEl.textContent = sessionCount + ' sessions, ' + windowCount + ' windows';
        statusEl.style.color = 'var(--accent-green)';
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
    setTimeout(function () {
      self._currentDelay = Math.min(
        self._currentDelay * 2,
        self._maxReconnectDelay
      );
      self.connect();
    }, this._currentDelay);
  }
}

// === Tab Bar Event Handlers ===

function initTabBar() {
  var tabs = document.querySelectorAll('#tab-bar .tab');
  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      var tabName = tab.getAttribute('data-tab');
      if (tabName) {
        navigate(tabName);
      }
    });
  });
}

// === New Session Button ===

function initNewSessionButton() {
  var btn = document.getElementById('btn-new-session');
  if (!btn) return;

  btn.addEventListener('click', function () {
    var name = prompt('Session name (leave empty for default):');
    if (name === null) return; // Cancelled

    var body = {};
    if (name.trim()) {
      body.name = name.trim();
    }

    api
      .post('/api/sessions', body)
      .then(function () {
        navigate('sessions');
      })
      .catch(function (err) {
        alert('Failed to create session: ' + err.message);
      });
  });
}

// === Init ===

var statusSocket = new StatusSocket();

function init() {
  initTabBar();
  initNewSessionButton();
  statusSocket.connect();
  render();
  updateSidebar();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
