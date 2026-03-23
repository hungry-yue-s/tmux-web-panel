/* global Terminal, FitAddon, WebLinksAddon, api, state, navigate, escapeHtml, renderPaneLayout, renderPanePills */

// === Terminal State ===

var terminalState = {
  term: null,
  ws: null,
  fitAddon: null,
  resizeObserver: null,
  isFullscreen: false,
};

// === Cleanup ===

function cleanupTerminal() {
  document.body.classList.remove('terminal-active');
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
    terminalState.term.dispose();
    terminalState.term = null;
  }
  terminalState.fitAddon = null;
  exitFullscreen();
}

// === Fullscreen ===

function enterFullscreen() {
  terminalState.isFullscreen = true;
  document.body.classList.add('terminal-fullscreen');
}

function exitFullscreen() {
  terminalState.isFullscreen = false;
  document.body.classList.remove('terminal-fullscreen');
}

function toggleFullscreen() {
  if (terminalState.isFullscreen) {
    exitFullscreen();
  } else {
    enterFullscreen();
  }
  // Re-fit after layout change
  if (terminalState.fitAddon) {
    setTimeout(function () {
      terminalState.fitAddon.fit();
    }, 100);
  }
}

// Escape key exits fullscreen
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && terminalState.isFullscreen) {
    exitFullscreen();
    if (terminalState.fitAddon) {
      setTimeout(function () {
        terminalState.fitAddon.fit();
      }, 100);
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

// === Create xterm Terminal ===

function createTerminalInstance() {
  return new Terminal({
    theme: {
      background: '#1a1b26',
      foreground: '#c0caf5',
      cursor: '#c0caf5',
      cursorAccent: '#1a1b26',
      selectionBackground: '#33467c',
      black: '#15161e',
      red: '#f7768e',
      green: '#9ece6a',
      yellow: '#e0af68',
      blue: '#7aa2f7',
      magenta: '#bb9af7',
      cyan: '#7dcfff',
      white: '#a9b1d6',
      brightBlack: '#414868',
      brightRed: '#f7768e',
      brightGreen: '#9ece6a',
      brightYellow: '#e0af68',
      brightBlue: '#7aa2f7',
      brightMagenta: '#bb9af7',
      brightCyan: '#7dcfff',
      brightWhite: '#c0caf5',
    },
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
    fontSize: 14,
    cursorBlink: true,
    scrollback: 5000,
    overviewRulerWidth: 0,
  });
}

// === Connect WebSocket ===

function connectTerminalWs(paneId, term) {
  var wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var wsUrl = wsProtocol + '//' + location.host + '/ws/terminal/' + encodeURIComponent(paneId);

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

  term.onData(function (data) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data: data }));
    }
  });

  return ws;
}

// === Render Terminal View ===

