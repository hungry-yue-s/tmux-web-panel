/* global api, state, navigate, escapeHtml, updateSidebar, updateTopbarSession */

// === Windows View ===

function renderWindows(container) {
  // Ensure terminal classes are removed so topbar stays visible
  document.body.classList.remove('terminal-active', 'terminal-fullscreen');
  // Reset any page-level scroll that may have pushed topbar out of view
  window.scrollTo(0, 0);
  document.documentElement.scrollTop = 0;

  container.innerHTML =
    '<div class="windows-view">' +
    '<div class="windows-body">' +
    '</div>' +
    '</div>';

  var bodyEl = container.querySelector('.windows-body');

  // Fetch sessions to validate current session, then load windows
  api
    .get('/api/sessions')
    .then(function (result) {
      var sessions = result.data || [];
      // Merge API sessions with existing state to preserve windowDetails from WebSocket
      var existingByName = {};
      (state.sessions || []).forEach(function (s) {
        if (s.windowDetails) existingByName[s.name] = s.windowDetails;
      });
      sessions.forEach(function (s) {
        if (!s.windowDetails && existingByName[s.name]) {
          s.windowDetails = existingByName[s.name];
        }
      });
      state.sessions = sessions;
      if (typeof updateSidebar === 'function') updateSidebar();

      if (sessions.length === 0) {
        state.currentSession = null;
        updateTopbarSession();
        bodyEl.innerHTML =
          '<div class="windows-empty">' +
          '<p style="font-size: 1.1rem; margin-bottom: 8px;">No sessions</p>' +
          '<p style="color: var(--text-muted);">Tap + in the top bar to create one.</p>' +
          '</div>';
        return;
      }

      // Auto-select first session if none selected or selection invalid
      var validSession = sessions.some(function (s) { return s.name === state.currentSession; });
      if (!state.currentSession || !validSession) {
        state.currentSession = sessions[0].name;
      }
      updateTopbarSession();

      _loadWindows(bodyEl, container);
    })
    .catch(function (err) {
      bodyEl.innerHTML =
        '<div class="windows-empty">' +
        '<p style="color: var(--accent-red);">Failed to load sessions</p>' +
        '<p style="color: var(--text-muted);">' + escapeHtml(err.message) + '</p>' +
        '</div>';
    });
}

// === Load Windows for current session ===

function _loadWindows(bodyEl, parentContainer) {
  var _skHtml = '<div class="windows-list">';
  for (var _ski = 0; _ski < 4; _ski++) {
    _skHtml +=
      '<div class="skeleton-card">' +
      '<div class="skeleton-row"><div class="skeleton skeleton-title"></div><div class="skeleton skeleton-badge"></div></div>' +
      '<div class="skeleton-row" style="gap:6px"><div class="skeleton skeleton-badge" style="width:80px"></div><div class="skeleton skeleton-badge" style="width:50px"></div></div>' +
      '<div class="skeleton skeleton-thumb"></div>' +
      '</div>';
  }
  _skHtml += '</div>';
  bodyEl.innerHTML = _skHtml;

  api
    .get('/api/sessions/' + encodeURIComponent(state.currentSession) + '/windows')
    .then(function (result) {
      var windows = result.data || [];
      state.windows = windows;

      // Compute snapshot order using the pure sort function (if module loaded).
      if (typeof window.sortWindowsForSnapshot === 'function') {
        var orderIds = window.sortWindowsForSnapshot(windows, {
          pinsById: state.pinsById || {},
          promotedBellIds: (state.promotedBellIdsBySession && state.promotedBellIdsBySession[state.currentSession]) || [],
        });
        state.windowOrderBySession = state.windowOrderBySession || {};
        state.windowOrderBySession[state.currentSession] = orderIds;

        // Reorder windows array to match the snapshot.
        var byId = {};
        windows.forEach(function (w) { byId[w.id] = w; });
        windows = orderIds.map(function (id) { return byId[id]; }).filter(Boolean);
        state.windows = windows;
      }

      if (windows.length === 0) {
        bodyEl.innerHTML =
          '<div class="windows-empty">' +
          '<p style="font-size: 1.1rem; margin-bottom: 8px;">No windows</p>' +
          '<p style="color: var(--text-muted);">Create a new window to get started.</p>' +
          '</div>';
        return;
      }

      var html = '<div class="windows-list">';
      windows.forEach(function (w) {
        html += _buildWindowCard(w);
      });
      html += '</div>';
      bodyEl.innerHTML = html;

      _attachWindowHandlers(bodyEl, parentContainer);
      _fetchPaneThumbnails(bodyEl, windows);
    })
    .catch(function (err) {
      bodyEl.innerHTML =
        '<div class="windows-empty">' +
        '<p style="color: var(--accent-red);">Failed to load windows</p>' +
        '<p style="color: var(--text-muted);">' + escapeHtml(err.message) + '</p>' +
        '</div>';
    });
}

