/* global escapeHtml */

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

    row.appendChild(pill);
  });

  container.appendChild(row);
}
