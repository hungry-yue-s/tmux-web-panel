import { validateTarget, validateWindowTarget, newId } from './model.js';

const FONT_FAMILY = "'Anymux Mono', 'Maple Mono NF CN', 'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Symbols Nerd Font Mono', monospace";

// xterm's public onData omits the input source. Track that bit so native tty
// answers still flow while keyboard/IME input is disabled during hydration.
export function installInputHandler(term, send) {
  const core = term._core?.coreService;
  if (typeof core?.triggerDataEvent !== 'function') throw new Error('终端组件版本不兼容，请更新面板。');
  const original = core.triggerDataEvent;
  let user = false;
  const forwarded = function (data, wasUserInput = false) {
    const previous = user; user = wasUserInput;
    try { return original.call(this, data, wasUserInput); } finally { user = previous; }
  };
  core.triggerDataEvent = forwarded;
  const listener = term.onData((data) => send(data, user));
  return () => { listener.dispose(); if (core.triggerDataEvent === forwarded) core.triggerDataEvent = original; };
}

export function installClipboardHandler(term, copy) {
  return term.parser.registerOscHandler(52, (payload) => {
    const separator = payload.indexOf(';');
    const encoded = payload.slice(separator + 1);
    // Clipboard queries are never answered by the browser. Keep side effects out
    // of snapshots/history and bound the live copy, like the legacy OSC52 path.
    if (separator < 0 || encoded === '?' || encoded.length > 1_500_000) return true;
    try {
      const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
      copy(new TextDecoder().decode(bytes));
    } catch { /* malformed clipboard content is not terminal input */ }
    return true;
  });
}

/** One native tmux client, one full window surface, one cancellable subscription. */
export class NativeWindowSession {
  constructor(global, { container, target, onFocus = () => {}, onState = () => {}, onTitle = () => {}, onFontSize = () => {}, onContext = () => {}, visible = true, fontSize }) {
    this.global = global;
    this.container = container;
    this.target = validateWindowTarget(target);
    if (!this.target) throw new Error('无效的原生窗口');
    this.onState = onState;
    this.onContext = onContext;
    this.context = null;
    this.onFontSize = onFontSize;
    this.visible = visible;
    this.status = 'connecting';
    this.disposed = false;
    this.epoch = 0;
    this.attempt = 0;
    this.inputVersion = 0;
    this.canResize = true;
    this.cleanups = [];
    this.renderQueue = [];
    this.renderBytes = 0;
    const mobile = !!global.MobileUI?.isMobile();
    this.term = new global.Terminal({
      theme: global.Theme?.getTerminalTheme(), minimumContrastRatio: 4.5,
      allowTransparency: !!global.Theme?.supportsTransparency?.(),
      fontFamily: 'monospace', fontSize: Math.max(mobile ? 11 : 8, Math.min(22, fontSize || (mobile ? 13 : 14))), cursorBlink: true,
      scrollback: 5000, overviewRuler: { width: 0 }, rescaleOverlappingGlyphs: true,
      macOptionClickForcesSelection: false, convertEol: false,
      allowProposedApi: true,
      disableStdin: true,
    });
    this.fitAddon = new global.FitAddon.FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.cleanups.push(installClipboardHandler(this.term, (text) => { if (!this.disposed && this.status === 'live' && this.hydrated) this.copy(text); }));
    if (this.term.onTitleChange) this.cleanups.push(this.term.onTitleChange((title) => { if (!this.disposed) onTitle(title); }));
    this.term.open(container);
    this._listen(container, 'pointerdown', onFocus, true);
    this._listen(container, 'focusin', onFocus);
    // iOS requires focus directly inside this trusted event, never after await.
    this._listen(container, 'click', () => { if (global.MobileUI?.isMobile()) this.focus(); });
    this.cleanups.push(installInputHandler(this.term, (data, user) => {
      if (user) { if (!this.composing && !this._duplicateComposition(data)) this.send(data, !this.pointerDispatch); }
      else this._input(data, false, 'response'); // Startup replies also work before hydration.
    }));
    if (this.term.onBinary) this.cleanups.push(this.term.onBinary((data) => {
      if (this.status === 'live' && this.hydrated) { if (!this.pointerDispatch) this.inputVersion++; this._input(data, true); }
    }));
    for (const type of ['mousedown', 'mouseup', 'mousemove', 'wheel']) {
      this._listen(container, type, () => {
        if (type === 'mousedown' || type === 'wheel') this.inputVersion++;
        this.pointerDispatch = true;
        global.queueMicrotask(() => { this.pointerDispatch = false; });
      }, true);
    }
    this._installCompositionGuard();
    this._listen(this.term.element, 'mouseup', () => {
      if (!global.MobileUI?.isMobile()) {
        const selection = this.term.getSelection();
        if (selection) this.copy(selection);
      }
    });
    this._installTouchSelection();
    this._listen(container, 'wheel', (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault(); event.stopPropagation();
      this.wheelDelta = (this.wheelDelta || 0) + event.deltaY;
      global.clearTimeout(this.wheelTimer);
      this.wheelTimer = global.setTimeout(() => { if (!this.disposed && this.wheelDelta) this.setFontSize(this.term.options.fontSize + (this.wheelDelta < 0 ? 1 : -1)); this.wheelDelta = 0; }, 150);
    }, { capture: true, passive: false });
    const theme = () => { if (!this.disposed) this.term.options.theme = global.Theme?.getTerminalTheme(); };
    this._listen(global.document, 'tmux-theme-change', theme);
    this._listen(global.document, 'tmux-transparency-change', theme);
    this.resizeObserver = new global.ResizeObserver(() => this.fit());
    this.resizeObserver.observe(container);
    this._listen(global, 'resize', () => this.fit());
    if (global.visualViewport) this._listen(global.visualViewport, 'resize', () => this.fit());
    this.ready = this._prepareRenderer().then(() => {
      if (this.disposed || !container.isConnected) return;
      this.rendererPrepared = true;
      this.fit();
      if (this.visible) this._connect();
    });
  }

