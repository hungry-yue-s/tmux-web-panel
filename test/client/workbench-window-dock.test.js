import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const INSTANCE = '19:20';
const source = path => readFileSync(path, 'utf8');
const windows = [];
afterEach(() => windows.splice(0).forEach(w => w.close()));

function setup({ activeServer = 'remote' } = {}) {
  const dom = new JSDOM('<!doctype html><body><div class="ms-app mode-terminal"><main class="ms-main"><div class="wb-stage"></div></main></div></body>', {
    url: 'https://panel.test/', runScripts: 'outside-only',
  });
  const w = dom.window;
  windows.push(w);
  Object.defineProperty(w, 'innerWidth', { value: 1440 });
  let context = { onTerminal: true, serverId: 'remote', instanceId: INSTANCE, sessionId: '$2', windowId: '@6', paneId: '%7', viewId: 'local-view-one', key: 'one' };
  w.Api = { activeServerId: () => activeServer, nodeUrl: (id, path) => '/n/' + id + path };
  w.Blocks = { ui: { currentContext: () => context } };
  w.fetch = vi.fn(async url => {
    const path = new URL(url, w.location.href).searchParams.get('path');
    return { status: 200, json: async () => ({ success: true, data: String(url).includes('/info')
      ? { isDirectory: true, absPath: path, mtimeMs: 1, size: 0 }
      : { absPath: path, parent: '/', entries: [], truncated: false } }) };
  });
  w.eval(source('plugins/files/client/js/file-preview.js'));
  w.eval(source('plugins/ui/client/js/block-host.js'));
  for (const kind of ['git', 'browser']) {
    w.BlockHost.register(kind, {
      title: kind, perWindow: kind === 'git', key: params => params.name,
      create(api) {
        const el = w.document.createElement('textarea');
        el.textContent = api.params.name;
        return { el };
      },
    });
  }
  const change = async next => {
    context = { ...context, ...next };
    w.dispatchEvent(new w.CustomEvent('terminal-context-changed', { detail: context }));
    await vi.waitFor(() => expect(w.FilePreview.blockDock.context()).toBe(context.serverId + '\u0000' + context.instanceId + '\u0000' + context.windowId));
    await w.FilePreview.restoreDocked();
  };
  return { w, change, setContext: next => { context = { ...context, ...next }; } };
}
const labels = w => [...w.document.querySelectorAll('.fp-dock-tab-label')].map(el => el.textContent);
const dockKey = windowId => 'tmux_file_preview_dock_v4:' + encodeURIComponent('remote\u000019:20\u0000' + windowId);
const gitKey = windowId => 'anymux_window_blocks_v1:' + encodeURIComponent('remote\u000019:20\u0000' + windowId);
const workspace = (revision, sessions) => ({ provider: 'tmux', complete: true, instanceId: INSTANCE, revision, sessions });
async function dockFile(w, path, source) {
  await w.FilePreview.openFile(path, '%7', source ? { source } : undefined);
  expect(w.FilePreview._test.dockCurrent()).toBe(true);
}

