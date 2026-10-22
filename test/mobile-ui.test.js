import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const source = readFileSync('public/js/mobile-ui.js', 'utf8');
let win;
afterEach(() => win?.close());
function setup({ width = 390, height = 844, landscape = false } = {}) {
  win = new JSDOM('<textarea></textarea><button>菜单</button>', { runScripts: 'outside-only', pretendToBeVisual: true }).window;
  Object.defineProperty(win, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(win, 'innerHeight', { value: height, configurable: true });
  win.matchMedia = () => ({ matches: landscape });
  const viewport = new win.EventTarget();
  viewport.height = height;
  viewport.offsetTop = 0;
  win.visualViewport = viewport;
  win.eval(source);
  return { root: win.document.documentElement, viewport, ui: win.MobileUI };
}

describe('mobile workspace viewport', () => {
  it.each([
    [{ width: 390 }, true],
    [{ width: 1440 }, false],
    [{ width: 844, height: 390, landscape: true }, true],
    [{ width: 844, height: 390 }, false],
  ])('keeps layout detection consistent for %j', (options, expected) => {
    const { root, ui } = setup(options);
    expect(ui.isMobile()).toBe(expected);
    expect(root.classList.contains('mobile-layout')).toBe(expected);
  });

  it('follows the visible keyboard viewport and restores navigation on blur', () => {
    const { root, viewport } = setup();
    win.document.querySelector('textarea').focus();
    viewport.height = 440;
    viewport.offsetTop = 12;
    viewport.dispatchEvent(new win.Event('resize'));
    expect(root.style.getPropertyValue('--mobile-viewport-height')).toBe('440px');
    expect(root.style.getPropertyValue('--mobile-viewport-top')).toBe('12px');
    expect(root.classList.contains('mobile-keyboard-open')).toBe(true);
    win.document.querySelector('button').focus();
    expect(root.classList.contains('mobile-keyboard-open')).toBe(false);
    viewport.height = 844;
    viewport.offsetTop = 0;
    viewport.dispatchEvent(new win.Event('resize'));
    expect(root.style.getPropertyValue('--mobile-viewport-height')).toBe('844px');
  });

  it('keeps host controls available when crossing between phone and desktop layouts', () => {
    const { ui } = setup();
    win.document.body.insertAdjacentHTML('beforeend', '<details class="mobile-server-operations"><summary>操作</summary><div><button>检测</button></div></details>');
    const operations = win.document.querySelector('details');
    Object.defineProperty(win, 'innerWidth', { value: 1440, configurable: true });
    ui.syncViewport();
    expect(operations.open).toBe(true);
    Object.defineProperty(win, 'innerWidth', { value: 390, configurable: true });
    ui.syncViewport();
    expect(operations.open).toBe(false);
    operations.open = true;
    ui.syncViewport();
    expect(operations.open).toBe(true);
  });

  it('does not mistake browser chrome or a desktop text field for a phone keyboard', () => {
    let ctx = setup();
    ctx.viewport.height = 500;
    ctx.viewport.dispatchEvent(new win.Event('resize'));
    expect(ctx.root.classList.contains('mobile-keyboard-open')).toBe(false);
    win.close();
    ctx = setup({ width: 1440 });
    win.document.querySelector('textarea').focus();
    ctx.viewport.height = 400;
    ctx.viewport.dispatchEvent(new win.Event('resize'));
    expect(ctx.root.classList.contains('mobile-keyboard-open')).toBe(false);
  });
});
