import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const source = readFileSync('android/app/src/main/assets/native-client.js', 'utf8');
let win;
afterEach(() => win?.close());
function setup(hash = '#/settings') {
  win = new JSDOM('<main id="ms-view"></main>', {
    url: 'https://panel.example/' + hash, runScripts: 'outside-only', pretendToBeVisual: true,
  }).window;
  const messages = [];
  win.TmuxAndroid = { postMessage: raw => messages.push(JSON.parse(raw)) };
  win.eval(source);
  return messages;
}

describe('Android workspace integration', () => {
  it('provides connection settings after route rerenders without duplicating buttons', async () => {
    const messages = setup();
    const host = win.document.getElementById('ms-view');
    host.innerHTML = '<h1>设置</h1>';
    await new Promise(resolve => win.setTimeout(resolve, 0));
    win.dispatchEvent(new win.HashChangeEvent('hashchange'));
    expect(host.querySelectorAll('#android-client-settings')).toHaveLength(1);
    host.querySelector('button').click();
    expect(messages.at(-1)).toEqual({ type: 'settings' });
  });

  it('closes the foremost overlay before leaving a tmux workspace', () => {
    setup('#/terminal');
    let paletteOpen = true;
    win.CommandPalette = { isOpen: () => paletteOpen, close: () => { paletteOpen = false; } };
    win.FilePreview = { closeModal: vi.fn(() => win.document.querySelector('.fp-overlay').remove()) };
    win.document.body.insertAdjacentHTML('beforeend', '<div class="fp-overlay"></div>');
    expect(win.__tmuxAndroidBack()).toBe(true);
    expect(win.FilePreview.closeModal).not.toHaveBeenCalled();
    expect(win.__tmuxAndroidBack()).toBe(true);
    expect(win.FilePreview.closeModal).toHaveBeenCalledOnce();
    expect(win.__tmuxAndroidBack()).toBe(false);
  });

  it('adapts existing text and PNG clipboard actions to the native channel', () => {
    const messages = setup();
    win.webkit.messageHandlers.tmuxPanelClipboard.postMessage({ text: 'echo hello' });
    win.webkit.messageHandlers.tmuxPanelClipboard.postMessage({ pngBase64: 'YWJj' });
    expect(messages.slice(-2)).toEqual([
      { type: 'clipboard', text: 'echo hello' }, { type: 'clipboard', pngBase64: 'YWJj' },
    ]);
  });

  it('restores the native client theme and reports later manual theme changes', () => {
    const messages = setup();
    win.__tmuxAndroidInstalled = false;
    win.__tmuxAndroidTheme = 'oyster';
    win.Theme = { apply: vi.fn(id => { win.document.documentElement.dataset.theme = id; }) };
    win.eval(source);
    expect(win.Theme.apply).toHaveBeenCalledWith('oyster');
    expect(messages.at(-1)).toMatchObject({ type: 'theme', id: 'oyster' });
    win.document.documentElement.dataset.theme = 'deep-current';
    win.document.dispatchEvent(new win.Event('tmux-theme-change'));
    expect(messages.at(-1)).toMatchObject({ type: 'theme', id: 'deep-current' });
  });

  it('exports renderer-owned Blob downloads through the Android document picker', async () => {
    const messages = setup();
    win.fetch = vi.fn(async () => ({ ok: true, blob: async () => new win.Blob(['hello'], { type: 'text/plain' }) }));
    const link = win.document.createElement('a');
    link.href = 'blob:https://panel.example/export'; link.download = 'notes.txt';
    win.document.body.append(link);
    const click = new win.MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(messages).toContainEqual({ type: 'download', name: 'notes.txt', mime: 'text/plain', data: 'aGVsbG8=' }));
  });

  it('rejects oversized in-memory exports with a visible explanation', async () => {
    const messages = setup();
    win.fetch = vi.fn(async () => ({ ok: true, blob: async () => ({ size: 17 * 1024 * 1024 }) }));
    const link = win.document.createElement('a');
    link.href = 'blob:https://panel.example/large'; link.download = 'large.zip';
    win.document.body.append(link); link.click();
    await vi.waitFor(() => expect(messages).toContainEqual({ type: 'notice', text: '文件超过 16 MB，请在浏览器中下载' }));
    expect(messages.some(message => message.type === 'download')).toBe(false);
  });

  it('streams same-origin HTTP downloads without copying them into JavaScript memory', () => {
    const messages = setup();
    win.fetch = vi.fn();
    const link = win.document.createElement('a');
    link.href = '/api/files/download?path=large.zip'; link.download = 'large.zip';
    win.document.body.append(link); link.click();
    expect(win.fetch).not.toHaveBeenCalled();
    expect(messages.at(-1)).toEqual({ type: 'downloadUrl', url: link.href, name: 'large.zip' });
  });
});