// === Build Window Card ===

function _buildWindowCard(w) {
  var commandBadgeClass = _getCommandBadgeClass(w.command);
  var shortPath = _shortenPath(w.path);
  var paneCount = w.panes || 0;

  // Notification indicator
  var notificationKey = (state.currentSession || '') + ':' + w.index;
  var hasNotification = typeof _windowNotifications !== 'undefined' && _windowNotifications[notificationKey];
  var cardExtraClass = hasNotification ? ' window-card-notified' : '';

  // Pane completion info
  var paneInfo = typeof _getPaneCompletionInfo === 'function'
    ? _getPaneCompletionInfo(state.currentSession, w.index) : { total: 0, completed: 0 };
  var completionHtml = paneInfo.completed > 0
    ? '<span class="window-card-completion">' + paneInfo.completed + '/' + paneInfo.total + ' \u2713</span>' : '';

  // Pane info is now rendered inside the thumbnail preview below

  return (
    '<div class="swipe-container" data-window-index="' + w.index + '" data-window-id="' + escapeHtml(w.id || '') + '" data-window-name="' + escapeHtml(w.name || '') + '">' +
    '<div class="swipe-actions">' +
    '<button class="btn swipe-action-move" data-window-index="' + w.index + '" data-window-id="' + escapeHtml(w.id || '') + '">Move</button>' +
    '<button class="btn swipe-action-rename" data-window-index="' + w.index + '" data-window-id="' + escapeHtml(w.id || '') + '">Rename</button>' +
    '<button class="btn btn-danger swipe-action-delete" data-window-index="' + w.index + '" data-window-id="' + escapeHtml(w.id || '') + '">Delete</button>' +
    '</div>' +
    '<div class="window-card card' + cardExtraClass + '" data-window-index="' + w.index + '" data-window-id="' + escapeHtml(w.id || '') + '">' +
    '<div class="window-card-header">' +
    '<strong class="window-card-name">' + escapeHtml(w.index + ': ' + (w.name || '')) + '</strong>' +
    completionHtml +
    '<span class="command-badge ' + commandBadgeClass + '">' + escapeHtml(w.command || 'unknown') + '</span>' +
    '</div>' +
    '<div class="window-card-meta">' +
    '<span class="tag">' + escapeHtml(shortPath) + '</span>' +
    '<span class="tag">' + paneCount + ' pane' + (paneCount !== 1 ? 's' : '') + '</span>' +
    '</div>' +
    '<div class="pane-thumbnail" data-thumb-index="' + w.index + '"></div>' +
    '</div>' +
    '</div>'
  );
}

function _getCommandBadgeClass(command) {
  if (!command) return 'command-badge-gray';
  var cmd = command.toLowerCase();
  if (cmd === 'claude') return 'command-badge-green';
  if (cmd === 'zsh' || cmd === 'bash') return 'command-badge-yellow';
  if (cmd === 'ssh') return 'command-badge-blue';
  return 'command-badge-gray';
}

function _shortenPath(path) {
  if (!path) return '';
  return path.replace(/^\/home\/yuebiao/, '~');
}

// === Pane Thumbnails ===

