import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const SOURCE = readFileSync('public/js/terminal.js', 'utf8');
const TRACE = readFileSync('public/js/terminal-trace.js', 'utf8');

let dom;
afterEach(() => {
  vi.useRealTimers();
  dom?.window.close();
  dom = null;
});

/**
 * The real renderTerminal and mount on a fake xterm whose cell size depends on what
 * really changes it: the font in use and the renderer. A socket opened too early
 * shows up as a grid that differs from the final one.
 */
function setup({ coreReady = async () => true, webgl = true, width = 1400, height = 900, panes = [{ id: '%1' }], listPanes } = {}) {
  dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', {
    url: 'https://panel.test/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const win = dom.window;
  const page = { width, height, fontLoaded: true };
  for (const [name, read] of [['clientWidth', () => page.width], ['clientHeight', () => page.height]]) {
    Object.defineProperty(win.HTMLElement.prototype, name, { configurable: true, get: read });
  }

  const cell = (term) => {
    const real = term.options.fontFamily !== 'monospace' && page.fontLoaded;
    const base = real ? { w: 8, h: 20 } : { w: 9, h: 18 };
    return term.webgl ? { w: base.w, h: base.h + 1 } : base;
  };
  const gridFor = (font, gl) => ({
    cols: Math.floor(page.width / (font ? 8 : 9)),
    rows: Math.floor(page.height / ((font ? 20 : 18) + (gl ? 1 : 0))),
  });

  class FakeTerminal {
    constructor(options) {
      this.options = { ...options };
      this.cols = 80;
      this.rows = 24;
      this.buffer = { active: { viewportY: 0, getLine: () => null } };
      this.written = [];
    }

    open(el) { this.element = win.document.createElement('div'); el.appendChild(this.element); }

    loadAddon(addon) { addon.activate(this); }

    onData() { return { dispose() {} }; }

    onWriteParsed() { return { dispose() {} }; }

    onScroll() { return { dispose() {} }; }

    onRender() { return { dispose() {} }; }

    onResize() { return { dispose() {} }; }

    refresh() {}

    clearTextureAtlas() {}

    focus() {}

    write(text) { this.written.push(text); }

    dispose() { this.disposed = true; }
  }

  const sockets = [];
  function FakeSocket(url) {
    this.url = new URL(url);
    this.readyState = 0;
    this.sent = [];
    sockets.push(this);
  }
  FakeSocket.prototype.send = function send(data) { this.sent.push(JSON.parse(data)); };
  FakeSocket.prototype.close = function close() { this.readyState = 3; };
  Object.assign(FakeSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });

  const fonts = { coreReady: vi.fn(coreReady), ensure: async () => false };
  const panesRequest = vi.fn(listPanes || (async () => panes));
  const observers = [];
  Object.assign(win, {
    Terminal: FakeTerminal,
    FitAddon: {
      FitAddon: class {
        activate(term) { this.term = term; }

        fit() {
          const size = cell(this.term);
          this.term.cols = Math.floor(page.width / size.w);
          this.term.rows = Math.floor(page.height / size.h);
        }
      },
    },
    WebglAddon: webgl === false
      ? { WebglAddon: class { onContextLoss() {} activate() { throw new Error('no GPU'); } dispose() {} } }
      : { WebglAddon: class { onContextLoss() {} activate(term) { term.webgl = true; } dispose() {} } },
    WebSocket: FakeSocket,
    ResizeObserver: class {
      constructor(callback) { observers.push(callback); }

      observe() {}

      disconnect() {}
    },
    TerminalFonts: fonts,
    Theme: { getTerminalTheme: () => ({}), supportsTransparency: () => false },
    state: { currentSession: 'work', currentWindow: '0', currentPane: '%1', currentTab: 'terminal' },
    TerminalTarget: {
      serverId: 'local',
      wsUrl: (paneId, nozoom, cols, rows) => `wss://panel.test/ws/terminal/${encodeURIComponent(paneId)}?cols=${cols}&rows=${rows}`,
      listPanes: panesRequest,
      supportsTmuxActions: () => true,
      hasNode: () => true,
      isRemote: () => false,
    },
    _isValidWindowIndex: () => true,
    escapeHtml: (text) => text,
    renderPanePills: vi.fn(),
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
  });
  win.eval(SOURCE);
  win.eval(TRACE);
  const host = win.document.getElementById('host');
  const ready = (ws) => { ws.readyState = 1; ws.onopen(); ws.onmessage({ data: JSON.stringify({ type: 'ready' }) }); };
  const sentSizes = (ws) => ws.sent.filter((m) => m.type === 'resize').map((m) => ({ cols: m.cols, rows: m.rows }));
  const attachSize = (ws) => ({ cols: Number(ws.url.searchParams.get('cols')), rows: Number(ws.url.searchParams.get('rows')) });
  const flush = () => new Promise((resolve) => { setTimeout(resolve, 0); });
  const fireResizeObserver = () => observers.at(-1)();
  return { win, page, host, sockets, fonts, panesRequest, ready, sentSizes, attachSize, gridFor, flush, fireResizeObserver, render: (known) => win.renderTerminal(host, known) };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

