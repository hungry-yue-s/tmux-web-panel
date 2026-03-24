/* global Terminal, FitAddon, WebLinksAddon, Auth, Theme */

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
    overlay.innerHTML =
      '<div class="modal-box">' +
        '<div class="modal-title">' + (opts.title || '') + '</div>' +
        '<input class="modal-input" type="text" placeholder="' + (opts.placeholder || '') + '" value="' + (opts.value || '') + '">' +
        '<div class="modal-actions">' +
          '<button class="modal-btn modal-cancel">' + (opts.cancelText || '取消') + '</button>' +
          '<button class="modal-btn modal-btn-primary modal-confirm">' + (opts.confirmText || '确定') + '</button>' +
        '</div>' +
      '</div>';

    var input = overlay.querySelector('.modal-input');
    var confirmBtn = overlay.querySelector('.modal-confirm');
    var cancelBtn = overlay.querySelector('.modal-cancel');

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
    var dangerClass = opts.danger ? ' modal-btn-danger' : ' modal-btn-primary';
    overlay.innerHTML =
      '<div class="modal-box">' +
        '<div class="modal-title">' + (opts.title || '') + '</div>' +
        (opts.message ? '<div class="modal-message">' + opts.message + '</div>' : '') +
        '<div class="modal-actions">' +
          '<button class="modal-btn modal-cancel">' + (opts.cancelText || '取消') + '</button>' +
          '<button class="modal-btn' + dangerClass + ' modal-confirm">' + (opts.confirmText || '确定') + '</button>' +
        '</div>' +
      '</div>';

    var confirmBtn = overlay.querySelector('.modal-confirm');
    var cancelBtn = overlay.querySelector('.modal-cancel');

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
    overlay.innerHTML =
      '<div class="modal-box">' +
        '<div class="modal-title">' + (opts.title || '') + '</div>' +
        (opts.message ? '<div class="modal-message">' + opts.message + '</div>' : '') +
        '<div class="modal-actions">' +
          '<button class="modal-btn modal-btn-primary modal-confirm">确定</button>' +
        '</div>' +
      '</div>';

    var confirmBtn = overlay.querySelector('.modal-confirm');

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

  // Ensure terminal classes are removed for non-terminal tabs so topbar stays visible
  if (state.currentTab !== 'terminal') {
    document.body.classList.remove('terminal-active', 'terminal-fullscreen');
  }

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

  // Theme
  html += '<div class="more-section">';
  html += '<div class="more-section-title">Theme</div>';
  html += '<div class="theme-grid">';
  var themeList = Theme.getThemeList();
  var currentTheme = Theme.getCurrent();
  themeList.forEach(function (t) {
    var isActive = t.id === currentTheme;
    var bg = t.colors['--bg-primary'];
    var bgCard = t.colors['--bg-card'];
    var text = t.colors['--text-primary'];
    var accent = t.colors['--accent-blue'];
    var green = t.colors['--accent-green'];
    var red = t.colors['--accent-red'];
    var purple = t.colors['--accent-purple'];
    html += '<div class="theme-card' + (isActive ? ' active' : '') + '" data-theme="' + t.id + '" style="background:' + bg + ';border-color:' + (isActive ? accent : bgCard) + ';">';
    html += '<div class="theme-card-preview">';
    html += '<div class="theme-card-bar" style="background:' + bgCard + ';">';
    html += '<span style="background:' + red + ';"></span>';
    html += '<span style="background:' + green + ';"></span>';
    html += '<span style="background:' + accent + ';"></span>';
    html += '</div>';
    html += '<div class="theme-card-body" style="background:' + bg + ';">';
    html += '<div class="theme-card-line" style="background:' + text + ';opacity:0.6;width:70%;"></div>';
    html += '<div class="theme-card-line" style="background:' + accent + ';opacity:0.7;width:50%;"></div>';
    html += '<div class="theme-card-line" style="background:' + purple + ';opacity:0.5;width:60%;"></div>';
    html += '</div>';
    html += '</div>';
    html += '<div class="theme-card-name" style="color:' + text + ';">' + escapeHtml(t.name) + '</div>';
    html += '</div>';
  });
  html += '</div>';
  html += '</div>';

  // About
  html += '<div class="more-section">';
  html += '<div class="more-section-title">About</div>';
  html += '<div class="card more-about-card">';
  html += '<div class="more-about-name">Tmux Web Panel v1.0.0</div>';
  html += '<div class="more-about-desc">A mobile-friendly web UI for tmux session management.</div>';
  html += '<a class="more-about-link" href="http://192.168.230.230/yuebiao/tmux-web-panel" target="_blank" rel="noopener">GitLab &rarr;</a>';
  html += '</div>';
  html += '</div>';

  // Logout button (only if authenticated)
  if (Auth.getToken()) {
    html += '<div class="more-section">';
    html += '<div class="more-section-title">Account</div>';
    html += '<div class="card more-status-card">';
    html += '<button id="btn-logout" style="' +
      'width:100%;padding:10px;font-size:0.95rem;font-weight:600;' +
      'border:1px solid var(--accent-red);border-radius:8px;background:transparent;' +
      'color:var(--accent-red);cursor:pointer;"' +
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

  // Bind theme cards
  container.querySelectorAll('.theme-card').forEach(function (card) {
    card.addEventListener('click', function () {
      var themeId = card.getAttribute('data-theme');
      Theme.apply(themeId);
      renderMore(container);
    });
  });

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

function _isPaneCompleted(session, windowIndex, paneId) {
  return !!_paneCompletions[session + ':' + windowIndex + ':' + paneId];
}

function _getSessionUnreadCount(sessionName) {
  var count = 0;
  Object.keys(_windowNotifications).forEach(function (key) {
    if (key.indexOf(sessionName + ':') === 0) count++;
  });
  return count;
}

function _handleCompletedWindows(completedWindows) {
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
  }
  _clearPaneCompletions(session, windowIndex);
}

