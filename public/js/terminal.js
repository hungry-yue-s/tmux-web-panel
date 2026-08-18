/* global Terminal, FitAddon, WebglAddon, Theme, Auth, api, state, navigate, escapeHtml, renderPaneLayout, renderPanePills, _promptSetActivePaneLabel, FilePreview, LinkDetect */

// === Clipboard Helper ===

function _execCommandCopy(text) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  var ok = false;
  try { ok = document.execCommand('copy'); } catch (_e) { ok = false; }
  document.body.removeChild(ta);
  return ok;
}

function _copyToClipboard(text, opts) {
  opts = opts || {};
  var silent = opts.silent;
  var n = text ? text.length : 0;
  function ok() { if (!silent) _showToast('已复制 ' + n + ' 字符'); }
  function fail(reason) { if (!silent) _showToast('复制失败' + (reason ? ' (' + reason + ')' : '')); }

  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(ok).catch(function (err) {
      // Async context lost user activation, or permission denied.
      // Fall back to execCommand (may also fail without gesture, but try).
      if (_execCommandCopy(text)) ok();
      else fail(err && err.name);
    });
    return;
  }
  if (_execCommandCopy(text)) ok();
  else fail();
}

// === Toast Notification ===

function _showToast(message, duration) {
  duration = duration || 2000;
  var existing = document.querySelector('.upload-toast');
  if (existing) existing.remove();

  var toast = document.createElement('div');
  toast.className = 'upload-toast';
  toast.textContent = message;
  document.body.appendChild(toast);

  requestAnimationFrame(function () {
    toast.classList.add('show');
  });

  setTimeout(function () {
    toast.classList.remove('show');
    setTimeout(function () { toast.remove(); }, 300);
  }, duration);
}

// === FAB Tool Panel ===

function _sendTermData(data) {
  if (terminalState.ws && terminalState.ws.readyState === WebSocket.OPEN) {
    terminalState.ws.send(JSON.stringify({ type: 'input', data: data }));
  }
}


function _createFabPanel(container) {
  // -- File input for upload --
  var fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.style.display = 'none';
  container.appendChild(fileInput);

  fileInput.addEventListener('change', function () {
    if (!fileInput.files || !fileInput.files[0]) return;
    var file = fileInput.files[0];
    var formData = new FormData();
    formData.append('file', file);
    fabEl.classList.add('uploading');
    fetch('/api/upload', {
      method: 'POST',
      headers: Auth.headers(),
      body: formData,
    })
      .then(function (res) {
        if (!res.ok) return res.json().then(function (j) { throw new Error(j.error || 'Upload failed'); });
        return res.json();
      })
      .then(function (result) {
        _copyToClipboard(result.data.path);
        _showToast('路径已复制: ' + result.data.path);
      })
      .catch(function (err) {
        _showToast('上传失败: ' + err.message, 3000);
      })
      .finally(function () {
        fabEl.classList.remove('uploading');
      });
  });

  // -- FAB button --
  var fabEl = document.createElement('div');
  fabEl.className = 'fab-tool';
  fabEl.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>';
  container.appendChild(fabEl);

  // -- Scene-aware drawer (FabDrawer) --
  var fabDrawerApi = null;
  var drawerVisible = false;
  var drawerMountEl = null;

  function toggleDrawer(open) {
    var willOpen = typeof open === 'boolean' ? open : !drawerVisible;

    if (willOpen) {
      // Mutually exclusive with soft keyboard: blur xterm textarea to
      // collapse the system keyboard before sliding the drawer up.
      if (document.activeElement && document.activeElement.blur) {
        try { document.activeElement.blur(); } catch (_e) { /* ignore */ }
      }
    }

    if (!drawerMountEl) {
      drawerMountEl = document.createElement('div');
      drawerMountEl.className = 'fab-drawer-mount';
      container.appendChild(drawerMountEl);
    }

    if (!fabDrawerApi && window.FabDrawer) {
      // Run migration on first mount
      if (window.FabMigrate) window.FabMigrate.runOnce();

      fabDrawerApi = window.FabDrawer.mount(drawerMountEl, {
        sendKey: function (seq) {
          if (seq === '__upload__') {
            fileInput.value = '';
            fileInput.click();
          } else {
            _sendTermData(seq);
          }
        },
        onKeyboard: function () {
          if (terminalState.term) {
            try { terminalState.term.focus(); } catch (_e) { /* ignore */ }
          }
          toggleDrawer(false);
        },
        onClose: function () { toggleDrawer(false); },
      });

      // Set initial scene from pre-existing pane-cmd data
      var curPane = state.currentPane;
      if (curPane && window._paneSceneMap && window._paneSceneMap[curPane]) {
        fabDrawerApi.setScene(window._paneSceneMap[curPane]);
      }
    }

    drawerMountEl.classList.toggle('open', willOpen);
    drawerVisible = willOpen;

    // Hide the FAB itself while the drawer is open
    fabEl.classList.toggle('hidden-by-drawer', willOpen);

    // Push .terminal-view up so the terminal re-fits above the drawer
    var tv = container.classList && container.classList.contains('terminal-view')
      ? container
      : (container.closest ? container.closest('.terminal-view') : null);
    if (tv) tv.classList.toggle('drawer-pushed', willOpen);

    // Re-fit xterm after CSS transition settles (0.25s), then tell tmux
    // about the new cols/rows so the pane redraws at the right size.
    setTimeout(function () {
      if (terminalState.fitAddon) {
        try { terminalState.fitAddon.fit(); } catch (_e) { /* ignore */ }
      }
      var tws = terminalState.ws, tterm = terminalState.term;
      if (tws && tws.readyState === WebSocket.OPEN && tterm) {
        tws.send(JSON.stringify({ type: 'resize', cols: tterm.cols, rows: tterm.rows }));
      }
    }, 270);
  }

  // Auto-close drawer when the user taps the terminal: the tap focuses
  // xterm's hidden textarea (triggering the system soft keyboard) — mutually
  // exclusive with the drawer, so collapse it back to the FAB state.
  function _onTerminalFocus(e) {
    if (!drawerVisible) return;
    var t = e.target;
    if (t && t.classList && t.classList.contains('xterm-helper-textarea')) {
      toggleDrawer(false);
    }
  }
  document.addEventListener('focusin', _onTerminalFocus);

  // -- FAB drag + tap-to-open-drawer --
  var dragStartX, dragStartY, fabStartX, fabStartY, dragMoved;

  fabEl.addEventListener('touchstart', function (e) {
    var t = e.touches[0];
    dragStartX = t.clientX; dragStartY = t.clientY;
    var rect = fabEl.getBoundingClientRect();
    fabStartX = rect.left; fabStartY = rect.top;
    dragMoved = false;
    fabEl.classList.add('dragging');
  }, { passive: true });

  fabEl.addEventListener('touchmove', function (e) {
    var t = e.touches[0];
    var dx = t.clientX - dragStartX, dy = t.clientY - dragStartY;
    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) dragMoved = true;
    if (!dragMoved) return;
    var nx = Math.max(0, Math.min(window.innerWidth - 48, fabStartX + dx));
    var ny = Math.max(0, Math.min(window.innerHeight - 48, fabStartY + dy));
    fabEl.style.left = nx + 'px'; fabEl.style.top = ny + 'px';
    fabEl.style.right = 'auto'; fabEl.style.bottom = 'auto';
  }, { passive: true });

  fabEl.addEventListener('touchend', function () {
    fabEl.classList.remove('dragging');
    if (!dragMoved) toggleDrawer(true);
    if (dragMoved) {
      localStorage.setItem('fab-pos', JSON.stringify({ left: fabEl.style.left, top: fabEl.style.top }));
    }
  }, { passive: true });

  fabEl.addEventListener('click', function () {
    if (!('ontouchstart' in window)) toggleDrawer(true);
  });

  // Restore position
  try {
    var pos = JSON.parse(localStorage.getItem('fab-pos'));
    if (pos) {
      fabEl.style.left = pos.left; fabEl.style.top = pos.top;
      fabEl.style.right = 'auto'; fabEl.style.bottom = 'auto';
    }
  } catch (_e) { /* ignore */ }

  // Return cleanup function
  return function () {
    document.removeEventListener('focusin', _onTerminalFocus);
    if (drawerMountEl && drawerMountEl.parentNode) {
      drawerMountEl.parentNode.removeChild(drawerMountEl);
    }
  };
}