function _fetchPaneThumbnails(view, windows) {
  // Get pane detail data from WebSocket state
  var sessionData = state.sessions.find(function (s) { return s.name === state.currentSession; });

  windows.forEach(function (w) {
    api
      .get('/api/sessions/' + encodeURIComponent(state.currentSession) + '/windows/' + encodeURIComponent(w.index) + '/panes')
      .then(function (result) {
        var panes = result.data || [];
        var thumbEl = view.querySelector('[data-thumb-index="' + w.index + '"]');
        if (!thumbEl) return;

        if (panes.length === 0) return;

        // Get pane command/port info from WebSocket data
        var wd = sessionData && sessionData.windowDetails
          ? sessionData.windowDetails.find(function (d) { return d.index === w.index; })
          : null;
        var paneDetails = wd && wd.panes ? wd.panes : [];
        var detailById = {};
        paneDetails.forEach(function (pd) { detailById[pd.id] = pd; });

        var maxRight = 0;
        var maxBottom = 0;
        panes.forEach(function (p) {
          var pL = p.left != null ? p.left : (p.x || 0);
          var pT = p.top != null ? p.top : (p.y || 0);
          var right = pL + (p.width || 1);
          var bottom = pT + (p.height || 1);
          if (right > maxRight) maxRight = right;
          if (bottom > maxBottom) maxBottom = bottom;
        });

        if (maxRight === 0 || maxBottom === 0) return;

        var html = '';
        var colors = [
          'rgba(122, 162, 247, 0.25)',
          'rgba(158, 206, 106, 0.25)',
          'rgba(187, 154, 247, 0.25)',
          'rgba(224, 175, 104, 0.25)',
          'rgba(247, 118, 142, 0.25)',
        ];
        panes.forEach(function (p, i) {
          var pL = p.left != null ? p.left : (p.x || 0);
          var pT = p.top != null ? p.top : (p.y || 0);
          var leftPct = (pL / maxRight * 100).toFixed(1);
          var topPct = (pT / maxBottom * 100).toFixed(1);
          var widthPct = ((p.width || 1) / maxRight * 100).toFixed(1);
          var heightPct = ((p.height || 1) / maxBottom * 100).toFixed(1);
          var color = colors[i % colors.length];

          // Get command/port info for this pane
          var detail = detailById[p.id] || {};
          var cmd = detail.command || p.command || '';
          var ports = detail.ports || [];
          var portHtml = ports.length > 0
            ? ports.map(function (port) {
                return '<span class="pane-thumb-port" data-port="' + port + '">:' + port + '</span>';
              }).join('')
            : '';
          var isCompleted = typeof _isPaneCompleted === 'function' &&
            _isPaneCompleted(state.currentSession, w.index, p.id);

          html +=
            '<div class="pane-thumb-cell" data-pane-id="' + (p.id || '') + '"' +
            ' data-window-index="' + w.index + '"' +
            ' style="' +
            'left:' + leftPct + '%;' +
            'top:' + topPct + '%;' +
            'width:' + widthPct + '%;' +
            'height:' + heightPct + '%;' +
            'background:' + color + ';">' +
            '<span class="pane-thumb-cmd' + (isCompleted ? ' pane-thumb-completed' : '') + '">' +
            escapeHtml(cmd) + (isCompleted ? ' ✓' : '') +
            '</span>' +
            portHtml +
            '</div>';
        });
        thumbEl.innerHTML = html;

        // Bind pane thumbnail click → navigate to that pane
        thumbEl.querySelectorAll('.pane-thumb-cell').forEach(function (cell) {
          cell.addEventListener('click', function (e) {
            e.stopPropagation();
            var paneId = cell.getAttribute('data-pane-id');
            var winIdx = cell.getAttribute('data-window-index');
            if (paneId) {
              navigate('terminal', { currentWindow: winIdx, currentPane: paneId });
            }
          });
        });

        // Bind port click in thumbnails
        thumbEl.querySelectorAll('.pane-thumb-port').forEach(function (el) {
          el.addEventListener('click', function (e) {
            e.stopPropagation();
            var port = el.getAttribute('data-port');
            if (typeof _showPortMenu === 'function') _showPortMenu(e, port);
          });
        });
      })
      .catch(function () {
        // Silently ignore thumbnail fetch errors
      });
  });
}

// === Event Handlers ===

