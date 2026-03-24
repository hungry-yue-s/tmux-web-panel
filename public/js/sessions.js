/* global api, state, navigate, escapeHtml, updateSidebar */

// === Sessions View ===

function renderSessions(container) {
  container.innerHTML =
    '<div class="sessions-view">' +
    '<div class="sessions-loading">' +
    '<div class="spinner"></div>' +
    '<p>Loading sessions...</p>' +
    '</div>' +
    '</div>';

  api
    .get('/api/sessions')
    .then(function (result) {
      var sessions = result.data || [];
      state.sessions = sessions;

      if (typeof updateSidebar === 'function') {
        updateSidebar();
      }

      var view = container.querySelector('.sessions-view');
      if (!view) return;

      if (sessions.length === 0) {
        view.innerHTML =
          '<div class="sessions-empty">' +
          '<p style="font-size: 1.1rem; margin-bottom: 8px;">No sessions</p>' +
          '<p style="color: var(--text-muted);">Create a new session to get started.</p>' +
          '</div>';
        return;
      }

      var html = '<div class="sessions-list">';
      sessions.forEach(function (session) {
        html += _buildSessionCard(session);
      });
      html += '</div>';
      view.innerHTML = html;

      _attachSessionHandlers(view);
      _fetchWindowPills(view, sessions);
    })
    .catch(function (err) {
      var view = container.querySelector('.sessions-view');
      if (!view) return;
      view.innerHTML =
        '<div class="sessions-empty">' +
        '<p style="color: var(--accent-red);">Failed to load sessions</p>' +
        '<p style="color: var(--text-muted);">' + escapeHtml(err.message) + '</p>' +
        '</div>';
    });
}

function _buildSessionCard(session) {
  var attachedBadge = session.attached
    ? '<span class="badge badge-green">attached</span>'
    : '<span class="badge" style="background: rgba(86,95,137,0.15); color: var(--text-muted);">detached</span>';

  return (
    '<div class="swipe-container" data-session="' + escapeHtml(session.name) + '">' +
    '<div class="swipe-actions">' +
    '<button class="btn swipe-action-rename" data-session="' + escapeHtml(session.name) + '">Rename</button>' +
    '<button class="btn btn-danger swipe-action-delete" data-session="' + escapeHtml(session.name) + '">Delete</button>' +
    '</div>' +
    '<div class="session-card card">' +
    '<div class="session-card-header">' +
    '<strong class="session-card-name">' + escapeHtml(session.name) + '</strong>' +
    attachedBadge +
    '</div>' +
    '<div class="session-card-meta">' +
    '<span class="tag">' + (session.windows || 0) + ' window' + ((session.windows || 0) !== 1 ? 's' : '') + '</span>' +
    '</div>' +
    '<div class="window-pills" data-session-pills="' + escapeHtml(session.name) + '"></div>' +
    '</div>' +
    '</div>'
  );
}

function _attachSessionHandlers(view) {
  // Click to navigate
  view.querySelectorAll('.session-card').forEach(function (card) {
    card.addEventListener('click', function (e) {
      if (e.defaultPrevented) return;
      var container = card.closest('.swipe-container');
      var sessionName = container ? container.getAttribute('data-session') : null;
      if (sessionName) {
        navigate('windows', { currentSession: sessionName });
      }
    });
  });

  // Swipe handling (mobile)
  _initSwipe(view);

  // Context menu (PC)
  _initContextMenu(view);
}

// === Window Pills ===

function _fetchWindowPills(view, sessions) {
  var MAX_PILLS = 4;

  sessions.forEach(function (session) {
    api
      .get('/api/sessions/' + encodeURIComponent(session.name) + '/windows')
      .then(function (result) {
        var windows = (result.data || []);
        var pillsContainer = view.querySelector('[data-session-pills="' + CSS.escape(session.name) + '"]');
        if (!pillsContainer) return;

        var html = '';
        var shown = windows.slice(0, MAX_PILLS);
        shown.forEach(function (w) {
          var label = w.name || w.index;
          html += '<span class="pill">' + escapeHtml(String(label)) + '</span>';
        });
        var remaining = windows.length - shown.length;
        if (remaining > 0) {
          html += '<span class="pill pill-more">+' + remaining + ' more</span>';
        }
        pillsContainer.innerHTML = html;
      })
      .catch(function () {
        // Silently ignore pill fetch errors
      });
  });
}

// === Swipe to Action (Mobile) ===

