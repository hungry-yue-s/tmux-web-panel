/* global Terminal, FitAddon, WebLinksAddon, WebglAddon, Theme, api, state, navigate, escapeHtml, renderPaneLayout, renderPanePills */

// === Clipboard Helper ===

function _copyToClipboard(text) {
  // Method 1: Clipboard API (works in secure contexts)
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).catch(function () {});
    return;
  }
  // Method 2: execCommand fallback (works in HTTP)
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try { document.execCommand('copy'); } catch (_e) { /* ignore */ }
  document.body.removeChild(ta);
}

// === Terminal State ===

var terminalState = {
  term: null,
  ws: null,
  fitAddon: null,
  resizeObserver: null,
  isFullscreen: false,
};

// === Cleanup ===

function _cleanupTerminalResources() {
  terminalState.termContainer = null;
  if (terminalState._vpHandler && window.visualViewport) {
    window.visualViewport.removeEventListener('resize', terminalState._vpHandler);
    window.visualViewport.removeEventListener('scroll', terminalState._vpHandler);
    terminalState._vpHandler = null;
  }
  if (terminalState.resizeObserver) {
    terminalState.resizeObserver.disconnect();
    terminalState.resizeObserver = null;
  }
  if (terminalState.ws) {
    terminalState.ws.close();
    terminalState.ws = null;
  }
  if (terminalState.term) {
    try { terminalState.term.dispose(); } catch (_e) {}
    terminalState.term = null;
  }
  terminalState.fitAddon = null;
}

function cleanupTerminal() {
  _cleanupTerminalResources();
  document.body.classList.remove('terminal-active');
  exitFullscreen();

}

// === Fullscreen ===

function enterFullscreen() {
  terminalState.isFullscreen = true;
  document.body.classList.add('terminal-fullscreen');
  // Request browser fullscreen
  var el = document.documentElement;
  var rfs = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
  if (rfs) {
    rfs.call(el).catch(function () {});
  }
}

function exitFullscreen() {
  terminalState.isFullscreen = false;
  document.body.classList.remove('terminal-fullscreen');
  // Exit browser fullscreen
  var efsDoc = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
  if (efsDoc && document.fullscreenElement) {
    efsDoc.call(document).catch(function () {});
  }
}

function toggleFullscreen() {
  if (terminalState.isFullscreen) {
    exitFullscreen();
  } else {
    enterFullscreen();
  }
  // Re-fit after layout change
  if (terminalState.fitAddon) {
    setTimeout(function () { terminalState.fitAddon.fit(); }, 100);
  }
}

// Sync state when user exits browser fullscreen via Escape or browser UI
document.addEventListener('fullscreenchange', function () {
  if (!document.fullscreenElement && terminalState.isFullscreen) {
    terminalState.isFullscreen = false;
    document.body.classList.remove('terminal-fullscreen');
    var btn = document.querySelector('.terminal-exit-fullscreen-btn');
    if (btn) btn.style.display = 'none';
    if (terminalState.fitAddon) {
      setTimeout(function () { terminalState.fitAddon.fit(); }, 100);
    }
  }
});

// === Pane Switching ===

function switchPane(newPaneId) {
  if (newPaneId === state.currentPane) return;
  state.currentPane = newPaneId;

  // Always do full reconnect so the new pane gets zoomed
  var content = document.getElementById('content');
  if (content) {
    cleanupTerminal();
    renderTerminal(content);
  }
}

// Switch to adjacent pane by direction (-1 = prev, +1 = next)
function switchPaneByDirection(direction) {
  if (!state.panes || state.panes.length <= 1) return;
  var currentIndex = -1;
  for (var i = 0; i < state.panes.length; i++) {
    if (state.panes[i].id === state.currentPane) { currentIndex = i; break; }
  }
  if (currentIndex < 0) return;
  var newIndex = currentIndex + direction;
  if (newIndex < 0) newIndex = state.panes.length - 1;
  if (newIndex >= state.panes.length) newIndex = 0;
  switchPane(state.panes[newIndex].id);
}

// === Pane Navigation Bar (with arrows) ===

