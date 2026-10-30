import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const TERMINAL_SRC = readFileSync('public/js/terminal.js', 'utf8');

/**
 * Evaluates just the font-size helper against a minimal fake window. The helper
 * only needs the viewport breakpoint and user offset; old pane/container
 * geometry is supplied to prove it does not shrink the type.
 */
function loadSizer({ width, height = 800, offset = 0, containerWidth = null, containerHeight = null, mobile = null }) {
  const container = {
    clientWidth: containerWidth === null ? width : containerWidth,
    clientHeight: containerHeight === null ? height : containerHeight,
  };
  const win = {
    innerWidth: width,
    MobileUI: mobile === null ? null : { isMobile: () => mobile },
    innerHeight: height,
    document: { querySelector: () => container },
  };

  const start = TERMINAL_SRC.indexOf('/** Readable starting point on phones');
  expect(start).toBeGreaterThan(-1);
  const fnStart = TERMINAL_SRC.indexOf('function _calcTerminalFontSize');
  const slice = TERMINAL_SRC.slice(start, TERMINAL_SRC.indexOf('\n}', fnStart) + 2);

  // eslint-disable-next-line no-new-func
  const factory = new Function('window', 'document', `
    function _getFontOffset() { return ${offset}; }
    ${slice}
    return {
      _calcTerminalFontSize: _calcTerminalFontSize,
      MOBILE_BASE_FONT_SIZE: MOBILE_BASE_FONT_SIZE,
      MOBILE_MIN_FONT_SIZE: MOBILE_MIN_FONT_SIZE,
    };
  `);
  return factory(win, win.document);
}

describe('mobile terminal font size', () => {
  it('stays readable on a 360px phone with a desktop-sized pane', () => {
    // The pane geometry comes from a desktop tmux window; fitting to it produced
    // ~8px text crammed into a corner.
    const win = loadSizer({ width: 360, height: 800 });

    const size = win._calcTerminalFontSize(213, 54);

    expect(size).toBe(13);
    expect(size).toBeGreaterThanOrEqual(11);
  });

  it('ignores pane geometry entirely below the desktop breakpoint', () => {
    const win = loadSizer({ width: 360, height: 800 });

    // A huge pane and a small pane must both yield the readable base.
    expect(win._calcTerminalFontSize(400, 120)).toBe(13);
    expect(win._calcTerminalFontSize(80, 24)).toBe(13);
    expect(win._calcTerminalFontSize(undefined, undefined)).toBe(13);
  });

  it('is readable across common phone widths', () => {
    for (const width of [320, 360, 390, 414, 767]) {
      const win = loadSizer({ width, height: 800 });
      expect(win._calcTerminalFontSize(213, 54)).toBeGreaterThanOrEqual(11);
    }
  });

  it('keeps the phone layout and font in coarse-pointer landscape', () => {
    expect(loadSizer({ width: 844, height: 390, mobile: true })._calcTerminalFontSize(213, 54)).toBe(13);
    expect(loadSizer({ width: 844, height: 900, mobile: false })._calcTerminalFontSize(213, 54)).toBe(14);
  });

  it('still honors the user font offset, with a readable floor', () => {
    expect(loadSizer({ width: 360, offset: 2 })._calcTerminalFontSize(213, 54)).toBe(15);
    expect(loadSizer({ width: 360, offset: -1 })._calcTerminalFontSize(213, 54)).toBe(12);
    // The floor stops A- from making the terminal unreadable again.
    expect(loadSizer({ width: 360, offset: -8 })._calcTerminalFontSize(213, 54)).toBe(11);
    expect(loadSizer({ width: 360, offset: 99 })._calcTerminalFontSize(213, 54)).toBe(22);
  });

  it('keeps desktop text at 14px while the grid adapts to old pane geometry', () => {
    const win = loadSizer({ width: 1440, height: 900, containerWidth: 1440, containerHeight: 900 });

    expect(win._calcTerminalFontSize(80, 24)).toBe(14);
    expect(win._calcTerminalFontSize(400, 120)).toBe(14);
    expect(loadSizer({ width: 768, containerWidth: 280 })._calcTerminalFontSize(400, 120)).toBe(14);
  });

  it('applies the desktop floor, not the mobile floor, on desktop', () => {
    const win = loadSizer({ width: 800, height: 600, containerWidth: 800, containerHeight: 600 });
    expect(win._calcTerminalFontSize(400, 200)).toBe(14);
    expect(loadSizer({ width: 800, offset: -99 })._calcTerminalFontSize(400, 200)).toBe(8);
  });
});