describe('native tmux window sidebar context', () => {
  it('restores each real window after prefix switching while a browser follows its server', async () => {
    const { w, change } = setup();
    await w.FilePreview.switchDockContext('remote', '@6', INSTANCE);
    await dockFile(w, '/one');
    const git = w.BlockHost.open('git', { name: 'first' });
    const browser = w.BlockHost.open('browser', { name: 'shared' });
    const browserBody = w.document.querySelector('[data-block-id="' + browser.id + '"] textarea');
    browserBody.value = 'retained browser state';
    expect(w.localStorage.getItem(dockKey('@6'))).not.toBeNull();
    expect(w.localStorage.getItem(gitKey('@6'))).not.toBeNull();

    await change({ windowId: '@7', paneId: '%8', key: 'two' });
    expect(labels(w)).toEqual(['browser']);
    expect(w.BlockHost.list().map(block => block.id)).toEqual([browser.id]);
    await dockFile(w, '/two');
    w.BlockHost.open('git', { name: 'second' });

    await change({ windowId: '@6', paneId: '%9', viewId: 'another-local-view', key: 'three' });
    expect(labels(w)).toEqual(['one', 'git', 'browser']);
    expect(w.BlockHost.list().map(block => block.id)).toEqual([git.id, browser.id]);
    expect(browserBody.value).toBe('retained browser state');
    expect([...Array(w.localStorage.length)].map((_, i) => w.localStorage.key(i))
      .filter(key => key.startsWith('tmux_file_preview_view_dock_v1:') || key.startsWith('anymux_view_blocks_v1:'))).toEqual([]);
  });

  it('opens tools and files on the unified terminal server when the legacy active server lags', async () => {
    const { w } = setup({ activeServer: 'old-server' });
    await w.FilePreview.switchDockContext('remote', '@6', INSTANCE);
    const git = w.BlockHost.open('git', { name: 'current' });
    expect(git.serverId).toBe('remote');
    await dockFile(w, '/current');
    expect(w.fetch.mock.calls.every(([url]) => String(url).startsWith('/n/remote/'))).toBe(true);
    expect(w.localStorage.getItem(gitKey('@6'))).not.toBeNull();
  });

  it('keeps an opened file bound to its source server and pane across window restores', async () => {
    const { w } = setup();
    await w.FilePreview.switchDockContext('remote', '@6', INSTANCE);
    await dockFile(w, '/bound', { serverId: 'origin', paneId: '%71' });
    await w.FilePreview.switchDockContext('remote', '@7', INSTANCE);
    w.fetch.mockClear();
    await w.FilePreview.switchDockContext('remote', '@6', INSTANCE);
    await w.FilePreview._test.refreshCurrent(true);
    expect(w.fetch.mock.calls.length).toBeGreaterThan(0);
    expect(w.fetch.mock.calls.every(([url]) => String(url).startsWith('/n/origin/'))).toBe(true);
    expect(w.fetch.mock.calls.filter(([url]) => String(url).includes('/info'))
      .every(([url]) => new URL(url, w.location.href).searchParams.get('paneId') === '%71')).toBe(true);
  });

  it('does not clear file or Git state from incomplete or delayed workspace snapshots', async () => {
    const { w } = setup();
    await w.FilePreview.switchDockContext('remote', '@6', INSTANCE);
    await dockFile(w, '/retained');
    w.BlockHost.open('git', { name: 'retained' });
    const fileState = w.localStorage.getItem(dockKey('@6'));
    const gitState = w.localStorage.getItem(gitKey('@6'));
    const legacyFile = 'tmux_file_preview_view_dock_v1:' + encodeURIComponent('remote\u0000local-view\u0000v1');
    const legacyGit = 'anymux_view_blocks_v1:' + encodeURIComponent('remote\u0000local-view\u0000v1');
    w.localStorage.setItem(legacyFile, 'legacy file');
    w.localStorage.setItem(legacyGit, 'legacy git');
    const snapshots = [
      { ...workspace(1, []), complete: false },
      workspace(2, [{ id: '$2', windows: [{ id: '@6' }] }]),
      workspace(1, []),
      workspace(3, [{ id: '$2', windowsComplete: false }]),
      { ...workspace(4, []), instanceId: 'older:instance' },
      workspace(5, [{ id: '$2', windows: [{ id: '@5' }] }]),
    ];
    for (const snapshot of snapshots) {
      expect(() => w.FilePreview.reconcileWorkspace('remote', snapshot)).not.toThrow();
      expect(w.localStorage.getItem(dockKey('@6'))).toBe(fileState);
      expect(w.localStorage.getItem(gitKey('@6'))).toBe(gitState);
      expect(labels(w)).toEqual(['retained', 'git']);
      expect(w.localStorage.getItem(legacyFile)).toBe('legacy file');
      expect(w.localStorage.getItem(legacyGit)).toBe('legacy git');
    }
  });

  it('retains the current dock while native focus is temporarily unconfirmed', async () => {
    const { w } = setup();
    await w.FilePreview.switchDockContext('remote', '@6', INSTANCE);
    await dockFile(w, '/retained');
    const panel = w.document.querySelector('.fp-dock');
    w.dispatchEvent(new w.CustomEvent('terminal-context-changed', {
      detail: { onTerminal: true, serverId: 'remote', windowId: null, instanceId: null, paneId: null },
    }));
    expect(w.document.querySelector('.fp-dock')).toBe(panel);
    expect(w.FilePreview.blockDock.context()).toBe('remote\u000019:20\u0000@6');
  });

  it('does not let an older tree delete a visited window even while the current window is present', async () => {
    const { w, setContext } = setup();
    await w.FilePreview.switchDockContext('remote', '@7', INSTANCE);
    setContext({ windowId: '@7' });
    await dockFile(w, '/hidden');
    const git = w.BlockHost.open('git', { name: 'hidden' });
    await w.FilePreview.switchDockContext('remote', '@6', INSTANCE);
    setContext({ windowId: '@6' });
    const fileState = w.localStorage.getItem(dockKey('@7'));
    const gitState = w.localStorage.getItem(gitKey('@7'));
    w.FilePreview.reconcileWorkspace('remote', workspace(2, [{ windows: [{ id: '@6' }, { id: '@7' }] }]));
    w.FilePreview.reconcileWorkspace('remote', workspace(1, [{ windows: [{ id: '@6' }] }]));
    expect(w.localStorage.getItem(dockKey('@7'))).toBe(fileState);
    expect(w.localStorage.getItem(gitKey('@7'))).toBe(gitState);
    setContext({ windowId: '@7' });
    await w.FilePreview.switchDockContext('remote', '@7', INSTANCE);
    expect(labels(w)).toEqual(['hidden', 'git']);
    expect(w.BlockHost.list()[0].id).toBe(git.id);
  });
});