  _listen(element, name, handler, options) {
    element?.addEventListener(name, handler, options);
    this.cleanups.push(() => element?.removeEventListener(name, handler, options));
  }

  _setStatus(status, message = '') {
    this.status = status;
    this.message = message;
    this.term.options.disableStdin = status !== 'live';
    if (!this.disposed) this.onState({ status, message, target: this.target });
  }

  async _prepareRenderer() {
    const global = this.global;
    let font = false;
    try { font = await (global.TerminalFonts?.coreReady(1500) || Promise.resolve(false)); } catch { /* use system monospace */ }
    if (this.disposed) return;
    if (font === true) this.term.options.fontFamily = FONT_FAMILY;
    if (font === null) global.TerminalFonts.coreReady(0).then((loaded) => { if (loaded && !this.disposed) this.lateFont = true; }).catch(() => {});
    if (global.WebglAddon) {
      try {
        const addon = new global.WebglAddon.WebglAddon();
        addon.onContextLoss(() => { addon.dispose(); if (!this.disposed) this.term.refresh(0, this.term.rows - 1); });
        this.term.loadAddon(addon);
      } catch { /* xterm's canvas renderer remains usable */ }
    }
    this.term.clearTextureAtlas?.();
    const schedule = () => {
      if (this.fontTimer || this.disposed || !global.TerminalFonts) return;
      this.fontTimer = global.setTimeout(() => {
        this.fontTimer = null;
        if (this.disposed) return;
        const buffer = this.term.buffer.active;
        let regular = '', bold = '';
        for (let y = buffer.viewportY; y < buffer.viewportY + this.term.rows; y++) {
          const line = buffer.getLine(y);
          if (!line) continue;
          for (let x = 0; x < line.length; x++) {
            const cell = line.getCell(x);
            const chars = cell?.getChars();
            if (!chars || chars.charCodeAt(0) < 0x1100) continue;
            if (cell.isBold()) bold += chars; else regular += chars;
          }
        }
        Promise.all([global.TerminalFonts.ensure(regular, 400), global.TerminalFonts.ensure(bold, 700)]).then((loaded) => {
          if (!this.disposed && loaded.some(Boolean)) { this.term.clearTextureAtlas?.(); this.term.refresh(0, this.term.rows - 1); }
        }).catch(() => {});
      }, 120);
    };
    this.cleanups.push(this.term.onWriteParsed(schedule), this.term.onScroll(schedule));
    schedule();
  }

