import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { NativeWindowSession } from '../../plugins/workbench/client/native-window-session.js';

const target = { serverId: 'dev', instanceId: '42:123', sessionId: '$1', windowId: '@1', paneId: '%1', clientId: 'c-test' };
const snapshots = (socket, seq = 0) => {
  socket.onmessage({ data: JSON.stringify({ type: 'ready', protocol: 1, ...target, cols: 100, rows: 30, resizeAllowed: true }) });
  socket.onmessage({ data: JSON.stringify({ type: 'snapshot', seq, data: 'aGk=', encoding: 'base64', cols: 100, rows: 30 }) });
};

export function fixture() {
  const dom = new JSDOM('<div id="host"></div>', { url: 'https://panel.test' });
  const win = dom.window;
  const sockets = [];
  const terminals = [];
  class Terminal {
    constructor(options) { this.options = options; this.cols = 80; this.rows = 24; this.writes = []; this.listeners = {}; this.parser = { registerOscHandler: () => ({ dispose() {} }) }; this._core = { coreService: { triggerDataEvent: (data) => this.listeners.data?.(data) } }; this.buffer = { active: { viewportY: 0, getLine: () => null } }; terminals.push(this); }
    open(host) { this.element = win.document.createElement('div'); this.element.className = 'xterm'; this.textarea = win.document.createElement('textarea'); this.textarea.className = 'xterm-helper-textarea'; this.element.append(this.textarea); host.append(this.element); }
    loadAddon() {}
    onData(fn) { this.listeners.data = fn; return { dispose() {} }; }
    onBinary(fn) { this.listeners.binary = fn; return { dispose() {} }; }
    onWriteParsed() { return { dispose() {} }; }
    onScroll() { return { dispose() {} }; }
    write(data, done) { this.writes.push(data); done?.(); }
    reset() { this.resets = (this.resets || 0) + 1; }
    resize(cols, rows) { this.cols = cols; this.rows = rows; }
    focus() { this.textarea.focus(); }
    dispose() { this.disposed = true; this.element?.remove(); }
    refresh() {}
    clearTextureAtlas() {}
    getSelection() { return 'selected'; }
    attachCustomKeyEventHandler() {}
  }
  class Socket {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; }
  }
  win.Terminal = Terminal;
  win.WebSocket = Socket;
  win.FitAddon = { FitAddon: class { fit() { const term = terminals[terminals.length - 1]; term.cols = 100; term.rows = 30; } } };
  win.ResizeObserver = class { constructor(fn) { this.callback = fn; } observe() {} disconnect() { this.disconnected = true; } };
  win.TerminalFonts = { coreReady: () => Promise.resolve(true), ensure: () => Promise.resolve(false), family: 'Panel' };
  win.Theme = { getTerminalTheme: () => ({ background: '#000' }), supportsTransparency: () => true };
  win.Auth = { wsTokenParam: () => 'token=secret' };
  win.Api = { nodeUrl: (server, path) => '/n/' + server + path };
  win.MobileUI = { isMobile: () => false };
  const host = win.document.getElementById('host');
  Object.defineProperties(host, { clientWidth: { configurable: true, value: 800 }, clientHeight: { configurable: true, value: 600 } });
  return { win, host, sockets, terminals, close: () => dom.window.close() };
}

afterEach(() => vi.useRealTimers());

