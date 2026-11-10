import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import xterm from '@xterm/headless';

describe('file modal beside workbench tool tabs', () => {
  it('keeps the modal source and tool draft when a breakpoint hides/reparents the dock', async () => {
    const dom = new JSDOM('<div id="main-layout"><div id="content"><div class="terminal-view"></div></div></div>', { url: 'https://panel.test' });
    const win = dom.window;
    Object.defineProperty(win, 'innerWidth', { configurable: true, value: 1440 });
    const fetch = vi.fn(async (url) => ({ status: 200, json: async () => ({ success: true, data: String(url).includes('/info')
      ? { isDirectory: true, absPath: '/tmp/source', mtimeMs: 1, size: 0 }
      : { absPath: '/tmp/source', parent: '/tmp', entries: [], truncated: false } }) }));
    new Function('window', 'document', 'fetch', 'Auth', readFileSync('plugins/files/client/js/file-preview.js', 'utf8'))(win, win.document, fetch, { headers: () => ({}) });
    const preview = win.FilePreview;
    const frame = win.document.createElement('section');
    const draft = win.document.createElement('textarea'); draft.value = 'unfinished commit'; frame.append(draft);
    const block = { key: 'git1', persistKey: 'git:/tmp/repo', title: 'Git', element: frame, active: true, onClose: vi.fn() };
    try {
      preview.switchViewContext('local', 'view-one'); preview.blockDock.sync([block]);
      await preview.openFile('/tmp/source', '%1', { source: { serverId: 'local', paneId: '%1' } });
      const modal = win.document.querySelector('.fp-overlay:not(.fp-dock)');
      expect(modal).not.toBeNull();
      Object.defineProperty(win, 'innerWidth', { value: 600 }); win.dispatchEvent(new win.Event('resize'));
      preview.blockDock.sync([]);
      expect(modal.isConnected).toBe(true);
      Object.defineProperty(win, 'innerWidth', { value: 1440 }); win.dispatchEvent(new win.Event('resize'));
      preview.blockDock.sync([block]);
      expect(modal.isConnected).toBe(true);
      modal.querySelector('.fp-btn-close').click();
      expect(modal.isConnected).toBe(false);
      expect(block.onClose).not.toHaveBeenCalled();
      expect(draft.value).toBe('unfinished commit');
    } finally { preview.closeDocked(); win.close(); }
  });  it('invalidates an old native file link source after the client loses its verified instance', async () => {
    const dom = new JSDOM('', { url: 'https://panel.test' }); const win = dom.window;
    const fetch = vi.fn();
    new Function('window', readFileSync('plugins/terminal/client/js/link-detect.js', 'utf8'))(win);
    new Function('window', 'document', 'fetch', 'Auth', 'LinkDetect', readFileSync('plugins/files/client/js/file-preview.js', 'utf8'))(win, win.document, fetch, { headers: () => ({}) }, win.LinkDetect);
    const term = new xterm.Terminal({ cols: 80, rows: 24, allowProposedApi: true }); let provider, verified = true;
    const registration = { dispose: vi.fn() };
    term.registerLinkProvider = (value) => { provider = value; return registration; };
    const returned = win.FilePreview.registerLinkProvider(term, '%1', () => '%1', { serverId: 'remote', paneId: '%1', isCurrent: () => verified });
    expect(returned).toBe(registration);
    await new Promise((resolve) => term.write('./src/main.js:12', resolve)); let links;
    provider.provideLinks(1, (value) => { links = value; }); expect(links.length).toBeGreaterThan(0);
    verified = false; links[0].activate(); await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled(); term.dispose(); win.close();
  });

});
