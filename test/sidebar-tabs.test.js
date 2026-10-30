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
  if (context) win.FilePreview.switchDockContext(context[0], context[1], context[2] || INSTANCE);
  return { win, doc: win.document, host: win.BlockHost, preview: win.FilePreview, shown };
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