describe('persistent native window sessions', () => {
  it('captures the target, fits before attach, restores bytes and ignores stale/duplicate frames', async () => {
    const f = fixture();
    const input = { ...target };
    const pane = new NativeWindowSession(f.win, { container: f.host, target: input });
    input.serverId = 'wrong';
    await pane.ready;
    const socket = f.sockets[0];
    expect(socket.url).toContain('/n/dev/ws/native-window/%401');
    expect(socket.url).toContain('cols=100');
    socket.readyState = 1;
    socket.onopen();
    expect(pane.send('early')).toBe(false);
    snapshots(socket);
    socket.onmessage({ data: JSON.stringify({ type: 'output', seq: 1, data: '5L2g', encoding: 'base64' }) });
    socket.onmessage({ data: JSON.stringify({ type: 'output', seq: 1, data: '5L2g', encoding: 'base64' }) });
    expect(f.terminals[0].writes.map((bytes) => Array.from(bytes))).toEqual([[104, 105], [228, 189, 160]]);
    expect(pane.send('x')).toBe(true);
    expect(socket.sent.at(-1)).toEqual({ type: 'input', encoding: 'base64', data: 'eA==' });
    pane.refresh();
    await Promise.resolve();
    const writes = f.terminals[0].writes.length;
    socket.onmessage?.({ data: JSON.stringify({ type: 'output', seq: 2, data: 'eA==', encoding: 'base64' }) });
    expect(f.terminals[0].writes).toHaveLength(writes);
    pane.dispose();
    f.close();
  });

  it('keeps hidden mobile panes at their last nonzero size and cleans only itself', async () => {
    const f = fixture();
    const secondHost = f.host.cloneNode();
    f.host.after(secondHost);
    Object.defineProperties(secondHost, { clientWidth: { value: 400 }, clientHeight: { value: 400 } });
    const a = new NativeWindowSession(f.win, { container: f.host, target });
    const b = new NativeWindowSession(f.win, { container: secondHost, target: { ...target, paneId: '%2', windowId: '@2', clientId: 'c-second' } });
    await Promise.all([a.ready, b.ready]);
    const socket = f.sockets[0];
    socket.readyState = 1;
    socket.onopen();
    snapshots(socket);
    a.setVisible(false);
    Object.defineProperty(f.host, 'clientWidth', { value: 0 });
    a.fit();
    expect(socket.sent.filter((msg) => msg.type === 'resize').every((msg) => msg.cols > 0 && msg.rows > 0)).toBe(true);
    expect(socket.sent.some((message) => message.type === 'visibility')).toBe(false);
    expect(socket.readyState).toBe(1);
    a.dispose();
    expect(f.terminals[0].disposed).toBe(true);
    expect(f.terminals[1].disposed).not.toBe(true);
    b.dispose();
    f.close();
  });

  it('never attaches after disposal while fonts are pending and never retries an exit', async () => {
    const f = fixture();
    let finish;
    f.win.TerminalFonts.coreReady = () => new Promise((resolve) => { finish = resolve; });
    const stale = new NativeWindowSession(f.win, { container: f.host, target });
    stale.dispose();
    finish(true);
    await stale.ready;
    expect(f.sockets).toHaveLength(0);
    f.win.TerminalFonts.coreReady = () => Promise.resolve(true);
    const pane = new NativeWindowSession(f.win, { container: f.host, target });
    await pane.ready;
    const socket = f.sockets[0];
    socket.readyState = 1;
    socket.onopen();
    snapshots(socket);
    socket.onmessage({ data: JSON.stringify({ type: 'exit', reason: 'pane exited' }) });
    socket.onclose?.({ code: 1006 });
    expect(pane.status).toBe('exited');
    expect(pane.send('never')).toBe(false);
    pane.dispose();
    f.close();
  });

  it('waits until visible, keeps a valid native grid, and accepts later snapshots', async () => {
    const f = fixture();
    const pane = new NativeWindowSession(f.win, { container: f.host, target, visible: false });
    await pane.ready;
    expect(f.sockets).toHaveLength(0);
    pane.setVisible(true);
    const socket = f.sockets[0];
    socket.readyState = 1; socket.onopen(); snapshots(socket);
    pane.setVisible(false); pane.setVisible(true);
    expect(socket.sent.some((message) => message.type === 'visibility')).toBe(false);
    socket.onmessage({ data: JSON.stringify({ type: 'ready', protocol: 1, ...target, cols: 72, rows: 18, resizeAllowed: false }) });
    expect([pane.term.cols, pane.term.rows]).toEqual([72, 18]);
    socket.onmessage({ data: JSON.stringify({ type: 'snapshot', seq: 1, data: 'bmV3', encoding: 'base64', cols: 72, rows: 18 }) });
    expect(pane.term.resets).toBe(2);
    expect([pane.term.cols, pane.term.rows]).toEqual([72, 18]);
    expect(pane.send('after')).toBe(true);
    pane.dispose(); f.close();
  });

  it('supports mobile long-press selection and copy without opening the soft keyboard', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.win.MobileUI.isMobile = () => true;
    f.win._copyToClipboard = vi.fn();
    const pane = new NativeWindowSession(f.win, { container: f.host, target });
    await pane.ready;
    pane.term.select = vi.fn();
    pane.term.element.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
    const start = new f.win.Event('touchstart', { bubbles: true, cancelable: true });
    Object.defineProperty(start, 'touches', { value: [{ clientX: 80, clientY: 60 }] });
    f.host.dispatchEvent(start);
    await vi.advanceTimersByTimeAsync(500);
    expect(pane.term.select).toHaveBeenCalled();
    f.host.querySelector('.wb-touch-copy').click();
    expect(f.win._copyToClipboard).toHaveBeenCalledWith('selected');
    expect(f.win.document.activeElement).not.toBe(pane.term.textarea);
    pane.dispose(); f.close();
  });

  it('encodes legacy mouse input as original bytes rather than UTF-8 text', async () => {
    const f = fixture();
    const pane = new NativeWindowSession(f.win, { container: f.host, target }); await pane.ready;
    const socket = f.sockets[0]; socket.readyState = 1; socket.onopen(); snapshots(socket);
    const bytes = '\x1b[M\x20\x80\x25';
    pane.term.listeners.binary(bytes);
    const message = socket.sent.at(-1);
    expect(message.type).toBe('input'); expect(message.encoding).toBe('base64');
    expect([...f.win.atob(message.data)].map((char) => char.charCodeAt(0))).toEqual([27, 91, 77, 32, 128, 37]);
    pane.dispose(); f.close();
  });

  it('does not feed a snapshot back into the same resize request forever', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const pane = new NativeWindowSession(f.win, { container: f.host, target }); await pane.ready;
    const socket = f.sockets[0]; socket.readyState = 1; socket.onopen(); snapshots(socket);
    await vi.advanceTimersByTimeAsync(100);
    expect(socket.sent.filter((message) => message.type === 'resize')).toHaveLength(0);
    // tmux may report a constrained/rounded grid. Its next snapshot is not a
    // reason to keep requesting the exact same fitted dimensions.
    socket.onmessage({ data: JSON.stringify({ type: 'snapshot', seq: 1, encoding: 'base64', data: 'aGk=', cols: 100, rows: 29 }) });
    await vi.advanceTimersByTimeAsync(200);
    expect(socket.sent.filter((message) => message.type === 'resize')).toHaveLength(0);
    pane.dispose(); f.close();
  });
  it('follows confirmed native window/pane changes but rejects replacement of the server instance', async () => {
    const f = fixture(); const contexts = [];
    const session = new NativeWindowSession(f.win, { container: f.host, target, onContext: (value) => contexts.push(value) }); await session.ready;
    const socket = f.sockets[0]; socket.readyState = 1; socket.onopen(); snapshots(socket);
    socket.onmessage({ data: JSON.stringify({ type: 'context', protocol: 1, ...target, sessionId: '$2', windowId: '@3', paneId: '%9' }) });
    expect(session.context).toMatchObject({ sessionId: '$2', windowId: '@3', paneId: '%9' });
    expect(contexts.at(-1).paneId).toBe('%9'); expect(Object.isFrozen(contexts.at(-1))).toBe(true);
    socket.onmessage({ data: JSON.stringify({ type: 'context', protocol: 1, ...target, instanceId: 'different' }) });
    expect(session.status).toBe('invalid'); session.dispose(); f.close();
  });
  it('answers native startup queries before hydration but never sends early keyboard input', async () => {
    const f = fixture(); const session = new NativeWindowSession(f.win, { container: f.host, target }); await session.ready;
    const socket = f.sockets[0]; socket.readyState = 1; socket.onopen();
    session.term._core.coreService.triggerDataEvent('\x1b[0n', false);
    expect(socket.sent.at(-1)).toEqual({ type: 'response', encoding: 'base64', data: 'G1swbg==' });
    session.term._core.coreService.triggerDataEvent('typed', true);
    expect(socket.sent.filter((message) => message.type === 'input')).toHaveLength(0);
    session.dispose(); f.close();
  });
  it('processes bootstrap query bytes without publishing a pane source or a live terminal', async () => {
    const f = fixture(); const contexts = [];
    const session = new NativeWindowSession(f.win, { container: f.host, target, onContext: (value) => contexts.push(value) }); await session.ready;
    const socket = f.sockets[0]; socket.readyState = 1; socket.onopen();
    socket.onmessage({ data: JSON.stringify({ type: 'bootstrap', encoding: 'base64', data: 'G1tj' }) });
    expect(Array.from(session.term.writes[0])).toEqual([27, 91, 99]);
    expect(session.status).toBe('connecting'); expect(session.context).toBeNull(); expect(contexts).toEqual([]);
    expect(session.send('early')).toBe(false); snapshots(socket); expect(session.status).toBe('live');
    session.dispose(); f.close();
  });
  it('disables user input throughout a replacement frame and restores it after the atomic write', async () => {
    const f = fixture(); const session = new NativeWindowSession(f.win, { container: f.host, target }); await session.ready;
    const socket = f.sockets[0]; socket.readyState = 1; socket.onopen(); snapshots(socket); let finish;
    session.term.write = (_data, callback) => { finish = callback; };
    const fitted = vi.spyOn(session.fitAddon, 'fit');
    socket.onmessage({ data: JSON.stringify({ type: 'snapshot', seq: 1, encoding: 'base64', data: 'aGk=', cols: 100, rows: 30 }) });
    expect(session.term.options.disableStdin).toBe(true); expect(session.send('while restoring')).toBe(false);
    session.fit(); expect(fitted).not.toHaveBeenCalled();
    finish(); expect(fitted).toHaveBeenCalledTimes(1); expect(session.term.options.disableStdin).toBe(false); expect(session.send('after')).toBe(true);
    session.dispose(); f.close();
  });
  it('chunks large Unicode input without changing the original byte stream', async () => {
    const f = fixture(); const session = new NativeWindowSession(f.win, { container: f.host, target }); await session.ready;
    const socket = f.sockets[0]; socket.readyState = 1; socket.onopen(); snapshots(socket);
    const text = '你好'.repeat(16000); expect(session.send(text)).toBe(true);
    const frames = socket.sent.filter((message) => message.type === 'input');
    expect(frames.length).toBeGreaterThan(1);
    const bytes = frames.flatMap((frame) => [...f.win.atob(frame.data)].map((char) => char.charCodeAt(0)));
    expect(new TextDecoder().decode(Uint8Array.from(bytes))).toBe(text);
    expect(frames.every((frame) => f.win.atob(frame.data).length <= 32768)).toBe(true);
    session.dispose(); f.close();
  });
  it('lets xterm own native focus reports without an extra DOM-level copy', async () => {
    const f = fixture(); const session = new NativeWindowSession(f.win, { container: f.host, target }); await session.ready;
    const socket = f.sockets[0]; socket.readyState = 1; socket.onopen(); snapshots(socket);
    session.term.modes = { sendFocusMode: true };
    session.term.textarea.dispatchEvent(new f.win.FocusEvent('focusin', { bubbles: true }));
    expect(socket.sent).toEqual([]);
    session.term._core.coreService.triggerDataEvent('\x1b[I', false);
    expect(socket.sent).toEqual([{ type: 'response', encoding: 'base64', data: 'G1tJ' }]);
    session.dispose(); f.close();
  });
  it('serializes pending bootstrap, full frame reset, and later live output in parser order', async () => {
    const f = fixture(); const session = new NativeWindowSession(f.win, { container: f.host, target }); await session.ready;
    const socket = f.sockets[0]; socket.readyState = 1; socket.onopen(); const queued = [];
    session.term.write = (data, done) => { session.term.writes.push(data); queued.push(done); };
    socket.onmessage({ data: JSON.stringify({ type: 'bootstrap', encoding: 'base64', data: 'Ym9vdA==' }) });
    snapshots(socket);
    socket.onmessage({ data: JSON.stringify({ type: 'output', seq: 1, encoding: 'base64', data: 'bGl2ZQ==' }) });
    expect(session.term.writes).toHaveLength(1); expect(session.term.resets || 0).toBe(0);
    queued.shift()(); expect(session.term.writes).toHaveLength(2); expect(session.term.resets).toBe(1);
    expect(session.status).toBe('connecting');
    queued.shift()(); expect(session.status).toBe('live'); expect(session.term.writes).toHaveLength(3);
    expect(session.term.writes.map((bytes) => new TextDecoder().decode(bytes))).toEqual(['boot', 'hi', 'live']);
    queued.shift()(); session.dispose(); f.close();
  });
  it('resolves fresh native context by request identity and rejects input races, timeout and old connections', async () => {
    vi.useFakeTimers(); const f = fixture(); const session = new NativeWindowSession(f.win, { container: f.host, target }); await session.ready;
    const socket = f.sockets[0]; socket.readyState = 1; socket.onopen(); snapshots(socket);
    const fresh = session.requestContext(); expect(session.requestContext()).toBe(fresh);
    const request = socket.sent.at(-1); expect(request.type).toBe('context-request');
    socket.onmessage({ data: JSON.stringify({ type: 'context', protocol: 1, ...target, paneId: '%8', requestId: request.requestId }) });
    await expect(fresh).resolves.toMatchObject({ paneId: '%8' });
    const raced = session.requestContext(); const failed = expect(raced).rejects.toThrow('输入');
    const race = socket.sent.at(-1); session.send('typed');
    socket.onmessage({ data: JSON.stringify({ type: 'context', protocol: 1, ...target, requestId: race.requestId }) }); await failed;
    const late = session.requestContext(); const timed = expect(late).rejects.toThrow('超时'); await vi.advanceTimersByTimeAsync(5001); await timed;
    const old = session.requestContext(); const disconnected = expect(old).rejects.toThrow('连接'); session.refresh(); await disconnected;
    session.dispose(); f.close();
  });
  it('ignores a prior click mouse-up report while still rejecting a new pointer intent during focus lookup', async () => {
    const f = fixture(); const session = new NativeWindowSession(f.win, { container: f.host, target }); await session.ready;
    const socket = f.sockets[0]; socket.readyState = 1; socket.onopen(); snapshots(socket);
    const fresh = session.requestContext(); const request = socket.sent.at(-1);
    f.host.dispatchEvent(new f.win.MouseEvent('mouseup', { bubbles: true })); session.term._core.coreService.triggerDataEvent('\x1b[<0;1;1m', true);
    socket.onmessage({ data: JSON.stringify({ type: 'context', protocol: 1, ...target, requestId: request.requestId }) }); await expect(fresh).resolves.toMatchObject({ paneId: '%1' });
    const later = session.requestContext(); const rejected = expect(later).rejects.toThrow('输入'); const next = socket.sent.at(-1);
    f.host.dispatchEvent(new f.win.MouseEvent('mousedown', { bubbles: true }));
    socket.onmessage({ data: JSON.stringify({ type: 'context', protocol: 1, ...target, requestId: next.requestId }) }); await rejected;
    session.dispose(); f.close();
  });

});
