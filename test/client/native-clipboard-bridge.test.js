import { repoPath } from '../../lib/paths.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const terminalSource = readFileSync('plugins/terminal/client/js/terminal.js', 'utf8');
const helperSource = terminalSource.slice(
  terminalSource.indexOf('// === Clipboard Helper ==='),
  terminalSource.indexOf('// === Toast Notification ==='),
);
const standaloneSource = readFileSync('plugins/terminal/client/terminal.html', 'utf8');
const webViewSource = readFileSync(
  repoPath('macos/Anymux/Sources/Anymux/PanelWebView.swift'),
  'utf8',
);

let dom;

function setup() {
  dom = new JSDOM('<!doctype html><html><body></body></html>', {
    runScripts: 'outside-only',
  });
  dom.window._showToast = vi.fn();
  dom.window.eval(helperSource);
  return dom.window;
}

afterEach(() => {
  if (dom) dom.window.close();
  dom = null;
});

describe('macOS native clipboard bridge', () => {
  it('uses the native bridge before browser clipboard APIs', () => {
    const window = setup();
    const postMessage = vi.fn();
    const writeText = vi.fn();
    window.webkit = {
      messageHandlers: {
        anymuxClipboard: { postMessage },
      },
    };
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    window._copyToClipboard('selected text');

    expect(postMessage).toHaveBeenCalledWith({ text: 'selected text' });
    expect(writeText).not.toHaveBeenCalled();
    expect(window._showToast).toHaveBeenCalledWith('已复制 13 字符');
  });

  it('uses the bridge of a macOS app from before the rename', () => {
    const window = setup();
    const postMessage = vi.fn();
    window.webkit = { messageHandlers: { tmuxPanelClipboard: { postMessage } } };
    window._copyToClipboard('old app');
    expect(postMessage).toHaveBeenCalledWith({ text: 'old app' });
  });

  it('keeps the standard browser clipboard path unchanged', async () => {
    const window = setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(window, 'isSecureContext', {
      configurable: true,
      value: true,
    });
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    window._copyToClipboard('browser text', { silent: true });
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith('browser text');
  });

  it('registers the same bridge in both terminal entry points and WKWebView', () => {
    expect(standaloneSource).toContain('anymuxClipboard');
    expect(standaloneSource).toContain("nativeHandler.postMessage({ text: String(text) })");
    expect(webViewSource).toContain('clipboardHandlerName = "anymuxClipboard"');
    expect(webViewSource).toContain('NSPasteboard.general');
    expect(webViewSource).toContain('text.utf8.count <= Self.maximumClipboardBytes');
  });
});