function renderPaneNavBar(container, panes, activePaneId, onSwitch) {
  container.innerHTML = '';
  if (!panes || panes.length <= 1) {
    // Still render pills for single pane (no arrows needed)
    renderPanePills(container, panes, activePaneId, onSwitch);
    return;
  }

  var nav = document.createElement('div');
  nav.className = 'pane-nav-bar';

  var prevBtn = document.createElement('button');
  prevBtn.className = 'btn pane-nav-arrow';
  prevBtn.textContent = '‹';
  prevBtn.addEventListener('click', function () { switchPaneByDirection(-1); });

  var pillsWrap = document.createElement('div');
  pillsWrap.className = 'pane-nav-pills';
  renderPanePills(pillsWrap, panes, activePaneId, onSwitch);

  var nextBtn = document.createElement('button');
  nextBtn.className = 'btn pane-nav-arrow';
  nextBtn.textContent = '›';
  nextBtn.addEventListener('click', function () { switchPaneByDirection(1); });

  // Current pane indicator
  var currentIdx = 0;
  for (var i = 0; i < panes.length; i++) {
    if (panes[i].id === activePaneId) { currentIdx = i; break; }
  }
  var indicator = document.createElement('div');
  indicator.className = 'pane-nav-indicator';
  indicator.textContent = (currentIdx + 1) + ' / ' + panes.length;

  nav.appendChild(prevBtn);
  nav.appendChild(pillsWrap);
  nav.appendChild(nextBtn);
  container.appendChild(nav);
  container.appendChild(indicator);
}

// === Per-pane/window Font Size Offset ===
//
// In tab mode, font offset is stored per pane (key = pane ID, e.g. "%0").
// In split mode, font offset is stored per window (key = "session:windowIndex").
// All offsets are stored in a single localStorage JSON object under 'tmux_font_offsets'.

var _fontOffsets = (function () {
  try {
    // Remove legacy single-offset key
    localStorage.removeItem('tmux_font_offset');
  } catch (_e) {}
  try {
    return JSON.parse(localStorage.getItem('tmux_font_offsets')) || {};
  } catch (_e) { return {}; }
})();

function _fontOffsetKey() {
  if (_terminalMode === 'split') {
    return (state.currentSession || '') + ':' + (state.currentWindow || '');
  }
  return state.currentPane || '';
}

function _getFontOffset() {
  return _fontOffsets[_fontOffsetKey()] || 0;
}

function _setFontOffset(val) {
  var key = _fontOffsetKey();
  if (val === 0) {
    delete _fontOffsets[key];
  } else {
    _fontOffsets[key] = val;
  }
  _saveFontOffsets();
}

function _saveFontOffsets() {
  try { localStorage.setItem('tmux_font_offsets', JSON.stringify(_fontOffsets)); } catch (_e) {}
}

// Clean up offsets for pane IDs that no longer exist
function _cleanupFontOffsets(validPaneIds) {
  var changed = false;
  var keys = Object.keys(_fontOffsets);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    // Pane keys start with '%', window keys contain ':'
    if (k.charAt(0) === '%' && validPaneIds.indexOf(k) === -1) {
      delete _fontOffsets[k];
      changed = true;
    }
  }
  if (changed) _saveFontOffsets();
}

function _adjustFontSize(dir) {
  if (!terminalState.term || !terminalState.fitAddon) return;
  var current = terminalState.term.options.fontSize || 14;
  var next = Math.max(8, Math.min(22, current + dir));
  if (next === current) return;
  var offset = _getFontOffset() + dir;
  _setFontOffset(offset);
  terminalState.term.options.fontSize = next;
  terminalState.fitAddon.fit();
  if (terminalState.ws && terminalState.ws.readyState === WebSocket.OPEN) {
    terminalState.ws.send(JSON.stringify({
      type: 'resize',
      cols: terminalState.term.cols,
      rows: terminalState.term.rows,
    }));
  }
}

// === Terminal View Mode (tab / split) ===

var _terminalMode = (function () {
  try { return localStorage.getItem('tmux_terminal_mode') || 'tab'; } catch (_e) { return 'tab'; }
})();

