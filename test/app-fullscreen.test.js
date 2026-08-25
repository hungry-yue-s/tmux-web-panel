import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const source = readFileSync('public/js/app-fullscreen.js', 'utf8');
const markup = '<!doctype html><html><body>' +
  '<button id="btn-app-fullscreen" data-app-fullscreen aria-pressed="false"></button>' +
  '<button id="sidebar-fullscreen" data-app-fullscreen aria-pressed="false"></button>' +
  '</body></html>';

let dom;

function setupFullscreenApi(options = {}) {
  dom = new JSDOM(markup, { runScripts: 'outside-only' });
  const { document } = dom.window;
  let fullscreenElement = null;

  if (options.keyboard) {
    Object.defineProperty(dom.window.navigator, 'keyboard', {
      configurable: true,
      value: {
        lock: vi.fn(() => Promise.resolve()),
        unlock: vi.fn(),
      },
    });
  }

  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => fullscreenElement,
  });

  document.documentElement.requestFullscreen = vi.fn(() => {
    fullscreenElement = document.documentElement;
    document.dispatchEvent(new dom.window.Event('fullscreenchange'));
    return Promise.resolve();
  });
  document.exitFullscreen = vi.fn(() => {
    fullscreenElement = null;
    document.dispatchEvent(new dom.window.Event('fullscreenchange'));
    return Promise.resolve();
  });

  dom.window.eval(source);
  dom.window.AppFullscreen.init();
  return document;
}

afterEach(() => {
  if (dom) dom.window.close();
  dom = null;
});

describe('global app fullscreen', () => {
  it('enters fullscreen and updates the button state', async () => {
    const document = setupFullscreenApi();
    const button = document.getElementById('btn-app-fullscreen');

    button.click();
    await Promise.resolve();

    expect(document.documentElement.requestFullscreen).toHaveBeenCalledOnce();
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.getAttribute('aria-label')).toBe('退出全屏显示');
    expect(button.classList.contains('is-active')).toBe(true);
    expect(document.getElementById('sidebar-fullscreen').getAttribute('aria-pressed')).toBe('true');
  });

  it('exits fullscreen through the same button', async () => {
    const document = setupFullscreenApi();
    const button = document.getElementById('btn-app-fullscreen');

    button.click();
    await Promise.resolve();
    button.click();
    await Promise.resolve();

    expect(document.exitFullscreen).toHaveBeenCalledOnce();
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.getAttribute('aria-label')).toBe('全屏显示面板');
    expect(button.classList.contains('is-active')).toBe(false);
  });

  it('keeps Escape available to the terminal while globally fullscreen', async () => {
    const document = setupFullscreenApi({ keyboard: true });
    const button = document.getElementById('btn-app-fullscreen');

    await dom.window.AppFullscreen.toggle();

    expect(dom.window.navigator.keyboard.lock).toHaveBeenCalledWith(['Escape']);
    expect(button.title).toBe('退出全屏显示');

    await dom.window.AppFullscreen.toggle();
    expect(dom.window.navigator.keyboard.unlock).toHaveBeenCalled();
  });

  it('disables the control when the browser API is unavailable', () => {
    dom = new JSDOM(markup, { runScripts: 'outside-only' });
    dom.window.eval(source);
    dom.window.AppFullscreen.init();

    const button = dom.window.document.getElementById('btn-app-fullscreen');
    expect(button.disabled).toBe(true);
    expect(button.title).toBe('当前浏览器不支持全屏显示');
  });

  it('uses the macOS shell bridge when browser fullscreen is unavailable', async () => {
    dom = new JSDOM(markup, { runScripts: 'outside-only' });
    const postMessage = vi.fn();
    dom.window.webkit = {
      messageHandlers: {
        tmuxPanelAction: { postMessage },
      },
    };
    dom.window.eval(source);
    dom.window.AppFullscreen.init();

    const button = dom.window.document.getElementById('btn-app-fullscreen');
    expect(button.disabled).toBe(false);

    button.click();
    await Promise.resolve();
    expect(postMessage).toHaveBeenCalledWith({ action: 'toggleFullscreen' });

    dom.window.document.dispatchEvent(new dom.window.CustomEvent(
      'tmux-panel-native-fullscreen',
      { detail: { active: true } },
    ));
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.title).toBe('退出全屏显示');
  });
});
