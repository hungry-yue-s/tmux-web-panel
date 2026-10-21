/* Real terminal bridge for the isolated review app. Never attach elsewhere. */
(function () {
  'use strict';
  if (location.hostname !== '127.0.0.1' || location.port !== '17681') return;
  if (window.__reviewTerminal) return;

  const state = window.__reviewTerminal = {
    connected: false, paneId: null, windowName: null, fontSize: 14,
    cols: 0, rows: 0, outputBytes: 0, inputBytes: 0, resizeCount: 0, error: null,
  };
  const allowedWindows = ['工作区', 'API 服务', '前端开发', '日志检查'];
  const root = document.querySelector('#prototype');
  const scroll = document.querySelector('.terminal-scroll');
  const fallback = scroll && scroll.querySelector('pre');
  const status = document.querySelector('.terminal-status');
  if (!root || !scroll || !fallback || !status) return;

  let term, fitAddon, host, socket, resizeObserver, themeObserver;
  let generation = 0, disposed = false, fitTimer;
  const events = new AbortController();
  const originalStatus = [...status.children].map(node => node.innerHTML);
  const listen = (node, type, handler, options = {}) =>
    node.addEventListener(type, handler, { ...options, signal: events.signal });

  function showFallback(message) {
    state.connected = false;
    fallback.hidden = false;
    if (host) host.style.visibility = 'hidden';
    scroll.classList.remove('review-terminal-live');
    status.children[0].textContent = message;
    status.children[1].textContent = '独立演示工作区';
  }

  function palette() {
    const css = getComputedStyle(root);
    const color = name => css.getPropertyValue(name).trim();
    const light = document.documentElement.classList.contains('light-theme');
    return {
      background: color('--terminal'), foreground: color('--terminal-text'),
      cursor: color('--accent'), cursorAccent: color('--terminal'),
      selectionBackground: light ? '#b7cfc1' : '#42524a',
      black: light ? '#24292f' : '#101b1e', red: color('--terminal-red'),
      green: color('--terminal-green'), yellow: color('--terminal-yellow'),
      blue: color('--terminal-blue'), magenta: light ? '#8250df' : '#bb9af7',
      cyan: light ? '#0550ae' : '#7dcfff', white: light ? '#6e7781' : '#c0caf5',
      brightBlack: color('--terminal-secondary'), brightRed: color('--terminal-red'),
      brightGreen: color('--terminal-green'), brightYellow: color('--terminal-yellow'),
      brightBlue: color('--terminal-blue'), brightMagenta: light ? '#8250df' : '#bb9af7',
      brightCyan: light ? '#0550ae' : '#7dcfff', brightWhite: color('--text'),
    };
  }

  function fit() {
    if (!term || disposed || root.dataset.mode !== 'terminal' || !host.getClientRects().length) return;
    fitAddon.fit();
    state.cols = term.cols;
    state.rows = term.rows;
    if (socket && socket.readyState === WebSocket.OPEN
      && (socket.sentCols !== term.cols || socket.sentRows !== term.rows)) {
      socket.sentCols = term.cols;
      socket.sentRows = term.rows;
      socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      state.resizeCount++;
    }
  }

  function scheduleFit() {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(fit, 120);
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = () => reject(new Error('终端组件加载失败'));
      document.head.append(script);
    });
  }

  async function loadAssets() {
    const style = document.createElement('style');
    style.textContent = "@font-face{font-family:ReviewMono;src:url('/fonts/TmuxPanelMono-Regular.woff2') format('woff2');font-weight:400;font-display:swap}@font-face{font-family:ReviewMono;src:url('/fonts/TmuxPanelMono-Bold.woff2') format('woff2');font-weight:700;font-display:swap}.terminal-scroll{position:relative}.review-xterm-host{position:absolute;inset:18px 16px;visibility:hidden;min-width:0;min-height:0}.review-xterm-host .xterm{height:100%}.review-xterm-host .xterm .xterm-viewport{background:var(--terminal);overflow:hidden}.review-terminal-live{overflow:hidden!important}";
    document.head.append(style);
    const cssReady = new Promise((resolve, reject) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = '/vendor/xterm/xterm.css';
      link.onload = resolve;
      link.onerror = () => reject(new Error('终端样式加载失败'));
      document.head.append(link);
    });
    await Promise.all([
      cssReady,
      (async () => {
        if (!window.Terminal) await loadScript('/vendor/xterm/xterm.js');
        if (!window.FitAddon) await loadScript('/vendor/xterm/addon-fit.js');
      })(),
      document.fonts ? document.fonts.load('14px ReviewMono').catch(() => {}) : Promise.resolve(),
    ]);
  }

  async function loadWorkspace() {
    const response = await fetch('/api/servers/local/workspace', { signal: events.signal });
    if (!response.ok) throw new Error('演示工作区不可用');
    const result = await response.json();
    const workspace = result.success && result.data;
    const session = workspace && workspace.serverId === 'local' && workspace.provider === 'tmux'
      && workspace.sessions.find(item => item.name === '产品开发');
    if (!session) throw new Error('未找到独立演示会话');
    const panes = new Map();
    for (const name of allowedWindows) {
      const window = session.windows.find(item => item.name === name);
      const pane = window && (window.panes.find(item => item.active) || window.panes[0]);
      if (!pane || !/^%\d+$/.test(pane.id)) throw new Error('演示窗口不完整');
      panes.set(name, pane.id);
      const row = [...document.querySelectorAll('.tree-row[data-window-name]')]
        .find(item => item.dataset.windowName === name);
      if (row && typeof pane.command === 'string') row.lastElementChild.textContent = pane.command;
    }
    return panes;
  }

  // One terminal instance; each replacement attach waits for the old socket's
  // close handshake so tmux's attach-session -d cannot race another attach.
  async function disconnect() {
    const previous = socket;
    if (!previous) return;
    if (previous.readyState !== WebSocket.CLOSED) {
      await new Promise(resolve => {
        previous.addEventListener('close', resolve, { once: true });
        previous.close();
      });
    }
    if (socket === previous) socket = null;
  }

  function mount() {
    host = document.createElement('div');
    host.className = 'review-xterm-host';
    host.setAttribute('aria-label', '独立演示 tmux 终端');
    scroll.append(host);
    term = new Terminal({
      fontFamily: "ReviewMono, 'Maple Mono NF CN', monospace", fontSize: 14,
      lineHeight: 1.35, theme: palette(), cursorBlink: !matchMedia('(prefers-reduced-motion: reduce)').matches, scrollback: 5000,
      allowTransparency: window.__tmuxPanelTransparency === true,
      macOptionClickForcesSelection: true, rescaleOverlappingGlyphs: true,
    });
    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(host);
    term.onData(data => {
      if (state.connected && socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'input', data }));
        state.inputBytes += data.length;
      }
    });
    resizeObserver = new ResizeObserver(scheduleFit);
    resizeObserver.observe(host);
    themeObserver = new MutationObserver(() => {
      term.options.theme = palette();
      scheduleFit();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
    themeObserver.observe(root, { attributes: true, attributeFilter: ['data-mode', 'class'] });
    document.querySelectorAll('[title="减小字号"],[title="增大字号"]').forEach(button => {
      listen(button, 'click', event => {
        event.stopImmediatePropagation();
        state.fontSize = Math.max(10, Math.min(20, state.fontSize + (button.title === '增大字号' ? 1 : -1)));
        term.options.fontSize = state.fontSize;
        fallback.style.fontSize = state.fontSize + 'px';
        scheduleFit();
        if (typeof window.toast === 'function') window.toast('终端字号 ' + state.fontSize + 'px');
      }, { capture: true });
    });
  }

  const ready = Promise.all([loadAssets(), loadWorkspace()]);
  async function connect(name, request) {
    const [, panes] = await ready;
    if (disposed || request !== generation) return;
    if (!term) mount();
    await disconnect();
    if (disposed || request !== generation) return;
    await new Promise(resolve => term.write('', resolve));
    if (disposed || request !== generation) return;
    showFallback('正在连接 tmux');
    state.paneId = panes.get(name);
    state.windowName = name;
    state.error = null;
    term.reset();
    fit();
    const url = new URL('/ws/terminal/local/' + encodeURIComponent(state.paneId), location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('cols', term.cols);
    url.searchParams.set('rows', term.rows);
    const connection = socket = new WebSocket(url);
    connection.sentCols = term.cols;
    connection.sentRows = term.rows;
    let hasOutput = false, revealed = false;
    function reveal() {
      if (disposed || request !== generation || socket !== connection
        || revealed || !state.connected || !hasOutput) return;
      revealed = true;
      fallback.hidden = true;
      host.style.visibility = 'visible';
      scroll.classList.add('review-terminal-live');
      status.children[0].textContent = '● tmux';
      status.children[1].textContent = '产品开发 / ' + name;
      status.children[2].textContent = '独立实时演示';
      scheduleFit();
    }
    connection.addEventListener('message', event => {
      if (disposed || request !== generation || socket !== connection) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'ready') {
        state.connected = true;
        reveal();
      } else if (message.type === 'output' && typeof message.data === 'string') {
        state.outputBytes += message.data.length;
        term.write(message.data, () => { hasOutput = true; reveal(); });
      } else if (message.type === 'error' || message.type === 'exit') {
        state.error = message.code || message.reason || 'TERMINAL_EXIT';
        showFallback('tmux 连接已结束');
      }
    });
    connection.addEventListener('close', () => {
      if (!disposed && request === generation && socket === connection) showFallback('tmux 已断开 · 静态演示');
    });
    connection.addEventListener('error', () => {
      if (request === generation) state.error = 'WEBSOCKET_ERROR';
    });
  }

  function select(name) {
    if (!allowedWindows.includes(name) || disposed) return;
    if (state.connected && state.windowName === name) return;
    const request = ++generation;
    state.connected = false;
    connect(name, request).catch(error => {
      if (disposed || request !== generation) return;
      state.error = error.message;
      showFallback('静态演示 · 实时终端不可用');
    });
  }

  state.dispose = () => {
    disposed = true;
    generation++;
    clearTimeout(fitTimer);
    events.abort();
    if (resizeObserver) resizeObserver.disconnect();
    if (themeObserver) themeObserver.disconnect();
    if (socket) socket.close();
    if (term) term.dispose();
    if (host) host.remove();
    fallback.hidden = false;
    scroll.classList.remove('review-terminal-live');
    [...status.children].forEach((node, index) => { node.innerHTML = originalStatus[index]; });
    state.connected = false;
  };
  listen(window, 'pagehide', state.dispose, { once: true });
  document.querySelectorAll('.tree-row[data-window-name]').forEach(row => {
    listen(row, 'click', () => select(row.dataset.windowName));
    listen(row, 'keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') select(row.dataset.windowName);
    });
  });
  select(document.querySelector('#active-window-name').textContent.trim());
})();