function _calcTerminalFontSize(paneCols, paneRows, containerEl) {
  var container = containerEl || document.querySelector('.terminal-container');
  var w = container ? container.clientWidth : window.innerWidth;
  var h = container ? container.clientHeight : window.innerHeight;

  // Use tmux pane's actual cols/rows as target
  var cols = paneCols || 80;
  var rows = paneRows || 24;

  // Monospace char width ≈ 0.6 * fontSize, line height ≈ 1.2 * fontSize
  // Subtract small padding (8px total)
  var fromWidth = (w - 8) / (cols * 0.6);
  var fromHeight = (h - 8) / (rows * 1.2);
  var size = Math.min(fromWidth, fromHeight);
  var base = Math.max(10, Math.min(16, Math.round(size)));
  // Apply user's manual offset (from A+/A- buttons), clamped to [8, 22]
  return Math.max(8, Math.min(22, base + _getFontOffset()));
}

// === Create xterm Terminal ===

function createTerminalInstance(paneCols, paneRows) {
  return new Terminal({
    theme: Theme.getTerminalTheme(),
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
    fontSize: _calcTerminalFontSize(paneCols, paneRows),
    cursorBlink: true,
    scrollback: 5000,
    overviewRulerWidth: 0,
    rescaleOverlappingGlyphs: true,
  });
}

// === Connect WebSocket ===

function connectTerminalWs(paneId, term, nozoom) {
  var wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var wsUrl = wsProtocol + '//' + location.host + '/ws/terminal/' + encodeURIComponent(paneId);
  var queryParts = [];
  if (nozoom) queryParts.push('nozoom=1');
  var tokenParam = Auth.wsTokenParam();
  if (tokenParam) queryParts.push(tokenParam);
  if (queryParts.length > 0) wsUrl += '?' + queryParts.join('&');

  var ws = new WebSocket(wsUrl);

  ws.onopen = function () {
    // Send initial resize
    if (term.cols && term.rows) {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }
  };

  ws.onmessage = function (e) {
    try {
      var msg = JSON.parse(e.data);
      if (msg.type === 'output') {
        term.write(msg.data);
      } else if (msg.type === 'clipboard') {
        _copyToClipboard(msg.data);
      }
    } catch (_err) {
      // Ignore parse errors
    }
  };

  ws.onclose = function () {
    // Could show reconnect UI here
  };

  ws.onerror = function () {
    // Will trigger onclose
  };

  // Suppress mouse-move reports after right-click so tmux popup menus stay open.
  // SGR mouse move: \x1b[<35;X;YM (button 35 = no-button movement)
  // SGR mouse drag: \x1b[<32..34;X;YM (button held + movement)
  var _suppressMouseMove = false;
  var _sgrMoveRe = /^\x1b\[<(35|32|33|34);\d+;\d+[Mm]$/;

  term.onData(function (data) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (_suppressMouseMove && _sgrMoveRe.test(data)) return;
    ws.send(JSON.stringify({ type: 'input', data: data }));
  });

  // Track right-click on terminal element
  var termEl = term.element;
  if (termEl) {
    termEl.addEventListener('mousedown', function (e) {
      if (e.button === 2) _suppressMouseMove = true;
      if (e.button === 0) _suppressMouseMove = false;
    }, true);
  }

  return ws;
}

// === Render Terminal View ===

