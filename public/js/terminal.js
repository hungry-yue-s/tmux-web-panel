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
  state.currentPane = newPaneId;
  var content = document.getElementById('content');
  if (content) {
    cleanupTerminal();
    renderTerminal(content);
  }
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

  // Build the terminal view structure
  container.innerHTML =
    '<div class="terminal-view">' +
    '<div class="terminal-header">' +
    '<button class="btn terminal-back-btn">&larr; Back</button>' +
    '<span class="terminal-header-title"></span>' +
    '<div class="terminal-header-actions">' +
    '<button class="btn terminal-split-btn" title="Split pane">&#8862;</button>' +
    '<button class="btn terminal-popout-btn" title="Pop out">&#8599;</button>' +
    '<button class="btn terminal-fullscreen-btn" title="Fullscreen">&#9634;</button>' +
    '</div>' +
    '</div>' +
    '<div class="terminal-pane-switcher"></div>' +
    '<div class="terminal-container"></div>' +
    '<div class="terminal-send-bar">' +
    '<input class="input terminal-send-input" type="text" placeholder="Send command...">' +
    '<button class="btn btn-primary terminal-send-btn">Send</button>' +
    '</div>' +
    '<button class="btn terminal-exit-fullscreen-btn" title="Exit fullscreen" style="display:none;">&times; Exit</button>' +
    '</div>';

  var view = container.querySelector('.terminal-view');
  var titleEl = view.querySelector('.terminal-header-title');
  var paneSwitcher = view.querySelector('.terminal-pane-switcher');
  var termContainer = view.querySelector('.terminal-container');
  var sendInput = view.querySelector('.terminal-send-input');
  var sendBtn = view.querySelector('.terminal-send-btn');
  var exitFsBtn = view.querySelector('.terminal-exit-fullscreen-btn');

  // Set title
  titleEl.textContent = escapeHtml(state.currentSession) + ' : ' + state.currentWindow;

  // Back button
  view.querySelector('.terminal-back-btn').addEventListener('click', function () {
    cleanupTerminal();
    navigate('windows', { currentSession: state.currentSession });
  });

  // Split button
  view.querySelector('.terminal-split-btn').addEventListener('click', function () {
    var direction = prompt('Split direction (horizontal / vertical):');
    if (!direction) return;
    direction = direction.trim().toLowerCase();
    if (direction !== 'horizontal' && direction !== 'vertical') {
      alert('Please enter "horizontal" or "vertical".');
      return;
    }
    api
      .post(
        '/api/sessions/' + encodeURIComponent(state.currentSession) +
        '/windows/' + encodeURIComponent(state.currentWindow) + '/panes',
        { direction: direction }
      )
      .then(function () {
        // Reload panes and re-render
        renderTerminal(container);
      })
      .catch(function (err) {
        alert('Failed to split pane: ' + err.message);
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
      setTimeout(function () {
        terminalState.fitAddon.fit();
      }, 100);
    }
  });

  // Send command bar
  function sendCommand() {
    var command = sendInput.value;
    if (!command || !state.currentPane) return;

    api
      .post('/api/panes/' + encodeURIComponent(state.currentPane) + '/send', { command: command })
      .then(function () {
        sendInput.value = '';
      })
      .catch(function (err) {
        alert('Failed to send command: ' + err.message);
      });
  }

  sendBtn.addEventListener('click', sendCommand);
  sendInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendCommand();
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
        renderPanePills(paneSwitcher, panes, state.currentPane, switchPane);
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

  // ResizeObserver for auto-fit
  var resizeObserver = new ResizeObserver(function () {
    fitAddon.fit();
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }
  });
  resizeObserver.observe(termContainer);

  // Store references for cleanup
  terminalState.term = term;
  terminalState.ws = ws;
  terminalState.fitAddon = fitAddon;
  terminalState.resizeObserver = resizeObserver;
}