function renderTerminal(container) {
  // Cleanup previous terminal
  cleanupTerminal();

  if (!state.currentSession || !state.currentWindow) {
    container.innerHTML =
      '<div style="padding: 24px; text-align: center; color: var(--text-muted);">' +
      '<p style="font-size: 1.2rem; margin-bottom: 8px;">No terminal selected</p>' +
      '<p>Select a session and window first.</p>' +
      '</div>';
    return;
  }

  // Mark body for mobile terminal layout
  document.body.classList.add('terminal-active');

  // Build the terminal view structure
  container.innerHTML =
    '<div class="terminal-view">' +
    '<div class="terminal-header">' +
    '<button class="btn terminal-back-btn">&larr;</button>' +
    '<div class="terminal-header-pills"></div>' +
    '<span class="terminal-header-title"></span>' +
    '<div class="terminal-header-actions">' +
    '<button class="btn terminal-split-btn" title="Split pane">&#8862;</button>' +
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
    cleanupTerminal();
    navigate('windows', { currentSession: state.currentSession });
  });

  // Split button — show popup with horizontal/vertical options
  view.querySelector('.terminal-split-btn').addEventListener('click', function (e) {
    // Remove existing popup if any
    var existing = view.querySelector('.split-popup');
    if (existing) { existing.remove(); return; }

    var popup = document.createElement('div');
    popup.className = 'split-popup';
    popup.innerHTML =
      '<button class="btn split-popup-btn" data-dir="horizontal">&#x2194; 水平分割</button>' +
      '<button class="btn split-popup-btn" data-dir="vertical">&#x2195; 垂直分割</button>';

    // Position below the split button
    var btn = e.currentTarget;
    btn.parentElement.appendChild(popup);

    function doSplit(direction) {
      popup.remove();
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
          alert('Failed to split pane: ' + err.message);
        });
    }

    popup.querySelectorAll('.split-popup-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        doSplit(b.getAttribute('data-dir'));
      });
    });

    // Close popup on outside click
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
      setTimeout(function () {
        terminalState.fitAddon.fit();
      }, 100);
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

      // If no current pane or current pane not in this window, pick first
      if (!state.currentPane || !panes.some(function (p) { return p.id === state.currentPane; })) {
        state.currentPane = panes.length > 0 ? panes[0].id : null;
      }

      // Render pane switcher
      var isMobile = window.innerWidth < 768;
      if (isMobile) {
        // Mobile: render pills inline in header row
        var headerPills = view.querySelector('.terminal-header-pills');
        if (panes.length > 1) {
          renderPanePills(headerPills, panes, state.currentPane, switchPane);
        }
      } else {
        renderPaneLayout(paneSwitcher, panes, state.currentPane, switchPane);
      }

      // Create and mount terminal
      if (state.currentPane) {
        _mountTerminal(termContainer);
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

function _mountTerminal(termContainer) {
  var term = createTerminalInstance();
  var fitAddon = new FitAddon.FitAddon();
  var webLinksAddon = new WebLinksAddon.WebLinksAddon();

  term.loadAddon(fitAddon);
  term.loadAddon(webLinksAddon);

  term.open(termContainer);

  // Small delay to ensure DOM is ready for fitting
  setTimeout(function () {
    fitAddon.fit();
  }, 50);

  // Connect WebSocket
  var ws = connectTerminalWs(state.currentPane, term);

  // Enable touch scrolling on mobile.
  // xterm.js preventDefault()s all touch events on its canvas, and tmux uses
  // the alternate screen buffer so xterm's local scrollback is empty.
  // Solution: overlay intercepts touch gestures and sends mouse wheel escape
  // sequences through the WebSocket so tmux handles the scrolling directly.
  var overlay = document.createElement('div');
  overlay.className = 'terminal-touch-overlay';
  termContainer.appendChild(overlay);

  var ts = { startY: 0, lastY: 0, moved: false, scrollAccum: 0 };

  overlay.addEventListener('touchstart', function (e) {
    if (e.touches.length === 1) {
      ts.startY = e.touches[0].clientY;
      ts.lastY = e.touches[0].clientY;
      ts.moved = false;
      ts.scrollAccum = 0;
    }
  });

  overlay.addEventListener('touchmove', function (e) {
    if (e.touches.length !== 1) return;
    var y = e.touches[0].clientY;
    var dy = ts.lastY - y;
    ts.lastY = y;
    ts.scrollAccum += dy;
    ts.moved = true;

    // Every 16px = 1 line scroll via mouse wheel escape sequences to tmux
    var lines = Math.trunc(ts.scrollAccum / 16);
    if (lines !== 0 && ws.readyState === WebSocket.OPEN) {
      // SGR mouse wheel: button 64 = wheel up (older), 65 = wheel down (newer)
      // Swipe up (lines > 0) = see newer content = wheel down
      var seq = lines > 0 ? '\x1b[<65;1;1M' : '\x1b[<64;1;1M';
      var count = Math.abs(lines);
      var batch = '';
      for (var j = 0; j < count; j++) { batch += seq; }
      ws.send(JSON.stringify({ type: 'input', data: batch }));
      ts.scrollAccum -= lines * 16;
    }
    e.preventDefault();
  });

  overlay.addEventListener('touchend', function (e) {
    if (!ts.moved) {
      // It was a tap, not a scroll — briefly hide overlay so tap reaches terminal
      overlay.style.pointerEvents = 'none';
      var touch = e.changedTouches[0];
      var el = document.elementFromPoint(touch.clientX, touch.clientY);
      if (el) {
        el.focus();
        el.click();
      }
      setTimeout(function () {
        overlay.style.pointerEvents = '';
      }, 300);
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

  // Handle mobile virtual keyboard: CSS 100vh doesn't shrink when keyboard
  // opens, so use visualViewport API to dynamically resize terminal-view.
  var vpHandler = null;
  if (window.visualViewport && window.innerWidth < 768) {
    vpHandler = function () {
      var view = termContainer.closest('.terminal-view');
      if (!view) return;
      var vvHeight = window.visualViewport.height;
      var viewTop = view.getBoundingClientRect().top;
      var available = vvHeight - viewTop;
      if (available > 0) {
        view.style.height = available + 'px';
        view.style.maxHeight = available + 'px';
      }
      fitAddon.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };
    window.visualViewport.addEventListener('resize', vpHandler);
    window.visualViewport.addEventListener('scroll', vpHandler);
    // Run once on mount to fix 100vh inaccuracy on mobile browsers
    setTimeout(vpHandler, 100);
  }

  // Store references for cleanup
  terminalState.term = term;
  terminalState.ws = ws;
  terminalState.fitAddon = fitAddon;
  terminalState.resizeObserver = resizeObserver;
  terminalState._vpHandler = vpHandler;
}