  _installCompositionGuard() {
    const area = this.term.textarea;
    if (!area) return;
    for (const [key, value] of Object.entries({ autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'send' })) area.setAttribute(key, value);
    this._listen(area, 'compositionstart', () => { this.composing = true; this.imeSent = false; this.imeText = ''; });
    this._listen(area, 'compositionend', (event) => {
      this.composing = false;
      this.imeText = event.data || '';
      this.imeSent = false;
      this.imeUntil = Date.now() + (/Android/i.test(this.global.navigator.userAgent) ? 300 : 150);
      this.global.clearTimeout(this.imeTimer);
      this.imeTimer = this.global.setTimeout(() => { if (!this.disposed) area.value = ''; }, 120);
    });
    this._listen(area, 'keydown', (event) => {
      if (!(this.composing || event.isComposing)) return;
      if (event.key === 'Enter' || event.keyCode === 13) { event.stopPropagation(); event.preventDefault(); }
      else if (event.key === 'Backspace' || event.keyCode === 8) event.stopPropagation();
    }, true);
  }

  _duplicateComposition(data) {
    if (!(this.imeUntil > Date.now())) return false;
    if (data === '\r') return true;
    if (this.imeText && data === this.imeText) {
      if (this.imeSent) return true;
      this.imeSent = true;
    }
    return false;
  }

