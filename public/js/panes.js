/* global escapeHtml, api, state, renderTerminal */

// === Global: block browser context menu everywhere ===
document.addEventListener('contextmenu', function (e) {
  e.preventDefault();
}, true);

// === Pane Layout Visualization ===

// Renders pane layout as positioned boxes within a container.
// panes: array of { id, index, command, width, height, top, left }
// activePaneId: currently selected pane id (or null)
// onPaneClick: callback(paneId) when a pane is clicked
function renderPaneLayout(container, panes, activePaneId, onPaneClick) {
  container.innerHTML = '';

  if (!panes || panes.length === 0) {
    container.innerHTML = '<div style="padding: 16px; text-align: center; color: var(--text-muted);">No panes</div>';
    return;
  }

  // 1. Calculate total dimensions from pane geometry
  var totalWidth = 0;
  var totalHeight = 0;
  panes.forEach(function (p) {
    var pLeft = p.left != null ? p.left : (p.x || 0);
    var pTop = p.top != null ? p.top : (p.y || 0);
    var right = pLeft + (p.width || 1);
    var bottom = pTop + (p.height || 1);
    if (right > totalWidth) totalWidth = right;
    if (bottom > totalHeight) totalHeight = bottom;
  });

  if (totalWidth === 0 || totalHeight === 0) return;

  // 2. Create a relative-positioned layout container
  var layout = document.createElement('div');
  layout.className = 'pane-layout';
  layout.style.aspectRatio = totalWidth + ' / ' + totalHeight;

  // 3. For each pane, create an absolute-positioned div
  panes.forEach(function (p) {
    var pLeft = p.left != null ? p.left : (p.x || 0);
    var pTop = p.top != null ? p.top : (p.y || 0);
    var leftPct = (pLeft / totalWidth * 100).toFixed(2);
    var topPct = (pTop / totalHeight * 100).toFixed(2);
    var widthPct = ((p.width || 1) / totalWidth * 100).toFixed(2);
    var heightPct = ((p.height || 1) / totalHeight * 100).toFixed(2);

    var box = document.createElement('div');
    box.className = 'pane-box' + (p.id === activePaneId ? ' active' : '');
    box.style.left = leftPct + '%';
    box.style.top = topPct + '%';
    box.style.width = widthPct + '%';
    box.style.height = heightPct + '%';
    box.setAttribute('data-pane-id', p.id);
    box.setAttribute('title', 'Pane ' + p.index + ': ' + (p.command || 'unknown') + ' (' + (p.width || 0) + 'x' + (p.height || 0) + ')');

    var label = document.createElement('span');
    label.className = 'pane-box-index';
    label.textContent = 'P' + p.index;

    var cmd = document.createElement('span');
    cmd.className = 'pane-box-cmd';
    cmd.textContent = p.command || '';

    box.appendChild(label);
    box.appendChild(cmd);

    // Click handler
    box.addEventListener('click', function (e) {
      e.stopPropagation();
      if (typeof onPaneClick === 'function') {
        onPaneClick(p.id);
      }
    });

    // Long-press / right-click for pane menu (set label, close)
    _bindPaneMenu(box, p, panes.length);

    layout.appendChild(box);
  });

  container.appendChild(layout);
}

// Mobile-friendly pane pill switcher.
// Horizontal scrollable row of pill buttons.
function renderPanePills(container, panes, activePaneId, onPaneClick) {
  container.innerHTML = '';

  if (!panes || panes.length === 0) return;

  var row = document.createElement('div');
  row.className = 'pane-pills';

  panes.forEach(function (p) {
    var pill = document.createElement('button');
    pill.className = 'pane-pill' + (p.id === activePaneId ? ' active' : '');
    pill.textContent = p.index;
    pill.setAttribute('data-pane-id', p.id);

    pill.addEventListener('click', function (e) {
      e.stopPropagation();
      if (typeof onPaneClick === 'function') {
        onPaneClick(p.id);
      }
    });

    // Long-press / right-click for pane menu (set label, close)
    _bindPaneMenu(pill, p, panes.length);

    row.appendChild(pill);
  });

  container.appendChild(row);
}

