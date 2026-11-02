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

describe('the dock taking its final space before the terminal measures', () => {
  const saved = (extra) => JSON.stringify({
    version: 1,
    tabs: [{ path: '/tmp/one.md', paneId: '%1' }, { path: '/tmp/two.md', paneId: '%1' }],
    activePath: '/tmp/one.md',
    width: 500,
    ...extra,
  });

  /** A page opening window @0 with this saved state, its file requests held back. */
  function restoring(state, { width = 1440, release = true } = {}) {
    const first = setup({ context: null, width });
    const key = first.preview._test.dockStateKey('local', '@0', INSTANCE);
    first.win.close();
    const { win, doc, preview } = setup({ context: null, width, storage: { [key]: state } });
    const realFetch = win.fetch;
    const held = [];
    let open = release;
    win.fetch = vi.fn((url) => new Promise((resolve) => {
      const go = () => realFetch(url).then(resolve);
      if (open) go(); else held.push(go);
    }));
    const finished = preview.switchDockContext('local', '@0', INSTANCE);
    const dock = () => doc.querySelector('.fp-dock');
    // From here on requests go through, including ones the restore has yet to make.
    const flushHeld = () => {
      open = true;
      while (held.length) held.shift()();
    };
    return { win, doc, preview, finished, dock, flushHeld };
  }

  it('holds the saved width at once, before any file has loaded', async () => {
    const { win, dock, finished, flushHeld } = restoring(saved(), { release: false });
    expect(dock()).not.toBeNull();
    expect(dock().style.width).toBe('500px');
    expect(dock().classList.contains('fp-restoring')).toBe(true);
    expect(win.document.body.classList.contains('fp-side-open')).toBe(true);

    flushHeld();
    await finished;
    expect(dock().style.width).toBe('500px');
    expect(dock().classList.contains('fp-restoring')).toBe(false);
  });

  it('keeps that width from start to finish, whatever the tabs do', async () => {
    const { dock, finished, doc } = restoring(saved(), { release: true });
    const widths = [dock().style.width];
    await finished;
    widths.push(dock().style.width);
    expect(new Set(widths)).toEqual(new Set(['500px']));
    expect(tabNames(doc)).toEqual(['one.md', 'two.md']);
  });

  it('holds to the 70% limit like the dock itself does', () => {
    const { dock } = restoring(saved({ width: 5000 }), { release: false });
    expect(dock().style.width).toBe(`${Math.floor(1440 * 0.7)}px`);
  });

  it('holds the default width when none was saved', () => {
    const { dock } = restoring(saved({ width: 0 }), { release: false });
    expect(parseFloat(dock().style.width)).toBeGreaterThanOrEqual(320);
  });

  it('takes no space at any moment for a dock saved as hidden, however many tabs it has', async () => {
    const { win, doc, dock, finished, flushHeld } = restoring(saved({ hidden: true }), { release: false });
    const inLayout = () => !!doc.querySelector('.ms-main .fp-dock');
    const opened = () => win.document.body.classList.contains('fp-side-open');
    expect(inLayout()).toBe(false);
    expect(opened()).toBe(false);

    // Tab by tab, as the two files arrive: this is where it used to appear.
    const seen = [];
    const watch = new win.MutationObserver(() => seen.push([inLayout(), opened()]));
    watch.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    flushHeld();
    await finished;
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    watch.disconnect();

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter(([layout, side]) => layout || side)).toEqual([]);
    expect(inLayout()).toBe(false);
    expect(opened()).toBe(false);
    expect(doc.querySelector('.fp-dock-restore').textContent).toContain('2');
    expect(dock()).toBeNull();
  });

  it('opens with all its tabs when a hidden dock is brought back', async () => {
    const { doc, finished } = restoring(saved({ hidden: true }));
    await finished;
    doc.querySelector('.fp-dock-restore').click();
    expect(doc.querySelector('.ms-main .fp-dock')).not.toBeNull();
    expect(tabNames(doc)).toEqual(['one.md', 'two.md']);
    expect(doc.body.classList.contains('fp-side-open')).toBe(true);
  });

  it('takes no space on a narrow window', () => {
    const { dock, win } = restoring(saved(), { width: 800, release: false });
    expect(dock()).toBeNull();
    expect(win.document.body.classList.contains('fp-side-open')).toBe(false);
  });

  it('gives the space back when none of the files can be opened any more', async () => {
    const first = setup({ context: null });
    const key = first.preview._test.dockStateKey('local', '@0', INSTANCE);
    first.win.close();
    const { win, doc, preview } = setup({ context: null, storage: { [key]: saved() } });
    win.fetch = vi.fn(() => Promise.resolve({ status: 404, json: () => Promise.resolve({ success: false, error: 'gone' }) }));
    const finished = preview.switchDockContext('local', '@0', INSTANCE);
    expect(doc.querySelector('.fp-dock')).not.toBeNull();
    await finished;
    expect(doc.querySelector('.fp-dock')).toBeNull();
    expect(win.document.body.classList.contains('fp-side-open')).toBe(false);
  });

  it('takes no space for a window it has already left', async () => {
    const { win, doc, preview, finished, flushHeld } = restoring(saved(), { release: false });
    const leaving = preview.switchDockContext('local', '@1', INSTANCE);
    expect(doc.querySelector('.fp-dock')).toBeNull();
    expect(win.document.body.classList.contains('fp-side-open')).toBe(false);
    flushHeld();
    await Promise.all([finished, leaving]);
    expect(doc.querySelector('.fp-dock')).toBeNull();
  });

  it('forgets a hidden restore when the window changes halfway', async () => {
    const { win, doc, preview, finished, flushHeld } = restoring(saved({ hidden: true }), { release: false });
    await preview.switchDockContext('local', '@1', INSTANCE);
    flushHeld();
    await finished;
    // A dock in the next window shows up as usual.
    await dockFile(preview, '/tmp/next.md');
    expect(doc.querySelector('.ms-main .fp-dock')).not.toBeNull();
    expect(win.document.body.classList.contains('fp-side-open')).toBe(true);
  });
});

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

  describe('giving way to a block that is already what this one would become', () => {
    it('goes, and brings that one up with what was typed in it', () => {
      const { doc, host, apis, disposed } = setup();
      host.open('repo', { name: 'one' });
      const first = doc.querySelector('.fp-dock-panels > .blk-frame');
      first.querySelector('.repo-body').value = 'half a commit message';
      host.open('repo', { name: 'two' });

      expect(apis.two.yieldToTwin({ name: 'one' })).toBe(true);

      expect(disposed).toEqual(['two']);
      expect(host._test.instances().map((instance) => instance.key)).toEqual(['repo:one']);
      expect(first.hidden).toBe(false);
      expect(first.querySelector('.repo-body').value).toBe('half a commit message');
      expect(saved(dom.window, '@0').blocks).toHaveLength(1);
    });

    it('stays when nothing here is that', () => {
      const { host, apis, disposed } = setup();
      host.open('repo', { name: 'one' });
      expect(apis.one.yieldToTwin({ name: 'two' })).toBe(false);
      expect(apis.one.yieldToTwin({ name: 'one' })).toBe(false);
      expect(disposed).toEqual([]);
      expect(host.list()).toHaveLength(1);
    });

    it('does not count the same repository in another window', async () => {
      const { host, preview, apis, disposed } = setup();
      host.open('repo', { name: 'one' });
      await preview.switchDockContext('local', '@1', INSTANCE);
      host.open('repo', { name: 'two' });
      expect(apis.two.yieldToTwin({ name: 'one' })).toBe(false);
      expect(disposed).toEqual([]);
    });

    it('takes nothing to the front when it was not on screen', () => {
      const { doc, host, apis } = setup();
      host.open('repo', { name: 'one' });
      const one = doc.querySelector('.fp-dock-panels > .blk-frame');
      host.open('repo', { name: 'two' });
      host.open('repo', { name: 'three' });
      const front = [...doc.querySelectorAll('.fp-dock-panels > .blk-frame')].find((frame) => !frame.hidden);
      expect(front).not.toBe(one);

      expect(apis.two.yieldToTwin({ name: 'one' })).toBe(true);

      expect(front.hidden).toBe(false);
      expect(one.hidden).toBe(true);
    });
  });

  describe('the real Git block, with focus moving between repositories', () => {
    const BLOCKS = fs.readFileSync('public/js/blocks.js', 'utf8');
    const WORKSPACE_BLOCKS = fs.readFileSync('public/js/blocks-workspace.js', 'utf8');
    const staged = (root) => ({
      root, branch: 'main', files: [{ path: 'a.txt', staged: true, unstaged: false, index: 'M', worktree: ' ' }],
      detached: false, head: { hash: 'abc', subject: 'x' },
    });
    const settled = () => new Promise((resolve) => { setTimeout(resolve, 0); });

    function gitSetup() {
      const context = setup();
      const { win, doc, host } = context;
      win.TerminalTarget = { serverId: 'local', sessionId: '$0', windowId: '@0' };
      win.state = { currentPane: '%1' };
      win.eval(BLOCKS);
      const focus = { pane: '%1' };
      win._resolveFocusedPaneId = () => Promise.resolve(focus.pane);
      const where = { '%1': '/repo/a', '%2': '/repo/b' };
      const posts = [];
      const statusFor = (query) => {
        const root = query.paneId ? where[query.paneId] : query.path;
        if (!root) return Promise.reject(new Error('not_a_git_repository'));
        return Promise.resolve(staged(root));
      };
      win.Blocks.ui.client = () => ({
        get: (path, query) => (path === '/api/git/status' ? statusFor(query) : Promise.resolve({ diff: '', files: [] })),
        send: (method, path, body) => {
          posts.push({ path, body });
          return Promise.resolve({ hash: 'def', subject: body.message });
        },
      });
      Object.defineProperty(doc, 'visibilityState', { value: 'visible', configurable: true });
      win.eval(WORKSPACE_BLOCKS);
      const repos = () => host._test.instances().filter((instance) => instance.windowKey?.endsWith(win.TerminalTarget.windowId)).map((instance) => instance.key);
      const shown = () => [...doc.querySelectorAll('.fp-dock-panels > .blk-frame')].find((frame) => !frame.hidden);
      const open = async () => {
        win.Blocks.openGit();
        await settled();
        await settled();
      };
      return { ...context, focus, where, posts, repos, shown, open };
    }

    it('gives each repository its block, and brings the first back with its draft', async () => {
      const { focus, repos, shown, open } = gitSetup();
      await open();
      const first = shown();
      first.querySelector('.git-message').value = 'half a commit message';

      focus.pane = '%2';
      await open();
      expect(repos()).toEqual(['git:/repo/a', 'git:/repo/b']);
      expect(shown()).not.toBe(first);

      focus.pane = '%1';
      await open();
      expect(repos()).toEqual(['git:/repo/a', 'git:/repo/b']);
      expect(shown()).toBe(first);
      expect(first.querySelector('.git-message').value).toBe('half a commit message');
    });

    it('still commits the first repository from its own block after focus moved away', async () => {
      const { focus, posts, shown, open } = gitSetup();
      await open();
      const first = shown();
      first.querySelector('.git-message').value = 'for the first repository';

      focus.pane = '%2';
      await open();
      first.querySelector('.git-commit-btn').click();
      await settled();

      expect(posts).toHaveLength(1);
      expect(posts[0].body).toMatchObject({ path: '/repo/a', message: 'for the first repository' });
      expect(posts[0].body.paneId).toBeUndefined();
    });

    it('shows that a pane is outside any repository, and leaves the block it had alone', async () => {
      const { focus, where, repos, shown, open } = gitSetup();
      await open();
      const first = shown();
      first.querySelector('.git-message').value = 'kept';

      delete where['%1'];
      await open();

      expect(repos()).toEqual(['git:/repo/a', 'git:pane:%1']);
      expect(shown()).not.toBe(first);
      expect(shown().textContent).toContain('这里不是 Git 仓库');
      expect(first.querySelector('.git-message').value).toBe('kept');
      void focus;
    });

    it('merges into the repository\'s block when a pane outside one moves into it', async () => {
      const { where, repos, shown, open, win } = gitSetup();
      await open();
      const first = shown();
      first.querySelector('.git-message').value = 'kept';

      delete where['%1'];
      await open();
      expect(repos()).toEqual(['git:/repo/a', 'git:pane:%1']);

      // cd back: the waiting block finds the repository on its next look.
      where['%1'] = '/repo/a';
      win.dispatchEvent(new win.Event('focus'));
      await settled();
      await settled();

      expect(repos()).toEqual(['git:/repo/a']);
      expect(shown()).toBe(first);
      expect(first.querySelector('.git-message').value).toBe('kept');
    });

    it('keeps a block per window: the same repository elsewhere is a separate one', async () => {
      const { preview, repos, shown, open, win } = gitSetup();
      await open();
      const first = shown();
      await preview.switchDockContext('local', '@1', INSTANCE);
      win.TerminalTarget.windowId = '@1';
      await open();
      expect(repos()).toEqual(['git:/repo/a']);
      expect(shown()).not.toBe(first);
    });
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

describe('tabs in the order the user puts them', () => {
  const dockKey = (preview) => preview._test.dockStateKey('local', '@0', INSTANCE);
  const windowBlocks = (win) => JSON.parse(win.localStorage.getItem(
    'twp_window_blocks_v1:' + encodeURIComponent('local\u0000' + INSTANCE + '\u0000@0'),
  ));
  const item = (doc, name) => [...doc.querySelectorAll('.fp-dock-tab-item')]
    .find((node) => node.querySelector('.fp-dock-tab-label').textContent === name);

  /** Drags one tab onto another, to its left half or its right. */
  function drag(win, from, to, side) {
    const doc = win.document;
    const data = { types: [], setData(type, value) { this.types.push(type); this[type] = value; } };
    const fire = (node, type, x) => {
      const event = new win.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: data });
      // jsdom lays nothing out: every tab is a zero-width box at 0.
      Object.defineProperty(event, 'clientX', { value: x });
      node.dispatchEvent(event);
      return event;
    };
    const source = item(doc, from);
    const target = item(doc, to);
    const x = side === 'after' ? 1 : -1;
    fire(source, 'dragstart', 0);
    const over = fire(target, 'dragover', x);
    const marked = target.classList.contains(side === 'after' ? 'fp-drop-after' : 'fp-drop-before');
    fire(target, 'drop', x);
    fire(source, 'dragend', 0);
    return { data, over, marked };
  }

  it('puts a file tab where it is dropped, and saves that order', async () => {
    const { win, doc, preview } = setup();
    for (const name of ['a.md', 'b.md', 'c.md']) await dockFile(preview, '/tmp/' + name);

    const { data, over, marked } = drag(win, 'c.md', 'a.md', 'before');
    expect(over.defaultPrevented).toBe(true);
    expect(marked).toBe(true);
    expect(tabNames(doc)).toEqual(['c.md', 'a.md', 'b.md']);
    expect(doc.querySelector('.fp-drop-before, .fp-drop-after, .fp-dragging')).toBeNull();

    drag(win, 'c.md', 'b.md', 'after');
    expect(tabNames(doc)).toEqual(['a.md', 'b.md', 'c.md']);
    const saved = JSON.parse(win.localStorage.getItem(dockKey(preview)));
    expect(saved.tabs.map((tab) => tab.path)).toEqual(['/tmp/a.md', '/tmp/b.md', '/tmp/c.md']);
    expect(saved.order).toEqual(['file:/tmp/a.md', 'file:/tmp/b.md', 'file:/tmp/c.md']);
    // Its own type, never text: dropped on the terminal, a tab is not typed into it.
    expect(data.types).toEqual(['application/x-tmux-panel-tab']);
  });

  it('moves with Alt+Shift and the arrow keys, keeping focus on the tab', async () => {
    const { win, doc, preview } = setup();
    for (const name of ['a.md', 'b.md']) await dockFile(preview, '/tmp/' + name);
    const tab = item(doc, 'b.md').querySelector('.fp-dock-tab');
    tab.focus();
    tab.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, shiftKey: true, bubbles: true }));
    expect(tabNames(doc)).toEqual(['b.md', 'a.md']);
    expect(doc.activeElement.textContent).toBe('b.md');
    // At the end of the strip, there is nowhere further to go.
    doc.activeElement.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, shiftKey: true, bubbles: true }));
    expect(tabNames(doc)).toEqual(['b.md', 'a.md']);
  });

  it('does nothing for a drop that is not a tab, or a tab dropped on itself', async () => {
    const { win, doc, preview } = setup();
    for (const name of ['a.md', 'b.md']) await dockFile(preview, '/tmp/' + name);
    const target = item(doc, 'a.md');
    const over = new win.Event('dragover', { bubbles: true, cancelable: true });
    target.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(false);
    target.dispatchEvent(new win.Event('drop', { bubbles: true, cancelable: true }));
    drag(win, 'a.md', 'a.md', 'after');
    expect(tabNames(doc)).toEqual(['a.md', 'b.md']);
  });

  it('puts blocks among the files, and keeps blocks in that order themselves', async () => {
    const { win, doc, host, preview, apis } = setup();
    await dockFile(preview, '/tmp/a.md');
    host.open('repo', { name: 'one' });
    apis.one.setTitle('One');
    host.open('repo', { name: 'two' });
    apis.two.setTitle('Two');
    expect(tabNames(doc)).toEqual(['a.md', 'One', 'Two']);

    drag(win, 'Two', 'a.md', 'before');
    expect(tabNames(doc)).toEqual(['Two', 'a.md', 'One']);
    expect(windowBlocks(win).blocks.map((block) => block.params.name)).toEqual(['two', 'one']);
    expect(JSON.parse(win.localStorage.getItem(dockKey(preview))).order)
      .toEqual(['block:repo:two', 'file:/tmp/a.md', 'block:repo:one']);
  });

  it('comes back in that order with its window', async () => {
    const { win, doc, host, preview, apis } = setup();
    for (const name of ['a.md', 'b.md']) await dockFile(preview, '/tmp/' + name);
    host.open('repo', { name: 'one' });
    apis.one.setTitle('One');
    drag(win, 'One', 'a.md', 'before');
    drag(win, 'b.md', 'a.md', 'before');
    expect(tabNames(doc)).toEqual(['One', 'b.md', 'a.md']);

    await preview.switchDockContext('local', '@1', INSTANCE);
    await preview.switchDockContext('local', '@0', INSTANCE);
    await vi.waitFor(() => expect(tabNames(doc)).toEqual(['One', 'b.md', 'a.md']));
  });

  it('gives each tab an icon for what it shows', async () => {
    const { win, doc, host, preview } = setup();
    // The icons are the blocks' own, as on the page.
    win.eval(fs.readFileSync('public/js/blocks.js', 'utf8'));
    win.fetch = vi.fn((url) => {
      const path = new URL(String(url), 'https://panel.test/').searchParams.get('path') || '/tmp';
      const kind = /\.png$/.test(path) ? { isImage: true } : /\./.test(path) ? { isText: true } : { isDirectory: true };
      const data = String(url).includes('/api/files/info')
        ? { absPath: path, mtimeMs: 1, size: 3, ...kind }
        : String(url).includes('/api/files/content')
          ? { content: 'a,b\n1,2\n', language: null }
          : { absPath: path, parent: '/', entries: [], truncated: false };
      return Promise.resolve({ status: 200, json: () => Promise.resolve({ success: true, data }) });
    });
    for (const path of ['/tmp/pic.png', '/tmp/parts.csv', '/tmp/main.ts', '/tmp/folder']) await dockFile(preview, path);
    host.open('repo', { name: 'one' });

    const items = [...doc.querySelectorAll('.fp-dock-tab-item')];
    expect(items.map((node) => node.getAttribute('data-kind'))).toEqual(['image', 'table', 'code', 'folder', 'dock']);
    expect(items.every((node) => node.querySelector('.fp-dock-tab svg'))).toBe(true);
    expect(tabNames(doc)).toEqual(['pic.png', 'parts.csv', 'main.ts', 'folder', 'Repo']);
  });

  it('knows a file by its name before the server has said what it is', () => {
    const { preview } = setup();
    const kind = (path) => preview._test.tabKind({ path });
    expect(['/r/a.md', '/r/b.pdf', '/r/c.ipynb', '/r/d.zip', '/r/e.html', '/r/f.patch', '/r/g.sqlite', '/r/h.xlsx', '/r/i.py', '/r/j.mov', '/r/k'].map(kind))
      .toEqual(['markdown', 'document', 'notebook', 'archive', 'browser', 'changes', 'database', 'table', 'code', 'video', 'file']);
    // What the server said wins over the name.
    expect(preview._test.tabKind({ path: '/r/logo', currentFile: { isImage: true } })).toBe('image');
    expect(preview._test.tabKind({ path: '/r/src', modeDir: true })).toBe('folder');
  });
});