function _attachWindowHandlers(view, container) {
  view.querySelectorAll('.window-card').forEach(function (card) {
    card.addEventListener('click', function (e) {
      if (e.defaultPrevented) return;
      var windowIndex = card.getAttribute('data-window-index');
      var windowId = card.getAttribute('data-window-id');
      if (!windowIndex) return;

      // C2 transitional: panes API still keyed by index. Re-fetch the index
      // from live tmux state right before the call to minimize stale-index risk.
      api.get('/api/sessions/' + encodeURIComponent(state.currentSession) + '/windows')
        .then(function (result) {
          var wins = result.data || [];
          var live = windowId ? wins.find(function (w) { return w.id === windowId; }) : null;
          var liveIndex = live ? String(live.index) : windowIndex;

          return api.get(
            '/api/sessions/' + encodeURIComponent(state.currentSession) +
            '/windows/' + encodeURIComponent(liveIndex) + '/panes'
          ).then(function (paneResult) {
            var panes = paneResult.data || [];
            var firstPaneId = panes.length > 0 ? panes[0].id : null;
            navigate('terminal', { currentWindow: liveIndex, currentPane: firstPaneId });
          });
        })
        .catch(function () {
          navigate('terminal', { currentWindow: windowIndex, currentPane: null });
        });
    });
  });

  _initWindowSwipe(view, container);
  _initWindowContextMenu(view, container);
}

// === Swipe to Action (Mobile) ===

function _initWindowSwipe(view, container) {
  var activeSwipe = null;
  var startX = 0;
  var startY = 0;
  var currentX = 0;
  var swiping = false;
  var longPressTimer = null;
  var longPressFired = false;
  var THRESHOLD = 60;
  var LONG_PRESS_MS = 500;
  var MOVE_CANCEL_PX = 10;

  view.addEventListener('touchstart', function (e) {
    var swipeContainer = e.target.closest('.swipe-container');
    if (!swipeContainer) return;

    if (activeSwipe && activeSwipe !== swipeContainer) {
      _resetWindowSwipe(activeSwipe);
    }

    var touch = e.touches[0];
    startX = touch.clientX;
    startY = touch.clientY;
    currentX = 0;
    swiping = false;
    longPressFired = false;
    activeSwipe = swipeContainer;

    longPressTimer = setTimeout(function () {
      longPressFired = true;
      longPressTimer = null;
      _showMobileContextMenu(swipeContainer, container, startX, startY);
    }, LONG_PRESS_MS);
  }, { passive: true });

  view.addEventListener('touchmove', function (e) {
    if (!activeSwipe) return;

    var touch = e.touches[0];
    var dx = touch.clientX - startX;
    var dy = touch.clientY - startY;

    if (Math.abs(dx) > MOVE_CANCEL_PX || Math.abs(dy) > MOVE_CANCEL_PX) {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    }

    if (longPressFired) return; // suppress swipe after long-press

    if (!swiping && Math.abs(dy) > Math.abs(dx)) {
      activeSwipe = null;
      return;
    }

    swiping = true;
    currentX = Math.min(0, Math.max(-220, dx));

    var card = activeSwipe.querySelector('.window-card');
    if (card) {
      card.style.transform = 'translateX(' + currentX + 'px)';
      card.style.transition = 'none';
    }
  }, { passive: true });

  view.addEventListener('touchend', function () {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    if (longPressFired) {
      longPressFired = false;
      activeSwipe = null;
      return;
    }
    if (!activeSwipe) return;

    var card = activeSwipe.querySelector('.window-card');
    if (!card) {
      activeSwipe = null;
      return;
    }

    card.style.transition = 'transform 0.2s ease';

    if (currentX < -THRESHOLD) {
      card.style.transform = 'translateX(-200px)';
      _attachWindowSwipeActionHandlers(activeSwipe, container);
    } else {
      card.style.transform = 'translateX(0)';
    }

    swiping = false;
  }, { passive: true });

  document.addEventListener('touchstart', function (e) {
    if (activeSwipe && !activeSwipe.contains(e.target)) {
      _resetWindowSwipe(activeSwipe);
      activeSwipe = null;
    }
  }, { passive: true });
}

