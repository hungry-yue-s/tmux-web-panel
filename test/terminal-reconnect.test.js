import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const source = readFileSync('public/js/terminal.js', 'utf8');
const between = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

/** The real socket, resize and reconnect code against a socket the test drives. */
function setup() {
  const dom = new JSDOM('<div id="terminal"></div>', { runScripts: 'outside-only' });
  const win = dom.window;
  const sockets = [];
  function FakeSocket(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    sockets.push(this);
  }
  FakeSocket.prototype.send = function (data) { this.sent.push(JSON.parse(data)); };
  FakeSocket.prototype.close = function () { this.readyState = 3; };
  Object.assign(FakeSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });

  const term = { cols: 80, rows: 24, element: null, onData: vi.fn(), write: vi.fn() };
  Object.assign(win, {
    WebSocket: FakeSocket,
    state: { currentTab: 'terminal' },
    TerminalTarget: { wsUrl: (paneId) => `wss://panel/ws/terminal/${paneId}` },
    _showToast: vi.fn(),
    _copyToClipboard: vi.fn(),
    _isMobileTerminal: () => false,
    __term: term,
    __container: win.document.getElementById('terminal'),
  });
  win.eval(`var terminalState = { term: __term, termContainer: __container, ws: null };`);
  win.eval(between('var RESIZE_DEBOUNCE_MS', 'var terminalState ='));
  win.eval(between('var TERMINAL_CONNECT_TIMEOUT_MS', '/** The core slice'));
  win.eval('function exitFullscreen() {}');
  win.eval(between('function _cleanupTerminalResources(', '// === Fullscreen'));
  win.eval(between('function connectTerminalWs(', '// === Render Terminal View'));
  win.eval(between('function _showReconnectOverlay(', '// === Navigate back to windows'));

  const open = (ws) => { ws.readyState = 1; ws.onopen(); };
  const ready = (ws) => ws.onmessage({ data: JSON.stringify({ type: 'ready' }) });
  const drop = (ws, code = 1006) => { ws.readyState = 3; ws.onclose({ code }); };
  const connected = () => {
    const ws = win.eval(`terminalState.ws = connectTerminalWs('%1', __term, false); terminalState.ws`);
    open(ws);
    ready(ws);
    return ws;
  };
  const overlays = () => win.document.querySelectorAll('.terminal-reconnect-overlay');
  return { win, term, sockets, open, ready, drop, connected, overlays };
}

const resizes = (ws) => ws.sent.filter((message) => message.type === 'resize');

