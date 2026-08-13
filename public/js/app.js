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
    input.type = 'text';
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
  _handleAuth(res) {
    if (res.status === 401) {
      Auth.clearToken();
      window.location.href = '/login.html';
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
    const res = await fetch(path, { headers: Auth.headers() });
    this._handleAuth(res);
    if (!res.ok) {
      await this._throwWithBody('GET', path, res);
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
      await this._throwWithBody('POST', path, res);
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
      await this._throwWithBody('PUT', path, res);
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
  windowOrderBySession: {},      // { 'main': ['@5', '@12'] } — latest snapshot order
  promotedBellIdsBySession: {},  // { 'main': ['@12'] } — newest first
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
    if (typeof FilePreview !== 'undefined' && FilePreview.closeDocked) {
      FilePreview.closeDocked();
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
}

// === Render ===

function render() {
  var content = document.getElementById('content');
  if (!content) return;

  // Ensure terminal classes are removed for non-terminal tabs so topbar stays visible
  if (state.currentTab !== 'terminal') {
    document.body.classList.remove('terminal-active', 'terminal-fullscreen');
  }

  // Add page transition animation
  content.classList.remove('view-transition');
  // Force reflow to restart animation
  void content.offsetWidth;
  content.classList.add('view-transition');

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
    case 'perf':
      renderPerf(content);
      break;
    case 'notifications':
      if (typeof NotificationPanel !== 'undefined') NotificationPanel.render();
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
  var pc = _getTotalPaneCount();
  var recent = _recentWindows.get();

  var html = '<div class="desktop-home"><div class="desktop-home-inner dh-layout">';

  // === LEFT COLUMN: stats + actions + recent ===
  html += '<aside class="dh-side">';
  html += '<div class="dh-stats-row">';
  html += '<div class="dh-stat-mini"><span class="dh-stat-mini-num dh-blue">' + sc + '</span><span class="dh-stat-mini-label">SESS</span></div>';
  html += '<div class="dh-stat-mini"><span class="dh-stat-mini-num dh-green">' + wc + '</span><span class="dh-stat-mini-label">WIN</span></div>';
  html += '<div class="dh-stat-mini"><span class="dh-stat-mini-num dh-purple">' + pc + '</span><span class="dh-stat-mini-label">PANE</span></div>';
  html += '</div>';
  html += '<div class="dh-actions dh-actions-side">';
  html += '<button class="dh-btn dh-btn-primary" id="dh-new-session">＋ Session</button>';
  html += '<button class="dh-btn dh-btn-secondary" id="dh-new-window">◫ Window</button>';
  html += '</div>';

  html += '<div class="dh-section-label">最近访问</div>';
  html += '<div class="dh-recent-list">';
  if (recent.length === 0) {
    html += '<div class="dh-recent-empty">暂无最近访问</div>';
  } else {
    var colors = ['var(--accent-blue)', 'var(--accent-green)', 'var(--accent-purple)', 'var(--accent-yellow)'];
    recent.forEach(function (r, i) {
      var color = colors[i % colors.length];
      var timeStr = _relativeTimeShort(r.timestamp);
      html += '<div class="dh-recent-item" data-session="' + escapeHtml(r.session) + '" data-window-index="' + r.windowIndex + '">';
      html += '<div class="dh-recent-bar" style="background:' + color + '"></div>';
      html += '<div class="dh-recent-body"><div class="dh-recent-name">' + escapeHtml(r.session) + ' / ' + escapeHtml(r.windowName || 'window ' + r.windowIndex) + '</div></div>';
      html += '<div class="dh-recent-time">' + timeStr + '</div>';
      html += '</div>';
    });
  }
  html += '</div>';

  html += '<div class="dh-tips dh-tips-side">';
  html += '<span><span class="dh-tip-key">⌘K</span> 命令面板</span>';
  html += '<span><span class="dh-tip-key">右键</span> 菜单</span>';
  html += '<span><span class="dh-tip-key">长按</span> 关闭</span>';
  html += '</div>';
  html += '</aside>';

  // === RIGHT COLUMN: perf panel ===
  html += '<main class="dh-main">';
  html += PerfPanel.renderSkeleton();
  html += '</main>';

  html += '</div></div>';
  container.innerHTML = html;

  PerfPanel.start();

  // Bind new session button
  var newSessionBtn = document.getElementById('dh-new-session');
  if (newSessionBtn) {
    newSessionBtn.addEventListener('click', function () {
      showPrompt({ title: '新建会话', placeholder: '会话名称' }).then(function (name) {
        if (!name || !name.trim()) return;
        return api.post('/api/sessions', { name: name.trim() });
      }).then(function (result) {
        if (result) { _sidebarSessionKey = ''; render(); updateSidebar(); }
      }).catch(function (err) { showAlert({ title: '创建失败', message: err.message }); });
    });
  }

  // Bind new window button
  var newWindowBtn = document.getElementById('dh-new-window');
  if (newWindowBtn) {
    newWindowBtn.addEventListener('click', function () {
      if (!state.currentSession) { showAlert({ title: '请先选择一个会话' }); return; }
      showPrompt({ title: '新建窗口', placeholder: '窗口名称（可留空）' }).then(function (windowName) {
        if (windowName === null) return;
        var body = windowName ? { name: windowName } : {};
        return api.post('/api/sessions/' + encodeURIComponent(state.currentSession) + '/windows', body);
      }).then(function (result) {
        if (!result) return;
        var idx = result.data && result.data.index;
        if (_isValidWindowIndex(idx)) navigate('terminal', { currentWindow: idx, currentPane: null });
        else navigate('windows');
      }).catch(function (err) { showAlert({ title: '创建失败', message: err.message }); });
    });
  }

  // Bind recent items
  container.querySelectorAll('.dh-recent-item').forEach(function (el) {
    el.addEventListener('click', function () {
      var sess = el.getAttribute('data-session');
      var winIdx = el.getAttribute('data-window-index');
      api.get('/api/sessions/' + encodeURIComponent(sess) + '/windows/' + encodeURIComponent(winIdx) + '/panes')
        .then(function (result) {
          var panes = result.data || [];
          navigate('terminal', { currentSession: sess, currentWindow: winIdx, currentPane: panes.length > 0 ? panes[0].id : null });
        })
        .catch(function () {
          navigate('terminal', { currentSession: sess, currentWindow: winIdx, currentPane: null });
        });
    });
  });
}

function _getTotalPaneCount() {
  var count = 0;
  (state.sessions || []).forEach(function (s) {
    (s.windowDetails || []).forEach(function (w) { count += w.panes ? w.panes.length : 1; });
  });
  return count;
}

function _relativeTimeShort(ts) {
  var diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return diff + 's';
  if (diff < 3600) return Math.floor(diff / 60) + 'm';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h';
  return Math.floor(diff / 86400) + 'd';
}

// === Placeholder Views ===

// renderSessions is defined in sessions.js
// renderWindows is defined in windows.js

// renderTerminal is defined in terminal.js

function renderPerf(container) {
  var html = '<div class="perf-view">';
  html += '<div class="perf-view-header">';
  html += '<button class="perf-back-btn" id="perf-back">&larr; 返回</button>';
  html += '<div class="perf-view-title">性能监控</div>';
  html += '</div>';
  html += PerfPanel.renderSkeleton();
  html += '</div>';
  container.innerHTML = html;

  PerfPanel.start();

  var backBtn = document.getElementById('perf-back');
  if (backBtn) {
    backBtn.addEventListener('click', function () { navigate('more'); });
  }
}

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
  html += '<div class="more-status-row more-machine-ip-row">';
  html += '<span class="more-status-label">机器 IP</span>';
  html += '<span id="more-machine-ip" class="more-status-value">读取中…</span>';
  html += '</div>';
  html += '</div>';
  html += '</div>';

  // Performance Monitor entry
  html += '<div class="more-section">';
  html += '<div class="more-section-title">Performance</div>';
  html += '<div class="card more-status-card">';
  html += '<button id="btn-open-perf" class="more-action-btn">📊 性能监控（机器与窗口）</button>';
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

  // Bind perf entry
  var perfBtn = document.getElementById('btn-open-perf');
  if (perfBtn) {
    perfBtn.addEventListener('click', function () { navigate('perf'); });
  }

  api.get('/api/system-stats').then(function (resp) {
    var target = document.getElementById('more-machine-ip');
    if (!target || !resp || !resp.success || !resp.data) return;
    if (resp.data.ip) {
      var detail = resp.data.ipInterface ? resp.data.ipInterface + ' · IPv4' : '主网络地址';
      target.innerHTML = '<span class="more-ip-address" title="' + escapeHtml(detail) + '">' +
        escapeHtml(resp.data.ip) + '</span>';
    } else {
      target.textContent = '未检测到';
    }
  }).catch(function () {
    var target = document.getElementById('more-machine-ip');
    if (target) target.textContent = '读取失败';
  });

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

function _appIcon(name) {
  var paths = {
    notifications: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.09A1.7 1.7 0 0 0 8.94 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.54-1H3v-4h.09A1.7 1.7 0 0 0 4.6 8.94a1.7 1.7 0 0 0-.34-1.88L4.2 7l2.83-2.83.06.06A1.7 1.7 0 0 0 8.97 4.6 1.7 1.7 0 0 0 10 3.06V3h4v.09a1.7 1.7 0 0 0 1.06 1.51 1.7 1.7 0 0 0 1.88-.34L17 4.2 19.83 7l-.06.06a1.7 1.7 0 0 0-.34 1.88A1.7 1.7 0 0 0 20.94 10H21v4h-.09A1.7 1.7 0 0 0 19.4 15Z"/>',
    collapse: '<path d="m14 7-5 5 5 5"/>',
    expand: '<path d="m10 7 5 5-5 5"/>'
  };
  return '<svg class="app-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + (paths[name] || '') + '</svg>';
}

function _sidebarCollapseContent(collapsed) {
  return _appIcon(collapsed ? 'expand' : 'collapse') + (collapsed ? '' : '<span>收起侧栏</span>');
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
    emptyHtml += '<button id="sidebar-btn-add-window" class="sidebar-action-btn" title="New Window">' + _appIcon('plus') + '</button>';
    emptyHtml += '<button id="sidebar-btn-more" class="sidebar-action-btn" title="More">' + _appIcon('settings') + '</button>';
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
  html += '<button class="sidebar-action-btn notification-bell" title="Notifications" onclick="NotificationPanel.render(event)">' + _appIcon('notifications') + '<span class="notification-bell-count" style="display:none">0</span></button>';
  html += '<button id="sidebar-btn-add-window" class="sidebar-action-btn" title="New Window">' + _appIcon('plus') + '</button>';
  html += '<button id="sidebar-btn-more" class="sidebar-action-btn" title="More">' + _appIcon('settings') + '</button>';
  html += '</div>';
  html += '</div>';

  html += '<div class="sidebar-section">';
  html += '<div class="sidebar-section-title">Sessions</div>';
  state.sessions.forEach(function (session) {
    var isActive = state.currentSession === session.name;
    html += '<div class="sidebar-session-group' + (isActive ? ' expanded' : '') + '" data-session="' + escapeHtml(session.name) + '">';
    var unreadCount = _getSessionUnreadCount(session.name);
    var badgeHtml = unreadCount > 0
      ? '<span class="sidebar-session-badge">' + unreadCount + '</span>'
      : '';
    html +=
      '<div class="sidebar-item sidebar-session-header' +
      (isActive ? ' active' : '') +
      '" data-session="' +
      escapeHtml(session.name) + '">' +
      '<span class="sidebar-expand-icon">' + (isActive ? '&#9662;' : '&#9656;') + '</span>' +
      '<span class="badge badge-green">&#x25cf;</span>' +
      '<span class="sidebar-session-name">' + escapeHtml(session.name) + '</span>' +
      '<span class="tag" style="margin-left: auto;">' + session.windows + 'w</span>' +
      badgeHtml +
      '</div>';
    html += '<div class="sidebar-windows" style="' + (isActive ? '' : 'display:none;') + '"></div>';
    html += '</div>';
  });
  html += '</div>';

  // Collapse button at bottom of sidebar
  html += '<button class="sidebar-collapse-btn" onclick="_toggleSidebarCollapse()" title="收起侧边栏">' + _sidebarCollapseContent(false) + '</button>';

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

function _toggleSidebarCollapse() {
  var sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  sidebar.classList.toggle('collapsed');
  var btn = sidebar.querySelector('.sidebar-collapse-btn');
  if (btn) {
    var collapsed = sidebar.classList.contains('collapsed');
    btn.innerHTML = _sidebarCollapseContent(collapsed);
    btn.title = collapsed ? '展开侧边栏' : '收起侧边栏';
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
          if (_isValidWindowIndex(idx)) {
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

      // 与卡片视图共享排序 + 缓存 snapshot 顺序，WS reconcile 检测集合变化时会失效
      if (typeof window.sortWindowsForSnapshot === 'function') {
        var orderIds = window.sortWindowsForSnapshot(windows, {
          pinsById: state.pinsById || {},
          promotedBellIds: (state.promotedBellIdsBySession && state.promotedBellIdsBySession[sessionName]) || [],
        });
        state.windowOrderBySession = state.windowOrderBySession || {};
        state.windowOrderBySession[sessionName] = orderIds;
        var byId = {};
        windows.forEach(function (w) { byId[w.id] = w; });
        windows = orderIds.map(function (id) { return byId[id]; }).filter(Boolean);
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

        // Pinned 状态（与卡片视图共享 state.pinsById）
        var isPinned = !!(state.pinsById && state.pinsById[w.id]);
        var pinnedIconHtml = isPinned ? '<span class="sidebar-pinned-icon">📌</span>' : '';

        html +=
          '<div class="sidebar-item sidebar-window-item' +
          (isCurrentWindow ? ' active' : '') +
          notifClass +
          '" data-session="' + escapeHtml(sessionName) +
          '" data-window-index="' + w.index +
          '" data-window-id="' + escapeHtml(w.id || '') + '"' +
          ' draggable="true">' +
          '<span class="sidebar-window-index">' + w.index + '</span>' +
          '<span class="sidebar-window-name">' + escapeHtml(w.name || 'window') + '</span>' +
          pinnedIconHtml +
          (notif ? '<span class="notification-dot"></span>' : '') +
          '<span class="sidebar-window-cmd">' + escapeHtml(w.command || '') + '</span>' +
          (panes.length > 1 ? '<span class="sidebar-pane-count">' + panes.length + 'p</span>' : '') +
          ratioHtml +
          '</div>';

      });
      windowsEl.innerHTML = html;

      // Attach window click handlers
      windowsEl.querySelectorAll('.sidebar-window-item').forEach(function (el) {
        el.addEventListener('click', function (e) {
          e.stopPropagation();
          var winIdx = el.getAttribute('data-window-index');
          var sess = el.getAttribute('data-session');
          _clearWindowNotification(sess, winIdx);
          var winName = el.querySelector('.sidebar-window-name');
          _recentWindows.add(sess, winIdx, winName ? winName.textContent : '');
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
        '<div class="context-menu-item" data-action="rename"><span class="context-menu-icon">✏</span>重命名</div>' +
        '<div class="context-menu-item context-menu-item-danger" data-action="delete"><span class="context-menu-icon">✕</span>删除</div>',
        function (action) {
          if (action === 'rename') {
            showPrompt({ title: '重命名会话', placeholder: '新名称', value: sess })
              .then(function (newName) {
                if (!newName || !newName.trim()) return;
                return api.put('/api/sessions/' + encodeURIComponent(sess), { newName: newName.trim() });
              })
              .then(function (result) {
                if (!result) return;
                if (state.currentSession === sess) {
                  state.currentSession = result.data && result.data.newName || state.currentSession;
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
      var winId = windowItem.getAttribute('data-window-id');
      var isPinned = !!(state.pinsById && state.pinsById[winId]);
      var pinLabel = isPinned ? 'Unpin' : 'Pin to top';

      // 侧边栏刷新回调：清缓存键 → updateSidebar 会触发 _rebuildSidebar → _loadSidebarWindows(currentSession)
      var refreshSidebar = function () {
        _sidebarSessionKey = '';
        updateSidebar();
      };

      _showMenu(e,
        '<div class="context-menu-item" data-action="pin"><span class="context-menu-icon">📌</span>' + pinLabel + '</div>' +
        '<div class="context-menu-item" data-action="move"><span class="context-menu-icon">→</span>Move to session…</div>' +
        '<div class="context-menu-item" data-action="rename"><span class="context-menu-icon">✏</span>重命名</div>' +
        '<div class="context-menu-item context-menu-item-danger" data-action="delete"><span class="context-menu-icon">✕</span>删除</div>',
        function (action) {
          if (action === 'pin') {
            if (typeof _togglePin === 'function') {
              _togglePin(winId, refreshSidebar);
            }
          } else if (action === 'move') {
            // 临时把 currentSession 指向源会话，让 _doMove 的 URL / 错误信息正确（源不一定是当前会话）
            var savedCurrent = state.currentSession;
            state.currentSession = winSess;
            _showSessionPicker(winSess).then(function (targetSession) {
              state.currentSession = savedCurrent;
              if (!targetSession) return;
              // _doMove 内部还会用 state.currentSession 拼 URL，再切回去
              var savedAgain = state.currentSession;
              state.currentSession = winSess;
              return _doMove(winIdx, winId, targetSession, false, function () {
                state.currentSession = savedAgain;
                refreshSidebar();
              }).finally(function () {
                state.currentSession = savedAgain;
              });
            });
          } else if (action === 'rename') {
            showPrompt({ title: '重命名窗口 ' + winIdx, placeholder: '新名称' })
              .then(function (newName) {
                if (!newName || !newName.trim()) return;
                return api.put(
                  '/api/sessions/' + encodeURIComponent(winSess) + '/windows/by-id/' + encodeURIComponent(winId),
                  { newName: newName.trim() }
                );
              })
              .then(function (result) {
                if (result) refreshSidebar();
              })
              .catch(function (err) {
                if (err.message && err.message.indexOf('moved_window') >= 0) {
                  showAlert({ title: '重命名失败', message: '窗口已被移到其它会话，请刷新后重试。' });
                } else {
                  showAlert({ title: '重命名失败', message: err.message });
                }
              });
          } else if (action === 'delete') {
            showConfirm({ title: '删除窗口', message: '确定删除窗口 ' + winIdx + '？', confirmText: '删除', danger: true })
              .then(function (confirmed) {
                if (!confirmed) return;
                return api.delete(
                  '/api/sessions/' + encodeURIComponent(winSess) + '/windows/by-id/' + encodeURIComponent(winId)
                );
              })
              .then(function (result) {
                if (!result) return;
                if (typeof _fontOffsets !== 'undefined' && typeof _saveFontOffsets === 'function') {
                  delete _fontOffsets[winSess + ':' + winIdx];
                  _saveFontOffsets();
                }
                refreshSidebar();
                if (String(state.currentWindow) === String(winIdx)) navigate('windows');
              })
              .catch(function (err) {
                if (err.message && err.message.indexOf('moved_window') >= 0) {
                  showAlert({ title: '删除失败', message: '窗口已被移到其它会话，请刷新后重试。' });
                } else {
                  showAlert({ title: '删除失败', message: err.message });
                }
              });
          }
        }
      );
      return;
    }

    // Right-clicked on empty sidebar area — just block browser menu, no custom menu
  }, true);
})();

function _showPortMenu(e, port) {
  e.stopPropagation();
  var isMobile = window.innerWidth < 768;
  if (isMobile) {
    var overlay = document.createElement('div');
    overlay.className = 'port-action-sheet-overlay';
    overlay.innerHTML =
      '<div class="port-action-sheet">' +
        '<div class="port-action-item" data-action="open">🔗 打开 localhost:' + port + '</div>' +
        '<div class="port-action-item" data-action="copy">📋 复制地址</div>' +
      '</div>';
    overlay.addEventListener('click', function (ev) {
      if (ev.target === overlay) overlay.remove();
      var item = ev.target.closest('.port-action-item');
      if (item) {
        var action = item.getAttribute('data-action');
        if (action === 'open') window.open('http://localhost:' + port, '_blank');
        if (action === 'copy') navigator.clipboard.writeText('localhost:' + port);
        overlay.remove();
      }
    });
    document.body.appendChild(overlay);
  } else {
    var menu = document.createElement('div');
    menu.className = 'port-context-menu';
    menu.innerHTML =
      '<div class="port-menu-item" data-action="open">🔗 打开 localhost:' + port + '</div>' +
      '<div class="port-menu-item" data-action="copy">📋 复制地址</div>';
    menu.style.left = e.pageX + 'px';
    menu.style.top = e.pageY + 'px';
    document.body.appendChild(menu);
    var rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (e.pageX - rect.width) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (e.pageY - rect.height) + 'px';
    menu.addEventListener('click', function (ev) {
      var item = ev.target.closest('.port-menu-item');
      if (item) {
        var action = item.getAttribute('data-action');
        if (action === 'open') window.open('http://localhost:' + port, '_blank');
        if (action === 'copy') navigator.clipboard.writeText('localhost:' + port);
      }
      menu.remove();
    });
    setTimeout(function () {
      document.addEventListener('click', function handler() {
        menu.remove();
        document.removeEventListener('click', handler);
      });
    }, 0);
  }
}

// === Sidebar Drag-and-Drop (window → session header → Move) ===
//
// HTML5 native drag, document-level delegation so it survives sidebar re-renders.
// Drop target = .sidebar-session-header. Same-session drops are silently ignored.

(function () {
  function _parseDragPayload(e) {
    try {
      var raw = e.dataTransfer && e.dataTransfer.getData('text/plain');
      if (!raw) return null;
      var payload = JSON.parse(raw);
      if (!payload || typeof payload.windowId !== 'string' || typeof payload.srcSession !== 'string') {
        return null;
      }
      return payload;
    } catch (_e) {
      return null;
    }
  }

  document.addEventListener('dragstart', function (e) {
    var item = e.target.closest && e.target.closest('.sidebar-window-item');
    if (!item) return;
    var windowId = item.getAttribute('data-window-id');
    var srcSession = item.getAttribute('data-session');
    var windowIndex = item.getAttribute('data-window-index');
    if (!windowId || !srcSession) return;

    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', JSON.stringify({
        windowId: windowId,
        srcSession: srcSession,
        windowIndex: windowIndex,
      }));
    }
    item.classList.add('dragging-from-here');
  });

  document.addEventListener('dragend', function (e) {
    // 清理所有源 item 和遗留的 drop target 高亮
    document.querySelectorAll('.sidebar-window-item.dragging-from-here').forEach(function (el) {
      el.classList.remove('dragging-from-here');
    });
    document.querySelectorAll('.sidebar-session-header.drag-over').forEach(function (el) {
      el.classList.remove('drag-over');
    });
  });

  document.addEventListener('dragover', function (e) {
    var header = e.target.closest && e.target.closest('.sidebar-session-header');
    if (!header) return;
    // 允许 drop
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';

    var targetSession = header.getAttribute('data-session');
    var payload = _parseDragPayload(e);
    // payload 在 dragover 期间通常 getData 拿不到（浏览器限制），用 .dragging-from-here 兜底判断 src
    var srcEl = document.querySelector('.sidebar-window-item.dragging-from-here');
    var srcSession = (payload && payload.srcSession) || (srcEl && srcEl.getAttribute('data-session'));
    if (!srcSession) {
      // Source unknown (e.g. sidebar rebuilt mid-drag) — don't highlight either way
      header.classList.remove('drag-over');
      return;
    }
    if (targetSession === srcSession) {
      header.classList.remove('drag-over');
      return;
    }
    header.classList.add('drag-over');
  });

  document.addEventListener('dragleave', function (e) {
    var header = e.target.closest && e.target.closest('.sidebar-session-header');
    if (!header) return;
    // 仅当离开 header 边界（relatedTarget 不在 header 内）时清除
    var rt = e.relatedTarget;
    if (rt && header.contains(rt)) return;
    header.classList.remove('drag-over');
  });

  document.addEventListener('drop', function (e) {
    var header = e.target.closest && e.target.closest('.sidebar-session-header');
    if (!header) return;
    e.preventDefault();
    header.classList.remove('drag-over');

    var payload = _parseDragPayload(e);
    if (!payload) return;
    var targetSession = header.getAttribute('data-session');
    if (!targetSession || targetSession === payload.srcSession) return;

    // _doMove 内部用 state.currentSession 拼源 URL；临时切到 srcSession，完成后还原
    var savedCurrent = state.currentSession;
    state.currentSession = payload.srcSession;

    var refreshSidebar = function () {
      _sidebarSessionKey = '';
      updateSidebar();
    };

    _doMove(payload.windowIndex, payload.windowId, targetSession, false, function () {
      state.currentSession = savedCurrent;
      refreshSidebar();
    }).finally(function () {
      state.currentSession = savedCurrent;
    });
  });
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

      // Reconcile cached window orders against the live set per session.
      // If a session's window-id set has changed (add/remove/move), invalidate
      // the cached order so the next render computes a fresh snapshot.
      state.windowOrderBySession = state.windowOrderBySession || {};
      state.promotedBellIdsBySession = state.promotedBellIdsBySession || {};
      Object.keys(state.windowOrderBySession).forEach(function (session) {
        var s = (data.sessions || []).find(function (x) { return x.name === session; });
        if (!s) {
          // Session gone entirely
          delete state.windowOrderBySession[session];
          delete state.promotedBellIdsBySession[session];
          return;
        }
        var liveIds = (s.windowDetails || []).map(function (w) { return w.id; });
        var cached = state.windowOrderBySession[session] || [];
        var liveSet = {};
        liveIds.forEach(function (id) { liveSet[id] = true; });

        var sameSet = cached.length === liveIds.length
          && cached.every(function (id) { return liveSet[id]; });

        if (!sameSet) {
          // Structural change → invalidate cached order
          delete state.windowOrderBySession[session];
          // Also drop any promoted-bell ids that no longer exist
          if (state.promotedBellIdsBySession[session]) {
            state.promotedBellIdsBySession[session] = state.promotedBellIdsBySession[session]
              .filter(function (id) { return liveSet[id]; });
          }
          if (session === state.currentSession && typeof window.rerenderCurrentWindowsView === 'function') {
            window.rerenderCurrentWindowsView();
          }
        }
      });

      // Bell promotion: any window with source:'bell' in completedWindows joins
      // the promotion list (newest-first), so the snapshot/splice logic lifts
      // it visually to the top of Tier 2.
      var _completed = (data && data.completedWindows) || [];
      _completed.forEach(function (cw) {
        if (cw.source !== 'bell' || !cw.windowId) return;
        state.promotedBellIdsBySession[cw.session] = state.promotedBellIdsBySession[cw.session] || [];
        var arr = state.promotedBellIdsBySession[cw.session];
        var existing = arr.indexOf(cw.windowId);
        if (existing >= 0) arr.splice(existing, 1);
        arr.unshift(cw.windowId);

        // If currently viewing this session, splice the card visually without
        // a full re-snapshot.
        if (cw.session === state.currentSession && typeof window.spliceBellPromoted === 'function') {
          window.spliceBellPromoted(cw.windowId);
        }
      });

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
        return api.put('/api/sessions/' + encodeURIComponent(state.currentSession), { newName: newName.trim() });
      })
      .then(function (result) {
        if (!result) return;
        state.currentSession = result.data && result.data.newName || state.currentSession;
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
          if (_isValidWindowIndex(idx)) {
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
  // Fetch pinned window ids once on startup (non-fatal).
  api.get('/api/pins').then(function (res) {
    state.pinsById = {};
    var pins = res && res.data && res.data.pins ? res.data.pins : [];
    pins.forEach(function (id) { state.pinsById[id] = true; });
  }).catch(function () { /* non-fatal */ });
  statusSocket.connect();
  render();
  updateSidebar();
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
