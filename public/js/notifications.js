/* global escapeHtml, navigate, state, api */

var NotificationPanel = (function () {
  var _notifications = [];
  var _isOpen = false;
  var _loaded = false;

  // --- Server API helpers ---

  function _fetchAll() {
    api.get('/api/notifications').then(function (res) {
      if (res.success && Array.isArray(res.data)) {
        _notifications = res.data;
        _loaded = true;
        _updateBadge();
        if (_isOpen) _rerenderPanel();
      }
    }).catch(function () { /* ignore */ });
  }

  function _serverMarkRead(id) {
    api.post('/api/notifications/' + id + '/read').catch(function () { /* ignore */ });
  }

  function _serverMarkReadByWindow(session, windowIndex) {
    api.post('/api/notifications/read-by-window', {
      session: session,
      windowIndex: windowIndex,
    }).catch(function () { /* ignore */ });
  }

  function _serverClearAll() {
    api.delete('/api/notifications').catch(function () { /* ignore */ });
  }

  // NOTE: Do not call _fetchAll() here — this IIFE runs before app.js
  // creates the `api` object. Instead, app.js calls NotificationPanel.refresh()
  // after the StatusSocket connects.

  /**
   * Handle real-time notifications pushed via WebSocket.
   * Called from app.js when a { type: 'notifications', data: [...] } message arrives.
   */
  function handleServerPush(newNotifications) {
    if (!Array.isArray(newNotifications)) return;
    for (var i = 0; i < newNotifications.length; i++) {
      var n = newNotifications[i];
      // Skip if already exists (dedup by id)
      var exists = _notifications.some(function (existing) { return existing.id === n.id; });
      if (!exists) {
        // Auto-mark as read if user is currently viewing this window
        if (
          typeof state !== 'undefined' &&
          state.currentTab === 'terminal' &&
          state.currentSession === n.session &&
          String(state.currentWindow) === String(n.windowIndex)
        ) {
          n.read = true;
          n.readAt = Date.now();
          _serverMarkRead(n.id);
        }
        _notifications.unshift(n);
      }
    }
    _updateBadge();
    if (_isOpen) _rerenderPanel();
  }

  function add(notification) {
    // Legacy path: called from app.js _applyCompletedWindows.
    // With server-side persistence, notifications are added via monitor.js → WebSocket push.
    // This is now a no-op — the server push path (handleServerPush) handles it.
  }

  function markRead(id) {
    var n = _notifications.find(function (n) { return n.id === id; });
    if (n && !n.read) {
      n.read = true;
      n.readAt = Date.now();
      _updateBadge();
      _serverMarkRead(id);
    }
  }

  function clearAll() {
    _notifications = [];
    _updateBadge();
    _serverClearAll();
    if (_isOpen) _rerenderPanel();
  }

  function unreadCount() {
    return _notifications.filter(function (n) { return !n.read; }).length;
  }

  function _updateBadge() {
    var count = unreadCount();
    var badges = document.querySelectorAll('.notification-bell-count');
    badges.forEach(function (el) {
      el.textContent = count;
      el.style.display = count > 0 ? '' : 'none';
    });
  }

  function _relativeTime(ts) {
    var diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60) return diff + 's';
    if (diff < 3600) return Math.floor(diff / 60) + 'm';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h';
    return Math.floor(diff / 86400) + 'd';
  }

  var _closeHandler = null;

  function _rerenderPanel() {
    var panel = document.getElementById('notification-panel');
    if (panel) _renderInto(panel, false);
  }

  function render(event) {
    // Stop the click from propagating to the document close handler
    if (event && event.stopPropagation) event.stopPropagation();

    var isMobile = window.innerWidth < 768;
    if (isMobile) {
      // Mobile: bottom sheet with overlay
      var existing = document.getElementById('notification-panel');
      var existingOverlay = document.getElementById('notification-sheet-overlay');
      if (existing) {
        existing.remove();
        if (existingOverlay) existingOverlay.remove();
        _isOpen = false;
        return;
      }

      var overlay = document.createElement('div');
      overlay.id = 'notification-sheet-overlay';
      overlay.className = 'notification-sheet-overlay';

      var panel = document.createElement('div');
      panel.id = 'notification-panel';
      panel.className = 'notification-panel notification-mobile-sheet';
      _renderInto(panel, false);

      document.body.appendChild(overlay);
      document.body.appendChild(panel);
      _isOpen = true;

      var closeSheet = function () {
        panel.remove();
        overlay.remove();
        _isOpen = false;
      };
      overlay.addEventListener('click', closeSheet);
    } else {
      // Toggle: if already open, close it
      var existing = document.getElementById('notification-panel');
      if (existing) {
        existing.remove();
        _isOpen = false;
        if (_closeHandler) {
          document.removeEventListener('click', _closeHandler);
          _closeHandler = null;
        }
        return;
      }

      var panel = document.createElement('div');
      panel.id = 'notification-panel';
      panel.className = 'notification-panel';
      _renderInto(panel, false);
      document.body.appendChild(panel);

      // Position below the bell icon that was clicked
      var bell = (event && event.currentTarget) ||
        document.querySelector('#sidebar .notification-bell') ||
        document.querySelector('.notification-bell');
      if (bell) {
        var rect = bell.getBoundingClientRect();
        panel.style.top = (rect.bottom + 4) + 'px';
        // Align left edge with bell, but clamp to viewport
        var left = rect.left;
        if (left + 320 > window.innerWidth) left = window.innerWidth - 324;
        if (left < 4) left = 4;
        panel.style.left = left + 'px';
        panel.style.right = 'auto';
      }

      _isOpen = true;

      // Close on outside click (delay to avoid catching current click)
      _closeHandler = function (e) {
        if (!panel.contains(e.target) && !e.target.closest('.notification-bell')) {
          panel.remove();
          _isOpen = false;
          document.removeEventListener('click', _closeHandler);
          _closeHandler = null;
        }
      };
      setTimeout(function () {
        document.addEventListener('click', _closeHandler);
      }, 10);
    }
  }

  function _renderInto(container, isMobile) {
    var html = '';
    if (isMobile) {
      html += '<div class="notification-mobile-header">';
      html += '<button class="notification-back-btn" onclick="navigate(\'windows\')">&larr; 通知</button>';
      html += '<button class="notification-clear-btn" onclick="NotificationPanel.clearAll()">全部清除</button>';
      html += '</div>';
    } else {
      html += '<div class="notification-panel-header">';
      html += '<span class="notification-panel-title">🔔 通知 <span class="notification-bell-count" style="' +
        (unreadCount() > 0 ? '' : 'display:none') + '">' + unreadCount() + '</span></span>';
      html += '<button class="notification-clear-btn" onclick="NotificationPanel.clearAll()">全部清除</button>';
      html += '</div>';
    }

    if (_notifications.length === 0) {
      html += '<div class="notification-empty">暂无通知</div>';
    } else {
      html += '<div class="notification-list">';
      _notifications.forEach(function (n) {
        var readClass = n.read ? ' notification-item-read' : '';
        html += '<div class="notification-item' + readClass + '" data-notif-id="' + n.id +
          '" data-session="' + (typeof escapeHtml === 'function' ? escapeHtml(n.session) : n.session) +
          '" data-window-index="' + n.windowIndex + '">';
        html += '<div class="notification-item-header">';
        var displayName = n.windowName
          ? n.windowIndex + ': ' + n.windowName
          : 'window ' + n.windowIndex;
        html += '<span class="notification-item-target">' + (typeof escapeHtml === 'function' ? escapeHtml(displayName) : displayName) + '</span>';
        html += '<span class="notification-item-time">' + _relativeTime(n.timestamp) + '</span>';
        html += '</div>';
        html += '<div class="notification-item-command">命令完成: ' + (typeof escapeHtml === 'function' ? escapeHtml(n.command) : n.command) + '</div>';
        html += '</div>';
      });
      html += '</div>';
    }

    container.innerHTML = html;

    container.querySelectorAll('.notification-item').forEach(function (el) {
      el.addEventListener('click', function () {
        var id = el.getAttribute('data-notif-id');
        var sess = el.getAttribute('data-session');
        var winIdx = el.getAttribute('data-window-index');
        markRead(id);
        if (typeof navigate === 'function') {
          navigate('terminal', { currentSession: sess, currentWindow: winIdx, currentPane: null });
        }
        var panel = document.getElementById('notification-panel');
        if (panel) { panel.remove(); _isOpen = false; }
      });
    });
  }

  function markReadByWindow(session, windowIndex) {
    var changed = false;
    _notifications.forEach(function (n) {
      if (!n.read && n.session === session && String(n.windowIndex) === String(windowIndex)) {
        n.read = true;
        n.readAt = Date.now();
        changed = true;
      }
    });
    if (changed) {
      _updateBadge();
      _serverMarkReadByWindow(session, windowIndex);
    }
  }

  return {
    add: add,
    markRead: markRead,
    _markReadByWindow: markReadByWindow,
    clearAll: clearAll,
    unreadCount: unreadCount,
    render: render,
    updateBadge: _updateBadge,
    handleServerPush: handleServerPush,
    refresh: _fetchAll,
  };
})();