function renderTerminal(container) {
  // Cleanup previous terminal resources without removing body class
  _cleanupTerminalResources();

  // Reset scroll position — if #content was scrolled (e.g. long window list),
  // the terminal header would be pushed above the visible area.
  container.scrollTop = 0;

  if (!state.currentSession || !state.currentWindow) {
    container.innerHTML =
      '<div style="padding: 24px; text-align: center; color: var(--text-muted);">' +
      '<p style="font-size: 1.2rem; margin-bottom: 8px;">No terminal selected</p>' +
      '<p>Select a session and window first.</p>' +
      '</div>';
    return;
  }

  // Reset page-level scroll (windows list may have scrolled <body>)
  // and lock body for mobile terminal layout
  window.scrollTo(0, 0);
  document.body.classList.add('terminal-active');

  // Build the terminal view structure
  container.innerHTML =
    '<div class="terminal-view">' +
    '<div class="terminal-header">' +
    '<button class="btn terminal-back-btn">&larr;</button>' +
    '<div class="terminal-header-pills"></div>' +
    '<span class="terminal-header-title"></span>' +
    '<div class="terminal-header-actions">' +
    '<div class="terminal-mode-toggle">' +
    '<button class="btn terminal-mode-opt' + (_terminalMode === 'tab' ? ' active' : '') + '" data-mode="tab" title="标签页模式">&#9723;</button>' +
    '<button class="btn terminal-mode-opt' + (_terminalMode === 'split' ? ' active' : '') + '" data-mode="split" title="分屏模式">&#8862;</button>' +
    '</div>' +
    '<button class="btn terminal-font-btn" data-dir="-1" title="Smaller font">A&#8722;</button>' +
    '<button class="btn terminal-font-btn" data-dir="1" title="Larger font">A&#43;</button>' +
    '<button class="btn terminal-split-btn" title="Split pane">&#10010;</button>' +
    '<button class="btn terminal-popout-btn" title="Pop out">&#8599;</button>' +
    '<button class="btn terminal-fullscreen-btn" title="Fullscreen">&#9634;</button>' +
    '</div>' +
    '</div>' +
    '<div class="terminal-pane-switcher"></div>' +
    '<div class="terminal-container"></div>' +
    '<button class="btn terminal-exit-fullscreen-btn" title="Exit fullscreen" style="display:none;">&times; Exit</button>' +
    '</div>';

  var view = container.querySelector('.terminal-view');
  var titleEl = view.querySelector('.terminal-header-title');
  var paneSwitcher = view.querySelector('.terminal-pane-switcher');
  var termContainer = view.querySelector('.terminal-container');
  var exitFsBtn = view.querySelector('.terminal-exit-fullscreen-btn');

  // Set title
  titleEl.textContent = escapeHtml(state.currentSession) + ' : ' + state.currentWindow;

  // Back button
  view.querySelector('.terminal-back-btn').addEventListener('click', function () {
    _backToWindows();
  });

  // Font size buttons
  view.querySelectorAll('.terminal-font-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var dir = parseInt(btn.getAttribute('data-dir'), 10);
      _adjustFontSize(dir);
    });
  });

  // Swipe-back visual indicator (rendered once, driven by overlay touch handler)
  if (window.innerWidth < 768) {
    var ind = document.createElement('div');
    ind.className = 'swipe-back-indicator';
    view.appendChild(ind);
  }

  // Split button
  function doSplit(direction) {
    api
      .post(
        '/api/sessions/' + encodeURIComponent(state.currentSession) +
        '/windows/' + encodeURIComponent(state.currentWindow) + '/panes',
        { paneId: state.currentPane, direction: direction }
      )
      .then(function () {
        renderTerminal(container);
      })
      .catch(function (err) {
        showAlert({ title: '分割窗格失败', message: err.message });
      });
  }

  view.querySelector('.terminal-split-btn').addEventListener('click', function (e) {
    // Mobile: split directly (direction doesn't matter, each pane gets its own screen)
    if (window.innerWidth < 768) {
      doSplit('vertical');
      return;
    }

    // Desktop: show popup to choose direction
    var existing = view.querySelector('.split-popup');
    if (existing) { existing.remove(); return; }

    var popup = document.createElement('div');
    popup.className = 'split-popup';
    popup.innerHTML =
      '<button class="btn split-popup-btn" data-dir="horizontal">&#x2194; 水平分割</button>' +
      '<button class="btn split-popup-btn" data-dir="vertical">&#x2195; 垂直分割</button>';

    var btn = e.currentTarget;
    btn.parentElement.appendChild(popup);

    popup.querySelectorAll('.split-popup-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        popup.remove();
        doSplit(b.getAttribute('data-dir'));
      });
    });

    function closePopup(ev) {
      if (!popup.contains(ev.target) && ev.target !== btn) {
        popup.remove();
        document.removeEventListener('click', closePopup, true);
      }
    }
    setTimeout(function () {
      document.addEventListener('click', closePopup, true);
    }, 0);
  });

  // Mode toggle (tab / split)
  view.querySelectorAll('.terminal-mode-opt').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var mode = btn.getAttribute('data-mode');
      if (mode === _terminalMode) return;
      _terminalMode = mode;
      try { localStorage.setItem('tmux_terminal_mode', mode); } catch (_e) {}
      // Re-render terminal view
      renderTerminal(container);
    });
  });

  // Pop-out button
  view.querySelector('.terminal-popout-btn').addEventListener('click', function () {
    if (state.currentPane) {
      window.open(
        '/terminal.html?pane=' + encodeURIComponent(state.currentPane),
        '_blank',
        'width=800,height=600'
      );
    }
  });

  // Fullscreen button
  view.querySelector('.terminal-fullscreen-btn').addEventListener('click', function () {
    toggleFullscreen();
    exitFsBtn.style.display = terminalState.isFullscreen ? 'block' : 'none';
  });

  // Exit fullscreen button (floating)
  exitFsBtn.addEventListener('click', function () {
    exitFullscreen();
    exitFsBtn.style.display = 'none';
    if (terminalState.fitAddon) {
      setTimeout(function () { terminalState.fitAddon.fit(); }, 100);
    }
  });

  // Fetch panes and set up terminal
  api
    .get(
      '/api/sessions/' + encodeURIComponent(state.currentSession) +
      '/windows/' + encodeURIComponent(state.currentWindow) + '/panes'
    )
    .then(function (result) {
      var panes = result.data || [];
      state.panes = panes;

      // Clean up font offsets for panes that no longer exist
      _cleanupFontOffsets(panes.map(function (p) { return p.id; }));

      // If no current pane or current pane not in this window, pick first
      if (!state.currentPane || !panes.some(function (p) { return p.id === state.currentPane; })) {
        state.currentPane = panes.length > 0 ? panes[0].id : null;
      }

      var useSplit = _terminalMode === 'split' && panes.length > 1 && window.innerWidth >= 768;

      // Render pane pills only in tab mode — split mode shows all panes natively
      if (panes.length > 1 && !useSplit) {
        var headerPills = view.querySelector('.terminal-header-pills');
        renderPanePills(headerPills, panes, state.currentPane, switchPane);
      }

      // Hide mode toggle when only 1 pane
      if (panes.length <= 1) {
        var toggle = view.querySelector('.terminal-mode-toggle');
        if (toggle) toggle.style.display = 'none';
      }

      // Mount terminal — split mode uses nozoom (tmux renders native splits)
      if (state.currentPane) {
        _mountTerminal(termContainer, useSplit);
      } else {
        termContainer.innerHTML =
          '<div style="padding: 24px; text-align: center; color: var(--text-muted);">No panes available</div>';
      }
    })
    .catch(function (err) {
      termContainer.innerHTML =
        '<div style="padding: 24px; text-align: center; color: var(--accent-red);">' +
        'Failed to load panes: ' + escapeHtml(err.message) +
        '</div>';
    });
}