// === Terminal State ===

var terminalState = {
  term: null,
  ws: null,
  fitAddon: null,
  resizeObserver: null,
  isFullscreen: false,
  ownsBrowserFullscreen: false,
};

// === Cleanup ===

function _cleanupTerminalResources() {
  terminalState.termContainer = null;
  if (terminalState._resizeHandler) {
    window.removeEventListener('resize', terminalState._resizeHandler);
    terminalState._resizeHandler = null;
  }
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
  var currentFullscreen = document.fullscreenElement || document.webkitFullscreenElement;
  terminalState.ownsBrowserFullscreen = !currentFullscreen;
  var rfs = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
  if (rfs && terminalState.ownsBrowserFullscreen) {
    try {
      var request = rfs.call(el);
      if (request && request.catch) {
        request.catch(function () { terminalState.ownsBrowserFullscreen = false; });
      }
    } catch (_err) {
      terminalState.ownsBrowserFullscreen = false;
    }
  }
}

function exitFullscreen() {
  var shouldExitBrowserFullscreen = terminalState.ownsBrowserFullscreen;
  terminalState.isFullscreen = false;
  terminalState.ownsBrowserFullscreen = false;
  document.body.classList.remove('terminal-fullscreen');
  // Exit browser fullscreen
  var efsDoc = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
  var currentFullscreen = document.fullscreenElement || document.webkitFullscreenElement;
  if (efsDoc && currentFullscreen && shouldExitBrowserFullscreen) {
    try {
      var exit = efsDoc.call(document);
      if (exit && exit.catch) exit.catch(function () {});
    } catch (_err) {}
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
  var currentFullscreen = document.fullscreenElement || document.webkitFullscreenElement;
  if (!currentFullscreen && terminalState.isFullscreen) {
    terminalState.isFullscreen = false;
    terminalState.ownsBrowserFullscreen = false;
    document.body.classList.remove('terminal-fullscreen');
    var btn = document.querySelector('.terminal-exit-fullscreen-btn');
    if (btn) btn.style.display = 'none';
    if (terminalState.fitAddon) {
      setTimeout(function () { terminalState.fitAddon.fit(); }, 100);
    }
  }
});

// === Pane Switching ===

// state.currentPane identifies the pane used to attach the terminal client.
// In native split mode that client renders the entire window, so currentPane
// may remain the first pane even after tmux focus moves elsewhere. Resolve the
// live active pane before any action whose relative paths depend on pane cwd.
function _resolvePreviewPaneId() {
  var fallback = state.currentPane;
  var useSplit = _terminalMode === 'split' && state.panes && state.panes.length > 1 && window.innerWidth >= 768;
  if (!useSplit || !state.currentSession || state.currentWindow == null) {
    return Promise.resolve(fallback);
  }

  return api.get(
    '/api/sessions/' + encodeURIComponent(state.currentSession) +
    '/windows/' + encodeURIComponent(state.currentWindow) + '/panes'
  ).then(function (result) {
    var panes = (result && result.data) || [];
    for (var i = 0; i < panes.length; i++) {
      if (panes[i].active) return panes[i].id;
    }
    return fallback;
  }).catch(function () {
    return fallback;
  });
}

function _openFilePreviewFromBuffer() {
  if (typeof FilePreview === 'undefined' || !state.currentPane) return Promise.resolve();
  return _resolvePreviewPaneId().then(function (paneId) {
    if (paneId) FilePreview.openFromBuffer(paneId);
  });
}

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
    return (state.currentSession || '') + ':' +
      (state.currentWindow != null ? state.currentWindow : '');
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