describe('reconnecting a terminal', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('sends later resizes on the new socket, so tmux follows the window after a drop', () => {
    const { win, term, sockets, open, ready, drop, connected } = setup();
    const first = connected();

    drop(first);
    vi.advanceTimersByTime(1000);
    const second = sockets[1];
    expect(second).toBeDefined();
    open(second);
    ready(second);
    expect(win.eval('terminalState.ws')).toBe(second);

    term.cols = 171;
    term.rows = 47;
    win.eval('_syncTerminalSize(terminalState.ws, __term, true)');
    expect(resizes(second).at(-1)).toEqual({ type: 'resize', cols: 171, rows: 47 });
    expect(resizes(first).at(-1)).toEqual({ type: 'resize', cols: 80, rows: 24 });
  });

  it('catches up on a resize that happened while the socket was down', () => {
    const { term, sockets, open, ready, drop, connected } = setup();
    drop(connected());
    term.cols = 120;
    term.rows = 40;
    vi.advanceTimersByTime(1000);
    open(sockets[1]);
    ready(sockets[1]);
    expect(resizes(sockets[1]).at(-1)).toEqual({ type: 'resize', cols: 120, rows: 40 });
  });

  it('keeps the overlay until the pane is back, not just the socket', () => {
    const { win, sockets, open, ready, drop, connected, overlays } = setup();
    const first = connected();
    drop(first);
    expect(overlays()).toHaveLength(1);

    vi.advanceTimersByTime(1000);
    open(sockets[1]);
    expect(overlays()).toHaveLength(1);
    expect(win.eval('terminalState.ws')).toBe(first);

    ready(sockets[1]);
    expect(overlays()).toHaveLength(0);
  });

  it('counts a socket that opens and is then dropped as a failed attempt', () => {
    const { sockets, open, drop, connected, overlays } = setup();
    drop(connected());
    vi.advanceTimersByTime(1000);
    open(sockets[1]);
    drop(sockets[1]);
    expect(overlays()).toHaveLength(1);
    vi.advanceTimersByTime(1500);
    expect(sockets).toHaveLength(3);
    expect(overlays()[0].textContent).toContain('2/10');
  });

  it('shows the overlay and starts counting again for each new drop', () => {
    const { sockets, open, ready, drop, connected, overlays } = setup();
    drop(connected());
    vi.advanceTimersByTime(1000);
    open(sockets[1]);
    ready(sockets[1]);
    expect(overlays()).toHaveLength(0);

    drop(sockets[1]);
    expect(overlays()).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(3);
    expect(overlays()[0].textContent).toContain('1/10');
  });

  it('stops on a clean close instead of fighting the client that took over', () => {
    const { sockets, open, ready, drop, connected, overlays } = setup();
    drop(connected());
    vi.advanceTimersByTime(1000);
    open(sockets[1]);
    ready(sockets[1]);
    drop(sockets[1], 1000);
    vi.advanceTimersByTime(60000);
    expect(sockets).toHaveLength(2);
    expect(overlays()).toHaveLength(0);
  });

  describe('leaving while a reconnect is under way', () => {
    it('closes the socket that is still connecting, so it cannot attach later', () => {
      const { win, sockets, drop, connected } = setup();
      drop(connected());
      vi.advanceTimersByTime(1000);
      const pending = sockets[1];
      expect(win.eval('terminalState.pendingWs')).toBe(pending);

      win.eval('cleanupTerminal()');

      expect(pending.readyState).toBe(3);
      expect(win.eval('terminalState.pendingWs')).toBeNull();
    });

    it('cancels the retry waiting on its timer', () => {
      const { win, sockets, drop, connected } = setup();
      drop(connected());
      win.eval('cleanupTerminal()');
      vi.advanceTimersByTime(60000);
      expect(sockets).toHaveLength(1);
    });

    it('cancels the next retry after a failed attempt too', () => {
      const { win, sockets, drop, connected } = setup();
      drop(connected());
      vi.advanceTimersByTime(1000);
      drop(sockets[1]);
      win.eval('cleanupTerminal()');
      vi.advanceTimersByTime(60000);
      expect(sockets).toHaveLength(2);
    });

    it('closes a socket that answers after its terminal has been replaced', () => {
      const { win, sockets, open, drop, connected, overlays } = setup();
      drop(connected());
      vi.advanceTimersByTime(1000);
      const pending = sockets[1];
      win.eval('terminalState.term = { cols: 80, rows: 24 }');

      open(pending);
      expect(pending.readyState).toBe(3);
      expect(pending.sent).toEqual([]);
      expect(overlays()).toHaveLength(1);
      expect(win.eval('terminalState.ws')).not.toBe(pending);
    });

    it('does not let a late `ready` from an old socket become the current one', () => {
      const { win, sockets, drop, connected } = setup();
      const first = connected();
      drop(first);
      vi.advanceTimersByTime(1000);
      const pending = sockets[1];
      win.eval('terminalState.term = { cols: 80, rows: 24 }');
      pending.readyState = 1;
      pending.onmessage({ data: JSON.stringify({ type: 'ready' }) });
      expect(win.eval('terminalState.ws')).toBe(first);
      expect(pending.readyState).toBe(3);
    });

    it('forgets the pending socket once it is the current one', () => {
      const { win, sockets, open, ready, drop, connected } = setup();
      drop(connected());
      vi.advanceTimersByTime(1000);
      open(sockets[1]);
      ready(sockets[1]);
      expect(win.eval('terminalState.pendingWs')).toBeNull();
      expect(win.eval('terminalState.ws')).toBe(sockets[1]);
    });
  });

  describe('a connection that never comes up', () => {
    it('counts as a drop after the limit and retries', () => {
      const { win, sockets, overlays } = setup();
      const ws = win.eval(`terminalState.ws = connectTerminalWs('%1', __term, false); terminalState.ws`);
      ws.close = function close() { this.readyState = 3; this.onclose({ code: 1006 }); };

      vi.advanceTimersByTime(19999);
      expect(ws.readyState).toBe(0);
      vi.advanceTimersByTime(1);
      expect(ws.readyState).toBe(3);
      expect(overlays()).toHaveLength(1);
      vi.advanceTimersByTime(1000);
      expect(sockets).toHaveLength(2);
    });

    it('leaves one alone that has delivered anything: it is attached, and must not attach twice', () => {
      const { win, open } = setup();
      const ws = win.eval(`terminalState.ws = connectTerminalWs('%1', __term, false); terminalState.ws`);
      open(ws);
      ws.onmessage({ data: JSON.stringify({ type: 'output', data: 'x' }) });
      vi.advanceTimersByTime(600000);
      expect(ws.readyState).toBe(1);
    });

    it('does not fire after the terminal has gone', () => {
      const { win } = setup();
      const ws = win.eval(`terminalState.ws = connectTerminalWs('%1', __term, false); terminalState.ws`);
      const close = vi.spyOn(ws, 'close');
      win.eval('cleanupTerminal()');
      expect(close).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(600000);
      expect(close).toHaveBeenCalledOnce();
    });
  });

  it('does not pile up input and copy handlers across reconnects', () => {
    const { win, term, sockets, open, ready, drop, connected } = setup();
    const element = win.document.createElement('div');
    term.element = element;
    const disposed = [];
    term.onData = vi.fn(() => ({ dispose: () => disposed.push(1) }));
    term.getSelection = vi.fn(() => 'text');
    drop(connected());
    vi.advanceTimersByTime(1000);
    open(sockets[1]);
    ready(sockets[1]);
    drop(sockets[1]);
    vi.advanceTimersByTime(1000);
    open(sockets[2]);
    ready(sockets[2]);

    expect(term.onData).toHaveBeenCalledTimes(3);
    expect(disposed).toHaveLength(2);
    element.dispatchEvent(new win.Event('mouseup'));
    expect(win._copyToClipboard).toHaveBeenCalledOnce();
  });

  it('never holds on to the first socket in the terminal mount', () => {
    const mount = between('function _mountTerminal(', '// === Reconnect Overlay');
    expect(mount).not.toMatch(/_syncTerminalSize\(ws[,)]/);
    expect(mount).not.toMatch(/var ws = connectTerminalWs/);
    expect(mount).toContain('terminalState.ws = connectTerminalWs(');
  });
});
