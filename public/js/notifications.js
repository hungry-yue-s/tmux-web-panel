/* global escapeHtml, navigate, state */

var NotificationPanel = (function () {
  var _notifications = [];
  var _maxNotifications = 50;
  var _isOpen = false;

  // Load from sessionStorage
  function _save() {
    try { sessionStorage.setItem('tmux_notifications', JSON.stringify(_notifications)); }
    catch (_e) { /* ignore */ }
  }
  function _load() {
    try { var saved = sessionStorage.getItem('tmux_notifications'); if (saved) _notifications = JSON.parse(saved); }
    catch (_e) { /* ignore */ }
  }
  _load();

  function add(notification) {
    _notifications.unshift({
      id: Date.now() + '-' + Math.random().toString(36).substr(2, 5),
      session: notification.session,
      windowIndex: notification.windowIndex,
      command: notification.prevCommand || '',
      paneId: notification.paneId || '',
      timestamp: Date.now(),
      read: false,
    });
    if (_notifications.length > _maxNotifications) _notifications = _notifications.slice(0, _maxNotifications);
    _save();
    _updateBadge();
  }

  function markRead(id) {
    var n = _notifications.find(function (n) { return n.id === id; });
    if (n) { n.read = true; _save(); _updateBadge(); }
  }

  function clearAll() {
    _notifications = [];
    _save();
    _updateBadge();
    if (_isOpen) render();
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

  function render() {
    var isMobile = window.innerWidth < 768;
    if (isMobile) {
      var content = document.getElementById('content');
      if (!content) return;
      _renderInto(content, true);
    } else {
      var existing = document.getElementById('notification-panel');
      if (existing) { existing.remove(); _isOpen = false; return; }
      var panel = document.createElement('div');
      panel.id = 'notification-panel';
      panel.className = 'notification-panel';
      _renderInto(panel, false);
      document.body.appendChild(panel);
      _isOpen = true;
      setTimeout(function () {
        document.addEventListener('click', function handler(e) {
          if (!panel.contains(e.target) && !e.target.closest('.notification-bell')) {
            panel.remove();
            _isOpen = false;
            document.removeEventListener('click', handler);
          }
        });
      }, 0);
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
        html += '<span class="notification-item-target">' + (typeof escapeHtml === 'function' ? escapeHtml(n.session) : n.session) + ' / ' + n.windowIndex + '</span>';
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

  return { add: add, markRead: markRead, clearAll: clearAll, unreadCount: unreadCount, render: render, updateBadge: _updateBadge };
})();
