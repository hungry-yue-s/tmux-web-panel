/* global escapeHtml, api, state, renderTerminal */

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

    // Long-press to close pane
    _bindLongPressClose(box, p.id, panes.length);

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
    pill.textContent = 'P' + p.index + ' ' + (p.command || '');
    pill.setAttribute('data-pane-id', p.id);

    pill.addEventListener('click', function (e) {
      e.stopPropagation();
      if (typeof onPaneClick === 'function') {
        onPaneClick(p.id);
      }
    });

    // Long-press to close pane
    _bindLongPressClose(pill, p.id, panes.length);

    row.appendChild(pill);
  });

  container.appendChild(row);
}

// Long-press (500ms) on a pane element to close it.
// Only works when there are 2+ panes (can't close the last one).
function _bindLongPressClose(el, paneId, paneCount) {
  if (paneCount <= 1) return; // don't allow closing the only pane

  var timer = null;
  var fired = false;

  function start(e) {
    fired = false;
    timer = setTimeout(function () {
      fired = true;
      _confirmClosePane(paneId);
    }, 500);
  }

  function cancel() {
    if (timer) { clearTimeout(timer); timer = null; }
  }

  function preventClick(e) {
    if (fired) { e.stopImmediatePropagation(); e.preventDefault(); }
  }

  el.addEventListener('mousedown', start);
  el.addEventListener('mouseup', cancel);
  el.addEventListener('mouseleave', cancel);
  el.addEventListener('touchstart', start, { passive: true });
  el.addEventListener('touchend', cancel);
  el.addEventListener('touchmove', cancel);
  // Prevent the normal click from firing after long-press
  el.addEventListener('click', preventClick, true);
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