it('retains readable A± sizes across windows, dock widths, reloads and servers', () => {
  const saved = new Map();
  const storage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) };
  const state = { currentPane: '%0', currentSession: 'work', currentWindow: 0 };
  const target = { serverId: 'local' };
  const terminalState = { term: { options: { fontSize: 14 } }, fitAddon: { fit: vi.fn() }, ws: {} };
  const source = TERMINAL_SRC.slice(TERMINAL_SRC.indexOf('var _fontOffsets ='), TERMINAL_SRC.indexOf('// === Create xterm Terminal'));
  const factory = new Function('window', 'localStorage', 'state', 'TerminalTarget', 'terminalState', '_syncTerminalSize', source + `
    return { size: _calcTerminalFontSize, adjust: _adjustFontSize, mode: value => { _terminalMode = value; } };
  `);
  const load = () => factory({ innerWidth: 1280 }, storage, state, target, terminalState, vi.fn());
  let controls = load();
  controls.adjust(1);
  expect(terminalState.term.options.fontSize).toBe(15);
  state.currentPane = '%1';
  expect(controls.size(80, 24)).toBe(14);
  state.currentPane = '%0';
  // A narrower document dock changes cols, never the saved type size.
  expect(controls.size(500, 200, { clientWidth: 280, clientHeight: 500 })).toBe(15);
  controls = load();
  expect(controls.size(80, 24)).toBe(15);
  target.serverId = 'build-server';
  expect(controls.size(80, 24)).toBe(14);
  target.serverId = 'local';
  controls.adjust(-1);
  expect(load().size(400, 120)).toBe(14);
  controls.mode('split');
  terminalState.term.options.fontSize = controls.size(80, 24);
  controls.adjust(1);
  state.currentWindow = 1;
  expect(controls.size(80, 24)).toBe(14);
  state.currentWindow = 0;
  expect(controls.size(400, 120)).toBe(15);
  // Legacy offsets are migrated and normalized after reaching the upper bound.
  saved.set('tmux_font_offsets', JSON.stringify({ '%0': 99 }));
  controls = load();
  terminalState.term.options.fontSize = controls.size(80, 24);
  expect(terminalState.term.options.fontSize).toBe(22);
  controls.adjust(-1);
  expect(load().size(400, 120)).toBe(21);
  expect(JSON.parse(saved.get('tmux_font_offsets'))).toEqual({ 'local:%0': 7 });
});

it('keeps a working renderer after font/GPU failure and ignores disposed font waits', async () => {
  const source = TERMINAL_SRC.slice(TERMINAL_SRC.indexOf('  var fontsReady ='), TERMINAL_SRC.indexOf('// Small delay to ensure DOM is ready for fitting'));
  const start = new Function('document', 'term', 'terminalState', 'WebglAddon', 'TERMINAL_FONT_FAMILY', 'termContainer', 'fitAddon', '_syncTerminalSize', source + '\nreturn fontWriteCleanup;');
  for (const [fontFails, disposed] of [[true, false], [false, false], [false, true]]) {
    let parsed;
    const listener = { dispose: vi.fn() };
    const term = {
      options: { fontFamily: 'monospace' }, rows: 24,
      onWriteParsed: callback => { parsed = callback; return listener; },
      loadAddon: vi.fn(() => { throw new Error('WebGL unavailable'); }), refresh: vi.fn(),
    };
    const gpu = { onContextLoss: vi.fn(), dispose: vi.fn() };
    const state = { term };
    const cancel = start({ fonts: { load: () => fontFails ? Promise.reject(new Error('font unavailable')) : Promise.resolve([]) } }, term, state,
      { WebglAddon: function () { return gpu; } }, 'Maple Mono', { clientWidth: 700, clientHeight: 500 }, { fit: vi.fn() }, vi.fn());
    if (disposed) { state.term = null; cancel(); }
    else parsed();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(listener.dispose).toHaveBeenCalled();
    expect(term.options.fontFamily).toBe(fontFails || disposed ? 'monospace' : 'Maple Mono');
    if (disposed) expect(term.loadAddon).not.toHaveBeenCalled();
    else {
      expect(term.refresh).toHaveBeenCalledWith(0, 23);
      expect(gpu.dispose).toHaveBeenCalledOnce();
    }
  }
});

