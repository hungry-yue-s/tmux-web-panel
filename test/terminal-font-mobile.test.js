import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const TERMINAL_SRC = readFileSync('public/js/terminal.js', 'utf8');

/**
 * Evaluates just the font-size helper against a minimal fake window. The helper
 * only reads the window dimensions, one container's client size and the user
 * offset, so a full JSDOM per case is needless cost.
 */
function loadSizer({ width, height = 800, offset = 0, containerWidth = null, containerHeight = null }) {
  const container = {
    clientWidth: containerWidth === null ? width : containerWidth,
    clientHeight: containerHeight === null ? height : containerHeight,
  };
  const win = {
    innerWidth: width,
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

  it('still honors the user font offset, with a readable floor', () => {
    expect(loadSizer({ width: 360, offset: 2 })._calcTerminalFontSize(213, 54)).toBe(15);
    expect(loadSizer({ width: 360, offset: -1 })._calcTerminalFontSize(213, 54)).toBe(12);
    // The floor stops A- from making the terminal unreadable again.
    expect(loadSizer({ width: 360, offset: -8 })._calcTerminalFontSize(213, 54)).toBe(11);
    expect(loadSizer({ width: 360, offset: 99 })._calcTerminalFontSize(213, 54)).toBe(22);
  });

  it('keeps the desktop fit-to-pane behavior at 768px and above', () => {
    const win = loadSizer({ width: 1440, height: 900, containerWidth: 1440, containerHeight: 900 });

    // 1440px wide fitting an 80-column pane wants a large size, capped at 16.
    expect(win._calcTerminalFontSize(80, 24)).toBe(16);
    // A very wide pane still scales down on desktop.
    expect(win._calcTerminalFontSize(400, 120)).toBeLessThan(13);
  });

  it('applies the desktop floor, not the mobile floor, on desktop', () => {
    const win = loadSizer({ width: 800, height: 600, containerWidth: 800, containerHeight: 600 });
    expect(win._calcTerminalFontSize(400, 200)).toBeLessThan(11);
    expect(win._calcTerminalFontSize(400, 200)).toBeGreaterThanOrEqual(8);
  });
});

describe('mobile font size constants', () => {
  it('documents a readable base and floor', () => {
    const win = loadSizer({ width: 360 });
    expect(win.MOBILE_BASE_FONT_SIZE).toBeGreaterThanOrEqual(13);
    expect(win.MOBILE_MIN_FONT_SIZE).toBeGreaterThanOrEqual(11);
  });

  it('branches on the same 768px breakpoint the rest of the view uses', () => {
    expect(TERMINAL_SRC).toContain('if (window.innerWidth < 768) {');
  });
});

describe('initial terminal fit', () => {
  it('sends the final fitted dimensions even when the socket opened first', () => {
    const delayedFit = TERMINAL_SRC.slice(
      TERMINAL_SRC.indexOf('// Small delay to ensure DOM is ready for fitting'),
      TERMINAL_SRC.indexOf('// Connect WebSocket'),
    );

    expect(delayedFit.indexOf('fitAddon.fit()')).toBeGreaterThan(-1);
    expect(delayedFit.indexOf('_syncTerminalSize(ws, term, true)'))
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
