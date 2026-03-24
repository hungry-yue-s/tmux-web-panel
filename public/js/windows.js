/* global api, state, navigate, escapeHtml, updateSidebar, updateTopbarSession */

// === Windows View ===

function renderWindows(container) {
  container.innerHTML =
    '<div class="windows-view">' +
    '<div class="windows-body">' +
    '<div class="spinner"></div>' +
    '<p>Loading...</p>' +
    '</div>' +
    '</div>';

  var bodyEl = container.querySelector('.windows-body');

  // Fetch sessions to validate current session, then load windows
  api
    .get('/api/sessions')
    .then(function (result) {
      var sessions = result.data || [];
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
  bodyEl.innerHTML =
    '<div class="spinner"></div><p style="text-align:center;color:var(--text-muted);">Loading windows...</p>';

  api
    .get('/api/sessions/' + encodeURIComponent(state.currentSession) + '/windows')
    .then(function (result) {
      var windows = result.data || [];
      state.windows = windows;

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

  return (
    '<div class="swipe-container" data-window-index="' + w.index + '" data-window-name="' + escapeHtml(w.name || '') + '">' +
    '<div class="swipe-actions">' +
    '<button class="btn swipe-action-rename" data-window-index="' + w.index + '">Rename</button>' +
    '<button class="btn btn-danger swipe-action-delete" data-window-index="' + w.index + '">Delete</button>' +
    '</div>' +
    '<div class="window-card card" data-window-index="' + w.index + '">' +
    '<div class="window-card-header">' +
    '<strong class="window-card-name">' + escapeHtml(w.index + ': ' + (w.name || '')) + '</strong>' +
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
  windows.forEach(function (w) {
    api
      .get('/api/sessions/' + encodeURIComponent(state.currentSession) + '/windows/' + encodeURIComponent(w.index) + '/panes')
      .then(function (result) {
        var panes = result.data || [];
        var thumbEl = view.querySelector('[data-thumb-index="' + w.index + '"]');
        if (!thumbEl) return;

        if (panes.length === 0) return;

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
        var colors = ['var(--accent-blue)', 'var(--accent-green)', 'var(--accent-purple)', 'var(--accent-yellow)', 'var(--accent-red)'];
        panes.forEach(function (p, i) {
          var pL = p.left != null ? p.left : (p.x || 0);
          var pT = p.top != null ? p.top : (p.y || 0);
          var leftPct = (pL / maxRight * 100).toFixed(1);
          var topPct = (pT / maxBottom * 100).toFixed(1);
          var widthPct = ((p.width || 1) / maxRight * 100).toFixed(1);
          var heightPct = ((p.height || 1) / maxBottom * 100).toFixed(1);
          var color = colors[i % colors.length];
          html +=
            '<div class="pane-thumb-cell" style="' +
            'left:' + leftPct + '%;' +
            'top:' + topPct + '%;' +
            'width:' + widthPct + '%;' +
            'height:' + heightPct + '%;' +
            'background:' + color + ';">' +
            '</div>';
        });
        thumbEl.innerHTML = html;
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
      if (!windowIndex) return;

      api
        .get('/api/sessions/' + encodeURIComponent(state.currentSession) + '/windows/' + encodeURIComponent(windowIndex) + '/panes')
        .then(function (result) {
          var panes = result.data || [];
          var firstPaneId = panes.length > 0 ? panes[0].id : null;
          navigate('terminal', { currentWindow: windowIndex, currentPane: firstPaneId });
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
  var THRESHOLD = 60;

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
    activeSwipe = swipeContainer;
  }, { passive: true });

  view.addEventListener('touchmove', function (e) {
    if (!activeSwipe) return;

    var touch = e.touches[0];
    var dx = touch.clientX - startX;
    var dy = touch.clientY - startY;

    if (!swiping && Math.abs(dy) > Math.abs(dx)) {
      activeSwipe = null;
      return;
    }

    swiping = true;
    currentX = Math.min(0, Math.max(-160, dx));

    var card = activeSwipe.querySelector('.window-card');
    if (card) {
      card.style.transform = 'translateX(' + currentX + 'px)';
      card.style.transition = 'none';
    }
  }, { passive: true });

  view.addEventListener('touchend', function () {
    if (!activeSwipe) return;

    var card = activeSwipe.querySelector('.window-card');
    if (!card) {
      activeSwipe = null;
      return;
    }

    card.style.transition = 'transform 0.2s ease';

    if (currentX < -THRESHOLD) {
      card.style.transform = 'translateX(-140px)';
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

function _resetWindowSwipe(swipeContainer) {
  var card = swipeContainer.querySelector('.window-card');
  if (card) {
    card.style.transition = 'transform 0.2s ease';
    card.style.transform = 'translateX(0)';
  }
}

function _attachWindowSwipeActionHandlers(swipeContainer, parentContainer) {
  var windowIndex = swipeContainer.getAttribute('data-window-index');

  var renameBtn = swipeContainer.querySelector('.swipe-action-rename');
  var deleteBtn = swipeContainer.querySelector('.swipe-action-delete');

  if (renameBtn) {
    renameBtn.onclick = function (e) {
      e.preventDefault();
      e.stopPropagation();
      _renameWindow(windowIndex, parentContainer);
    };
  }

  if (deleteBtn) {
    deleteBtn.onclick = function (e) {
      e.preventDefault();
      e.stopPropagation();
      _deleteWindow(windowIndex, parentContainer);
    };
  }
}

// === Context Menu (PC) ===

function _initWindowContextMenu(view, container) {
  var existing = document.getElementById('window-context-menu');
  if (existing) existing.remove();

  var menu = document.createElement('div');
  menu.id = 'window-context-menu';
  menu.className = 'context-menu';
  menu.style.display = 'none';
  menu.innerHTML =
    '<div class="context-menu-item" data-action="rename">Rename</div>' +
    '<div class="context-menu-item context-menu-item-danger" data-action="delete">Delete</div>';
  document.body.appendChild(menu);

  var targetIndex = null;

  view.addEventListener('contextmenu', function (e) {
    var swipeContainer = e.target.closest('.swipe-container');
    if (!swipeContainer) return;

    e.preventDefault();
    targetIndex = swipeContainer.getAttribute('data-window-index');

    menu.style.display = 'block';
    menu.style.left = e.pageX + 'px';
    menu.style.top = e.pageY + 'px';

    var rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.left = (e.pageX - rect.width) + 'px';
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = (e.pageY - rect.height) + 'px';
    }
  });

  menu.addEventListener('click', function (e) {
    var item = e.target.closest('.context-menu-item');
    if (!item || !targetIndex) return;

    var action = item.getAttribute('data-action');
    menu.style.display = 'none';

    if (action === 'rename') {
      _renameWindow(targetIndex, container);
    } else if (action === 'delete') {
      _deleteWindow(targetIndex, container);
    }
  });

  document.addEventListener('click', function () {
    menu.style.display = 'none';
  });

  document.addEventListener('contextmenu', function (e) {
    if (!view.contains(e.target)) {
      menu.style.display = 'none';
    }
  });
}

// === Window Actions ===

function _renameWindow(windowIndex, container) {
  var newName = prompt('New name for window ' + windowIndex + ':');
  if (!newName || !newName.trim()) return;

  api
    .put(
      '/api/sessions/' + encodeURIComponent(state.currentSession) + '/windows/' + encodeURIComponent(windowIndex),
      { newName: newName.trim() }
    )
    .then(function () {
      renderWindows(container);
    })
    .catch(function (err) {
      alert('Failed to rename window: ' + err.message);
    });
}

function _deleteWindow(windowIndex, container) {
  var confirmed = confirm('Delete window ' + windowIndex + '? This cannot be undone.');
  if (!confirmed) return;

  api
    .delete('/api/sessions/' + encodeURIComponent(state.currentSession) + '/windows/' + encodeURIComponent(windowIndex))
    .then(function () {
      renderWindows(container);
    })
    .catch(function (err) {
      alert('Failed to delete window: ' + err.message);
    });
}