describe('mobile font size constants', () => {
  it('documents a readable base and floor', () => {
    const win = loadSizer({ width: 360 });
    expect(win.MOBILE_BASE_FONT_SIZE).toBeGreaterThanOrEqual(13);
    expect(win.MOBILE_MIN_FONT_SIZE).toBeGreaterThanOrEqual(11);
  });

  it('branches on the same 768px breakpoint the rest of the view uses', () => {
    expect(TERMINAL_SRC).toContain('return window.MobileUI ? window.MobileUI.isMobile() : window.innerWidth < 768;');
    expect(TERMINAL_SRC).toContain('if (_isMobileTerminal()) {');
  });
});

describe('mobile touch forwarding', () => {
  it('focuses xterm without disabling the swipe overlay', () => {
    const tapBlock = TERMINAL_SRC.slice(
      TERMINAL_SRC.indexOf('// No file path hit'),
      TERMINAL_SRC.indexOf('if (ts.direction === \'vertical\')', TERMINAL_SRC.indexOf('// No file path hit')),
    );

    expect(tapBlock).toContain('refocusOnClick = true');
    expect(tapBlock).toContain('term.focus()');
    expect(tapBlock).not.toContain('overlay.style.pointerEvents');
    expect(tapBlock).not.toContain('setTimeout');
  });

  it('still treats sub-threshold finger jitter as a tap', () => {
    const touchMove = TERMINAL_SRC.slice(
      TERMINAL_SRC.indexOf("overlay.addEventListener('touchmove'"),
      TERMINAL_SRC.indexOf("overlay.addEventListener('touchend'"),
    );

    expect(touchMove.indexOf('ts.moved = true'))
      .toBeGreaterThan(touchMove.indexOf('// Lock direction after initial movement'));
  });

  it('refocuses xterm after Chrome dispatches its compatibility click', () => {
    const clickBlock = TERMINAL_SRC.slice(
      TERMINAL_SRC.indexOf("overlay.addEventListener('click'"),
      TERMINAL_SRC.indexOf('// ResizeObserver for auto-fit'),
    );

    expect(clickBlock).toContain('if (!refocusOnClick) return');
    expect(clickBlock).toContain('e.preventDefault()');
    expect(clickBlock).toContain('term.focus()');
  });
});