// === Mount Terminal Instance ===

function _mountTerminal(termContainer, nozoom) {
  // Get current pane's tmux dimensions (in split/nozoom mode, pass null to auto-fit)
  var currentPane = state.panes ? state.panes.find(function (p) { return p.id === state.currentPane; }) : null;
  var paneCols = nozoom ? null : (currentPane ? currentPane.width : null);
  var paneRows = nozoom ? null : (currentPane ? currentPane.height : null);
  var term = createTerminalInstance(paneCols, paneRows);
  var fitAddon = new FitAddon.FitAddon();
  var webLinksAddon = new WebLinksAddon.WebLinksAddon();

  term.loadAddon(fitAddon);
  term.loadAddon(webLinksAddon);

  term.open(termContainer);

  // Use WebGL renderer for crisp box-drawing characters (tmux split borders)
  if (typeof WebglAddon !== 'undefined') {
    try {
      var webglAddon = new WebglAddon.WebglAddon();
      webglAddon.onContextLoss(function () {
        webglAddon.dispose();
      });
      term.loadAddon(webglAddon);
    } catch (_e) {
      // WebGL not available — fall back to default canvas renderer
    }
  }



  // Small delay to ensure DOM is ready for fitting
  setTimeout(function () {
    fitAddon.fit();
    // On mobile, don't auto-focus to avoid browser scroll-to-focus pushing header away
    if (window.innerWidth >= 768) {
      term.focus();
    }
    // Reset #content scroll after mount — focus or xterm layout may have caused scroll
    var contentEl = document.getElementById('content');
    if (contentEl) contentEl.scrollTop = 0;
  }, 50);


  // Connect WebSocket (nozoom = split mode, shows full window with native tmux splits)
  var ws = connectTerminalWs(state.currentPane, term, nozoom);

  // Enable touch scrolling on mobile.
  // xterm.js preventDefault()s all touch events on its canvas, and tmux uses
  // the alternate screen buffer so xterm's local scrollback is empty.
  // Solution: overlay intercepts touch gestures and sends mouse wheel escape
  // sequences through the WebSocket so tmux handles the scrolling directly.
  var overlay = document.createElement('div');
  overlay.className = 'terminal-touch-overlay';
  termContainer.appendChild(overlay);

  // Unified touch handler: vertical = tmux scroll, horizontal = swipe back
  var ts = {
    startX: 0, startY: 0, lastY: 0,
    moved: false, scrollAccum: 0,
    direction: null,  // null | 'vertical' | 'horizontal'
    startTime: 0, currentDx: 0,
  };
  var LOCK_DISTANCE = 12;         // px before direction locks
  var swipeIndicator = termContainer.closest('.terminal-view')
    ? termContainer.closest('.terminal-view').querySelector('.swipe-back-indicator')
    : null;
  var sw = window.innerWidth;
  var SWIPE_THRESHOLD = sw * 0.22;
  var VELOCITY_TRIGGER = 0.35;    // px/ms

  // Pinch-to-zoom state
  var pinch = { active: false, startDist: 0, startFontSize: 0 };

  function _pinchDist(e) {
    var t0 = e.touches[0], t1 = e.touches[1];
    var dx = t1.clientX - t0.clientX, dy = t1.clientY - t0.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  overlay.addEventListener('touchstart', function (e) {
    if (e.touches.length === 2) {
      // Start pinch-to-zoom
      pinch.active = true;
      pinch.startDist = _pinchDist(e);
      pinch.startFontSize = term.options.fontSize || 14;
      ts.direction = null;
      e.preventDefault();
      return;
    }
    if (e.touches.length === 1) {
      pinch.active = false;
      var t = e.touches[0];
      ts.startX = t.clientX;
      ts.startY = t.clientY;
      ts.lastY = t.clientY;
      ts.moved = false;
      ts.scrollAccum = 0;
      ts.direction = null;
      ts.startTime = Date.now();
      ts.currentDx = 0;
      if (swipeIndicator) {
        swipeIndicator.style.transition = 'none';
        swipeIndicator.style.opacity = '0';
      }
    }
  });

  overlay.addEventListener('touchmove', function (e) {
    // Pinch-to-zoom: adjust font size
    if (e.touches.length === 2 && pinch.active) {
      var dist = _pinchDist(e);
      var scale = dist / pinch.startDist;
      var newSize = Math.round(pinch.startFontSize * scale);
      newSize = Math.max(8, Math.min(22, newSize));
      if (newSize !== term.options.fontSize) {
        var delta = newSize - term.options.fontSize;
        _setFontOffset(_getFontOffset() + delta);
        term.options.fontSize = newSize;
        fitAddon.fit();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      }
      e.preventDefault();
      return;
    }
    if (e.touches.length !== 1 || pinch.active) return;
    var t = e.touches[0];
    var dx = t.clientX - ts.startX;
    var dy = t.clientY - ts.startY;
    ts.moved = true;

    // Lock direction after initial movement
    if (!ts.direction) {
      if (Math.abs(dx) >= LOCK_DISTANCE || Math.abs(dy) >= LOCK_DISTANCE) {
        ts.direction = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
      } else {
        return; // Not enough movement yet
      }
    }

    if (ts.direction === 'horizontal') {
      ts.currentDx = Math.max(0, dx);
      // Visual feedback
      if (swipeIndicator) {
        var progress = Math.min(ts.currentDx / SWIPE_THRESHOLD, 1);
        swipeIndicator.style.opacity = String(progress * 0.9);
        swipeIndicator.style.transform = 'scaleX(' + (0.3 + progress * 0.7) + ')';
      }
      e.preventDefault();
    } else {
      // Vertical: tmux scroll
      var scrollDy = ts.lastY - t.clientY;
      ts.lastY = t.clientY;
      ts.scrollAccum += scrollDy;

      var lines = Math.trunc(ts.scrollAccum / 16);
      if (lines !== 0 && ws.readyState === WebSocket.OPEN) {
        var seq = lines > 0 ? '\x1b[<65;1;1M' : '\x1b[<64;1;1M';
        var count = Math.abs(lines);
        var batch = '';
        for (var j = 0; j < count; j++) { batch += seq; }
        ws.send(JSON.stringify({ type: 'input', data: batch }));
        ts.scrollAccum -= lines * 16;
      }
      e.preventDefault();
    }
  });

  overlay.addEventListener('touchend', function (e) {
    if (pinch.active) {
      pinch.active = false;
      return;
    }
    if (!ts.moved) {
      // Tap: pass through to terminal
      overlay.style.pointerEvents = 'none';
      var touch = e.changedTouches[0];
      var el = document.elementFromPoint(touch.clientX, touch.clientY);
      if (el) { el.focus(); el.click(); }
      setTimeout(function () { overlay.style.pointerEvents = ''; }, 300);
      return;
    }

    if (ts.direction === 'horizontal') {
      var endX = e.changedTouches[0].clientX;
      var totalDx = endX - ts.startX;
      var dt = Date.now() - ts.startTime;
      var velocity = dt > 0 ? totalDx / dt : 0;

      // Fade out indicator
      if (swipeIndicator) {
        swipeIndicator.style.transition = 'opacity 0.25s, transform 0.25s';
        swipeIndicator.style.opacity = '0';
        swipeIndicator.style.transform = 'scaleX(0.3)';
      }

      if (totalDx >= SWIPE_THRESHOLD || velocity >= VELOCITY_TRIGGER) {
        _backToWindows();
      }
    }
  });

  // ResizeObserver for auto-fit
  var resizeObserver = new ResizeObserver(function () {
    fitAddon.fit();
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }
  });
  resizeObserver.observe(termContainer);

  // Handle mobile virtual keyboard: when keyboard opens, visualViewport
  // shrinks but CSS vh doesn't. Resize terminal-container (not the whole view)
  // to keep the header visible.
  var vpHandler = null;
  if (window.visualViewport && window.innerWidth < 768) {
    var initialVpHeight = window.visualViewport.height;
    vpHandler = function () {
      var vvHeight = window.visualViewport.height;
      // Only intervene when keyboard is likely open (viewport shrunk > 100px)
      if (initialVpHeight - vvHeight > 100) {
        var header = termContainer.closest('.terminal-view')
          ? termContainer.closest('.terminal-view').querySelector('.terminal-header')
          : null;
        var headerH = header ? header.offsetHeight : 36;
        var contentPad = 24; // #content padding top+bottom
        var available = vvHeight - headerH - contentPad;
        if (available > 0) {
          termContainer.style.height = available + 'px';
          termContainer.style.maxHeight = available + 'px';
        }
      } else {
        termContainer.style.height = '';
        termContainer.style.maxHeight = '';
      }
      fitAddon.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };
    window.visualViewport.addEventListener('resize', vpHandler);
    window.visualViewport.addEventListener('scroll', vpHandler);
  }

  // Store references for cleanup
  terminalState.term = term;
  terminalState.ws = ws;
  terminalState.fitAddon = fitAddon;
  terminalState.resizeObserver = resizeObserver;
  terminalState._vpHandler = vpHandler;
}