function createTerminalInstance(paneCols, paneRows, nozoom) {
  var term = new Terminal({
    theme: Theme.getTerminalTheme(),
    fontFamily: "'Maple Mono NF CN', 'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Symbols Nerd Font Mono', monospace",
    fontSize: _calcTerminalFontSize(paneCols, paneRows),
    cursorBlink: true,
    scrollback: 5000,
    overviewRuler: { width: 0 },
    rescaleOverlappingGlyphs: true,
    // tmux runs with `mouse on`, so xterm forwards every drag to tmux and
    // DISABLES its own local selection. tmux then routes the drag to copy-mode
    // OR — if the pane runs a mouse-grabbing app (claude/vim/htop/less) — to
    // that APP, whose weak/absent drag-select is what stalls after a few chars
    // (same break in a native terminal, hence "tmux 内部异常时浏览器也异常").
    // The escape hatch is xterm's force-selection modifier (macOS: Option +
    // this option; Linux/Win: Shift), which bypasses both tmux and the app for
    // a clean LOCAL selection.
    //
    // ONLY enable it in zoom/tab mode, where xterm renders a single pane.
    // In split (nozoom) mode the grid holds ALL panes + borders, and xterm's
    // LINEAR selection is not pane-aware — Option+drag would select straight
    // across the `│` border into the next pane. Split mode must use tmux's own
    // pane-aware copy-mode instead (plain drag, or keyboard prefix+[).
    macOptionClickForcesSelection: !nozoom,
  });
  return term;
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

  ws.onclose = function (event) {
    // Clean close (1000) = tmux detached us: another client attached with `-d`
    // and took over, or the session ended. Reconnecting would just kick that
    // client back — an endless ping-pong between two web views. 1008/1013 are
    // permanent rejections (bad paneId / connection limit). Only auto-reconnect
    // on abnormal closures (1006 network drop / server crash / restart).
    if (event && (event.code === 1000 || event.code === 1008 || event.code === 1013)) {
      if (event.code === 1000) _showToast('会话已被其它窗口接管');
      return;
    }
    if (terminalState.term === term && state.currentTab === 'terminal') {
      _showReconnectOverlay(term, paneId, nozoom);
    }
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

    // --- IME composition guard ---
    // During active composition, suppress onData — intermediate text is
    // managed by the IME, not meant for the terminal.
    if (term._imeComposing) return;

    // After compositionend, xterm's CompositionHelper fires onData with the
    // final composed text. Allow that first send, suppress duplicates.
    if (term._imeGuardUntil && Date.now() < term._imeGuardUntil) {
      // Enter that confirmed the IME candidate — not a real terminal Enter
      if (data === '\r') return;
      // First onData with composed text: let it through (xterm's legitimate send)
      if (!term._imeSentOnce && term._imeLastComposed && data === term._imeLastComposed) {
        term._imeSentOnce = true;
        // fall through to ws.send
      } else if (term._imeSentOnce && term._imeLastComposed && data === term._imeLastComposed) {
        // Duplicate — suppress
        return;
      }
    }

    ws.send(JSON.stringify({ type: 'input', data: data }));
  });

  // Track right-click on terminal element
  var termEl = term.element;
  if (termEl) {
    termEl.addEventListener('mousedown', function (e) {
      if (e.button === 2) _suppressMouseMove = true;
      if (e.button === 0) _suppressMouseMove = false;
    }, true);

    // Desktop local-selection copy. In zoom/tab mode (single pane rendered)
    // macOptionClickForcesSelection is on, so Option/Alt+drag (Mac) or
    // Shift+drag (Linux/Win) makes a LOCAL xterm selection that bypasses both
    // tmux and any mouse-grabbing app in the pane (immune to live-output
    // repaints, edge-drops, copy-mode state). xterm's selection lives on the
    // canvas, not the DOM, so Cmd/Ctrl+C can't grab it — copy it on release.
    //   - Plain drag forwards to tmux → xterm selection stays empty here → no
    //     double-copy against tmux's OSC 52 path.
    //   - Split (nozoom) mode: macOptionClickForcesSelection is OFF, so xterm
    //     never makes a selection → getSelection() is empty → this is inert.
    //     Split mode relies on tmux's pane-aware copy-mode instead.
    termEl.addEventListener('mouseup', function () {
      if (window.innerWidth < 768) return; // mobile has its own selection UI
      var text = term.getSelection();
      if (text) _copyToClipboard(text);
    });
  }

  return ws;
}

// === Render Terminal View ===

function _terminalToolIcon(paths) {
  return '<svg class="terminal-tool-icon" viewBox="0 0 24 24" fill="none"'
    + ' stroke="currentColor" stroke-width="1.8" stroke-linecap="round"'
    + ' stroke-linejoin="round" aria-hidden="true" focusable="false">'
    + paths + '</svg>';
}

function _terminalFontIcon(sign) {
  return '<span class="terminal-font-glyph" aria-hidden="true">A'
    + '<span>' + sign + '</span></span>';
}

