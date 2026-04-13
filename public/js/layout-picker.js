/* global api, state, Theme, _showToast, escapeHtml */

var LayoutPicker = (function () {
  var LAYOUTS = [
    { name: 'even-horizontal', label: 'even-h' },
    { name: 'even-vertical',   label: 'even-v' },
    { name: 'main-horizontal', label: 'main-h' },
    { name: 'main-vertical',   label: 'main-v' },
    { name: 'tiled',           label: 'tiled' },
  ];
  var MIN_PANE_PX = 30;

  // DOM refs (created once)
  var backdrop, picker, layoutBar, layoutCards, previewWindow, dragGhost, sizeTooltip;
  var isOpen = false;
  var domReady = false;

  // State
  var panes = [];       // from API: {id, x, y, width, height, active, command}
  var paneRects = [];   // pixel-space for smooth drag
  var paneContents = {}; // paneId -> captured text
  var currentLayout = '';
  var selectedPane = null;
  var winWidth = 0, winHeight = 0;
  var scaleX = 1, scaleY = 1;
  var dirty = false;    // true if any layout/resize/swap change was made

  // ─── Style injection ───
  function injectStyles() {
    if (document.getElementById('layout-picker-styles')) return;
    var style = document.createElement('style');
    style.id = 'layout-picker-styles';
    style.textContent = [
      '.lp-backdrop{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.55);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);z-index:100;align-items:center;justify-content:center;}',
      '.lp-backdrop.show{display:flex;}',
      '.lp-picker{position:relative;display:flex;flex-direction:column;gap:0;}',

      // Layout bar
      '.lp-layout-bar{display:flex;align-items:center;gap:6px;padding:8px 12px;background:var(--bg-secondary,#1a1b26);border:1px solid var(--border-color,#3b4261);border-bottom:none;border-radius:10px 10px 0 0;width:100%;}',
      '.lp-layout-bar-title{font-size:12px;font-weight:600;color:var(--text-primary,#c0caf5);margin-right:8px;white-space:nowrap;}',
      '.lp-layout-bar-cards{display:flex;gap:4px;flex:1;justify-content:center;}',
      '.lp-lcard{background:var(--bg-tertiary,#24283b);border:1.5px solid var(--border-color,#3b4261);border-radius:5px;padding:4px 6px;cursor:pointer;transition:all 0.12s;text-align:center;width:56px;position:relative;}',
      '.lp-lcard:hover{border-color:var(--accent-blue,#7aa2f7);background:var(--bg-hover,#292e42);}',
      '.lp-lcard.active{border-color:var(--accent-green,#9ece6a);background:var(--bg-hover,#292e42);}',
      '.lp-lcard.active::after{content:"✓";position:absolute;top:2px;right:4px;font-size:9px;color:var(--accent-green,#9ece6a);}',
      '.lp-lcard-label{font-size:8px;color:var(--text-muted,#565f89);margin-top:2px;}',
      '.lp-lcard-key{font-size:8px;color:var(--accent-blue,#7aa2f7);opacity:0.5;}',

      // Mini icons
      '.lp-mi{display:flex;gap:1px;width:36px;height:18px;margin:0 auto;border-radius:2px;overflow:hidden;}',
      '.lp-mi.v{flex-direction:column;}',
      '.lp-mi.t{flex-direction:column;}',
      '.lp-mi .p{background:var(--accent-blue,#7aa2f7);opacity:0.45;border-radius:1px;flex:1;min-width:0;min-height:0;}',
      '.lp-mi .p.m{background:var(--accent-green,#9ece6a);opacity:0.7;}',
      '.lp-mi .sr{display:flex;gap:1px;flex:1;min-height:0;}',
      '.lp-mi .sc{display:flex;flex-direction:column;gap:1px;flex:1;min-width:0;}',
      '.lp-mi .sr .p,.lp-mi .sc .p{flex:1;}',
      '.lp-mi.t .sr{display:flex;gap:1px;flex:1;}',

      '.lp-layout-bar-close{background:none;border:none;color:var(--text-muted,#565f89);font-size:16px;cursor:pointer;padding:2px 6px;border-radius:4px;margin-left:8px;}',
      '.lp-layout-bar-close:hover{background:var(--bg-hover,#292e42);color:var(--text-primary,#c0caf5);}',
      '.lp-layout-bar-hint{font-size:9px;color:var(--text-muted,#565f89);white-space:nowrap;}',
      '.lp-kbd{background:var(--bg-hover,#292e42);border:1px solid var(--border-color,#3b4261);border-radius:2px;padding:0px 3px;font-size:9px;font-family:inherit;color:var(--accent-blue,#7aa2f7);}',

      // Preview window
      '.lp-preview-window{position:relative;background:var(--bg-primary,#0d0e17);border:1px solid var(--border-color,#3b4261);border-top:none;border-radius:0 0 10px 10px;overflow:hidden;}',

      // Panes
      '.lp-preview-pane{position:absolute;background:var(--bg-secondary,#1a1b26);border:1.5px solid var(--border-color,#3b4261);border-radius:3px;overflow:hidden;cursor:grab;transition:border-color 0.15s,box-shadow 0.15s;display:flex;flex-direction:column;user-select:none;-webkit-user-select:none;touch-action:none;}',
      '.lp-preview-pane:hover{border-color:var(--accent-blue,#7aa2f7);}',
      '.lp-preview-pane.main-pane{border-color:var(--accent-green,#9ece6a);}',
      '.lp-preview-pane.dragging{opacity:0.4;border-style:dashed;}',
      '.lp-preview-pane.drag-over{border-color:var(--accent-orange,#ff9e64);box-shadow:inset 0 0 12px rgba(255,158,100,0.15);}',
      '.lp-preview-pane.selected{border-color:var(--accent-orange,#ff9e64);}',

      // Pane header
      '.lp-pane-header{display:flex;align-items:center;gap:4px;padding:3px 6px;background:color-mix(in srgb, var(--bg-hover,#292e42) 80%, transparent);border-bottom:1px solid var(--border-color,#3b4261);font-size:10px;flex-shrink:0;}',
      '.lp-pane-idx{font-weight:700;color:var(--accent-blue,#7aa2f7);min-width:14px;}',
      '.lp-preview-pane.main-pane .lp-pane-idx{color:var(--accent-green,#9ece6a);}',
      '.lp-pane-cmd{color:var(--text-muted,#565f89);}',

      // Pane content
      '.lp-pane-content{flex:1;padding:4px 6px;font-family:"Menlo","Consolas","Courier New",monospace;font-size:9px;line-height:1.3;color:var(--text-muted,#565f89);overflow:hidden;white-space:pre;opacity:0.7;}',

      // Drag ghost
      '.lp-drag-ghost{position:fixed;pointer-events:none;z-index:1000;background:var(--bg-hover,#292e42);border:2px solid var(--accent-orange,#ff9e64);border-radius:6px;padding:6px 14px;font-size:16px;font-weight:700;color:var(--accent-orange,#ff9e64);box-shadow:0 8px 24px rgba(0,0,0,0.5);opacity:0.9;display:none;}',

      // Resize handles
      '.lp-resize-handle{position:absolute;z-index:5;background:transparent;transition:background 0.15s;}',
      '.lp-resize-handle:hover,.lp-resize-handle.active{background:color-mix(in srgb, var(--accent-blue,#7aa2f7) 40%, transparent);}',
      '.lp-resize-handle.horizontal{cursor:row-resize;}',
      '.lp-resize-handle.vertical{cursor:col-resize;}',
      '.lp-resize-handle::after{content:"";position:absolute;border-radius:2px;background:var(--accent-blue,#7aa2f7);opacity:0;transition:opacity 0.15s;}',
      '.lp-resize-handle:hover::after,.lp-resize-handle.active::after{opacity:1;}',
      '.lp-resize-handle.vertical::after{width:2px;height:20px;left:50%;top:50%;transform:translate(-50%,-50%);}',
      '.lp-resize-handle.horizontal::after{height:2px;width:20px;left:50%;top:50%;transform:translate(-50%,-50%);}',
      '.lp-resize-handle.cross{cursor:move;border-radius:50%;z-index:6;}',
      '.lp-resize-handle.cross::after{width:6px;height:6px;border-radius:50%;left:50%;top:50%;transform:translate(-50%,-50%);}',

      // Size tooltip
      '.lp-size-tooltip{position:fixed;pointer-events:none;z-index:1000;background:var(--bg-hover,#292e42);border:1px solid var(--accent-blue,#7aa2f7);border-radius:4px;padding:2px 8px;font-size:10px;color:var(--accent-blue,#7aa2f7);display:none;white-space:nowrap;}',

      // Swap hint
      '.lp-swap-hint{position:absolute;bottom:8px;left:50%;transform:translateX(-50%);background:color-mix(in srgb, var(--bg-hover,#292e42) 90%, transparent);border:1px solid var(--border-color,#3b4261);border-radius:6px;padding:4px 12px;font-size:10px;color:var(--accent-orange,#ff9e64);z-index:10;white-space:nowrap;}',

      // Responsive
      '@media (max-width:480px){',
      '  .lp-layout-bar{padding:6px 8px;gap:4px;}',
      '  .lp-layout-bar-title{font-size:10px;}',
      '  .lp-lcard{width:44px;padding:3px 4px;}',
      '  .lp-mi{width:28px;height:14px;}',
      '  .lp-lcard-label{font-size:7px;}',
      '  .lp-layout-bar-hint{display:none;}',
      '  .lp-pane-header{font-size:9px;padding:2px 4px;}',
      '  .lp-pane-content{font-size:8px;}',
      '}',
    ].join('\n');
    document.head.appendChild(style);
  }

  // ─── DOM creation ───
  function createDOM() {
    if (domReady) return;
    injectStyles();

    backdrop = document.createElement('div');
    backdrop.className = 'lp-backdrop';
    backdrop.addEventListener('click', function (e) { if (e.target === backdrop) close(); });

    picker = document.createElement('div');
    picker.className = 'lp-picker';

    layoutBar = document.createElement('div');
    layoutBar.className = 'lp-layout-bar';
    layoutBar.innerHTML =
      '<span class="lp-layout-bar-title">布局</span>' +
      '<div class="lp-layout-bar-cards"></div>' +
      '<span class="lp-layout-bar-hint"><span class="lp-kbd">1</span>-<span class="lp-kbd">5</span> <span class="lp-kbd">Esc</span></span>' +
      '<button class="lp-layout-bar-close">\u2715</button>';
    layoutCards = layoutBar.querySelector('.lp-layout-bar-cards');
    layoutBar.querySelector('.lp-layout-bar-close').addEventListener('click', close);

    previewWindow = document.createElement('div');
    previewWindow.className = 'lp-preview-window';

    picker.appendChild(layoutBar);
    picker.appendChild(previewWindow);
    backdrop.appendChild(picker);

    dragGhost = document.createElement('div');
    dragGhost.className = 'lp-drag-ghost';

    sizeTooltip = document.createElement('div');
    sizeTooltip.className = 'lp-size-tooltip';

    document.body.appendChild(backdrop);
    document.body.appendChild(dragGhost);
    document.body.appendChild(sizeTooltip);

    domReady = true;
  }

  // ─── Keyboard ───
  function onKeyDown(e) {
    if (!isOpen) return;
    if (e.key === 'Escape') { close(); return; }
    var n = parseInt(e.key);
    if (n >= 1 && n <= 5) {
      e.preventDefault();
      selectLayout(LAYOUTS[n - 1].name);
    }
  }

  // ─── Open / Close / Toggle ───
  function open() {
    if (isOpen) return;
    if (!state.currentSession || state.currentWindow == null) {
      if (typeof _showToast === 'function') _showToast('No active window', 2000);
      return;
    }
    createDOM();
    isOpen = true;
    dirty = false;
    selectedPane = null;
    currentLayout = '';
    paneContents = {};
    backdrop.classList.add('show');
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onWindowResize);

    fetchData().then(function () {
      renderLayoutCards();
      renderPreview();
      fetchAllCaptures();
    }).catch(function (err) {
      if (typeof _showToast === 'function') _showToast('Failed to load panes: ' + err.message, 3000);
      close();
    });
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    backdrop.classList.remove('show');
    document.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('resize', onWindowResize);
    previewWindow.innerHTML = '';

    if (dirty && typeof _fetchPaneThumbnails === 'function') {
      // If we have a global refresh for pane thumbnails, call it
      try { _fetchPaneThumbnails(); } catch (_e) { /* ignore */ }
    }
    // Trigger a window list refresh if anything changed
    if (dirty && typeof state !== 'undefined') {
      // The windows panel has a render function triggered by session data refresh.
      // Fire a lightweight re-fetch via the existing WebSocket mechanism.
      var ev = new CustomEvent('layout-picker-changed');
      document.dispatchEvent(ev);
    }
  }

  function toggle() { isOpen ? close() : open(); }

  function onWindowResize() {
    if (isOpen && panes.length > 0) renderPreview();
  }

  // ─── API helpers ───
  function sessionPath() {
    return '/api/sessions/' + encodeURIComponent(state.currentSession) +
           '/windows/' + encodeURIComponent(state.currentWindow);
  }

  function fetchData() {
    return Promise.all([
      api.get(sessionPath() + '/panes'),
      api.get(sessionPath() + '/layout'),
    ]).then(function (results) {
      if (!results[0].success) throw new Error(results[0].error || 'Failed to load panes');
      if (!results[1].success) throw new Error(results[1].error || 'Failed to load layout');
      panes = results[0].data || [];
      var layoutData = results[1].data || {};
      winWidth = layoutData.width || 80;
      winHeight = layoutData.height || 24;
    });
  }

  function fetchAllCaptures() {
    var requests = panes.map(function (p) {
      return api.get('/api/panes/' + encodeURIComponent(p.id) + '/capture')
        .then(function (r) {
          if (r.success && r.data) {
            paneContents[p.id] = r.data.content || '';
          }
        })
        .catch(function () { /* ignore capture failure */ });
    });
    Promise.all(requests).then(function () {
      if (isOpen) updatePaneContentDOM();
    });
  }

  function updatePaneContentDOM() {
    panes.forEach(function (p, i) {
      var el = previewWindow.querySelector('.lp-preview-pane[data-idx="' + i + '"] .lp-pane-content');
      if (el && paneContents[p.id]) {
        el.textContent = paneContents[p.id];
      }
    });
  }

  // ─── Layout cards ───
  function renderLayoutCards() {
    var html = '';
    LAYOUTS.forEach(function (l, i) {
      var isActive = l.name === currentLayout;
      html += '<div class="lp-lcard' + (isActive ? ' active' : '') + '" data-layout="' + l.name + '">';
      html += '<span class="lp-lcard-key">' + (i + 1) + '</span>';
      html += miniIconHTML(l.name, panes.length);
      html += '<div class="lp-lcard-label">' + l.label + '</div>';
      html += '</div>';
    });
    layoutCards.innerHTML = html;
    layoutCards.querySelectorAll('.lp-lcard').forEach(function (card) {
      card.addEventListener('click', function () {
        selectLayout(card.dataset.layout);
      });
    });
  }

  function selectLayout(name) {
    if (typeof _showToast === 'function') _showToast('Switching layout...', 1000);
    api.post(sessionPath() + '/layout', { layout: name })
      .then(function (r) {
        if (!r.success) throw new Error(r.error || 'Failed to switch layout');
        dirty = true;
        currentLayout = name;
        selectedPane = null;
        return fetchData();
      })
      .then(function () {
        renderLayoutCards();
        renderPreview();
        fetchAllCaptures();
        if (typeof _showToast === 'function') _showToast('Layout: ' + name, 1200);
      })
      .catch(function (err) {
        if (typeof _showToast === 'function') _showToast('Error: ' + err.message, 3000);
      });
  }

  function miniIconHTML(name, n) {
    if (n < 1) n = 1;
    var h = '';
    switch (name) {
      case 'even-horizontal':
        h = '<div class="lp-mi">'; for (var i = 0; i < n; i++) h += '<div class="p"></div>'; h += '</div>'; break;
      case 'even-vertical':
        h = '<div class="lp-mi v">'; for (var i = 0; i < n; i++) h += '<div class="p"></div>'; h += '</div>'; break;
      case 'main-horizontal':
        h = '<div class="lp-mi v"><div class="p m" style="flex:2"></div>';
        if (n > 1) { h += '<div class="sr">'; for (var i = 1; i < n; i++) h += '<div class="p"></div>'; h += '</div>'; }
        h += '</div>'; break;
      case 'main-vertical':
        h = '<div class="lp-mi"><div class="p m" style="flex:2"></div>';
        if (n > 1) { h += '<div class="sc">'; for (var i = 1; i < n; i++) h += '<div class="p"></div>'; h += '</div>'; }
        h += '</div>'; break;
      case 'tiled': {
        // tmux tiled: always 2 columns, rows = ceil(n/2), last row may be single full-width
        var cols = n >= 2 ? 2 : 1;
        var rows = Math.ceil(n / cols);
        h = '<div class="lp-mi t">'; var idx = 0;
        for (var r = 0; r < rows; r++) {
          var rowItems = Math.min(cols, n - idx);
          h += '<div class="sr">';
          for (var c = 0; c < rowItems; c++, idx++) h += '<div class="p"></div>';
          h += '</div>';
        }
        h += '</div>'; break;
      }
    }
    return h;
  }

  // ─── Preview rendering ───
  function renderPreview() {
    // Viewport-proportional sizing
    var vpW = window.innerWidth, vpH = window.innerHeight;
    var pixW = vpW * 0.88, pixH = vpH * 0.75;
    var vpAspect = vpW / vpH;
    if (pixW / pixH > vpAspect) pixW = pixH * vpAspect;
    else pixH = pixW / vpAspect;

    previewWindow.style.width = pixW + 'px';
    previewWindow.style.height = pixH + 'px';
    picker.style.width = pixW + 'px';

    scaleX = pixW / winWidth;
    scaleY = pixH / winHeight;

    var html = '';
    panes.forEach(function (p, i) {
      var isMain = (i === 0 && (currentLayout === 'main-horizontal' || currentLayout === 'main-vertical'));
      var cls = 'lp-preview-pane' + (isMain ? ' main-pane' : '') + (selectedPane === i ? ' selected' : '');

      var left = p.x * scaleX + 2;
      var top = p.y * scaleY + 2;
      var width = p.width * scaleX - 4;
      var height = p.height * scaleY - 4;

      html += '<div class="' + cls + '" data-idx="' + i + '" data-pane-id="' + escapeHtml(p.id) + '" style="' +
        'left:' + left + 'px;top:' + top + 'px;width:' + width + 'px;height:' + height + 'px;">';
      html += '<div class="lp-pane-header">';
      html += '<span class="lp-pane-idx">' + i + '</span>';
      html += '<span class="lp-pane-cmd">' + escapeHtml(p.command || 'zsh') + '</span>';
      html += '</div>';
      html += '<div class="lp-pane-content">' + escapeHtml(paneContents[p.id] || '') + '</div>';
      html += '</div>';
    });

    html += '<div class="lp-swap-hint">Drag to swap \u00b7 Drag borders to resize</div>';
    previewWindow.innerHTML = html;

    // Store pixel-space rects for smooth resize
    paneRects = panes.map(function (p) {
      return { x: p.x * scaleX, y: p.y * scaleY, w: p.width * scaleX, h: p.height * scaleY };
    });

    // Bind pane interactions
    previewWindow.querySelectorAll('.lp-preview-pane').forEach(function (el) {
      el.addEventListener('pointerdown', onPanePointerDown);
    });

    // Add resize handles
    renderResizeHandles();
  }

  function syncPanesFromRects() {
    var els = previewWindow.querySelectorAll('.lp-preview-pane');
    els.forEach(function (el, i) {
      if (i >= paneRects.length) return;
      var r = paneRects[i];
      el.style.left = (r.x + 2) + 'px';
      el.style.top = (r.y + 2) + 'px';
      el.style.width = (r.w - 4) + 'px';
      el.style.height = (r.h - 4) + 'px';
    });
  }

  // ─── Border detection ───
  function findPixelBorders(rects) {
    var maxScale = Math.max(scaleX || 5, scaleY || 5);
    var tolerance = Math.ceil(maxScale * 1.5) + 2;
    var borderMap = {};

    for (var i = 0; i < rects.length; i++) {
      for (var j = i + 1; j < rects.length; j++) {
        var a = rects[i], b = rects[j];
        checkBorder(a.x + a.w, b.x, 'vertical', a, b, i, j, borderMap, tolerance);
        checkBorder(b.x + b.w, a.x, 'vertical', b, a, j, i, borderMap, tolerance);
        checkBorder(a.y + a.h, b.y, 'horizontal', a, b, i, j, borderMap, tolerance);
        checkBorder(b.y + b.h, a.y, 'horizontal', b, a, j, i, borderMap, tolerance);
      }
    }

    var borders = [];
    Object.keys(borderMap).forEach(function (key) {
      var b = borderMap[key];
      borders.push({
        dir: b.dir, pos: b.pos,
        start: b.start, end: b.end,
        leftPanes: Object.keys(b.leftSet).map(Number),
        rightPanes: Object.keys(b.rightSet).map(Number)
      });
    });

    // Detect cross/T-junction points
    var crossTol = 8;
    var crossCount = borders.length;
    for (var i = 0; i < crossCount; i++) {
      for (var j = i + 1; j < crossCount; j++) {
        var bi = borders[i], bj = borders[j];
        if (bi.dir === bj.dir) continue;
        var vb = bi.dir === 'vertical' ? bi : bj;
        var hb = bi.dir === 'horizontal' ? bi : bj;
        if (vb.pos >= hb.start - crossTol && vb.pos <= hb.end + crossTol &&
            hb.pos >= vb.start - crossTol && hb.pos <= vb.end + crossTol) {
          borders.push({
            dir: 'cross', posX: vb.pos, posY: hb.pos,
            vBorder: vb, hBorder: hb
          });
        }
      }
    }

    return borders;
  }

  function checkBorder(edge1, edge2, dir, paneA, paneB, idxA, idxB, map, tolerance) {
    if (Math.abs(edge1 - edge2) > tolerance) return;
    var pos = (edge1 + edge2) / 2;
    var posKey = Math.round(pos);
    var key = dir + ':' + posKey;

    var overlapStart, overlapEnd;
    if (dir === 'vertical') {
      overlapStart = Math.max(paneA.y, paneB.y);
      overlapEnd = Math.min(paneA.y + paneA.h, paneB.y + paneB.h);
    } else {
      overlapStart = Math.max(paneA.x, paneB.x);
      overlapEnd = Math.min(paneA.x + paneA.w, paneB.x + paneB.w);
    }
    if (overlapEnd - overlapStart < 2) return;

    if (!map[key]) map[key] = { dir: dir, pos: pos, leftSet: {}, rightSet: {}, start: overlapStart, end: overlapEnd };
    map[key].leftSet[idxA] = true;
    map[key].rightSet[idxB] = true;
    map[key].start = Math.min(map[key].start, overlapStart);
    map[key].end = Math.max(map[key].end, overlapEnd);
  }

  // ─── Resize handles ───
  function renderResizeHandles() {
    var borders = findPixelBorders(paneRects);
    var isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    var hitSize = isTouch ? 24 : 10;
    var crossHit = isTouch ? 32 : 14;

    borders.forEach(function (b) {
      var el = document.createElement('div');
      el.className = 'lp-resize-handle ' + b.dir;
      if (b.dir === 'vertical') {
        el.style.left = (b.pos - hitSize / 2) + 'px';
        el.style.top = (b.start + 2) + 'px';
        el.style.width = hitSize + 'px';
        el.style.height = (b.end - b.start - 4) + 'px';
      } else if (b.dir === 'horizontal') {
        el.style.left = (b.start + 2) + 'px';
        el.style.top = (b.pos - hitSize / 2) + 'px';
        el.style.width = (b.end - b.start - 4) + 'px';
        el.style.height = hitSize + 'px';
      } else {
        el.className = 'lp-resize-handle cross';
        el.style.left = (b.posX - crossHit / 2) + 'px';
        el.style.top = (b.posY - crossHit / 2) + 'px';
        el.style.width = crossHit + 'px';
        el.style.height = crossHit + 'px';
        el.style.cursor = 'move';
        el.style.borderRadius = '50%';
      }
      el.dataset.border = JSON.stringify(b);
      el.addEventListener('mousedown', onResizeStart);
      el.addEventListener('touchstart', function (ev) {
        if (ev.touches.length !== 1) return;
        ev.preventDefault();
        var t = ev.touches[0];
        onResizeStart({
          currentTarget: ev.currentTarget,
          clientX: t.clientX,
          clientY: t.clientY,
          preventDefault: function () {},
          stopPropagation: function () {}
        });
      }, { passive: false });
      previewWindow.appendChild(el);
    });
  }

  // ─── Resize drag ───
  function onResizeStart(e) {
    e.stopPropagation();
    e.preventDefault();
    var handle = e.currentTarget;
    var border = JSON.parse(handle.dataset.border);
    var rects = paneRects;
    var lastX = e.clientX, lastY = e.clientY;
    var localScaleX = scaleX, localScaleY = scaleY;

    handle.classList.add('active');
    sizeTooltip.style.display = 'block';
    document.body.style.userSelect = 'none';
    document.body.style.webkitUserSelect = 'none';

    function applyDelta(dx, dy) {
      if (border.dir === 'vertical' || border.dir === 'cross') {
        var lp = border.dir === 'cross' ? border.vBorder.leftPanes : border.leftPanes;
        var rp = border.dir === 'cross' ? border.vBorder.rightPanes : border.rightPanes;
        var minDx = -Infinity, maxDx = Infinity;
        lp.forEach(function (pi) { minDx = Math.max(minDx, MIN_PANE_PX - rects[pi].w); });
        rp.forEach(function (pi) { maxDx = Math.min(maxDx, rects[pi].w - MIN_PANE_PX); });
        dx = Math.max(minDx, Math.min(maxDx, dx));
        lp.forEach(function (pi) { rects[pi].w += dx; });
        rp.forEach(function (pi) { rects[pi].x += dx; rects[pi].w -= dx; });
      }
      if (border.dir === 'horizontal' || border.dir === 'cross') {
        var tp = border.dir === 'cross' ? border.hBorder.leftPanes : border.leftPanes;
        var bp = border.dir === 'cross' ? border.hBorder.rightPanes : border.rightPanes;
        var minDy = -Infinity, maxDy = Infinity;
        tp.forEach(function (pi) { minDy = Math.max(minDy, MIN_PANE_PX - rects[pi].h); });
        bp.forEach(function (pi) { maxDy = Math.min(maxDy, rects[pi].h - MIN_PANE_PX); });
        dy = Math.max(minDy, Math.min(maxDy, dy));
        tp.forEach(function (pi) { rects[pi].h += dy; });
        bp.forEach(function (pi) { rects[pi].y += dy; rects[pi].h -= dy; });
      }
    }

    function onMove(ev) {
      ev.preventDefault();
      var dx = ev.clientX - lastX;
      var dy = ev.clientY - lastY;
      lastX = ev.clientX;
      lastY = ev.clientY;

      applyDelta(dx, dy);
      syncPanesFromRects();

      // Move handle along with drag
      if (border.dir === 'vertical') {
        handle.style.left = (parseFloat(handle.style.left) + dx) + 'px';
      } else if (border.dir === 'horizontal') {
        handle.style.top = (parseFloat(handle.style.top) + dy) + 'px';
      } else if (border.dir === 'cross') {
        handle.style.left = (parseFloat(handle.style.left) + dx) + 'px';
        handle.style.top = (parseFloat(handle.style.top) + dy) + 'px';
      }

      // Tooltip
      var info = '';
      if (border.dir === 'vertical' || border.dir === 'cross') {
        var lIdx = (border.dir === 'cross' ? border.vBorder : border).leftPanes[0];
        var rIdx = (border.dir === 'cross' ? border.vBorder : border).rightPanes[0];
        info += Math.round(rects[lIdx].w / localScaleX) + ' | ' + Math.round(rects[rIdx].w / localScaleX) + ' cols';
      }
      if (border.dir === 'cross') info += '  ';
      if (border.dir === 'horizontal' || border.dir === 'cross') {
        var tIdx = (border.dir === 'cross' ? border.hBorder : border).leftPanes[0];
        var bIdx = (border.dir === 'cross' ? border.hBorder : border).rightPanes[0];
        info += Math.round(rects[tIdx].h / localScaleY) + ' | ' + Math.round(rects[bIdx].h / localScaleY) + ' rows';
      }
      sizeTooltip.textContent = info;
      sizeTooltip.style.left = (ev.clientX + 14) + 'px';
      sizeTooltip.style.top = (ev.clientY - 18) + 'px';
    }

    function onUp() {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
      document.removeEventListener('touchmove', onTouchMove, true);
      document.removeEventListener('touchend', onTouchEnd, true);
      handle.classList.remove('active');
      sizeTooltip.style.display = 'none';
      document.body.style.userSelect = '';
      document.body.style.webkitUserSelect = '';

      // Compute resize deltas and send API calls
      sendResizeDeltas(rects, localScaleX, localScaleY);
    }

    function onTouchMove(ev) {
      if (ev.touches.length !== 1) return;
      ev.preventDefault();
      var t = ev.touches[0];
      onMove({ clientX: t.clientX, clientY: t.clientY, preventDefault: function () {} });
    }
    function onTouchEnd() { onUp(); }

    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
    document.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
    document.addEventListener('touchend', onTouchEnd, true);
  }

  function sendResizeDeltas(rects, localScaleX, localScaleY) {
    // Only resize the FIRST pane that changed in each axis.
    // tmux resize-pane automatically adjusts adjacent panes,
    // so sending resize for both sides would cancel out or double.
    var resizeOps = [];
    var didResizeH = false, didResizeV = false;

    panes.forEach(function (p, i) {
      var newCols = Math.round(rects[i].w / localScaleX);
      var newRows = Math.round(rects[i].h / localScaleY);
      var dCols = newCols - p.width;
      var dRows = newRows - p.height;

      if (dCols !== 0 && !didResizeH) {
        didResizeH = true;
        resizeOps.push(
          api.post('/api/panes/' + encodeURIComponent(p.id) + '/resize', {
            direction: dCols > 0 ? 'R' : 'L',
            amount: Math.abs(dCols)
          })
        );
      }
      if (dRows !== 0 && !didResizeV) {
        didResizeV = true;
        resizeOps.push(
          api.post('/api/panes/' + encodeURIComponent(p.id) + '/resize', {
            direction: dRows > 0 ? 'D' : 'U',
            amount: Math.abs(dRows)
          })
        );
      }
    });

    if (resizeOps.length === 0) return;

    dirty = true;
    Promise.all(resizeOps)
      .then(function () {
        if (typeof _showToast === 'function') _showToast('Resized', 1200);
        return fetchData();
      })
      .then(function () {
        renderPreview();
        fetchAllCaptures();
      })
      .catch(function (err) {
        if (typeof _showToast === 'function') _showToast('Resize error: ' + (err.message || err), 3000);
        // Still re-fetch to reset to actual state
        fetchData().then(function () { renderPreview(); });
      });
  }

  // ─── Pane swap (drag + click) ───
  function onPanePointerDown(e) {
    var pane = e.currentTarget;
    var idx = parseInt(pane.dataset.idx);

    // Click-to-swap: second click
    if (selectedPane !== null && selectedPane !== idx) {
      doSwap(selectedPane, idx);
      return;
    }

    var startX = e.clientX, startY = e.clientY;
    var moved = false;

    pane.setPointerCapture(e.pointerId);

    function onMove(ev) {
      var dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (!moved && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
        moved = true;
        pane.classList.add('dragging');
        dragGhost.textContent = idx + ' ' + (panes[idx] ? panes[idx].command || 'zsh' : 'zsh');
        dragGhost.style.display = 'block';
      }
      if (moved) {
        dragGhost.style.left = (ev.clientX - 24) + 'px';
        dragGhost.style.top = (ev.clientY - 16) + 'px';
        previewWindow.querySelectorAll('.lp-preview-pane').forEach(function (p) {
          p.classList.remove('drag-over');
          if (p !== pane) {
            var r = p.getBoundingClientRect();
            if (ev.clientX >= r.left && ev.clientX <= r.right &&
                ev.clientY >= r.top && ev.clientY <= r.bottom) {
              p.classList.add('drag-over');
            }
          }
        });
      }
    }

    function onUp() {
      pane.removeEventListener('pointermove', onMove);
      pane.removeEventListener('pointerup', onUp);
      pane.removeEventListener('pointercancel', onUp);
      pane.classList.remove('dragging');
      dragGhost.style.display = 'none';

      if (moved) {
        var target = null;
        previewWindow.querySelectorAll('.lp-preview-pane').forEach(function (p) {
          if (p !== pane && p.classList.contains('drag-over')) {
            target = parseInt(p.dataset.idx);
          }
          p.classList.remove('drag-over');
        });
        if (target !== null) doSwap(idx, target);
      } else {
        // Toggle selection for click-to-swap
        selectedPane = (selectedPane === idx) ? null : idx;
        renderPreview();
      }
    }

    pane.addEventListener('pointermove', onMove);
    pane.addEventListener('pointerup', onUp);
    pane.addEventListener('pointercancel', onUp);
  }

  function doSwap(a, b) {
    var srcPane = panes[a];
    var dstPane = panes[b];
    if (!srcPane || !dstPane) return;

    selectedPane = null;
    if (typeof _showToast === 'function') _showToast('Swapping...', 1000);

    api.post('/api/panes/' + encodeURIComponent(srcPane.id) + '/swap', { target: dstPane.id })
      .then(function (r) {
        if (!r.success) throw new Error(r.error || 'Swap failed');
        dirty = true;
        if (typeof _showToast === 'function') {
          _showToast('Swapped: ' + (srcPane.command || 'zsh') + ' \u2194 ' + (dstPane.command || 'zsh'), 1200);
        }
        return fetchData();
      })
      .then(function () {
        renderPreview();
        fetchAllCaptures();
      })
      .catch(function (err) {
        if (typeof _showToast === 'function') _showToast('Swap error: ' + (err.message || err), 3000);
        fetchData().then(function () { renderPreview(); });
      });
  }

  return { open: open, close: close, toggle: toggle };
})();