// === Navigate back to windows and scroll to current window ===

function _backToWindows() {
  var windowIndex = state.currentWindow;
  cleanupTerminal();
  navigate('windows', { currentSession: state.currentSession });

  // After render, scroll to the window card that was just open
  if (windowIndex != null) {
    _scrollToWindowCard(windowIndex);
  }
}

function _scrollToWindowCard(windowIndex) {
  // The render is async (fetches sessions then windows), so poll briefly
  var attempts = 0;
  var timer = setInterval(function () {
    var card = document.querySelector('.swipe-container[data-window-index="' + windowIndex + '"]');
    if (card) {
      clearInterval(timer);
      // Scroll only #content container, not the entire page
      // (scrollIntoView scrolls all ancestors including body, pushing topbar out of view)
      var contentEl = document.getElementById('content');
      if (contentEl) {
        var cardRect = card.getBoundingClientRect();
        var contentRect = contentEl.getBoundingClientRect();
        var targetTop = contentEl.scrollTop + (cardRect.top - contentRect.top) - (contentEl.clientHeight - card.offsetHeight) / 2;
        contentEl.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
      }
      // Brief highlight
      card.style.outline = '2px solid var(--accent-blue)';
      card.style.outlineOffset = '2px';
      card.style.borderRadius = '10px';
      setTimeout(function () {
        card.style.outline = '';
        card.style.outlineOffset = '';
      }, 1500);
    }
    if (++attempts > 20) clearInterval(timer);
  }, 100);
}