// Long-press (500ms) or right-click a pane element to open its menu
// (set label / close pane). Works for any pane count — "close" is gated inside.
function _bindPaneMenu(el, pane, paneCount) {
  var timer = null;
  var fired = false;

  function open(x, y) {
    fired = true;
    _showPaneMenu(x, y, pane, paneCount);
  }
  function start(e) {
    // Only left mouse button arms the long-press; right-click goes via contextmenu.
    if (e.type === 'mousedown' && e.button !== 0) return;
    fired = false;
    var t = e.touches && e.touches[0];
    var x = t ? t.pageX : e.pageX;
    var y = t ? t.pageY : e.pageY;
    timer = setTimeout(function () { open(x, y); }, 500);
  }
  function cancel() {
    if (timer) { clearTimeout(timer); timer = null; }
  }
  function preventClick(e) {
    if (fired) { e.stopImmediatePropagation(); e.preventDefault(); fired = false; }
  }

  el.addEventListener('mousedown', start);
  el.addEventListener('mouseup', cancel);
  el.addEventListener('mouseleave', cancel);
  el.addEventListener('touchstart', start, { passive: true });
  el.addEventListener('touchend', cancel);
  el.addEventListener('touchmove', cancel);
  // Prevent the normal click from firing after long-press
  el.addEventListener('click', preventClick, true);
  el.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    e.stopPropagation();
    open(e.pageX, e.pageY);
  });
}

// Builds the per-pane action menu (reuses .context-menu styles).
function _showPaneMenu(x, y, pane, paneCount) {
  var existing = document.querySelector('.pane-context-menu');
  if (existing) existing.remove();

  var menu = document.createElement('div');
  menu.className = 'context-menu pane-context-menu';
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  var labelItem = document.createElement('div');
  labelItem.className = 'context-menu-item';
  labelItem.setAttribute('data-action', 'label');
  labelItem.textContent = '✏ 设置标签';
  menu.appendChild(labelItem);

  if (paneCount > 1) {
    var closeItem = document.createElement('div');
    closeItem.className = 'context-menu-item context-menu-item-danger';
    closeItem.setAttribute('data-action', 'close');
    closeItem.textContent = '✕ 关闭窗格';
    menu.appendChild(closeItem);
  }

  function dismiss() {
    menu.remove();
    document.removeEventListener('click', onDoc, true);
    document.removeEventListener('touchstart', onDoc, true);
  }
  function onDoc(e) { if (!menu.contains(e.target)) dismiss(); }

  menu.addEventListener('click', function (e) {
    var item = e.target.closest('.context-menu-item');
    if (!item) return;
    var action = item.getAttribute('data-action');
    dismiss();
    if (action === 'label') _promptSetPaneLabel(pane);
    else if (action === 'close') _confirmClosePane(pane.id);
  });

  document.body.appendChild(menu);
  // Clamp to the viewport so the menu never renders partly offscreen
  // (mirrors windows.js / sessions.js context-menu behavior).
  var rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = Math.max(0, x - rect.width) + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top = Math.max(0, y - rect.height) + 'px';
  // Defer the outside-click binding so the opening event doesn't dismiss it.
  setTimeout(function () {
    document.addEventListener('click', onDoc, true);
    document.addEventListener('touchstart', onDoc, true);
  }, 0);
}

// Prompts for a label and PUTs it (empty clears). tmux redraws the border.
function _promptSetPaneLabel(pane) {
  showPrompt({
    title: '设置窗格标签',
    placeholder: '标签（留空清除）',
    value: pane.label || '',
    confirmText: '保存',
  })
    .then(function (label) {
      if (label === null) return; // cancelled
      var trimmed = label.trim();
      return api.put('/api/panes/' + encodeURIComponent(pane.id) + '/label', { label: trimmed })
        .then(function () {
          // Keep the in-memory pane in sync so reopening the menu prefills the new value.
          pane.label = trimmed;
        });
    })
    .catch(function (err) {
      showAlert({ title: '设置标签失败', message: err.message });
    });
}

function _confirmClosePane(paneId) {
  showConfirm({ title: '关闭窗格', message: '确定关闭此窗格？', confirmText: '关闭', danger: true })
    .then(function (confirmed) {
      if (!confirmed) return;
      return api.delete(
        '/api/sessions/' + encodeURIComponent(state.currentSession) +
        '/windows/' + encodeURIComponent(state.currentWindow) +
        '/panes/' + encodeURIComponent(paneId)
      );
    })
    .then(function (result) {
      if (!result) return;
      if (typeof _fontOffsets !== 'undefined') {
        delete _fontOffsets[paneId];
        _saveFontOffsets();
      }
      var content = document.getElementById('content');
      if (content && typeof renderTerminal === 'function') {
        state.currentPane = null;
        renderTerminal(content);
      }
    })
    .catch(function (err) {
      showAlert({ title: '关闭窗格失败', message: err.message });
    });
}