function _showMobileContextMenu(swipeContainer, container, x, y) {
  var windowId = swipeContainer.getAttribute('data-window-id');
  var windowIndex = swipeContainer.getAttribute('data-window-index');
  var isPinned = !!(state.pinsById && state.pinsById[windowId]);

  var menu = document.getElementById('window-context-menu');
  if (!menu) return;

  menu.querySelector('[data-action="pin"]').textContent = isPinned ? 'Unpin' : 'Pin to top';
  _ctxTargetIndex = windowIndex;
  _ctxTargetId = windowId;
  _ctxContainer = container;

  menu.style.display = 'block';
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  var rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top = (y - rect.height) + 'px';
}

function _resetWindowSwipe(swipeContainer) {
  var card = swipeContainer.querySelector('.window-card');
  if (card) {
    card.style.transition = 'transform 0.2s ease';
    card.style.transform = 'translateX(0)';
  }
}

function _attachWindowSwipeActionHandlers(swipeContainer, parentContainer) {
  var windowIndex = swipeContainer.getAttribute('data-window-index');
  var windowId = swipeContainer.getAttribute('data-window-id');

  var renameBtn = swipeContainer.querySelector('.swipe-action-rename');
  var deleteBtn = swipeContainer.querySelector('.swipe-action-delete');
  var moveBtn = swipeContainer.querySelector('.swipe-action-move');

  if (renameBtn) {
    renameBtn.onclick = function (e) {
      e.preventDefault();
      e.stopPropagation();
      _renameWindow(windowIndex, windowId, parentContainer);
    };
  }

  if (deleteBtn) {
    deleteBtn.onclick = function (e) {
      e.preventDefault();
      e.stopPropagation();
      _deleteWindow(windowIndex, windowId, parentContainer);
    };
  }

  if (moveBtn) {
    moveBtn.onclick = function (e) {
      e.preventDefault();
      e.stopPropagation();
      _moveWindow(windowIndex, windowId, parentContainer);
    };
  }
}

// === Context Menu (PC) ===

// Singleton context menu state — auto-initialized via IIFE
var _ctxMenu = null;
var _ctxContainer = null;
var _ctxTargetIndex = null;
var _ctxTargetId = null;

function _initWindowContextMenu(view, container) {
  _ctxContainer = container;
}

(function () {

  var menu = document.createElement('div');
  menu.id = 'window-context-menu';
  menu.className = 'context-menu';
  menu.style.display = 'none';
  menu.innerHTML =
    '<div class="context-menu-item" data-action="pin"></div>' +
    '<div class="context-menu-item" data-action="move">Move to session…</div>' +
    '<div class="context-menu-item" data-action="rename">Rename</div>' +
    '<div class="context-menu-item context-menu-item-danger" data-action="delete">Delete</div>';
  document.body.appendChild(menu);
  _ctxMenu = menu;

  // Capture phase — fires before browser can show native menu
  document.addEventListener('contextmenu', function (e) {
    var swipeContainer = e.target.closest('.swipe-container[data-window-id]');
    if (!swipeContainer) {
      menu.style.display = 'none';
      return;
    }

    e.preventDefault();
    e.stopImmediatePropagation();
    _ctxTargetIndex = swipeContainer.getAttribute('data-window-index');
    _ctxTargetId = swipeContainer.getAttribute('data-window-id');

    var pinItem = menu.querySelector('[data-action="pin"]');
    var isPinned = state.pinsById && state.pinsById[_ctxTargetId];
    pinItem.textContent = isPinned ? 'Unpin' : 'Pin to top';

    menu.style.display = 'block';
    menu.style.left = e.pageX + 'px';
    menu.style.top = e.pageY + 'px';

    var rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (e.pageX - rect.width) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (e.pageY - rect.height) + 'px';
  }, true); // capture phase

  menu.addEventListener('click', function (e) {
    var item = e.target.closest('.context-menu-item');
    if (!item || !_ctxTargetIndex) return;

    var action = item.getAttribute('data-action');
    menu.style.display = 'none';

    if (action === 'rename') {
      _renameWindow(_ctxTargetIndex, _ctxTargetId, _ctxContainer);
    } else if (action === 'delete') {
      _deleteWindow(_ctxTargetIndex, _ctxTargetId, _ctxContainer);
    } else if (action === 'pin') {
      _togglePin(_ctxTargetId, function () { renderWindows(_ctxContainer); });
    } else if (action === 'move') {
      _moveWindow(_ctxTargetIndex, _ctxTargetId, _ctxContainer);
    }
  });

  document.addEventListener('click', function () {
    menu.style.display = 'none';
  });
})();