function renderTerminal(container) {
  // Cleanup previous terminal resources without removing body class
  _cleanupTerminalResources();

  // Reset scroll position — if #content was scrolled (e.g. long window list),
  // the terminal header would be pushed above the visible area.
  container.scrollTop = 0;

  if (!state.currentSession || !_isValidWindowIndex(state.currentWindow)) {
    state.currentWindow = null;
    state.currentPane = null;
    if (typeof saveNavState === 'function') saveNavState();
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
    '<button type="button" class="btn terminal-tool-btn terminal-back-btn" title="返回窗口列表" aria-label="返回窗口列表">' +
    _terminalToolIcon('<path d="m15 18-6-6 6-6"/><path d="M9 12h10"/>') + '</button>' +
    '<div class="terminal-header-pills"></div>' +
    '<span class="terminal-header-title"></span>' +
    '<div class="terminal-header-actions" role="toolbar" aria-label="终端控制">' +
    '<button type="button" class="btn terminal-tool-btn terminal-refresh-btn" title="刷新终端" aria-label="刷新终端">' +
    _terminalToolIcon('<path d="M20 11a8 8 0 1 0-2.34 5.66"/><path d="M20 4v7h-7"/>') + '</button>' +
    '<div class="terminal-mode-toggle" role="group" aria-label="终端布局模式">' +
    '<button type="button" class="btn terminal-tool-btn terminal-mode-opt' + (_terminalMode === 'tab' ? ' active' : '') + '" data-mode="tab" title="标签页模式" aria-label="标签页模式" aria-pressed="' + (_terminalMode === 'tab' ? 'true' : 'false') + '">' +
    _terminalToolIcon('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M7 6.5h4"/>') + '</button>' +
    '<button type="button" class="btn terminal-tool-btn terminal-mode-opt' + (_terminalMode === 'split' ? ' active' : '') + '" data-mode="split" title="分屏模式 · 再点一次打开布局选择器" aria-label="分屏模式" aria-pressed="' + (_terminalMode === 'split' ? 'true' : 'false') + '">' +
    _terminalToolIcon('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18"/><path d="M3 12h18"/>') + '</button>' +
    '</div>' +
    '<div class="terminal-font-toggle" role="group" aria-label="终端字号">' +
    '<button type="button" class="btn terminal-tool-btn terminal-font-btn" data-dir="-1" title="减小字号" aria-label="减小字号">' + _terminalFontIcon('\u2212') + '</button>' +
    '<button type="button" class="btn terminal-tool-btn terminal-font-btn" data-dir="1" title="增大字号" aria-label="增大字号">' + _terminalFontIcon('+') + '</button>' +
    '</div>' +
    '<button type="button" class="btn terminal-tool-btn terminal-split-btn" title="新增分屏" aria-label="新增分屏">' +
    _terminalToolIcon('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18"/><path d="M16.5 9v6"/><path d="M13.5 12h6"/>') + '</button>' +
    '<button type="button" class="btn terminal-tool-btn terminal-label-btn" title="设置当前窗格标签" aria-label="设置当前窗格标签">' +
    _terminalToolIcon('<path d="M20.59 13.41 11 3.83V3H4v7h.83l9.58 9.59a2 2 0 0 0 2.82 0l3.36-3.36a2 2 0 0 0 0-2.82Z"/><circle cx="7.5" cy="6.5" r="1"/>') + '</button>' +
    '<button type="button" class="btn terminal-tool-btn terminal-open-buf-btn" title="从 tmux 缓冲区打开文件 (Ctrl+Shift+O)" aria-label="从 tmux 缓冲区打开文件">' +
    _terminalToolIcon('<path d="M3 6h6l2 2h10v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M3 10h18"/>') + '</button>' +
    '<button type="button" class="btn terminal-tool-btn terminal-popout-btn" title="在新窗口打开" aria-label="在新窗口打开">' +
    _terminalToolIcon('<path d="M15 3h6v6"/><path d="m10 14 11-11"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>') + '</button>' +
    '<button type="button" class="btn terminal-tool-btn terminal-fullscreen-btn" title="全屏" aria-label="全屏">' +
    _terminalToolIcon('<path d="M8 3H3v5"/><path d="M16 3h5v5"/><path d="M8 21H3v-5"/><path d="M16 21h5v-5"/>') + '</button>' +
    '</div>' +
    '</div>' +
    '<div class="terminal-pane-switcher"></div>' +
    '<div class="terminal-container"></div>' +
    '<button class="btn terminal-exit-fullscreen-btn" title="Exit fullscreen" style="display:none;">&times; Exit</button>' +
    '</div>';

  var view = container.querySelector('.terminal-view');
  if (window.innerWidth < 768) _createFabPanel(view);
  var titleEl = view.querySelector('.terminal-header-title');
  var paneSwitcher = view.querySelector('.terminal-pane-switcher');
  var termContainer = view.querySelector('.terminal-container');
  terminalState.termContainer = termContainer;
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

  view.querySelector('.terminal-refresh-btn').addEventListener('click', function () {
    _sidebarSessionKey = '';
    render();
    updateSidebar();
  });



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

  // Set a label on the current pane — always available (works for single-pane
  // and split modes where no pane pills are shown).
  view.querySelector('.terminal-label-btn').addEventListener('click', function (e) {
    e.stopPropagation();
    if (typeof _promptSetActivePaneLabel === 'function') {
      _promptSetActivePaneLabel(state.currentSession, state.currentWindow);
    }
  });

  // Mode toggle: click to switch mode; if already in split mode, open layout picker
  view.querySelectorAll('.terminal-mode-opt').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var mode = btn.getAttribute('data-mode');
      if (mode === _terminalMode) {
        // Already in this mode — split button opens layout picker
        if (mode === 'split' && typeof LayoutPicker !== 'undefined') {
          LayoutPicker.open();
        }
        return;
      }
      _terminalMode = mode;
      try { localStorage.setItem('tmux_terminal_mode', mode); } catch (_e) {}
      renderTerminal(container);
    });
  });

  // Open file from tmux paste buffer
  view.querySelector('.terminal-open-buf-btn').addEventListener('click', function () {
    _openFilePreviewFromBuffer();
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
  var term = createTerminalInstance(paneCols, paneRows, nozoom);
  var fitAddon = new FitAddon.FitAddon();

  term.loadAddon(fitAddon);
  // URL + file-path links are both handled by FilePreview's unified provider
  // (public/js/link-detect.js), which merges soft-wrapped rows — something the
  // old WebLinksAddon (per display row) could not do. No web-links addon.
  if (typeof FilePreview !== 'undefined') {
    FilePreview.registerLinkProvider(term, state.currentPane, _resolvePreviewPaneId);
  }

  term.open(termContainer);

  // Disable mobile soft keyboard autocorrect/autocomplete to reduce
  // IME composition interference (Enter interpreted as delete, etc.)
  if (term.textarea) {
    term.textarea.setAttribute('autocapitalize', 'off');
    term.textarea.setAttribute('autocomplete', 'off');
    term.textarea.setAttribute('autocorrect', 'off');
    term.textarea.setAttribute('spellcheck', 'false');
    // Hint mobile keyboard that Enter means "send", not "newline"
    term.textarea.setAttribute('enterkeyhint', 'send');

    // --- Mobile CJK IME composition fix ---
    // xterm.js CompositionHelper (xtermjs/xterm.js#3600, #2403, #5108) has
    // known issues with mobile CJK IMEs (WeChat, Sogou, GBoard CJK):
    //   1. Enter confirms candidate but xterm also sends \r
    //   2. Composed text fires onData multiple times (duplicate input events)
    //   3. After compositionend, textarea retains text causing re-send
    //
    // Strategy: let xterm's CompositionHelper handle the first send of
    // composed text via its internal triggerDataEvent. We only add a guard
    // layer in onData to catch mobile-specific duplicates.
    // Ref: CodeMirror uses 200-400ms flush delay for Chrome Android.
    var _isAndroid = /Android/i.test(navigator.userAgent);
    var _imeGuardMs = _isAndroid ? 300 : 150;

    term._imeComposing = false;
    term._imeGuardUntil = 0;
    term._imeSentOnce = false;    // first onData after compositionend allowed
    term._imeLastComposed = null; // text from compositionend for dedup

    term.textarea.addEventListener('compositionstart', function () {
      term._imeComposing = true;
      term._imeSentOnce = false;
      term._imeLastComposed = null;
    });

    term.textarea.addEventListener('compositionend', function (e) {
      term._imeComposing = false;
      term._imeLastComposed = e.data || '';
      term._imeSentOnce = false;
      // Guard window: longer on Android (GBoard fires contradictory events)
      term._imeGuardUntil = Date.now() + _imeGuardMs;
      // Clear textarea AFTER xterm's CompositionHelper reads it.
      // xterm uses setTimeout(0) in _finalizeComposition; we wait longer.
      var ta = term.textarea;
      if (ta) {
        setTimeout(function () { ta.value = ''; }, 120);
      }
    });

    // During composition, block Enter from reaching xterm as \r.
    // Enter is for IME candidate confirmation, not terminal input.
    // Use both stopPropagation (prevent xterm handler) and preventDefault
    // (prevent default \r insertion on some mobile browsers).
    // Backspace: only stopPropagation (IME needs it for candidate editing,
    // but xterm shouldn't process it as terminal backspace).
    term.textarea.addEventListener('keydown', function (e) {
      // Use spec-standard isComposing (more reliable than manual tracking)
      var composing = term._imeComposing || e.isComposing;
      if (!composing) return;
      if (e.key === 'Enter' || e.keyCode === 13) {
        e.stopPropagation();
        e.preventDefault();
      } else if (e.key === 'Backspace' || e.keyCode === 8) {
        e.stopPropagation();
      }
    }, true); // capture phase — before xterm's handler
  }

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

  // Long-press to select text: convert touch coordinates to terminal row/col,
  // use term.select() to highlight word, allow drag to extend selection.
  var longPress = { timer: null, active: false };
  var sel = { anchorRow: 0, anchorCol: 0, dragging: false };
  var LONG_PRESS_MS = 500;
  var LONG_PRESS_MOVE_TOLERANCE = 10; // px

  // Cell metrics in on-screen px. Cached per gesture: getBoundingClientRect()
  // forces synchronous layout, and touchmove fires on every frame.
  var cellCache = null;

  function _cellMetrics() {
    if (cellCache) return cellCache;
    var screen = termContainer.querySelector('.xterm-screen');
    if (!screen) return null;
    var rect = screen.getBoundingClientRect();
    if (!rect.height || !term.cols || !term.rows) return null;
    cellCache = {
      left: rect.left,
      top: rect.top,
      w: rect.width / term.cols,
      h: rect.height / term.rows,
    };
    return cellCache;
  }

  // Convert touch clientX/Y to terminal col/row
  function _touchToCell(clientX, clientY) {
    var m = _cellMetrics();
    if (!m) return null;
    var col = Math.floor((clientX - m.left) / m.w);
    var row = Math.floor((clientY - m.top) / m.h);
    col = Math.max(0, Math.min(term.cols - 1, col));
    row = Math.max(0, Math.min(term.rows - 1, row));
    return { col: col, row: row };
  }

  // Get line text from buffer at a viewport row
  function _getLineText(viewportRow) {
    var bufRow = term.buffer.active.viewportY + viewportRow;
    var line = term.buffer.active.getLine(bufRow);
    return line ? line.translateToString() : '';
  }

  // Find word boundaries at col in lineText
  function _wordBounds(lineText, col) {
    if (col >= lineText.length || /\s/.test(lineText[col])) {
      // On whitespace — select single char
      return { start: col, end: col + 1 };
    }
    var start = col, end = col;
    while (start > 0 && /\S/.test(lineText[start - 1])) start--;
    while (end < lineText.length && /\S/.test(lineText[end])) end++;
    return { start: start, end: end };
  }

  function _enterSelectionMode(clientX, clientY) {
    var cell = _touchToCell(clientX, clientY);
    if (!cell) return;
    longPress.active = true;
    if (navigator.vibrate) navigator.vibrate(30);

    // Select word at long-press position
    var lineText = _getLineText(cell.row);
    var bounds = _wordBounds(lineText, cell.col);
    var bufRow = term.buffer.active.viewportY + cell.row;
    term.select(bounds.start, bufRow, bounds.end - bounds.start);

    sel.anchorRow = cell.row;
    sel.anchorCol = cell.col;
    sel.dragging = true;

    _showCopyButton();
    _updatePreview();
  }

  // Extend selection from anchor to current touch position (character-level,
  // works across lines via xterm's select() length wrapping)
  function _extendSelection(clientX, clientY) {
    var cell = _touchToCell(clientX, clientY);
    if (!cell) return;

    // Determine start and end in viewport coordinates
    var startRow, startCol, endRow, endCol;
    if (cell.row < sel.anchorRow || (cell.row === sel.anchorRow && cell.col < sel.anchorCol)) {
      sel.dragDirection = 'up';
      startRow = cell.row; startCol = cell.col;
      endRow = sel.anchorRow; endCol = sel.anchorCol;
    } else {
      sel.dragDirection = 'down';
      startRow = sel.anchorRow; startCol = sel.anchorCol;
      endRow = cell.row; endCol = cell.col;
    }

    // Snap start to word beginning, end to word end
    var startLine = _getLineText(startRow);
    var endLine = _getLineText(endRow);
    var sBounds = _wordBounds(startLine, startCol);
    var eBounds = _wordBounds(endLine, endCol);

    var selCol = sBounds.start;
    var selBufRow = term.buffer.active.viewportY + startRow;
    // Total length = remaining chars on start line + full middle lines + chars on end line
    var length;
    if (startRow === endRow) {
      length = eBounds.end - sBounds.start;
    } else {
      length = (term.cols - sBounds.start); // rest of start line
      for (var r = startRow + 1; r < endRow; r++) length += term.cols;
      length += eBounds.end; // end line
    }
    term.select(selCol, selBufRow, length);
    _showCopyButton();
    _updatePreview();
  }

  function _updatePreview() {
    var text = term.getSelection();
    if (!text) { _hidePreview(); return; }
    var el = termContainer.querySelector('.term-sel-preview');
    if (!el) {
      el = document.createElement('textarea');
      el.className = 'term-sel-preview';
      el.spellcheck = false;
      el.autocomplete = 'off';
      // Stop touch events on preview from propagating to overlay
      el.addEventListener('touchstart', function (ev) { ev.stopPropagation(); });
      el.addEventListener('touchmove', function (ev) { ev.stopPropagation(); });
      el.addEventListener('touchend', function (ev) { ev.stopPropagation(); });
      termContainer.appendChild(el);
    }
    // Only update value while dragging; once user lifts finger they can edit freely
    if (sel.dragging) {
      el.value = text;
      if (sel.dragDirection === 'up') {
        el.scrollTop = 0;
      } else {
        el.scrollTop = el.scrollHeight;
      }
    }
  }

  // Get the current preview text (user may have edited it)
  function _getPreviewText() {
    var el = termContainer.querySelector('.term-sel-preview');
    return el ? el.value : '';
  }

  function _hidePreview() {
    var el = termContainer.querySelector('.term-sel-preview');
    if (el) el.remove();
  }

  function _exitSelectionMode() {
    if (!longPress.active) return;
    longPress.active = false;
    sel.dragging = false;
    _hideCopyButton();
    _hidePreview();
    term.clearSelection();
  }

  function _showCopyButton() {
    if (!term.getSelection()) return;
    var existing = termContainer.querySelector('.term-copy-btn');
    if (existing) return;
    var btn = document.createElement('button');
    btn.className = 'term-copy-btn';
    btn.textContent = 'Copy';
    btn.addEventListener('touchend', function (ev) {
      ev.stopPropagation();
      ev.preventDefault();
      var text = _getPreviewText() || term.getSelection();
      if (text) _copyToClipboard(text);
      term.clearSelection();
      _showToast('Copied');
      longPress.active = false;
      sel.dragging = false;
      _hideCopyButton();
      _hidePreview();
    });
    termContainer.appendChild(btn);
  }

  function _hideCopyButton() {
    var btn = termContainer.querySelector('.term-copy-btn');
    if (btn) btn.remove();
  }

  // Emit `lines` worth of SGR wheel events at the given screen point.
  // Shared by finger-tracking drag and inertial fling.
  function _sendWheelLines(lines, clientX, clientY) {
    if (ws.readyState !== WebSocket.OPEN) return false;
    // Send the wheel event at the finger's terminal cell, NOT 1;1 — tmux
    // treats the 1;1 corner as outside any pane and drops WheelUpPane, so
    // a hard-coded 1;1 never scrolls. Cell coords are 1-based; clamp to >=2
    // to stay clear of the dead corner. Targeting the touched cell also
    // routes the scroll to the correct pane in split layouts.
    var cell = _touchToCell(clientX, clientY);
    var mx = Math.max(2, (cell ? cell.col : 1) + 1);
    var my = Math.max(2, (cell ? cell.row : 1) + 1);
    var btn = lines > 0 ? 65 : 64;
    var seq = '\x1b[<' + btn + ';' + mx + ';' + my + 'M';
    var batch = '';
    for (var j = 0; j < Math.abs(lines); j++) { batch += seq; }
    ws.send(JSON.stringify({ type: 'input', data: batch }));
    return true;
  }

  // Inertial scrolling. Without it the view stops dead the instant the finger
  // lifts, which is the bulk of what reads as "not smooth" on touch.
  // Decay is exponential: v(t) = v0 * e^(-t/tau), so the glide distance is
  // tau * (v0 - FLING_MIN_V). 0.9672 per frame puts tau near 500ms, matching
  // UIScrollView's normal deceleration rate.
  var FLING_START_V = 0.08;        // px/ms — below this a lift is not a flick
  var FLING_MIN_V = 0.015;         // px/ms — decay floor, stop here
  var FLING_DECAY = 0.9672;        // per 16.67ms frame => tau ~500ms
  var FLING_IDLE_CANCEL_MS = 100;  // finger paused before lifting = no fling
  var FLING_VELOCITY_WINDOW_MS = 90;
  var FLING_MAX_LINES_PER_FRAME = 8;
  var flingRaf = null;

  function _stopFling() {
    if (flingRaf !== null) {
      cancelAnimationFrame(flingRaf);
      flingRaf = null;
    }
  }

  // Velocity from a short trailing window rather than an exponential average:
  // an EMA starts at zero and chases the finger's natural slow-down just before
  // release, which underestimates the launch velocity.
  var vSamples = [];

  function _trackVelocity(now, clientY) {
    vSamples.push({ t: now, y: clientY });
    while (vSamples.length > 2 && now - vSamples[0].t > FLING_VELOCITY_WINDOW_MS) {
      vSamples.shift();
    }
  }

  function _windowVelocity() {
    if (vSamples.length < 2) return 0;
    var first = vSamples[0];
    var last = vSamples[vSamples.length - 1];
    var span = last.t - first.t;
    if (span <= 0) return 0;
    return (first.y - last.y) / span;
  }

  function _startFling(initialVelocity, clientX, clientY) {
    _stopFling();
    var velocity = initialVelocity;
    var accum = 0;
    var lastT = 0;

    function step(t) {
      flingRaf = null;
      if (ws.readyState !== WebSocket.OPEN) return;
      if (!lastT) {
        lastT = t;
        flingRaf = requestAnimationFrame(step);
        return;
      }
      var dt = t - lastT;
      lastT = t;

      accum += velocity * dt;
      var m = _cellMetrics();
      var lineH = m ? m.h : 16;
      var lines = Math.trunc(accum / lineH);
      if (lines !== 0) {
        var capped = Math.max(-FLING_MAX_LINES_PER_FRAME,
          Math.min(FLING_MAX_LINES_PER_FRAME, lines));
        if (!_sendWheelLines(capped, clientX, clientY)) return;
        accum -= lines * lineH;
      }

      velocity *= Math.pow(FLING_DECAY, dt / 16.67);
      if (Math.abs(velocity) < FLING_MIN_V) return;
      flingRaf = requestAnimationFrame(step);
    }

    flingRaf = requestAnimationFrame(step);
  }

  // Unified touch handler: vertical = tmux scroll, horizontal = swipe back
  var ts = {
    startX: 0, startY: 0, lastY: 0,
    moved: false, scrollAccum: 0,
    direction: null,  // null | 'vertical' | 'horizontal'
    startTime: 0, currentDx: 0,
    lastMoveTime: 0,
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
    _stopFling();
    if (e.touches.length === 2) {
      // Start pinch-to-zoom
      clearTimeout(longPress.timer);
      pinch.active = true;
      pinch.startDist = _pinchDist(e);
      pinch.startFontSize = term.options.fontSize || 14;
      ts.direction = null;
      e.preventDefault();
      return;
    }
    if (e.touches.length === 1) {
      pinch.active = false;
      cellCache = null;
      var t = e.touches[0];
      ts.startX = t.clientX;
      ts.startY = t.clientY;
      ts.lastY = t.clientY;
      ts.moved = false;
      ts.scrollAccum = 0;
      ts.direction = null;
      ts.startTime = Date.now();
      ts.currentDx = 0;
      vSamples.length = 0;
      ts.lastMoveTime = ts.startTime;
      if (swipeIndicator) {
        swipeIndicator.style.transition = 'none';
        swipeIndicator.style.opacity = '0';
      }

      // Start long-press timer (only if not already in selection mode)
      if (!longPress.active) {
        var lpX = t.clientX, lpY = t.clientY;
        clearTimeout(longPress.timer);
        longPress.timer = setTimeout(function () {
          if (!ts.moved) {
            _enterSelectionMode(lpX, lpY);
          }
        }, LONG_PRESS_MS);
      }
    }
  });

  overlay.addEventListener('touchmove', function (e) {
    // In selection mode, drag to extend selection
    if (longPress.active && sel.dragging && e.touches.length === 1) {
      var dt = e.touches[0];
      _extendSelection(dt.clientX, dt.clientY);
      e.preventDefault();
      return;
    }

    // Cancel long-press if finger moved too far
    if (longPress.timer && e.touches.length === 1) {
      var lt = e.touches[0];
      var ldx = lt.clientX - ts.startX;
      var ldy = lt.clientY - ts.startY;
      if (Math.abs(ldx) > LONG_PRESS_MOVE_TOLERANCE || Math.abs(ldy) > LONG_PRESS_MOVE_TOLERANCE) {
        clearTimeout(longPress.timer);
        longPress.timer = null;
      }
    }

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
        cellCache = null;
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

      var mvNow = Date.now();
      if (mvNow > ts.lastMoveTime) {
        _trackVelocity(mvNow, t.clientY);
        ts.lastMoveTime = mvNow;
      }

      // One wheel event scrolls tmux by exactly one row, so the threshold must
      // be the row's real on-screen height. A fixed 16px drifts from the finger
      // because mobile font sizes land at 10-12px (row height ~12-14px).
      var metrics = _cellMetrics();
      var lineH = metrics ? metrics.h : 16;
      var lines = Math.trunc(ts.scrollAccum / lineH);
      if (lines !== 0) {
        if (_sendWheelLines(lines, t.clientX, t.clientY)) {
          ts.scrollAccum -= lines * lineH;
        }
      }
      e.preventDefault();
    }
  });

  overlay.addEventListener('touchend', function (e) {
    clearTimeout(longPress.timer);
    longPress.timer = null;

    // In selection mode
    if (longPress.active) {
      if (sel.dragging) {
        // Finger lifted after drag — stop dragging, keep selection visible
        sel.dragging = false;
      } else {
        // Tap while selection is showing — exit selection mode
        _exitSelectionMode();
      }
      return;
    }

    if (pinch.active) {
      pinch.active = false;
      return;
    }
    if (!ts.moved) {
      // Tap: check if tapped on a link (file path OR URL) first
      if (typeof FilePreview !== 'undefined') {
        var tapTouch = e.changedTouches[0];
        var tapCell = _touchToCell(tapTouch.clientX, tapTouch.clientY);
        if (tapCell) {
          var tapLine = _getLineText(tapCell.row);
          var tapHit = FilePreview.hitTest(tapLine, tapCell.col, term, tapCell.row);
          if (tapHit) {
            _resolvePreviewPaneId().then(function (paneId) {
              FilePreview.activateHit(tapHit, paneId);
            });
            return;
          }
        }
      }
      // No file path hit — pass through to terminal
      overlay.style.pointerEvents = 'none';
      var touch = e.changedTouches[0];
      var el = document.elementFromPoint(touch.clientX, touch.clientY);
      if (el) { el.focus(); el.click(); }
      setTimeout(function () { overlay.style.pointerEvents = ''; }, 300);
      return;
    }

    if (ts.direction === 'vertical') {
      // A finger that paused before lifting is a deliberate stop, not a flick.
      var idleMs = Date.now() - ts.lastMoveTime;
      var launchV = _windowVelocity();
      if (idleMs < FLING_IDLE_CANCEL_MS && Math.abs(launchV) >= FLING_START_V) {
        var ft = e.changedTouches[0];
        _startFling(launchV, ft.clientX, ft.clientY);
      }
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

  // Ctrl+wheel to zoom font size (desktop).
  // Debounce: a single scroll gesture triggers only one font size step.
  var _wheelZoomTimer = null;
  var _wheelZoomDir = 0;
  termContainer.addEventListener('wheel', function (e) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    e.stopPropagation();
    _wheelZoomDir += e.deltaY;
    clearTimeout(_wheelZoomTimer);
    _wheelZoomTimer = setTimeout(function () {
      if (_wheelZoomDir !== 0) {
        _adjustFontSize(_wheelZoomDir < 0 ? 1 : -1);
      }
      _wheelZoomDir = 0;
    }, 150);
  }, { passive: false, capture: true });

  // Handle mobile virtual keyboard: when keyboard opens, visualViewport
  // shrinks but CSS vh doesn't. Resize terminal-container (not the whole view)
  // to keep the header visible.
  var vpHandler = null;
  if (window.visualViewport && window.innerWidth < 768) {
    var initialVpHeight = window.visualViewport.height;
    vpHandler = function () {
      var vvHeight = window.visualViewport.height;
      // Only intervene when keyboard is likely open (viewport shrunk > 100px)
      var fabTool = document.querySelector('.fab-tool');
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
        // Move FAB above the keyboard
        if (fabTool) {
          var visibleBottom = window.visualViewport.offsetTop + vvHeight;
          var fabY = visibleBottom - 48 - 16; // 48=fab height, 16=margin
          fabTool.style.top = fabY + 'px';
          fabTool.style.bottom = 'auto';
          fabTool.style.right = '16px';
          fabTool.style.left = 'auto';
          fabTool._kbOpen = true;
        }
      } else {
        termContainer.style.height = '';
        termContainer.style.maxHeight = '';
        // Reset FAB position
        if (fabTool && fabTool._kbOpen) {
          fabTool._kbOpen = false;
          var savedPos = null;
          try { savedPos = JSON.parse(localStorage.getItem('fab-pos')); } catch(_e) {}
          if (savedPos) {
            fabTool.style.left = savedPos.left;
            fabTool.style.top = savedPos.top;
            fabTool.style.right = 'auto';
            fabTool.style.bottom = 'auto';
          } else {
            fabTool.style.top = '';
            fabTool.style.left = '';
            fabTool.style.right = '';
            fabTool.style.bottom = '';
          }
        }
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

  // Track viewport width to re-render when crossing mobile/desktop threshold
  var _lastIsDesktop = window.innerWidth >= 768;
  var _resizeHandler = function () {
    var isDesktop = window.innerWidth >= 768;
    if (isDesktop !== _lastIsDesktop) {
      _lastIsDesktop = isDesktop;
      // Viewport crossed 768px threshold — re-render to switch tab/split layout
      if (state.currentTab === 'terminal' && terminalState.term === term) {
        var content = document.getElementById('content');
        if (content) renderTerminal(content);
      }
    }
  };
  window.addEventListener('resize', _resizeHandler);
  // Store for cleanup
  terminalState._resizeHandler = _resizeHandler;
}

// === Reconnect Overlay ===

function _showReconnectOverlay(term, paneId, nozoom) {
  var termContainer = terminalState.termContainer;
  if (!termContainer) return;

  // Create overlay
  var overlay = document.createElement('div');
  overlay.className = 'terminal-reconnect-overlay';
  overlay.innerHTML =
    '<div class="terminal-reconnect-box">' +
    '<div class="terminal-reconnect-spinner"></div>' +
    '<div class="terminal-reconnect-text">连接已断开，正在重连...</div>' +
    '</div>';
  termContainer.appendChild(overlay);

  var attempt = 0;
  var maxAttempts = 10;
  var baseDelay = 1000;
  var textEl = overlay.querySelector('.terminal-reconnect-text');

  function tryReconnect() {
    attempt++;
    if (attempt > maxAttempts || state.currentTab !== 'terminal' || terminalState.term !== term) {
      if (textEl) textEl.textContent = '重连失败，请返回重新进入';
      var spinner = overlay.querySelector('.terminal-reconnect-spinner');
      if (spinner) spinner.style.display = 'none';
      return;
    }

    if (textEl) textEl.textContent = '正在重连... (' + attempt + '/' + maxAttempts + ')';

    var ws = connectTerminalWs(paneId, term, nozoom);

    ws.onopen = function () {
      // Reconnected — remove overlay, update state
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      terminalState.ws = ws;
      // Re-send resize
      if (term.cols && term.rows) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };

    ws.onclose = function (event) {
      // Stop retrying on a clean close — we were detached/taken over, not
      // dropped. Retrying here would re-trigger the ping-pong. (See the main
      // onclose handler for the full rationale.)
      if (event && (event.code === 1000 || event.code === 1008 || event.code === 1013)) {
        if (textEl) textEl.textContent = '会话已被其它窗口接管';
        var spinner = overlay.querySelector('.terminal-reconnect-spinner');
        if (spinner) spinner.style.display = 'none';
        return;
      }
      // Retry with exponential backoff
      if (state.currentTab === 'terminal' && terminalState.term === term) {
        var delay = Math.min(baseDelay * Math.pow(1.5, attempt - 1), 10000);
        setTimeout(tryReconnect, delay);
      }
    };

    ws.onerror = function () {
      // onclose will fire
    };
  }

  setTimeout(tryReconnect, baseDelay);
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