describe('attaching at the final size', () => {
  it('uses the final font and renderer from the first attach, and never asks for another size', async () => {
    const t = setup();
    t.render({ panes: [{ id: '%1' }] });
    await t.flush();

    expect(t.sockets).toHaveLength(1);
    expect(t.attachSize(t.sockets[0])).toEqual(t.gridFor(true, true));

    t.ready(t.sockets[0]);
    await new Promise((resolve) => { setTimeout(resolve, 120); });
    expect(t.sockets).toHaveLength(1);
    for (const size of t.sentSizes(t.sockets[0])) expect(size).toEqual(t.gridFor(true, true));
  });

  it('opens no socket while the font is still on its way', async () => {
    const font = deferred();
    const t = setup({ coreReady: () => font.promise });
    t.render({ panes: [{ id: '%1' }] });
    await t.flush();
    expect(t.sockets).toHaveLength(0);

    font.resolve(true);
    await t.flush();
    expect(t.sockets).toHaveLength(1);
    expect(t.attachSize(t.sockets[0])).toEqual(t.gridFor(true, true));
  });

  it('asks for the core slice with a limit, and nothing else first', async () => {
    const t = setup();
    t.render({ panes: [{ id: '%1' }] });
    await t.flush();
    expect(t.fonts.coreReady).toHaveBeenCalledWith(1500);
  });

  it('attaches in the fallback font when the core font fails, and stays there', async () => {
    const t = setup({ coreReady: async () => false });
    t.render({ panes: [{ id: '%1' }] });
    await t.flush();
    expect(t.attachSize(t.sockets[0])).toEqual(t.gridFor(false, true));
    expect(t.win.terminalState.term.options.fontFamily).toBe('monospace');
  });

  describe('when the core font misses the limit', () => {
    const lateFont = () => {
      const late = deferred();
      return { late, coreReady: (ms) => (ms ? Promise.resolve(null) : late.promise) };
    };

    async function attachedInFallback(t) {
      t.page.fontLoaded = false;
      t.render({ panes: [{ id: '%1' }] });
      await t.flush();
      const ws = t.sockets[0];
      t.ready(ws);
      return ws;
    }

    const settle = () => new Promise((resolve) => { setTimeout(resolve, 150); });

    it('attaches in the fallback instead of waiting for it', async () => {
      const { coreReady } = lateFont();
      const t = setup({ coreReady });
      const ws = await attachedInFallback(t);
      expect(t.attachSize(ws)).toEqual(t.gridFor(false, true));
      expect(t.win.terminalState.term.options.fontFamily).toBe('monospace');
    });

    it('leaves the grid alone when the font arrives after the attach', async () => {
      const { late, coreReady } = lateFont();
      const t = setup({ coreReady });
      const ws = await attachedInFallback(t);
      const term = t.win.terminalState.term;
      const before = t.sentSizes(ws).length;

      t.page.fontLoaded = true;
      late.resolve(true);
      await settle();

      expect(t.sockets).toHaveLength(1);
      expect(t.sentSizes(ws).slice(before)).toEqual([]);
      expect(term.options.fontFamily).toBe('monospace');
      expect([term.cols, term.rows]).toEqual(Object.values(t.gridFor(false, true)));
    });

    it('does not change the grid for the observer firing without a real change', async () => {
      const { late, coreReady } = lateFont();
      const t = setup({ coreReady });
      const ws = await attachedInFallback(t);
      t.page.fontLoaded = true;
      late.resolve(true);
      await t.flush();
      const before = t.sentSizes(ws).length;

      t.fireResizeObserver();
      await settle();

      expect(t.sentSizes(ws).slice(before)).toEqual([]);
      expect(t.win.terminalState.term.options.fontFamily).toBe('monospace');
    });

    it('takes the font along with the next real change of size', async () => {
      const { late, coreReady } = lateFont();
      const t = setup({ coreReady });
      const ws = await attachedInFallback(t);
      t.page.fontLoaded = true;
      late.resolve(true);
      await t.flush();
      const before = t.sentSizes(ws).length;

      t.page.width = 1000;
      t.fireResizeObserver();
      await settle();

      expect(t.win.terminalState.term.options.fontFamily).not.toBe('monospace');
      expect(t.sentSizes(ws).slice(before)).toEqual([t.gridFor(true, true)]);
    });

    it('takes the font along with the user changing the font size', async () => {
      const { late, coreReady } = lateFont();
      const t = setup({ coreReady });
      await attachedInFallback(t);
      t.page.fontLoaded = true;
      late.resolve(true);
      await t.flush();
      t.win._adjustFontSize(1);
      expect(t.win.terminalState.term.options.fontFamily).not.toBe('monospace');
    });

    it('has nothing to apply if the late font fails too', async () => {
      const { late, coreReady } = lateFont();
      const t = setup({ coreReady });
      await attachedInFallback(t);
      late.resolve(false);
      await t.flush();
      t.page.width = 1000;
      t.fireResizeObserver();
      await settle();
      expect(t.win.terminalState.term.options.fontFamily).toBe('monospace');
    });

    it('uses the font straight away for the next terminal', async () => {
      const state = { value: null };
      const t = setup({ coreReady: async (ms) => (ms ? state.value : true) });
      await attachedInFallback(t);
      t.page.fontLoaded = true;
      state.value = true;
      t.render({ panes: [{ id: '%1' }] });
      await t.flush();
      expect(t.attachSize(t.sockets[1])).toEqual(t.gridFor(true, true));
    });
  });

  it('measures with the renderer it will really use when WebGL is unavailable', async () => {
    const t = setup({ webgl: false });
    t.render({ panes: [{ id: '%1' }] });
    await t.flush();
    expect(t.attachSize(t.sockets[0])).toEqual(t.gridFor(true, false));
  });

  it('still attaches when the font wait itself breaks', async () => {
    const t = setup({ coreReady: () => Promise.reject(new Error('fonts broke')) });
    t.render({ panes: [{ id: '%1' }] });
    await t.flush();
    expect(t.sockets).toHaveLength(1);
  });

  it('measures the space the dock takes right after the render call', async () => {
    const t = setup();
    t.render({ panes: [{ id: '%1' }] });
    // What MsApp does next, in the same tick: the dock takes its width.
    t.page.width = 1000;
    await t.flush();
    expect(t.attachSize(t.sockets[0])).toEqual(t.gridFor(true, true));
    expect(t.attachSize(t.sockets[0]).cols).toBe(125);
  });

  it('opens no socket for a terminal that was thrown away while waiting', async () => {
    const font = deferred();
    const t = setup({ coreReady: () => font.promise });
    t.render({ panes: [{ id: '%1' }] });
    await t.flush();
    t.win.cleanupTerminal();
    font.resolve(true);
    await t.flush();
    expect(t.sockets).toHaveLength(0);
  });

  it('opens no socket once the page around it has gone', async () => {
    const font = deferred();
    const t = setup({ coreReady: () => font.promise });
    t.render({ panes: [{ id: '%1' }] });
    await t.flush();
    t.host.innerHTML = '';
    font.resolve(true);
    await t.flush();
    expect(t.sockets).toHaveLength(0);
  });
});