// === Window Actions ===

function _renameWindow(windowIndex, windowId, container) {
  var currentName = '';
  var sc = document.querySelector('.swipe-container[data-window-id="' + windowId + '"]');
  if (sc) currentName = sc.getAttribute('data-window-name') || '';

  showPrompt({ title: '重命名窗口 ' + windowIndex, placeholder: '新名称', value: currentName })
    .then(function (newName) {
      if (!newName || !newName.trim()) return;
      return api.put(
        '/api/sessions/' + encodeURIComponent(state.currentSession) + '/windows/by-id/' + encodeURIComponent(windowId),
        { newName: newName.trim() }
      );
    })
    .then(function (result) {
      if (result) renderWindows(container);
    })
    .catch(function (err) {
      if (err.message && err.message.indexOf('moved_window') >= 0) {
        showAlert({ title: '重命名失败', message: '窗口已被移到其它会话，请刷新后重试。' });
      } else {
        showAlert({ title: '重命名失败', message: err.message });
      }
    });
}

function _deleteWindow(windowIndex, windowId, container) {
  showConfirm({ title: '删除窗口', message: '确定删除窗口 ' + windowIndex + '？此操作不可撤销。', confirmText: '删除', danger: true })
    .then(function (confirmed) {
      if (!confirmed) return;
      return api.delete(
        '/api/sessions/' + encodeURIComponent(state.currentSession) + '/windows/by-id/' + encodeURIComponent(windowId)
      );
    })
    .then(function (result) {
      if (!result) return;
      if (typeof _fontOffsets !== 'undefined' && typeof _saveFontOffsets === 'function') {
        var wKey = (state.currentSession || '') + ':' + windowIndex;
        delete _fontOffsets[wKey];
        _saveFontOffsets();
      }
      renderWindows(container);
    })
    .catch(function (err) {
      if (err.message && err.message.indexOf('moved_window') >= 0) {
        showAlert({ title: '删除失败', message: '窗口已被移到其它会话，请刷新后重试。' });
      } else {
        showAlert({ title: '删除失败', message: err.message });
      }
    });
}

/**
 * Show a list of sessions (excluding `excludeSession`) and resolve with the picked name,
 * or null if cancelled.
 * @returns {Promise<string|null>}
 */
function _showSessionPicker(excludeSession) {
  return new Promise(function (resolve) {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    var box = document.createElement('div');
    box.className = 'modal-box';

    var titleEl = document.createElement('div');
    titleEl.className = 'modal-title';
    titleEl.textContent = '选择目标会话';
    box.appendChild(titleEl);

    var list = document.createElement('div');
    list.className = 'session-picker-list';

    var sessions = (state.sessions || []).filter(function (s) { return s.name !== excludeSession; });
    if (sessions.length === 0) {
      var emptyMsg = document.createElement('div');
      emptyMsg.className = 'modal-message';
      emptyMsg.textContent = '没有可选的目标会话。';
      box.appendChild(emptyMsg);
    } else {
      sessions.forEach(function (s) {
        var item = document.createElement('button');
        item.className = 'session-picker-item';
        item.textContent = s.name + '  (' + s.windows + ' window' + (s.windows !== 1 ? 's' : '') + ')';
        item.addEventListener('click', function () {
          overlay.remove();
          resolve(s.name);
        });
        list.appendChild(item);
      });
      box.appendChild(list);
    }

    var actions = document.createElement('div');
    actions.className = 'modal-actions';
    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'modal-btn modal-cancel';
    cancelBtn.textContent = '取消';
    cancelBtn.addEventListener('click', function () { overlay.remove(); resolve(null); });
    actions.appendChild(cancelBtn);
    box.appendChild(actions);

    overlay.appendChild(box);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) { overlay.remove(); resolve(null); }
    });

    document.body.appendChild(overlay);
  });
}

function _moveWindow(windowIndex, windowId, container) {
  _showSessionPicker(state.currentSession).then(function (targetSession) {
    if (!targetSession) return;
    return _doMove(windowIndex, windowId, targetSession, false, function () {
      renderWindows(container);
    });
  });
}