  _installTouchSelection() {
    let origin, anchor, selecting = false, suppressClick = false, copyButton;
    const clearHold = () => { this.global.clearTimeout(this.holdTimer); this.holdTimer = null; };
    const position = (touch) => {
      const screen = this.term.element.querySelector('.xterm-screen') || this.term.element;
      const rect = screen.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      return { col: Math.max(0, Math.min(this.term.cols - 1, Math.floor((touch.clientX - rect.left) * this.term.cols / rect.width))),
        row: this.term.buffer.active.viewportY + Math.max(0, Math.min(this.term.rows - 1, Math.floor((touch.clientY - rect.top) * this.term.rows / rect.height))) };
    };
    const showCopy = () => {
      if (copyButton) return;
      copyButton = this.global.document.createElement('button');
      copyButton.type = 'button'; copyButton.className = 'wb-touch-copy'; copyButton.textContent = '复制选区';
      copyButton.addEventListener('click', (event) => {
        event.preventDefault(); event.stopPropagation();
        const selection = this.term.getSelection();
        if (selection) this.copy(selection);
        copyButton?.remove(); copyButton = null;
        suppressClick = false; selecting = false;
      });
      this.container.append(copyButton);
    };
    this._listen(this.container, 'touchstart', (event) => {
      if (!this.global.MobileUI?.isMobile() || event.touches.length !== 1 || event.target.closest?.('.wb-touch-copy')) return;
      clearHold(); selecting = false; copyButton?.remove(); copyButton = null;
      const touch = event.touches[0]; origin = { x: touch.clientX, y: touch.clientY }; anchor = position(touch);
      if (!anchor) return;
      this.holdTimer = this.global.setTimeout(() => {
        if (this.disposed || !anchor) return;
        selecting = true; suppressClick = true;
        const line = this.term.buffer.active.getLine(anchor.row);
        const word = (col) => /[\p{L}\p{N}_./\\:~-]/u.test(line?.getCell?.(col)?.getChars() || '');
        let left = anchor.col, right = anchor.col;
        if (word(left)) { while (left > 0 && word(left - 1)) left--; while (right < this.term.cols - 1 && word(right + 1)) right++; }
        anchor = { row: anchor.row, col: left };
        this.term.select(left, anchor.row, right - left + 1);
        showCopy();
      }, 450);
    }, { capture: true, passive: true });
    this._listen(this.container, 'touchmove', (event) => {
      if (!origin || event.touches.length !== 1) { clearHold(); return; }
      const touch = event.touches[0];
      if (!selecting) { if (Math.hypot(touch.clientX - origin.x, touch.clientY - origin.y) > 10) clearHold(); return; }
      event.preventDefault(); event.stopPropagation();
      const point = position(touch); if (!point) return;
      const first = anchor.row * this.term.cols + anchor.col;
      const last = point.row * this.term.cols + point.col;
      const start = Math.min(first, last);
      this.term.select(start % this.term.cols, Math.floor(start / this.term.cols), Math.abs(last - first) + 1);
    }, { capture: true, passive: false });
    this._listen(this.container, 'touchend', (event) => {
      clearHold(); origin = null;
      if (selecting) { event.preventDefault(); event.stopPropagation(); }
    }, { capture: true, passive: false });
    this._listen(this.container, 'touchcancel', clearHold, { passive: true });
    this._listen(this.container, 'click', (event) => {
      if (event.target.closest?.('.wb-touch-copy')) return;
      if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); suppressClick = false; }
    }, true);
    this._listen(this.container, 'contextmenu', (event) => { if (this.global.MobileUI?.isMobile()) event.preventDefault(); });
    this.cleanups.push(() => { clearHold(); copyButton?.remove(); });
  }

  _url() {
    const global = this.global;
    const { serverId, instanceId, sessionId, windowId, clientId } = this.target;
    const path = global.Api.nodeUrl(serverId, '/ws/native-window/' + encodeURIComponent(windowId));
    const query = new URLSearchParams({ instanceId, sessionId, clientId, cols: String(this.term.cols), rows: String(this.term.rows), protocol: '1' });
    const auth = global.Auth?.wsTokenParam?.();
    if (auth) for (const [key, value] of new URLSearchParams(auth)) query.set(key, value);
    return (global.location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + global.location.host + path + '?' + query;
  }

  _connect() {
    if (this.disposed || this.status === 'exited' || this.status === 'invalid') return;
    if (!this.visible) { this._setStatus('disconnected', '窗格已暂停显示'); return; }
    const epoch = ++this.epoch;
    const current = () => !this.disposed && epoch === this.epoch;
    this.hydrated = false;
    this.serverReady = false;
    this.lastSeq = null;
    this.lastSize = this.term.cols + ':' + this.term.rows;
    this.snapshotVersion = 0;
    this._setStatus('connecting', this.attempt ? '正在重新连接' : '正在连接');
    const ws = new this.global.WebSocket(this._url());
    this.ws = ws;
    this.connectTimer = this.global.setTimeout(() => { if (current()) this._drop(true, '连接超时'); }, 20_000);
    ws.onopen = () => {};
    ws.onmessage = (event) => {
      if (!current()) return;
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'bootstrap') {
          if (message.encoding !== 'base64' || typeof message.data !== 'string' || this.hydrated) throw new Error('原生终端启动数据无效');
          this._render({ data: Uint8Array.from(this.global.atob(message.data), (char) => char.charCodeAt(0)) });
        } else if (message.type === 'ready' || message.type === 'context') {
          this._context(message);
          if (message.type === 'context') {
            const request = this.contextRequest;
            if (request && request.id === message.requestId) this._settleContext(request.inputVersion === this.inputVersion ? null : new Error('查询期间已有新的终端输入，请重试'));
            return;
          }
          const wasResizable = this.canResize;
          this.canResize = message.resizeAllowed !== false;
          if (!wasResizable && this.canResize) this.lastSize = null;
          if (!this.canResize && message.cols > 0 && message.rows > 0) this.term.resize(message.cols, message.rows);
          this.serverReady = true;
          this._becameReady();
        } else if (message.type === 'snapshot' || message.type === 'output') {
          if (message.encoding !== 'base64' || !Number.isSafeInteger(message.seq) || message.seq < 0 || typeof message.data !== 'string') throw new Error('终端数据格式无效');
          if (message.type === 'output' && (this.lastSeq === null || message.seq > this.lastSeq + 1)) throw new Error('终端输出中断');
          if (message.type === 'output' && message.seq <= this.lastSeq) return;
          if (message.type === 'snapshot' && this.lastSeq !== null && message.seq <= this.lastSeq) return;
          const data = Uint8Array.from(this.global.atob(message.data), (char) => char.charCodeAt(0));
          this.lastSeq = message.seq;
          if (message.type === 'snapshot') {
            if (message.instanceId) this._context(message);
            if (Number.isSafeInteger(message.historyTotal) && message.historyTotal >= 0) this.historyTotal = message.historyTotal;
            if (Number.isSafeInteger(message.historyLines) && message.historyLines >= 0) this.historyLines = message.historyLines;
            const snapshotVersion = ++this.snapshotVersion;
            this.hydrated = false;
            this.restoring = true;
            this.term.options.disableStdin = true;
            this._render({ data, snapshotVersion, cols: message.cols, rows: message.rows });
          } else this._render({ data });
        } else if (message.type === 'clipboard' && typeof message.data === 'string') this.copy(message.data);
        else if (message.type === 'exit') { this._disconnect(); this._setStatus('exited', message.reason || '远端任务已结束'); }
        else if (message.type === 'error') this._drop(message.retryable === true, message.message || '无法连接窗格');
      } catch (error) { this._drop(false, error.message || '终端协议无效'); }
    };
    ws.onclose = (event) => {
      if (!current()) return;
      this._drop(![1000, 1008, 1013].includes(event.code), event.code === 1000 ? '终端订阅已结束' : '连接已断开');
    };
    ws.onerror = () => {}; // close owns retry, so only one timer is ever live.
  }

  _render(frame) {
    // Reset and a complete native frame form one parser transaction. A previous
    // async write must finish before that reset, and later output waits behind it.
    this.renderQueue.push({ ...frame, epoch: this.epoch });
    this.renderBytes += frame.data.length;
    if (this.renderBytes > 16 * 1024 * 1024) { this._drop(true, '终端输出积压，正在恢复完整画面'); return; }
    this._drainRender();
  }

  _drainRender() {
    if (this.disposed || this.writing || !this.renderQueue.length) return;
    const frame = this.renderQueue.shift(); this.renderBytes -= frame.data.length;
    if (frame.epoch !== this.epoch) { this._drainRender(); return; }
    if (frame.snapshotVersion) {
      this.term.reset();
      if (frame.cols > 0 && frame.rows > 0) this.term.resize(frame.cols, frame.rows);
    }
    this.writing = true;
    this.term.write(frame.data, () => {
      this.writing = false;
      if (!this.disposed && frame.epoch === this.epoch && frame.snapshotVersion === this.snapshotVersion) {
        this.hydrated = true; this.restoring = false; this._becameReady();
      }
      this._drainRender();
    });
  }

  _becameReady() {
    if (!this.serverReady || !this.hydrated) return;
    this.global.clearTimeout(this.connectTimer);
    this.attempt = 0;
    this.term.options.disableStdin = false;
    if (this.status !== 'live') this._setStatus('live');
    this.fit();
  }

  _send(message) {
    if (!this.disposed && this.ws?.readyState === 1) { this.ws.send(JSON.stringify(message)); return true; }
    return false;
  }

  _context(message) {
    if (message.protocol !== 1 || message.instanceId !== this.target.instanceId || message.clientId !== this.target.clientId) throw new Error('原生客户端身份已变化');
    const pane = validateTarget({ ...message, serverId: this.target.serverId });
    if (!pane) throw new Error('原生客户端焦点无效');
    this.target = validateWindowTarget({ ...pane, clientId: this.target.clientId });
    const next = Object.freeze({ ...pane, clientId: this.target.clientId });
    if (!this.context || ['sessionId', 'windowId', 'paneId'].some((key) => this.context[key] !== next[key])) {
      this.context = next;
      this.linkProvider?.dispose?.();
      const source = Object.freeze({ serverId: next.serverId, paneId: next.paneId,
        isCurrent: () => this.status === 'live' && this.hydrated && this.context?.instanceId === next.instanceId });
      this.linkProvider = this.global.FilePreview?.registerLinkProvider(this.term, next.paneId, () => next.paneId, source);
      this.onContext(next);
    }
  }

  requestContext() {
    if (this.status !== 'live' || !this.hydrated) return Promise.reject(new Error('原生终端尚未确认当前窗格'));
    if (this.contextRequest) return this.contextRequest.promise;
    const request = { id: newId('q'), inputVersion: this.inputVersion };
    request.promise = new Promise((resolve, reject) => { request.resolve = resolve; request.reject = reject; });
    this.contextRequest = request;
    request.timer = this.global.setTimeout(() => { if (this.contextRequest === request) this._settleContext(new Error('原生焦点查询超时，请重试')); }, 5000);
    if (!this._send({ type: 'context-request', requestId: request.id })) this._settleContext(new Error('原生终端连接已断开'));
    return request.promise;
  }

  _settleContext(error) {
    const request = this.contextRequest; if (!request) return;
    this.contextRequest = null; this.global.clearTimeout(request.timer);
    if (error) request.reject(error); else request.resolve(this.context);
  }

  _input(data, binary = false, type = 'input') {
    if (this.disposed || typeof data !== 'string') return false;
    const bytes = binary ? Uint8Array.from(data, (char) => char.charCodeAt(0)) : new TextEncoder().encode(data);
    for (let start = 0; start < bytes.length; start += 32768) {
      let raw = ''; for (const byte of bytes.subarray(start, start + 32768)) raw += String.fromCharCode(byte);
      if (!this._send({ type, encoding: 'base64', data: this.global.btoa(raw) })) return false;
    }
    return true;
  }

  send(data, trackIntent = true) {
    // A lost connection never replays uncertain keyboard input.
    if (this.status !== 'live' || !this.hydrated || typeof data !== 'string') return false;
    if (trackIntent) this.inputVersion++; return this._input(data);
  }

  fit() {
    if (this.disposed || this.restoring || !this.visible || !this.container.isConnected || !this.container.clientWidth || !this.container.clientHeight || !this.canResize) return;
    if (this.lateFont) { this.lateFont = false; this.term.options.fontFamily = FONT_FAMILY; this.term.clearTextureAtlas?.(); }
    try { this.fitAddon.fit(); } catch { return; }
    const { cols, rows } = this.term;
    if (this.status !== 'live' || cols < 2 || rows < 2 || this.lastSize === cols + ':' + rows) return;
    this.global.clearTimeout(this.resizeTimer);
    this.resizeTimer = this.global.setTimeout(() => {
      if (!this.visible || this.disposed || this.status !== 'live') return;
      if (this._send({ type: 'resize', cols, rows })) this.lastSize = cols + ':' + rows;
    }, 80);
  }

  setVisible(visible) {
    if (this.visible === visible) return;
    this.visible = visible;
    // A hidden native client continues consuming TTY bytes and answering its
    // terminal queries. Returning to it never requests another baseline.
    if (visible) {
      this.fit();
      if (!this.ws && this.rendererPrepared && !this.retryTimer) this._connect();
    }
  }

  focus() { if (!this.disposed) this.term.focus(); }
  paste(text) {
    if (this.status !== 'live' || !this.hydrated) return false;
    if (this.term.paste) this.term.paste(text); else this.send(text);
    return true;
  }
  setFontSize(size) {
    if (this.disposed) return;
    this.term.options.fontSize = Math.max(this.global.MobileUI?.isMobile() ? 11 : 8, Math.min(22, size));
    this.onFontSize(this.term.options.fontSize);
    this.fit();
  }
  copy(text) {
    if (this.global._copyToClipboard) this.global._copyToClipboard(text);
    else this.global.navigator.clipboard?.writeText(text).catch(() => {});
  }

  _disconnect() {
    this._settleContext(new Error('原生终端连接已变化'));
    this.epoch++;
    for (const key of ['connectTimer', 'resizeTimer', 'retryTimer']) { this.global.clearTimeout(this[key]); this[key] = null; }
    if (this.ws) {
      this.ws.onopen = this.ws.onmessage = this.ws.onclose = this.ws.onerror = null;
      try { this.ws.close(); } catch { /* already closed */ }
      this.ws = null;
    }
    this.hydrated = false;
    this.restoring = false;
    this.context = null;
    this.renderQueue = [];
    this.renderBytes = 0;
  }

  _drop(retryable, message) {
    this._disconnect();
    if (!retryable) { this._setStatus('invalid', message); return; }
    this._setStatus('disconnected', message);
    if (++this.attempt <= 10 && this.visible) this.retryTimer = this.global.setTimeout(() => { this.retryTimer = null; this._connect(); }, Math.min(1000 * 1.5 ** (this.attempt - 1), 15_000));
  }

  refresh() {
    if (this.disposed || this.status === 'exited' || this.status === 'invalid') return;
    this._disconnect();
    this.attempt = 0;
    this.fit();
    this._connect();
  }

  invalidate(message = '远端窗口已不存在') { this._disconnect(); this._setStatus('invalid', message); }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this._disconnect();
    this.global.clearTimeout(this.fontTimer);
    this.global.clearTimeout(this.imeTimer);
    this.global.clearTimeout(this.wheelTimer);
    this.resizeObserver.disconnect();
    for (const cleanup of this.cleanups) { if (typeof cleanup === 'function') cleanup(); else cleanup?.dispose?.(); }
    this.cleanups = [];
    this.linkProvider?.dispose?.();
    this.term.dispose();
  }
}