describe('panes the caller already has', () => {
  it('attaches without another request', async () => {
    const t = setup();
    t.render({ panes: [{ id: '%1' }] });
    await t.flush();
    expect(t.panesRequest).not.toHaveBeenCalled();
    expect(t.sockets).toHaveLength(1);
  });

  it('asks and waits when it has none', async () => {
    const answer = deferred();
    const t = setup({ listPanes: () => answer.promise });
    t.render();
    await t.flush();
    expect(t.panesRequest).toHaveBeenCalledOnce();
    expect(t.sockets).toHaveLength(0);
    answer.resolve([{ id: '%1' }]);
    await t.flush();
    expect(t.sockets).toHaveLength(1);
  });

  it('does not wait for the check of an old list, and leaves the terminal alone if it was right', async () => {
    const answer = deferred();
    const t = setup({ listPanes: () => answer.promise });
    t.render({ panes: [{ id: '%1' }], verifyPanes: true });
    await t.flush();
    expect(t.sockets).toHaveLength(1);
    answer.resolve([{ id: '%1' }]);
    await t.flush();
    expect(t.sockets).toHaveLength(1);
    expect(t.sockets[0].readyState).not.toBe(3);
  });

  it('starts over when the check shows the list was wrong', async () => {
    const answer = deferred();
    const t = setup({ listPanes: () => answer.promise });
    t.render({ panes: [{ id: '%1' }], verifyPanes: true });
    await t.flush();
    expect(t.sockets).toHaveLength(1);

    answer.resolve([{ id: '%1' }, { id: '%2' }]);
    await t.flush();
    await t.flush();
    expect(t.sockets).toHaveLength(2);
    expect(t.sockets[0].readyState).toBe(3);
  });

  it('ignores the answer to a check once it has moved on', async () => {
    const answer = deferred();
    const t = setup({ listPanes: () => answer.promise });
    t.render({ panes: [{ id: '%1' }], verifyPanes: true });
    await t.flush();
    t.win.cleanupTerminal();
    answer.resolve([{ id: '%9' }]);
    await t.flush();
    expect(t.sockets).toHaveLength(1);
  });
});

