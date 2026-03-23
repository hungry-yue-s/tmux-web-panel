/* global api, state, navigate, escapeHtml */

// === Windows View ===

function renderWindows(container) {
  if (!state.currentSession) {
    navigate('sessions');
    return;
  }

  container.innerHTML =
    '<div class="windows-view">' +
    '<div class="windows-header">' +
    '<button class="btn windows-back-btn">&larr; ' + escapeHtml(state.currentSession) + '</button>' +
    '<button class="btn btn-primary windows-add-btn">+ Window</button>' +
    '</div>' +
    '<div class="windows-search">' +
    '<input class="input search-input" type="text" placeholder="Search windows...">' +
    '</div>' +
    '<div class="windows-loading">' +
    '<div class="spinner"></div>' +
    '<p>Loading windows...</p>' +
    '</div>' +
    '</div>';

  var view = container.querySelector('.windows-view');

  // Back button
  view.querySelector('.windows-back-btn').addEventListener('click', function () {
    navigate('sessions');
  });

  // Add window button
  view.querySelector('.windows-add-btn').addEventListener('click', function () {
    var name = prompt('Window name (leave empty for default):');
    if (name === null) return;

    var body = {};
    if (name.trim()) {
      body.name = name.trim();
    }

    api
      .post('/api/sessions/' + encodeURIComponent(state.currentSession) + '/windows', body)
      .then(function () {
        renderWindows(container);
      })
      .catch(function (err) {
        alert('Failed to create window: ' + err.message);
      });
  });

  // Search handler
  var searchInput = view.querySelector('.search-input');
  searchInput.addEventListener('input', function () {
    _filterWindows(view, searchInput.value.trim().toLowerCase());
  });

  // Fetch windows
  api
    .get('/api/sessions/' + encodeURIComponent(state.currentSession) + '/windows')
    .then(function (result) {
      var windows = result.data || [];
      state.windows = windows;

      var loadingEl = view.querySelector('.windows-loading');
      if (loadingEl) loadingEl.remove();

      if (windows.length === 0) {
        var emptyEl = document.createElement('div');
        emptyEl.className = 'windows-empty';
        emptyEl.innerHTML =
          '<p style="font-size: 1.1rem; margin-bottom: 8px;">No windows</p>' +
          '<p style="color: var(--text-muted);">Create a new window to get started.</p>';
        view.appendChild(emptyEl);
        return;
      }

      var listEl = document.createElement('div');
      listEl.className = 'windows-list';
      var html = '';
      windows.forEach(function (w) {
        html += _buildWindowCard(w);
      });
      listEl.innerHTML = html;
      view.appendChild(listEl);

      _attachWindowHandlers(view, container);
      _fetchPaneThumbnails(view, windows);
    })
    .catch(function (err) {
      var loadingEl = view.querySelector('.windows-loading');
      if (loadingEl) loadingEl.remove();

      var errEl = document.createElement('div');
      errEl.className = 'windows-empty';
      errEl.innerHTML =
        '<p style="color: var(--accent-red);">Failed to load windows</p>' +
        '<p style="color: var(--text-muted);">' + escapeHtml(err.message) + '</p>';
      view.appendChild(errEl);
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
    '<button class="btn btn-primary swipe-action-split" data-window-index="' + w.index + '">Split</button>' +
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

        // Calculate bounding box
        var maxRight = 0;
        var maxBottom = 0;
        panes.forEach(function (p) {
          var right = (p.left || 0) + (p.width || 1);
          var bottom = (p.top || 0) + (p.height || 1);
          if (right > maxRight) maxRight = right;
          if (bottom > maxBottom) maxBottom = bottom;
        });

        if (maxRight === 0 || maxBottom === 0) return;

        var html = '';
        var colors = ['var(--accent-blue)', 'var(--accent-green)', 'var(--accent-purple)', 'var(--accent-yellow)', 'var(--accent-red)'];
        panes.forEach(function (p, i) {
          var leftPct = ((p.left || 0) / maxRight * 100).toFixed(1);
          var topPct = ((p.top || 0) / maxBottom * 100).toFixed(1);
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

// === Filter Windows ===

function _filterWindows(view, query) {
  var containers = view.querySelectorAll('.swipe-container[data-window-index]');
  containers.forEach(function (el) {
    var name = (el.getAttribute('data-window-name') || '').toLowerCase();
    var index = el.getAttribute('data-window-index') || '';
    if (!query || name.indexOf(query) !== -1 || index.indexOf(query) !== -1) {
      el.style.display = '';
    } else {
      el.style.display = 'none';
    }
  });
}

// === Event Handlers ===

function _attachWindowHandlers(view, container) {
  // Click to navigate to terminal
  view.querySelectorAll('.window-card').forEach(function (card) {
    card.addEventListener('click', function (e) {
      if (e.defaultPrevented) return;
      var windowIndex = card.getAttribute('data-window-index');
      if (!windowIndex) return;

      // Fetch panes and navigate to terminal with first pane
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

  // Swipe handling (mobile)
  _initWindowSwipe(view, container);

  // Context menu (PC)
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
    currentX = Math.min(0, Math.max(-200, dx));

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
      card.style.transform = 'translateX(-190px)';
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
  var splitBtn = swipeContainer.querySelector('.swipe-action-split');
  var deleteBtn = swipeContainer.querySelector('.swipe-action-delete');

  if (renameBtn) {
    renameBtn.onclick = function (e) {
      e.preventDefault();
      e.stopPropagation();
      _renameWindow(windowIndex, parentContainer);
    };
  }

  if (splitBtn) {
    splitBtn.onclick = function (e) {
      e.preventDefault();
      e.stopPropagation();
      _splitWindow(windowIndex, parentContainer);
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
    '<div class="context-menu-item" data-action="split-h">Split Horizontal</div>' +
    '<div class="context-menu-item" data-action="split-v">Split Vertical</div>' +
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
    } else if (action === 'split-h') {
      _splitWindowDirection(targetIndex, 'horizontal', container);
    } else if (action === 'split-v') {
      _splitWindowDirection(targetIndex, 'vertical', container);
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

function _splitWindow(windowIndex, container) {
  var direction = prompt('Split direction (horizontal / vertical):');
  if (!direction) return;
  direction = direction.trim().toLowerCase();
  if (direction !== 'horizontal' && direction !== 'vertical') {
    alert('Please enter "horizontal" or "vertical".');
    return;
  }
  _splitWindowDirection(windowIndex, direction, container);
}

function _splitWindowDirection(windowIndex, direction, container) {
  api
    .post(
      '/api/sessions/' + encodeURIComponent(state.currentSession) + '/windows/' + encodeURIComponent(windowIndex) + '/panes',
      { direction: direction }
    )
    .then(function () {
      renderWindows(container);
    })
    .catch(function (err) {
      alert('Failed to split window: ' + err.message);
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
