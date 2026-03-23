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

function renderSessions(container) {
  container.innerHTML =
    '<div style="padding: 24px; text-align: center; color: var(--text-muted);">' +
    '<p style="font-size: 1.2rem; margin-bottom: 8px;">Sessions</p>' +
    '<p>Loading...</p>' +
    '</div>';
}

function renderWindows(container) {
  container.innerHTML =
    '<div style="padding: 24px; text-align: center; color: var(--text-muted);">' +
    '<p style="font-size: 1.2rem; margin-bottom: 8px;">Windows</p>' +
    '<p>Coming soon</p>' +
    '</div>';
}

function renderTerminal(container) {
  container.innerHTML =
    '<div style="padding: 24px; text-align: center; color: var(--text-muted);">' +
    '<p style="font-size: 1.2rem; margin-bottom: 8px;">Terminal</p>' +
    '<p>Coming soon</p>' +
    '</div>';
}

function renderMore(container) {
  container.innerHTML =
    '<div style="padding: 24px; text-align: center; color: var(--text-muted);">' +
    '<p style="font-size: 1.2rem; margin-bottom: 8px;">More</p>' +
    '<p>Coming soon</p>' +
    '</div>';
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
  }

  connect() {
    var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var url = protocol + '//' + location.host + '/ws/status';

    this._ws = new WebSocket(url);
    var self = this;

    this._ws.onopen = function () {
      self._currentDelay = self._reconnectDelay;
      var statusEl = document.getElementById('status-info');
      if (statusEl) {
        statusEl.textContent = 'Connected';
        statusEl.style.color = 'var(--accent-green)';
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
      var statusEl = document.getElementById('status-info');
      if (statusEl) {
        statusEl.textContent = 'Disconnected — reconnecting...';
        statusEl.style.color = 'var(--accent-yellow)';
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

      if (statusEl) {
        var sessionCount = Array.isArray(data.sessions) ? data.sessions.length : 0;
        var windowCount = Array.isArray(data.sessions)
          ? data.sessions.reduce(function (sum, s) { return sum + (s.windows || 0); }, 0)
          : 0;
        statusEl.textContent = sessionCount + ' sessions, ' + windowCount + ' windows';
        statusEl.style.color = 'var(--accent-green)';
      }
    }
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