describe('isTerminalLive', () => {
  it('is true while waiting for the font, attached, or reconnecting, and false once it has given up', async () => {
    const font = deferred();
    const t = setup({ coreReady: () => font.promise });
    expect(t.win.isTerminalLive()).toBe(false);
    t.render({ panes: [{ id: '%1' }] });
    await t.flush();
    expect(t.win.isTerminalLive()).toBe(true);
    font.resolve(true);
    await t.flush();
    const ws = t.sockets[0];
    t.ready(ws);
    expect(t.win.isTerminalLive()).toBe(true);

    ws.readyState = 3;
    ws.onclose({ code: 1006 });
    expect(t.win.isTerminalLive()).toBe(true);

    t.win.cleanupTerminal();
    expect(t.win.isTerminalLive()).toBe(false);
  });

  it('is false after another client took the pane over, so going back attaches again', async () => {
    const t = setup();
    t.render({ panes: [{ id: '%1' }] });
    await t.flush();
    const ws = t.sockets[0];
    t.ready(ws);
    ws.readyState = 3;
    ws.onclose({ code: 1000 });
    expect(t.win.isTerminalLive()).toBe(false);
  });
});

describe('TerminalTrace', () => {
  it('does nothing until turned on', () => {
    const t = setup();
    const trace = t.win.TerminalTrace;
    trace.begin('x');
    trace.mark('ready');
    expect(trace.enabled()).toBe(false);
    expect(trace.last()).toBeNull();
    expect(trace.all()).toEqual([]);
  });

  it('records the timeline as times, sizes and counts, with nothing from the terminal', async () => {
    const t = setup();
    const trace = t.win.TerminalTrace;
    trace.enable();
    trace.begin('local @2');
    t.render({ panes: [{ id: '%1' }] });
    await t.flush();
    const ws = t.sockets[0];
    t.ready(ws);
    const secret = 'super-secret-terminal-output';
    ws.onmessage({ data: JSON.stringify({ type: 'output', data: `\x1b[?1049h${secret}` }) });

    const record = trace.last();
    expect(record.label).toBe('local @2');
    for (const name of ['panes', 'font', 'wsCreated', 'wsOpen', 'ready', 'firstOutput']) {
      expect(record.marks[name]).toEqual(expect.any(Number));
    }
    expect(record.counts).toMatchObject({ connects: 1, alternateScreens: 1 });
    expect(record.sizes[0]).toMatchObject(t.gridFor(true, true));
    expect(JSON.stringify(record)).not.toContain(secret);
    expect(JSON.stringify(record)).not.toContain('wss://');

    trace.disable();
    expect(trace.last()).toBeNull();
    expect(trace.all()).toEqual([]);
  });

  /** A terminal as the trace sees it, with its xterm events fired by hand. */
  function fakeTerm() {
    const events = {};
    const on = (name) => (fn) => { events[name] = fn; return { dispose() { delete events[name]; } }; };
    return {
      events,
      onWriteParsed: on('parsed'),
      onRender: on('render'),
      onResize: on('resize'),
    };
  }

  /** Times run on the page's clock, so the test can read them back in its own terms. */
  function traced() {
    vi.useFakeTimers();
    const t = setup();
    const trace = t.win.TerminalTrace;
    let clock = 0;
    Object.defineProperty(t.win.performance, 'now', { configurable: true, value: () => clock });
    const advance = (ms) => { clock += ms; vi.advanceTimersByTime(ms); };
    trace.enable();
    trace.begin('x');
    const term = fakeTerm();
    const handle = trace.attach(term);
    return { t, trace, advance, term, handle };
  }
  const big = 'x'.repeat(2000);

  describe('the stable mark', () => {
    it('comes only after output has gone quiet, small repaints aside', () => {
      const { trace, advance, handle } = traced();
      handle.output(big);
      advance(500);
      handle.output(big);
      advance(999);
      expect(trace.last().marks.stable).toBeUndefined();
      advance(2);
      expect(trace.last().marks.stable).toBe(500);
      handle.output('spinner');
      advance(5000);
      expect(trace.last().marks.stable).toBe(500);
      trace.disable();
    });

    it('moves when a late redraw arrives: the 8.5s screen must not read as 3.2s', () => {
      const { trace, advance, handle } = traced();
      advance(3200);
      handle.output(big);
      advance(1000);
      expect(trace.last().marks.stable).toBe(3200);

      advance(700);
      handle.output(big);
      // Withdrawn straight away, not only once it has settled again.
      expect(trace.last().marks.stable).toBeUndefined();
      advance(1000);
      expect(trace.last().marks.stable).toBe(4900);

      advance(2560);
      handle.output(big);
      advance(1000);
      expect(trace.last().marks.stable).toBe(8460);
      trace.disable();
    });

    it('is withdrawn by a new attach even when the frame is small', () => {
      const { trace, advance, handle } = traced();
      handle.output(big);
      advance(1000);
      expect(trace.last().marks.stable).toBe(0);
      advance(500);
      handle.output('\x1b[?1049h');
      expect(trace.last().marks.stable).toBeUndefined();
      advance(1000);
      expect(trace.last().marks.stable).toBe(1500);
      trace.disable();
    });

    it('is withdrawn by a change of size and by a new connection', () => {
      const { trace, advance, handle, term } = traced();
      handle.connecting(100, 30);
      handle.output(big);
      advance(1000);
      term.events.resize({ cols: 120, rows: 30 });
      expect(trace.last().marks.stable).toBeUndefined();
      advance(1000);
      expect(trace.last().marks.stable).toBe(1000);
      handle.connecting(120, 30);
      expect(trace.last().marks.stable).toBeUndefined();
      expect(trace.last().counts.connects).toBe(2);
      trace.disable();
    });

    it('takes the time the redraw reached the screen, not when its bytes came in', () => {
      const { trace, advance, handle, term } = traced();
      handle.output(big);
      term.events.parsed();
      advance(300);
      term.events.render();
      advance(1000);
      expect(trace.last().marks.stable).toBe(300);
      expect(trace.last().marks.firstRender).toBe(300);
      trace.disable();
    });

    it('is not decided by `ready` or anything else before the first output', () => {
      const { trace, advance, handle } = traced();
      handle.mark('ready');
      handle.connecting(100, 30);
      advance(10000);
      expect(trace.last().marks.stable).toBeUndefined();
      trace.disable();
    });
  });

  describe('which run a report belongs to', () => {
    it('keeps the time already waited when a bare route resolves to its default window', () => {
      const { trace, advance } = traced();
      trace.disable();
      trace.enable();
      trace.begin('cc-windows ');
      advance(1456);
      trace.begin('cc-windows @2', { continues: true });
      trace.mark('workspace');
      expect(trace.all()).toHaveLength(1);
      expect(trace.last().label).toBe('cc-windows @2');
      expect(trace.last().marks.workspace).toBe(1456);
      trace.disable();
    });

    it('starts over for a new navigation', () => {
      const { trace, advance } = traced();
      advance(1000);
      trace.begin('next');
      trace.mark('workspace');
      expect(trace.all()).toHaveLength(2);
      expect(trace.last().marks.workspace).toBe(0);
      trace.disable();
    });

    it('writes nothing from an old terminal into a newer run', () => {
      const { trace, advance, handle, term } = traced();
      handle.output(big);
      const old = trace.last();
      trace.begin('next');
      const next = trace.last();

      handle.mark('ready');
      handle.connecting(50, 50);
      handle.output('\x1b[?1049h' + big);
      term.events.parsed();
      term.events.render();
      term.events.resize({ cols: 9, rows: 9 });
      advance(5000);

      expect(next.marks).toEqual({});
      expect(next.sizes).toEqual([]);
      expect(next.counts).toEqual({ alternateScreens: 0, connects: 0 });
      // Nor does the old run change after it was replaced.
      expect(old.marks.ready).toBeUndefined();
      expect(old.counts.alternateScreens).toBe(0);
      trace.disable();
    });

    it('binds firstParsed and firstRender to the terminal that drew them', () => {
      const { trace, term } = traced();
      trace.begin('next');
      const newer = fakeTerm();
      const handle = trace.attach(newer);
      term.events.parsed();
      term.events.render();
      expect(trace.last().marks.firstParsed).toBeUndefined();
      handle.output('x');
      newer.events.parsed();
      newer.events.render();
      expect(trace.last().marks.firstParsed).toEqual(expect.any(Number));
      expect(trace.last().marks.firstRender).toEqual(expect.any(Number));
      trace.disable();
    });

    it('gives a terminal no route announced its own run, not the last terminal\'s', () => {
      const { trace, handle } = traced();
      handle.output(big);
      const routed = trace.last();
      const remounted = trace.attach(fakeTerm());
      expect(trace.last()).not.toBe(routed);
      expect(trace.last().label).toBe('remount');
      remounted.mark('ready');
      expect(routed.marks.ready).toBeUndefined();
      trace.disable();
    });

    it('keeps only a limited history', () => {
      const { trace } = traced();
      for (let i = 0; i < 100; i += 1) trace.begin(`run ${i}`);
      expect(trace.all().length).toBeLessThanOrEqual(20);
      trace.disable();
    });
  });

  it('counts a second attach as a second alternate-screen entry', () => {
    const { trace, handle } = traced();
    handle.output('\x1b[?1049h...\x1b[?1049h');
    handle.output('\x1b[?1049h');
    expect(trace.last().counts.alternateScreens).toBe(3);
    trace.disable();
  });

  it('counts an alternate-screen entry split across two frames, once, keeping none of the text', () => {
    const { trace, handle } = traced();
    handle.output('before\x1b[?10');
    handle.output('49hafter');
    expect(trace.last().counts.alternateScreens).toBe(1);
    handle.output('more');
    expect(trace.last().counts.alternateScreens).toBe(1);
    expect(JSON.stringify(trace.last())).not.toContain('before');
    expect(JSON.stringify(trace.last())).not.toContain('more');
    trace.disable();
  });

  it('times from the click when turned on at runtime, too', () => {
    const t = setup();
    const trace = t.win.TerminalTrace;
    let clock = 1000;
    Object.defineProperty(t.win.performance, 'now', { configurable: true, value: () => clock });
    trace.enable();
    t.win.document.body.click();
    clock = 1400;
    trace.begin('x');
    trace.mark('workspace');
    expect(trace.last().marks.workspace).toBe(400);
    trace.disable();
  });
});
