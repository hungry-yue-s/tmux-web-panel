import { describe, it, expect, vi, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';

const INSTANCE = '1873:1700000000';

const previewSource = fs.readFileSync('public/js/file-preview.js', 'utf8');
const hostSource = fs.readFileSync('public/js/block-host.js', 'utf8');

let dom;
afterEach(() => dom?.window.close());

/** The real file preview and BlockHost in a page with a terminal to dock beside. */
function setup({ context = ['local', '@0'], storage = {}, width = 1440, terminal = true } = {}) {
  dom = new JSDOM(
    '<!doctype html><body><div class="ms-app' + (terminal ? ' mode-terminal' : '') + '"><main class="ms-main">'
      + (terminal ? '<div class="terminal-view"></div>' : '') + '</main></div></body>',
    { url: 'https://panel.test/', runScripts: 'outside-only' }
  );
  const win = dom.window;
  Object.defineProperty(win, 'innerWidth', { value: width, configurable: true });
  Object.entries(storage).forEach(([key, value]) => win.localStorage.setItem(key, value));
  win.Api = { activeServerId: () => 'local', nodeUrl: (_id, path) => path };
  win.fetch = vi.fn((url) => {
    const path = new URL(String(url), 'https://panel.test/').searchParams.get('path') || '/tmp';
    const data = String(url).includes('/api/files/info')
      ? { isDirectory: true, absPath: path, mtimeMs: 1, size: 0 }
      : { absPath: path, parent: '/', entries: [], truncated: false };
    return Promise.resolve({ status: 200, json: () => Promise.resolve({ success: true, data }) });
  });
  win.eval(previewSource);
  win.eval(hostSource);
  const shown = [];
  win.BlockHost.register('tool', {
    title: 'Tool',
    icon: 'dock',
    key: (params) => params.name,
    create: (api) => {
      const el = win.document.createElement('div');
      el.className = 'tool-body';
      el.textContent = api.params.name;
      return { el, onShow: () => shown.push(api.params.name) };
    },
  });
  const apis = {};
  const disposed = [];
  win.BlockHost.register('repo', {
    title: 'Repo',
    icon: 'dock',
    perWindow: true,
    key: (params) => params.name,
    create: (api) => {
      const el = win.document.createElement('textarea');
      el.className = 'repo-body';
      apis[api.params.name] = api;
      return { el, dispose: () => disposed.push(api.params.name) };
    },
  });
  if (context) win.FilePreview.switchDockContext(context[0], context[1], context[2] ?? INSTANCE);
  return { win, doc: win.document, host: win.BlockHost, preview: win.FilePreview, shown, apis, disposed };
}

const tabNames = (doc) => [...doc.querySelectorAll('.fp-dock-tab')].map((tab) => tab.textContent);
const activeTab = (doc) => doc.querySelector('.fp-dock-tab-item.active .fp-dock-tab').textContent;

async function dockFile(preview, path) {
  await preview.openFile(path, '%1');
  preview._test.dockCurrent();
}

describe('one sidebar for files and tool blocks', () => {
  it('shows a block as a tab next to file tabs and switches between them', async () => {
    const { doc, host, preview } = setup();
    await dockFile(preview, '/tmp/one.md');
    host.open('tool', { name: 'git' });

    expect(doc.querySelectorAll('.fp-dock')).toHaveLength(1);
    expect(doc.querySelector('.blk-dock')).toBeNull();
    expect(tabNames(doc)).toEqual(['one.md', 'Tool']);
    expect(activeTab(doc)).toBe('Tool');
    const frame = doc.querySelector('.fp-dock-panels > .blk-frame');
    expect(frame.hidden).toBe(false);
    expect(doc.querySelector('.fp-dock-panels > .fp-modal')).toBeNull();
    expect(doc.querySelector('.fp-dock').classList.contains('fp-dock-has-actions')).toBe(true);

    doc.querySelectorAll('.fp-dock-tab')[0].click();
    expect(activeTab(doc)).toBe('one.md');
    expect(doc.querySelector('.fp-dock-panels > .fp-modal')).not.toBeNull();
    // Stays attached while hidden: a browser tab keeps its page, a draft its text.
    expect(frame.isConnected).toBe(true);
    expect(frame.hidden).toBe(true);
    expect(doc.querySelector('.fp-dock').classList.contains('fp-dock-has-actions')).toBe(false);

    doc.querySelectorAll('.fp-dock-tab')[1].click();
    expect(frame.hidden).toBe(false);
    expect(doc.querySelector('.fp-dock-panels > .fp-modal')).toBeNull();
  });

  it('tells a block when it comes to the front', async () => {
    const { doc, host, preview, shown } = setup();
    await dockFile(preview, '/tmp/one.md');
    host.open('tool', { name: 'git' });
    const before = shown.length;
    doc.querySelectorAll('.fp-dock-tab')[0].click();
    expect(shown).toHaveLength(before);
    doc.querySelectorAll('.fp-dock-tab')[1].click();
    expect(shown).toHaveLength(before + 1);
  });

  it('keeps the sidebar while either kind of tab remains', async () => {
    const { doc, host, preview } = setup();
    await dockFile(preview, '/tmp/one.md');
    host.open('tool', { name: 'git' });

    doc.querySelectorAll('.fp-dock-tab-close')[0].click(); // the file
    expect(tabNames(doc)).toEqual(['Tool']);
    expect(doc.querySelector('.fp-dock')).not.toBeNull();

    doc.querySelectorAll('.fp-dock-tab-close')[0].click(); // the block closes through BlockHost
    expect(host.list()).toHaveLength(0);
    expect(doc.querySelector('.fp-dock')).toBeNull();
  });

  it('moves a block out of the strip and back when it floats', async () => {
    const { doc, host, preview } = setup();
    await dockFile(preview, '/tmp/one.md');
    host.open('tool', { name: 'git' });
    const { id } = host.list()[0];

    host.setMode(id, 'float');
    expect(tabNames(doc)).toEqual(['one.md']);
    expect(activeTab(doc)).toBe('one.md');
    const frame = doc.querySelector('.ms-main > .blk-frame.blk-mode-float');
    expect(frame.hidden).toBe(false);
    expect(frame.hasAttribute('data-dock-block')).toBe(false);
    expect(frame.getAttribute('role')).toBe('region');

    host.setMode(id, 'dock');
    expect(tabNames(doc)).toEqual(['one.md', 'Tool']);
    expect(activeTab(doc)).toBe('Tool');
    expect(doc.querySelector('.fp-dock-panels > .blk-frame')).toBe(frame);
  });

  it('leaves block tabs out of the per-window file state', async () => {
    const { win, host, preview } = setup();
    await dockFile(preview, '/tmp/one.md');
    host.open('tool', { name: 'git' });
    const saved = JSON.parse(win.localStorage.getItem(preview._test.dockStateKey('local', '@0', INSTANCE)));
    expect(saved.tabs).toEqual([{ path: '/tmp/one.md', paneId: '%1' }]);
    expect(saved.activePath).toBeNull();
    expect(saved.activeBlock).toBe('tool:git');
  });

  it('keeps blocks across window switches, while files stay with their window', async () => {
    const { doc, host, preview } = setup();
    await dockFile(preview, '/tmp/one.md');
    host.open('tool', { name: 'git' });

    await preview.switchDockContext('local', '@1', INSTANCE);
    expect(tabNames(doc)).toEqual(['Tool']);
    expect(doc.querySelector('.fp-dock-panels > .blk-frame').hidden).toBe(false);

    await preview.switchDockContext('local', '@0', INSTANCE);
    await vi.waitFor(() => expect(tabNames(doc)).toEqual(['one.md', 'Tool']));
    // It was on top when that window's dock was last saved.
    expect(activeTab(doc)).toBe('Tool');
  });

  it('forgets a deleted window without destroying server-scoped tool blocks', async () => {
    const { win, doc, host, preview } = setup();
    await dockFile(preview, '/tmp/deleted.md');
    host.open('tool', { name: 'git' });
    const frame = doc.querySelector('.blk-frame');
    preview.forgetWindow('local', '@0', INSTANCE);
    expect(host.list()).toHaveLength(1);
    expect(win.localStorage.getItem(preview._test.dockStateKey('local', '@0', INSTANCE))).toBeNull();
    await preview.switchDockContext('local', '@1', INSTANCE);
    expect(tabNames(doc)).toEqual(['Tool']);
    expect(doc.querySelector('.fp-dock-panels > .blk-frame')).toBe(frame);
  });

  it('parks docked blocks away from the terminal and brings them back', async () => {
    const { doc, host, preview } = setup();
    host.open('tool', { name: 'git' });
    const frame = doc.querySelector('.fp-dock-panels > .blk-frame');

    await preview.switchDockContext(null, null);
    expect(doc.querySelector('.fp-dock')).toBeNull();
    expect(frame.isConnected).toBe(false);
    expect(host.list()).toHaveLength(1);

    await preview.switchDockContext('local', '@0', INSTANCE);
    expect(tabNames(doc)).toEqual(['Tool']);
    expect(doc.querySelector('.fp-dock-panels > .blk-frame')).toBe(frame);
  });

  it('floats a block opened where no sidebar can exist', () => {
    const { doc, host } = setup({ context: null, terminal: false });
    host.open('tool', { name: 'git' });
    expect(doc.querySelector('.fp-dock')).toBeNull();
    expect(host.list()[0].mode).toBe('float');
    expect(doc.querySelector('.ms-main > .blk-frame.blk-mode-float').hidden).toBe(false);
  });

  it('counts blocks on the restore button and brings the sidebar back for them', async () => {
    const { doc, host, preview } = setup();
    await dockFile(preview, '/tmp/one.md');
    host.open('tool', { name: 'git' });
    preview.blockDock.hide();
    expect(doc.querySelector('.fp-dock')).toBeNull();
    const restore = doc.querySelector('.fp-dock-restore');
    expect(restore.textContent).toContain('2');
    expect(restore.getAttribute('aria-label')).toBe('展开右侧边栏');

    host.open('tool', { name: 'git' }); // asking for it again reopens the sidebar
    expect(doc.querySelector('.fp-dock')).not.toBeNull();
    expect(activeTab(doc)).toBe('Tool');
    expect(doc.querySelector('.fp-dock-restore')).toBeNull();
  });

  it('does not let Esc in a block input hide the sidebar', () => {
    const { win, doc, host } = setup();
    host.open('tool', { name: 'git' });
    const input = doc.createElement('input');
    doc.querySelector('.tool-body').appendChild(input);
    input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(doc.querySelector('.fp-dock')).not.toBeNull();
    doc.querySelector('.tool-body').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(doc.querySelector('.fp-dock')).toBeNull();
  });

  it('opens a block behind nothing: a file modal on top is dismissed', async () => {
    const { doc, host, preview } = setup();
    await preview.openFile('/tmp/modal.md', '%1');
    expect(doc.querySelector('.fp-overlay:not(.fp-side)')).not.toBeNull();
    host.open('tool', { name: 'git' });
    expect(doc.querySelector('.fp-overlay:not(.fp-side)')).toBeNull();
    expect(activeTab(doc)).toBe('Tool');
  });

  it('opens a new file as a modal over a block tab, then returns to the block', async () => {
    const { doc, host, preview } = setup();
    host.open('tool', { name: 'git' });
    await preview.openFile('/tmp/modal.md', '%1');
    expect(doc.querySelector('.fp-overlay:not(.fp-side)')).not.toBeNull();
    expect(tabNames(doc)).toEqual(['Tool']);
    preview.closeModal();
    expect(doc.querySelector('.fp-overlay:not(.fp-side)')).toBeNull();
    expect(activeTab(doc)).toBe('Tool');
    expect(doc.querySelector('.fp-dock-panels > .blk-frame').hidden).toBe(false);
  });
});

describe('blocks bound to a window', () => {
  const windowStoreKey = (windowId, instance = INSTANCE) =>
    'twp_window_blocks_v1:' + encodeURIComponent('local\u0000' + instance + '\u0000' + windowId);
  const saved = (win, windowId) => JSON.parse(win.localStorage.getItem(windowStoreKey(windowId)));
  const workspace = (windowIds, instanceId = INSTANCE) => ({
    provider: 'tmux', complete: true, instanceId,
    sessions: [{ windows: windowIds.map((id) => ({ id })) }],
  });

  it('goes and comes back with its window, keeping what was typed', async () => {
    const { doc, host, preview } = setup();
    host.open('repo', { name: 'one' });
    const frame = doc.querySelector('.fp-dock-panels > .blk-frame');
    frame.querySelector('.repo-body').value = 'half a commit message';

    await preview.switchDockContext('local', '@1', INSTANCE);
    expect(doc.querySelector('.fp-dock')).toBeNull();
    expect(host.list()).toHaveLength(0);
    expect(frame.isConnected).toBe(false);

    await preview.switchDockContext('local', '@0', INSTANCE);
    expect(tabNames(doc)).toEqual(['Repo']);
    expect(doc.querySelector('.fp-dock-panels > .blk-frame')).toBe(frame);
    expect(frame.hidden).toBe(false);
    expect(frame.querySelector('.repo-body').value).toBe('half a commit message');
  });

  it('sits next to that window\'s files, after them, and on top if it was', async () => {
    const { doc, host, preview } = setup();
    await dockFile(preview, '/tmp/zero.md');
    host.open('repo', { name: 'one' });
    await preview.switchDockContext('local', '@1', INSTANCE);
    await dockFile(preview, '/tmp/one.md');
    expect(tabNames(doc)).toEqual(['one.md']);

    await preview.switchDockContext('local', '@0', INSTANCE);
    await vi.waitFor(() => expect(tabNames(doc)).toEqual(['zero.md', 'Repo']));
    expect(activeTab(doc)).toBe('Repo');

    await preview.switchDockContext('local', '@1', INSTANCE);
    await vi.waitFor(() => expect(tabNames(doc)).toEqual(['one.md']));
    expect(activeTab(doc)).toBe('one.md');
  });

  it('keeps a separate block per window for the same repository', async () => {
    const { doc, host, preview } = setup();
    host.open('repo', { name: 'one' });
    const first = doc.querySelector('.fp-dock-panels > .blk-frame');
    await preview.switchDockContext('local', '@1', INSTANCE);

    host.open('repo', { name: 'one' });
    const second = doc.querySelector('.fp-dock-panels > .blk-frame');
    expect(second).not.toBe(first);
    expect(host.list()).toHaveLength(1);

    // Asking again in the same window brings that one back, not a third.
    host.open('repo', { name: 'one' });
    expect(host.list()).toHaveLength(1);
    expect(doc.querySelector('.fp-dock-panels > .blk-frame')).toBe(second);
  });

  it('leaves server-wide blocks in place while the window ones change', async () => {
    const { doc, host, preview } = setup();
    host.open('tool', { name: 'browser' });
    host.open('repo', { name: 'one' });
    expect(tabNames(doc)).toEqual(['Tool', 'Repo']);

    await preview.switchDockContext('local', '@1', INSTANCE);
    expect(tabNames(doc)).toEqual(['Tool']);
    expect(host.list().map((block) => block.kind)).toEqual(['tool']);

    await preview.switchDockContext('local', '@0', INSTANCE);
    expect(tabNames(doc)).toEqual(['Tool', 'Repo']);
  });

  it('hides a floating or maximized one in other windows, and stops counting as visible', async () => {
    const { doc, host, preview, apis } = setup();
    host.open('repo', { name: 'one' }, { mode: 'float' });
    const frame = doc.querySelector('.ms-main > .blk-frame.blk-mode-float');
    expect(apis.one.isVisible()).toBe(true);

    await preview.switchDockContext('local', '@1', INSTANCE);
    expect(frame.hidden).toBe(true);
    expect(apis.one.isVisible()).toBe(false);

    await preview.switchDockContext('local', '@0', INSTANCE);
    expect(frame.hidden).toBe(false);
    expect(apis.one.isVisible()).toBe(true);
  });

  it('is put away on other pages and comes back with the terminal', async () => {
    const { doc, host, preview } = setup();
    host.open('repo', { name: 'one' });
    const frame = doc.querySelector('.fp-dock-panels > .blk-frame');
    await preview.switchDockContext(null, null);
    expect(frame.isConnected).toBe(false);
    expect(host.list()).toHaveLength(0);

    await preview.switchDockContext('local', '@0', INSTANCE);
    expect(doc.querySelector('.fp-dock-panels > .blk-frame')).toBe(frame);
  });

  it('is saved under its own window and only built when that window is visited', async () => {
    const first = setup();
    first.host.open('repo', { name: 'one' });
    expect(saved(first.win, '@0').blocks).toEqual([{ kind: 'repo', params: { name: 'one' }, mode: 'dock', geom: null }]);
    expect(saved(first.win, '@0').active).toBe(0);
    expect(first.win.localStorage.getItem('twp_blocks_v1:local')).toBeNull();
    const storage = { [windowStoreKey('@0')]: first.win.localStorage.getItem(windowStoreKey('@0')) };
    first.win.close();

    const { doc, host, preview, apis } = setup({ context: ['local', '@1'], storage });
    host.render();
    expect(apis.one).toBeUndefined();
    expect(doc.querySelector('.fp-dock')).toBeNull();

    await preview.switchDockContext('local', '@0', INSTANCE);
    expect(apis.one).toBeDefined();
    expect(tabNames(doc)).toEqual(['Repo']);
    expect(activeTab(doc)).toBe('Repo');
  });

  it('keeps a window without a tmux instance id in memory only', async () => {
    const { win, doc, host, preview } = setup({ context: ['local', '@0', ''] });
    host.open('repo', { name: 'one' });
    expect(tabNames(doc)).toEqual(['Repo']);
    expect([...Array(win.localStorage.length).keys()].map((i) => win.localStorage.key(i))
      .filter((key) => key.startsWith('twp_'))).toEqual([]);
    await preview.switchDockContext('local', '@1', '');
    expect(tabNames(doc)).toEqual([]);
    await preview.switchDockContext('local', '@0', '');
    expect(tabNames(doc)).toEqual(['Repo']);
  });

  it('does not bring back a window\'s blocks under a new tmux instance', async () => {
    const first = setup();
    first.host.open('repo', { name: 'one' });
    const storage = { [windowStoreKey('@0')]: first.win.localStorage.getItem(windowStoreKey('@0')) };
    first.win.close();
    const { doc, apis } = setup({ context: ['local', '@0', '9999:1'], storage });
    expect(apis.one).toBeUndefined();
    expect(doc.querySelector('.fp-dock')).toBeNull();
  });

  it('goes away with a window that was deleted, and not with any other', async () => {
    const { win, doc, host, preview, disposed } = setup();
    host.open('repo', { name: 'zero' });
    await preview.switchDockContext('local', '@1', INSTANCE);
    host.open('repo', { name: 'one' });

    preview.forgetWindow('local', '@0', INSTANCE);
    expect(disposed).toEqual(['zero']);
    expect(win.localStorage.getItem(windowStoreKey('@0'))).toBeNull();
    expect(saved(win, '@1').blocks).toHaveLength(1);
    expect(tabNames(doc)).toEqual(['Repo']);

    preview.forgetWindow('local', '@1', INSTANCE);
    expect(disposed).toEqual(['zero', 'one']);
    expect(doc.querySelector('.fp-dock')).toBeNull();
  });

  it('forgets windows only on a complete snapshot, on that server', async () => {
    const stale = windowStoreKey('@7', '1:1');
    const otherServer = 'twp_window_blocks_v1:' + encodeURIComponent('box\u0000' + INSTANCE + '\u0000@0');
    const { win, doc, host, preview, disposed } = setup({ storage: { [stale]: '{}', [otherServer]: '{}' } });
    host.open('repo', { name: 'zero' });
    await preview.switchDockContext('local', '@1', INSTANCE);
    host.open('repo', { name: 'one' });

    preview.reconcileWorkspace('local', { ...workspace(['@1']), complete: false });
    expect(disposed).toEqual([]);
    expect(win.localStorage.getItem(stale)).toBe('{}');

    preview.reconcileWorkspace('local', workspace(['@1']));
    expect(disposed).toEqual(['zero']);
    expect(win.localStorage.getItem(windowStoreKey('@0'))).toBeNull();
    expect(win.localStorage.getItem(stale)).toBeNull();
    expect(win.localStorage.getItem(otherServer)).toBe('{}');
    expect(tabNames(doc)).toEqual(['Repo']);
  });

  it('gives a block saved before this to the first window it is seen in', async () => {
    const storage = {
      'twp_blocks_v1:local': JSON.stringify({
        version: 1,
        active: 0,
        blocks: [
          { kind: 'repo', params: { name: 'one' }, mode: 'dock', geom: null },
          { kind: 'tool', params: { name: 'browser' }, mode: 'dock', geom: null },
        ],
      }),
    };
    const { win, doc, host, preview } = setup({ context: ['local', '@3'], storage });
    host.render();
    await vi.waitFor(() => expect(tabNames(doc)).toEqual(['Repo', 'Tool']));

    expect(saved(win, '@3').blocks.map((block) => block.kind)).toEqual(['repo']);
    expect(saved(win, '@3').active).toBe(0);
    expect(JSON.parse(win.localStorage.getItem('twp_blocks_v1:local')).blocks.map((block) => block.kind)).toEqual(['tool']);

    await preview.switchDockContext('local', '@4', INSTANCE);
    expect(tabNames(doc)).toEqual(['Tool']);
  });

  it('floats when opened away from a terminal, then joins the first window', async () => {
    const { win, doc, host, preview } = setup({ context: null });
    host.open('repo', { name: 'one' });
    expect(host.list()[0].mode).toBe('float');
    expect(saved(win, '@0')).toBeNull();

    await preview.switchDockContext('local', '@0', INSTANCE);
    expect(saved(win, '@0').blocks).toHaveLength(1);
    expect(host.list()).toHaveLength(1);
    const frame = doc.querySelector('.ms-main > .blk-frame.blk-mode-float');
    expect(frame.hidden).toBe(false);

    await preview.switchDockContext('local', '@1', INSTANCE);
    expect(host.list()).toHaveLength(0);
    expect(frame.hidden).toBe(true);
  });

  it('closes for good: not back in that window, and gone from its saved state', async () => {
    const { win, doc, host, preview } = setup();
    host.open('repo', { name: 'one' });
    doc.querySelector('.fp-dock-tab-close').click();
    expect(win.localStorage.getItem(windowStoreKey('@0'))).toBeNull();
    await preview.switchDockContext('local', '@1', INSTANCE);
    await preview.switchDockContext('local', '@0', INSTANCE);
    expect(doc.querySelector('.fp-dock')).toBeNull();
  });
});