function _doMove(windowIndex, windowId, targetSession, confirmDestroy, refreshFn) {
  var body = { targetSession: targetSession };
  if (confirmDestroy) body.confirmDestroySource = true;

  return api.post(
    '/api/sessions/' + encodeURIComponent(state.currentSession) + '/windows/by-id/' + encodeURIComponent(windowId) + '/move',
    body
  ).then(function (result) {
    if (!result) return;
    // Invalidate cached order for both source and target sessions so they re-snapshot
    if (state.windowOrderBySession) {
      delete state.windowOrderBySession[state.currentSession];
      delete state.windowOrderBySession[targetSession];
    }
    if (typeof refreshFn === 'function') refreshFn();
  }).catch(function (err) {
    var msg = err.message || '';
    if (msg.indexOf('requires_confirmation') >= 0) {
      return showConfirm({
        title: '销毁源会话',
        message: '这会销毁会话 ' + state.currentSession + '，继续？',
        confirmText: '继续',
        danger: true,
      }).then(function (ok) {
        if (ok) return _doMove(windowIndex, windowId, targetSession, true, refreshFn);
      });
    }
    if (msg.indexOf('moved_window') >= 0) {
      showAlert({ title: '移动失败', message: '窗口已被移到其它会话，请刷新后重试。' });
      return;
    }
    showAlert({ title: '移动失败', message: msg });
  });
}

function _togglePin(windowId, refreshFn) {
  if (!windowId) return;
  var currentlyPinned = !!(state.pinsById && state.pinsById[windowId]);
  var nextPinned = !currentlyPinned;

  api.put('/api/pins/' + encodeURIComponent(windowId), { pinned: nextPinned })
    .then(function () {
      return api.get('/api/pins');
    })
    .then(function (res) {
      state.pinsById = {};
      var pins = (res.data && res.data.pins) || [];
      pins.forEach(function (id) { state.pinsById[id] = true; });
      // Force a full re-snapshot for current session
      if (state.windowOrderBySession) {
        delete state.windowOrderBySession[state.currentSession];
      }
      if (typeof refreshFn === 'function') refreshFn();
    })
    .catch(function (err) {
      showAlert({ title: 'Pin 失败', message: err.message });
    });
}

// === Re-render hook used by WS reconcile (Task 8) ===
//
// Called when the live window-id set diverges from the cached snapshot
// (window created/killed/moved). Triggers a fresh fetch + snapshot.
window.rerenderCurrentWindowsView = function () {
  var view = document.querySelector('.windows-view');
  if (!view || !state.currentSession) return;
  var container = view.parentElement;
  if (container) renderWindows(container);
};

// === DOM splice for bell-rising-edge promotion (Task 8 + sidebar) ===
//
// Moves the item for `windowId` to just below the pinned tier (top of Tier 2)
// without re-fetching or re-rendering. Pinned items are not promoted (they
// already sit higher). Works on any flat list of items selected by itemSelector.
function _splicePromotedInList(listEl, itemSelector, windowId) {
  if (!listEl) return;
  var item = listEl.querySelector(itemSelector + '[data-window-id="' + windowId + '"]');
  if (!item) return;

  // Count leading pinned items to know where Tier 2 starts.
  var pinnedCount = 0;
  for (var i = 0; i < listEl.children.length; i++) {
    var id = listEl.children[i].getAttribute('data-window-id');
    if (id && state.pinsById && state.pinsById[id]) {
      pinnedCount++;
    } else {
      break;
    }
  }
  var target = listEl.children[pinnedCount] || null;
  if (target === item) return; // already at top of non-pinned region

  listEl.insertBefore(item, target);
}

window.spliceBellPromoted = function (windowId) {
  if (!windowId) return;
  if (state.pinsById && state.pinsById[windowId]) return;

  // Card view（当前在 Windows tab 时存在）
  _splicePromotedInList(document.querySelector('.windows-list'), '.swipe-container', windowId);

  // Sidebar windows（每个展开的 session group 一个 .sidebar-windows 容器）
  document.querySelectorAll('.sidebar-windows').forEach(function (listEl) {
    _splicePromotedInList(listEl, '.sidebar-window-item', windowId);
  });
};