describe('mobile horizontal swipe', () => {
  it.each([
    [-80, 375, false, false, 1],
    [80, 375, false, false, -1],
    [-30, 375, false, false, null],
    [-80, 1024, false, false, null],
    [-80, 375, true, false, null],
    [-80, 375, false, true, null],
  ])('handles dx=%s at width=%s, cancelled=%s, pinch=%s', (dx, width, cancelled, pinching, direction) => {
    const start = TERMINAL_SRC.indexOf("  overlay.addEventListener('touchend', function (e) {");
    const end = TERMINAL_SRC.indexOf("  overlay.addEventListener('touchcancel'", start);
    const switchPaneByDirection = vi.fn();
    let handler;
    const viewportHelper = TERMINAL_SRC.slice(TERMINAL_SRC.indexOf('function _isMobileTerminal()'), TERMINAL_SRC.indexOf('function _calcTerminalFontSize'));
    const install = new Function('overlay', 'window', 'ts', 'longPress', 'pinch', 'switchPaneByDirection', viewportHelper + TERMINAL_SRC.slice(start, end));
    install({ addEventListener: (_, fn) => { handler = fn; } }, { innerWidth: width },
      { startX: 200, moved: true, direction: 'horizontal', cancelled },
      { timer: null, active: false }, { active: pinching }, switchPaneByDirection);
    handler({ touches: [], changedTouches: [{ clientX: 200 + dx }], preventDefault: vi.fn() });
    if (direction === null) expect(switchPaneByDirection).not.toHaveBeenCalled();
    else expect(switchPaneByDirection).toHaveBeenCalledExactlyOnceWith(direction);
  });

  it('keeps horizontal terminal drags on the terminal route', () => {
    expect(TERMINAL_SRC).not.toContain('SWIPE_THRESHOLD');
    expect(TERMINAL_SRC).not.toContain('VELOCITY_TRIGGER');
    expect(TERMINAL_SRC).not.toContain('swipe-back-indicator');
    expect(TERMINAL_SRC).toContain("ts.direction === 'horizontal'");
  });
});

describe('initial terminal fit', () => {
  it('sends the final fitted dimensions even when the socket opened first', () => {
    const delayedFit = TERMINAL_SRC.slice(
      TERMINAL_SRC.indexOf('// Small delay to ensure DOM is ready for fitting'),
      TERMINAL_SRC.indexOf('// Connect WebSocket'),
    );

    expect(delayedFit.indexOf('fitAddon.fit()')).toBeGreaterThan(-1);
    expect(delayedFit.indexOf('_syncTerminalSize(terminalState.ws, term, true)'))
      .toBeGreaterThan(delayedFit.indexOf('fitAddon.fit()'));
  });

  it('sends the dimensions again after the server confirms the PTY is ready', () => {
    const readyHandler = TERMINAL_SRC.slice(
      TERMINAL_SRC.indexOf("msg.type === 'ready'"),
      TERMINAL_SRC.indexOf('} catch (_err)', TERMINAL_SRC.indexOf("msg.type === 'ready'")),
    );

    expect(readyHandler).toContain('ws._sentCols = null');
    expect(readyHandler).toContain('_syncTerminalSize(ws, term, true)');
  });
});


describe('mobile keyboard viewport', () => {
  it('measures the real terminal edge and input deck, then fits after shell resizing', () => {
    const source = TERMINAL_SRC.slice(TERMINAL_SRC.indexOf('  // The shell follows visualViewport height.'), TERMINAL_SRC.indexOf('  // Store references for cleanup'));
    const listeners = {};
    const viewport = { height: 800, offsetTop: 0, addEventListener: (type, fn) => { listeners[type] = fn; } };
    const controls = { getBoundingClientRect: () => ({ height: 60 }) };
    const container = {
      style: {}, getBoundingClientRect: () => ({ top: 96 }),
      closest: () => ({ querySelector: () => controls }),
    };
    const term = {};
    const fit = vi.fn();
    const sync = vi.fn();
    const frames = [];
    const install = new Function('window', 'termContainer', 'term', 'terminalState', 'fitAddon', '_syncTerminalSize', '_isMobileTerminal', 'requestAnimationFrame', source);
    install({ visualViewport: viewport }, container, term, { term }, { fit }, sync, () => true, fn => frames.push(fn));
    viewport.height = 340;
    viewport.offsetTop = 20;
    listeners.resize();
    expect(container.style.maxHeight).toBe('204px');
    expect(fit).not.toHaveBeenCalled();
    frames.shift()();
    expect(fit).toHaveBeenCalledOnce();
    expect(sync).toHaveBeenCalledOnce();
    viewport.height = 800;
    viewport.offsetTop = 0;
    listeners.resize();
    expect(container.style.maxHeight).toBe('');
  });
});