function updateSidebar() {
  var sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  if (state.sessions.length === 0) {
    // Preserve sidebar header for desktop
    var emptyHtml = '<div class="sidebar-header">';
    emptyHtml += '<div class="sidebar-header-row">';
    emptyHtml += '<span id="sidebar-dot" class="topbar-dot"></span>';
    emptyHtml += '<span id="sidebar-status-info" class="sidebar-status-info"></span>';
    emptyHtml += '<button id="sidebar-btn-add-window" class="sidebar-action-btn" title="New Window">&#43;</button>';
    emptyHtml += '<button id="sidebar-btn-more" class="sidebar-action-btn" title="More">&#9881;</button>';
    emptyHtml += '</div>';
    emptyHtml += '</div>';
    emptyHtml += '<div class="sidebar-section">' +
      '<div class="sidebar-section-title">Sessions</div>' +
      '<div style="color: var(--text-muted); font-size: 0.85rem; padding: 8px 12px;">No sessions</div>' +
      '</div>';
    sidebar.innerHTML = emptyHtml;
    _bindSidebarHeaderButtons(sidebar);
    _syncSidebarHeader();
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

  // Sidebar header (visible on desktop only, replaces topbar)
  var html = '<div class="sidebar-header">';
  html += '<div class="sidebar-header-row">';
  html += '<span id="sidebar-dot" class="topbar-dot"></span>';
  html += '<span id="sidebar-status-info" class="sidebar-status-info"></span>';
  html += '<button id="sidebar-btn-add-window" class="sidebar-action-btn" title="New Window">&#43;</button>';
  html += '<button id="sidebar-btn-more" class="sidebar-action-btn" title="More">&#9881;</button>';
  html += '</div>';
  html += '</div>';

  html += '<div class="sidebar-section">';
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



  // Sidebar header button handlers + sync
  _bindSidebarHeaderButtons(sidebar);
  _syncSidebarHeader();

  // Load windows for active session
  if (state.currentSession) {
    _loadSidebarWindows(state.currentSession);
  }
}

function _bindSidebarHeaderButtons(sidebar) {
  var sidebarAddBtn = sidebar.querySelector('#sidebar-btn-add-window');
  if (sidebarAddBtn) {
    sidebarAddBtn.addEventListener('click', function () {
      if (!state.currentSession) {
        showAlert({ title: '请先选择一个会话' });
        return;
      }
      showPrompt({ title: '新建窗口', placeholder: '窗口名称（可留空）' })
        .then(function (windowName) {
          if (windowName === null) return;
          var body = windowName ? { name: windowName } : {};
          return api.post('/api/sessions/' + encodeURIComponent(state.currentSession) + '/windows', body);
        })
        .then(function (result) {
          if (!result) return;
          var idx = result.data && result.data.index;
          if (idx) {
            navigate('terminal', { currentWindow: idx, currentPane: null });
          } else {
            navigate('windows');
          }
        })
        .catch(function (err) { showAlert({ title: '创建窗口失败', message: err.message }); });
    });
  }

  var sidebarMoreBtn = sidebar.querySelector('#sidebar-btn-more');
  if (sidebarMoreBtn) {
    sidebarMoreBtn.addEventListener('click', function () {
      if (state.currentTab === 'more') {
        navigate('windows');
      } else {
        navigate('more');
      }
    });
  }
}

function _syncSidebarHeader() {
  // Sync dot
  var topbarDot = document.getElementById('status-dot');
  var sidebarDot = document.getElementById('sidebar-dot');
  if (topbarDot && sidebarDot) {
    sidebarDot.className = topbarDot.className;
  }
  // Sync status info
  var topbarInfo = document.getElementById('status-info');
  var sidebarInfo = document.getElementById('sidebar-status-info');
  if (topbarInfo && sidebarInfo) {
    sidebarInfo.textContent = topbarInfo.textContent;
    sidebarInfo.style.color = topbarInfo.style.color;
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
  _updateSidebarNotifications();
}

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

      // Get pane data from state.sessions for this session
      var sessionData = state.sessions.find(function (s) { return s.name === sessionName; });

      var html = '';
      windows.forEach(function (w) {
        var isCurrentWindow = state.currentTab === 'terminal' &&
          state.currentSession === sessionName &&
          String(state.currentWindow) === String(w.index);
        var notifKey = sessionName + ':' + w.index;
        var notif = _windowNotifications[notifKey];
        var notifClass = notif ? (notif.phase === 'blink' ? ' notification-blink' : ' notification-badge') : '';

        // Get pane data from windowDetails
        var windowDetail = sessionData && sessionData.windowDetails
          ? sessionData.windowDetails.find(function (wd) { return String(wd.index) === String(w.index); })
          : null;
        var panes = windowDetail && windowDetail.panes ? windowDetail.panes : [];

        // Compute pane completion ratio
        var completionInfo = _getPaneCompletionInfo(sessionName, w.index);
        var ratioHtml = '';
        if (completionInfo.total > 0 && completionInfo.completed > 0) {
          ratioHtml = '<span class="sidebar-pane-ratio">' + completionInfo.completed + '/' + completionInfo.total + '</span>';
        }

        html +=
          '<div class="sidebar-item sidebar-window-item' +
          (isCurrentWindow ? ' active' : '') +
          notifClass +
          '" data-session="' + escapeHtml(sessionName) +
          '" data-window-index="' + w.index + '">' +
          '<span class="sidebar-window-index">' + w.index + '</span>' +
          '<span class="sidebar-window-name">' + escapeHtml(w.name || 'window') + '</span>' +
          (notif ? '<span class="notification-dot"></span>' : '') +
          '<span class="sidebar-window-cmd">' + escapeHtml(w.command || '') + '</span>' +
          ratioHtml +
          '</div>';

        // Pane sub-items
        panes.forEach(function (p) {
          var isCompleted = _isPaneCompleted(sessionName, w.index, p.id);
          var completedClass = isCompleted ? ' sidebar-pane-completed' : '';

          // Shorten path: replace /home/username with ~
          var shortPath = p.currentPath || '';
          shortPath = shortPath.replace(/^\/home\/[^/]+/, '~');

          // Build port spans
          var portsHtml = '';
          if (p.ports && p.ports.length > 0) {
            p.ports.forEach(function (port) {
              portsHtml += '<span class="sidebar-pane-port" data-port="' + port + '">:' + port + '</span>';
            });
          }

          html +=
            '<div class="sidebar-pane-item' + completedClass + '"' +
            ' data-session="' + escapeHtml(sessionName) +
            '" data-window-index="' + w.index +
            '" data-pane-id="' + escapeHtml(String(p.id)) + '">' +
            '<span class="sidebar-pane-arrow">▸</span>' +
            '<span class="sidebar-pane-cmd">' + (isCompleted ? '✓ ' : '') + escapeHtml(p.command || '') + '</span>' +
            portsHtml +
            (shortPath ? '<span class="sidebar-pane-path">' + escapeHtml(shortPath) + '</span>' : '') +
            '</div>';
        });
      });
      windowsEl.innerHTML = html;

      // Attach window click handlers
      windowsEl.querySelectorAll('.sidebar-window-item').forEach(function (el) {
        el.addEventListener('click', function (e) {
          e.stopPropagation();
          var winIdx = el.getAttribute('data-window-index');
          var sess = el.getAttribute('data-session');
          _clearWindowNotification(sess, winIdx);
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

      // Attach pane item click handlers
      windowsEl.querySelectorAll('.sidebar-pane-item').forEach(function (el) {
        el.addEventListener('click', function (e) {
          e.stopPropagation();
          var winIdx = el.getAttribute('data-window-index');
          var sess = el.getAttribute('data-session');
          var paneId = el.getAttribute('data-pane-id');
          _clearWindowNotification(sess, winIdx);
          navigate('terminal', { currentSession: sess, currentWindow: winIdx, currentPane: paneId });
        });
      });

      // Attach port click handlers
      windowsEl.querySelectorAll('.sidebar-pane-port').forEach(function (el) {
        el.addEventListener('click', function (e) {
          e.stopPropagation();
          var port = el.getAttribute('data-port');
          if (typeof _showPortMenu === 'function') {
            _showPortMenu(e, port);
          }
        });
      });

    })
    .catch(function () {
      windowsEl.innerHTML = '<div style="color: var(--accent-red); font-size: 0.75rem; padding: 4px 12px 4px 36px;">Failed</div>';
    });
}

// === Sidebar Context Menu (unified) ===
//
// Single document-level capture handler for all sidebar right-clicks.
// No per-rebuild listeners — avoids duplicate handler accumulation.

(function () {
  var menu = null;

  function _ensureMenu() {
    if (menu) return menu;
    menu = document.createElement('div');
    menu.id = 'sidebar-context-menu';
    menu.className = 'context-menu';
    menu.style.display = 'none';
    document.body.appendChild(menu);
    document.addEventListener('click', function () { menu.style.display = 'none'; });
    return menu;
  }

  function _showMenu(e, items, onclick) {
    var m = _ensureMenu();
    m.innerHTML = items;
    m.style.display = 'block';
    m.style.left = e.pageX + 'px';
    m.style.top = e.pageY + 'px';
    var rect = m.getBoundingClientRect();
    if (rect.right > window.innerWidth) m.style.left = (e.pageX - rect.width) + 'px';
    if (rect.bottom > window.innerHeight) m.style.top = (e.pageY - rect.height) + 'px';
    m.onclick = function (ev) {
      var item = ev.target.closest('.context-menu-item');
      if (!item) return;
      m.style.display = 'none';
      onclick(item.getAttribute('data-action'));
    };
  }

  document.addEventListener('contextmenu', function (e) {
    var sidebar = document.getElementById('sidebar');
    if (!sidebar || !sidebar.contains(e.target)) return;

    // Always block browser menu inside sidebar
    e.preventDefault();
    e.stopImmediatePropagation();

    // Session header right-click
    var sessionHeader = e.target.closest('.sidebar-session-header');
    if (sessionHeader) {
      var sess = sessionHeader.getAttribute('data-session');
      _showMenu(e,
        '<div class="context-menu-item" data-action="rename">重命名</div>' +
        '<div class="context-menu-item context-menu-item-danger" data-action="delete">删除</div>',
        function (action) {
          if (action === 'rename') {
            showPrompt({ title: '重命名会话', placeholder: '新名称', value: sess })
              .then(function (newName) {
                if (!newName || !newName.trim()) return;
                return api.put('/api/sessions/' + encodeURIComponent(sess), { name: newName.trim() });
              })
              .then(function (result) {
                if (!result) return;
                if (state.currentSession === sess) {
                  state.currentSession = result.data && result.data.name || state.currentSession;
                  updateTopbarSession();
                }
                _sidebarSessionKey = '';
                updateSidebar();
              })
              .catch(function (err) { showAlert({ title: '重命名失败', message: err.message }); });
          } else if (action === 'delete') {
            showConfirm({ title: '删除会话', message: '确定删除会话 "' + sess + '"？', confirmText: '删除', danger: true })
              .then(function (confirmed) {
                if (!confirmed) return;
                return api.delete('/api/sessions/' + encodeURIComponent(sess));
              })
              .then(function (result) {
                if (!result) return;
                if (state.currentSession === sess) {
                  state.currentSession = null;
                  updateTopbarSession();
                }
                _sidebarSessionKey = '';
                updateSidebar();
                render();
              })
              .catch(function (err) { showAlert({ title: '删除失败', message: err.message }); });
          }
        }
      );
      return;
    }

    // Window item right-click
    var windowItem = e.target.closest('.sidebar-window-item');
    if (windowItem) {
      var winIdx = windowItem.getAttribute('data-window-index');
      var winSess = windowItem.getAttribute('data-session');
      _showMenu(e,
        '<div class="context-menu-item" data-action="rename">重命名</div>' +
        '<div class="context-menu-item context-menu-item-danger" data-action="delete">删除</div>',
        function (action) {
          if (action === 'rename') {
            showPrompt({ title: '重命名窗口 ' + winIdx, placeholder: '新名称' })
              .then(function (newName) {
                if (!newName || !newName.trim()) return;
                return api.put(
                  '/api/sessions/' + encodeURIComponent(winSess) + '/windows/' + encodeURIComponent(winIdx),
                  { newName: newName.trim() }
                );
              })
              .then(function (result) {
                if (result) { _sidebarSessionKey = ''; updateSidebar(); }
              })
              .catch(function (err) { showAlert({ title: '重命名失败', message: err.message }); });
          } else if (action === 'delete') {
            showConfirm({ title: '删除窗口', message: '确定删除窗口 ' + winIdx + '？', confirmText: '删除', danger: true })
              .then(function (confirmed) {
                if (!confirmed) return;
                return api.delete('/api/sessions/' + encodeURIComponent(winSess) + '/windows/' + encodeURIComponent(winIdx));
              })
              .then(function (result) {
                if (!result) return;
                if (typeof _fontOffsets !== 'undefined' && typeof _saveFontOffsets === 'function') {
                  delete _fontOffsets[winSess + ':' + winIdx];
                  _saveFontOffsets();
                }
                _sidebarSessionKey = '';
                updateSidebar();
                if (String(state.currentWindow) === String(winIdx)) navigate('windows');
              })
              .catch(function (err) { showAlert({ title: '删除失败', message: err.message }); });
          }
        }
      );
      return;
    }

    // Right-clicked on empty sidebar area — just block browser menu, no custom menu
  }, true);
})();

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

      var sessionCount = Array.isArray(data.sessions) ? data.sessions.length : 0;
      var windowCount = Array.isArray(data.sessions)
        ? data.sessions.reduce(function (sum, s) { return sum + (s.windows || 0); }, 0)
        : 0;

      this._lastStatus = {
        sessionCount: sessionCount,
        windowCount: windowCount,
      };

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
  var cls = 'topbar-dot ' + (connected ? 'connected' : 'disconnected');
  var dot = document.getElementById('status-dot');
  if (dot) dot.className = cls;
  var sidebarDot = document.getElementById('sidebar-dot');
  if (sidebarDot) sidebarDot.className = cls;
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
    showPrompt({ title: '新建会话', placeholder: '会话名称（可留空）' })
      .then(function (name) {
        if (name === null) return;
        var body = {};
        if (name.trim()) body.name = name.trim();
        return api.post('/api/sessions', body);
      })
      .then(function (result) {
        if (result) navigate('windows');
      })
      .catch(function (err) { showAlert({ title: '创建会话失败', message: err.message }); });
  } else if (action === 'rename' && state.currentSession) {
    showPrompt({ title: '重命名会话', placeholder: '新名称', value: state.currentSession })
      .then(function (newName) {
        if (!newName || !newName.trim()) return;
        return api.put('/api/sessions/' + encodeURIComponent(state.currentSession), { name: newName.trim() });
      })
      .then(function (result) {
        if (!result) return;
        state.currentSession = result.data && result.data.name || state.currentSession;
        updateTopbarSession();
        render();
      })
      .catch(function (err) { showAlert({ title: '重命名失败', message: err.message }); });
  } else if (action === 'delete' && state.currentSession) {
    showConfirm({ title: '删除会话', message: '确定删除会话 "' + state.currentSession + '"？', confirmText: '删除', danger: true })
      .then(function (confirmed) {
        if (!confirmed) return;
        return api.delete('/api/sessions/' + encodeURIComponent(state.currentSession));
      })
      .then(function (result) {
        if (!result) return;
        state.currentSession = null;
        updateTopbarSession();
        navigate('windows');
      })
      .catch(function (err) { showAlert({ title: '删除失败', message: err.message }); });
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
        showAlert({ title: '请先选择一个会话' });
        return;
      }
      showPrompt({ title: '新建窗口', placeholder: '窗口名称（可留空）' })
        .then(function (windowName) {
          if (windowName === null) return;
          var body = windowName ? { name: windowName } : {};
          return api.post('/api/sessions/' + encodeURIComponent(state.currentSession) + '/windows', body);
        })
        .then(function (result) {
          if (!result) return;
          var idx = result.data && result.data.index;
          if (idx) {
            navigate('terminal', { currentWindow: idx, currentPane: null });
          } else {
            navigate('windows');
          }
        })
        .catch(function (err) { showAlert({ title: '创建窗口失败', message: err.message }); });
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
  // Auth check: verify token (or detect if auth is enabled)
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