function _initSwipe(view) {
  var activeSwipe = null;
  var startX = 0;
  var startY = 0;
  var currentX = 0;
  var swiping = false;
  var THRESHOLD = 60;

  view.addEventListener('touchstart', function (e) {
    var container = e.target.closest('.swipe-container');
    if (!container) return;

    // Reset any previously swiped card
    if (activeSwipe && activeSwipe !== container) {
      _resetSwipe(activeSwipe);
    }

    var touch = e.touches[0];
    startX = touch.clientX;
    startY = touch.clientY;
    currentX = 0;
    swiping = false;
    activeSwipe = container;
  }, { passive: true });

  view.addEventListener('touchmove', function (e) {
    if (!activeSwipe) return;

    var touch = e.touches[0];
    var dx = touch.clientX - startX;
    var dy = touch.clientY - startY;

    // If vertical scroll is dominant, ignore
    if (!swiping && Math.abs(dy) > Math.abs(dx)) {
      activeSwipe = null;
      return;
    }

    swiping = true;
    // Only allow left swipe (negative dx), clamp
    currentX = Math.min(0, Math.max(-160, dx));

    var card = activeSwipe.querySelector('.session-card');
    if (card) {
      card.style.transform = 'translateX(' + currentX + 'px)';
      card.style.transition = 'none';
    }
  }, { passive: true });

  view.addEventListener('touchend', function () {
    if (!activeSwipe) return;

    var card = activeSwipe.querySelector('.session-card');
    if (!card) {
      activeSwipe = null;
      return;
    }

    card.style.transition = 'transform 0.2s ease';

    if (currentX < -THRESHOLD) {
      // Snap open
      card.style.transform = 'translateX(-140px)';
      _attachSwipeActionHandlers(activeSwipe);
    } else {
      // Snap closed
      card.style.transform = 'translateX(0)';
    }

    swiping = false;
  }, { passive: true });

  // Tap elsewhere to close
  document.addEventListener('touchstart', function (e) {
    if (activeSwipe && !activeSwipe.contains(e.target)) {
      _resetSwipe(activeSwipe);
      activeSwipe = null;
    }
  }, { passive: true });
}

function _resetSwipe(container) {
  var card = container.querySelector('.session-card');
  if (card) {
    card.style.transition = 'transform 0.2s ease';
    card.style.transform = 'translateX(0)';
  }
}

function _attachSwipeActionHandlers(container) {
  var sessionName = container.getAttribute('data-session');

  var renameBtn = container.querySelector('.swipe-action-rename');
  var deleteBtn = container.querySelector('.swipe-action-delete');

  if (renameBtn) {
    renameBtn.onclick = function (e) {
      e.preventDefault();
      e.stopPropagation();
      _renameSession(sessionName);
    };
  }

  if (deleteBtn) {
    deleteBtn.onclick = function (e) {
      e.preventDefault();
      e.stopPropagation();
      _deleteSession(sessionName);
    };
  }
}

// === Context Menu (PC) ===

function _initContextMenu(view) {
  // Remove any existing context menu
  var existing = document.getElementById('session-context-menu');
  if (existing) existing.remove();

  var menu = document.createElement('div');
  menu.id = 'session-context-menu';
  menu.className = 'context-menu';
  menu.style.display = 'none';
  menu.innerHTML =
    '<div class="context-menu-item" data-action="rename">Rename</div>' +
    '<div class="context-menu-item context-menu-item-danger" data-action="delete">Delete</div>';
  document.body.appendChild(menu);

  var targetSession = null;

  view.addEventListener('contextmenu', function (e) {
    var container = e.target.closest('.swipe-container');
    if (!container) return;

    e.preventDefault();
    targetSession = container.getAttribute('data-session');

    menu.style.display = 'block';
    menu.style.left = e.pageX + 'px';
    menu.style.top = e.pageY + 'px';

    // Ensure menu stays within viewport
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
    if (!item || !targetSession) return;

    var action = item.getAttribute('data-action');
    menu.style.display = 'none';

    if (action === 'rename') {
      _renameSession(targetSession);
    } else if (action === 'delete') {
      _deleteSession(targetSession);
    }
  });

  // Close menu on click elsewhere
  document.addEventListener('click', function () {
    menu.style.display = 'none';
  });

  document.addEventListener('contextmenu', function (e) {
    if (!view.contains(e.target)) {
      menu.style.display = 'none';
    }
  });
}

// === Session Actions ===

function _renameSession(sessionName) {
  showPrompt({ title: '重命名会话', placeholder: '新名称', value: sessionName })
    .then(function (newName) {
      if (!newName || !newName.trim()) return;
      return api.put('/api/sessions/' + encodeURIComponent(sessionName), { name: newName.trim() });
    })
    .then(function (result) {
      if (result) navigate('sessions');
    })
    .catch(function (err) {
      showAlert({ title: '重命名失败', message: err.message });
    });
}

function _deleteSession(sessionName) {
  showConfirm({ title: '删除会话', message: '确定删除会话 "' + sessionName + '"？此操作不可撤销。', confirmText: '删除', danger: true })
    .then(function (confirmed) {
      if (!confirmed) return;
      return api.delete('/api/sessions/' + encodeURIComponent(sessionName));
    })
    .then(function (result) {
      if (!result) return;
      if (state.currentSession === sessionName) {
        state.currentSession = null;
      }
      navigate('sessions');
    })
    .catch(function (err) {
      showAlert({ title: '删除失败', message: err.message });
    });
}
