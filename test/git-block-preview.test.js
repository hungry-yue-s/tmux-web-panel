import { describe, it, expect, vi, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';

const INSTANCE = '1873:1700000000';
const PREVIEW = fs.readFileSync('public/js/file-preview.js', 'utf8');
const HOST = fs.readFileSync('public/js/block-host.js', 'utf8');
const BLOCKS = fs.readFileSync('public/js/blocks.js', 'utf8');
const WORKSPACE_BLOCKS = fs.readFileSync('public/js/blocks-workspace.js', 'utf8');

const COMMIT = 'c1c1c1c1c1c1c1c1';
const NOTES_DIFF = 'diff --git a/notes.md b/notes.md\nindex 1..2 100644\n--- a/notes.md\n+++ b/notes.md\n@@ -1,2 +1,2 @@\n-# One\n+# Two\n same\n';
const LOGO_DIFF = 'diff --git a/logo.png b/logo.png\nnew file mode 100644\nindex 0000000..1111111\nBinary files /dev/null and b/logo.png differ\n';
const OLD_DIFF = 'diff --git a/old.txt b/old.txt\ndeleted file mode 100644\nindex 3..0000000\n--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n';
const NEW_DIFF = 'diff --git a/new.txt b/new.txt\nnew file mode 100644\nindex 0000000..4\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+hello\n';

let dom;
afterEach(() => dom?.window.close());

/** The real file preview, BlockHost and Git block, with the git API answered here. */
function setup() {
  dom = new JSDOM(
    '<!doctype html><body><div class="ms-app mode-terminal"><main class="ms-main"><div class="terminal-view"></div></main></div></body>',
    { url: 'https://panel.test/', runScripts: 'outside-only' },
  );
  const win = dom.window;
  const doc = win.document;
  Object.defineProperty(win, 'innerWidth', { value: 1440, configurable: true });
  Object.defineProperty(doc, 'visibilityState', { value: 'visible', configurable: true });
  win.HTMLElement.prototype.scrollIntoView = () => {};
  win.Api ={ activeServerId: () => 'local', nodeUrl: (_id, path) => '/n/x' + path };
  win.Auth = { headers: () => ({}), wsTokenParam: () => 'token=t' };
  win.fetch = vi.fn(() => Promise.reject(new Error('the preview is stubbed')));
  win.eval(PREVIEW);
  win.eval(HOST);
  win.eval(BLOCKS);
  win.TerminalTarget = { serverId: 'local', sessionId: '$0', windowId: '@0' };
  win.state = { currentPane: '%1' };
  win.FilePreview.switchDockContext('local', '@0', INSTANCE);

  const status = {
    root: '/repo', branch: 'main', upstream: null, ahead: 0, behind: 0, detached: false, head: { hash: 'h', subject: 's' },
    files: [
      { path: 'logo.png', staged: true, unstaged: false, index: 'A', worktree: ' ' },
      { path: 'notes.md', staged: false, unstaged: true, index: ' ', worktree: 'M' },
      { path: 'new.txt', staged: false, unstaged: true, untracked: true, index: '?', worktree: '?' },
    ],
  };
  const diffs = { 'logo.png': LOGO_DIFF, 'notes.md': NOTES_DIFF, 'new.txt': NEW_DIFF };
  const get = vi.fn(async (path, query) => {
    if (path === '/api/git/status') return JSON.parse(JSON.stringify(status));
    if (path === '/api/git/diff') return { diff: diffs[query.file] };
    if (path === '/api/git/log') {
      return { rows: [{ graph: '* ', commit: { hash: COMMIT, short: 'c1c1c1c', refs: [], subject: 'second', author: 'T', date: 'now' } }] };
    }
    if (path === '/api/git/show') {
      return {
        diff: COMMIT + '\nT <t@e>\nnow\n\nsecond\n\n' + NOTES_DIFF + LOGO_DIFF + OLD_DIFF,
        files: [
          { path: 'notes.md', from: null, status: 'M', added: 1, removed: 1, binary: false },
          { path: 'logo.png', from: null, status: 'A', added: 0, removed: 0, binary: true },
          { path: 'old.txt', from: null, status: 'D', added: 0, removed: 1, binary: false },
        ],
      };
    }
    if (path === '/api/git/file') return { isText: query.file !== 'logo.png', isImage: query.file === 'logo.png', content: 'text of ' + query.rev, size: 3, tooLarge: false };
    throw new Error('Unexpected ' + path);
  });
  win.Blocks.ui.client = () => ({ get, send: vi.fn(async () => ({})), url: (path) => '/n/x' + path });
  win.eval(WORKSPACE_BLOCKS);
  const renderInto = vi.fn(async (box, source) => {
    box.textContent = 'rendered ' + (source.name || source.path);
    return true;
  });
  win.FilePreview.renderInto = renderInto;
  win.BlockHost.open('git', { path: '/repo' });
  const frame = () => win.BlockHost._test.instances()[0].frame;
  const press = (label, scope = frame()) => {
    const target = [...scope.querySelectorAll('button')].find((b) => b.textContent.trim() === label);
    if (!target) throw new Error('no button ' + label);
    target.click();
    return target;
  };
  const buttonFor = (label, scope = frame()) => [...scope.querySelectorAll('button')].find((b) => b.textContent.trim() === label);
  const fileQueries = () => get.mock.calls.filter(([path]) => path === '/api/git/file').map(([, query]) => query);
  return { win, doc, get, frame, press, buttonFor, renderInto, fileQueries, status };
}

const settled = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => { setTimeout(resolve, 0); }); };

describe('a commit in the Git history', () => {
  async function openCommit(context) {
    await settled();
    context.press('历史');
    await settled();
    context.frame().querySelector('.git-log-row.has-commit').click();
    await settled();
    return [...context.frame().querySelectorAll('.git-commit-file-list .git-file')];
  }
  // The changes view keeps its own buttons with the same names, out of sight.
  const detail = (context) => context.frame().querySelector('.git-log-detail');

  it('lists the files it changed, with what kind of change and how many lines', async () => {
    const context = setup();
    const rows = await openCommit(context);
    expect(rows.map((row) => row.querySelector('.git-badge').textContent)).toEqual(['M', 'A', 'D']);
    expect(rows.map((row) => row.querySelector('.git-file-base').textContent)).toEqual(['notes.md', 'logo.png', 'old.txt']);
    expect(rows.map((row) => row.querySelector('.git-file-stats').textContent)).toEqual(['+1−1', '二进制', '+0−1']);
    expect(context.frame().querySelector('.git-commit-files .git-group-head').textContent).toContain('改动的文件3');
    // Every file's diff is there to begin with, the binary one with nothing in it.
    expect(context.frame().querySelectorAll('.git-commit-diffs .blk-diff-filebox')).toHaveLength(3);
  });

  it('shows one file\'s diff on its own, and all of them again', async () => {
    const context = setup();
    const rows = await openCommit(context);
    rows[2].click();
    const diffs = context.frame().querySelector('.git-commit-diffs');
    expect(rows[2].classList.contains('is-active')).toBe(true);
    expect(diffs.querySelector('.git-commit-file-diff').textContent).toContain('bye');
    expect(diffs.textContent).not.toContain('# Two');

    context.press('全部文件', detail(context));
    expect(rows[2].classList.contains('is-active')).toBe(false);
    expect(diffs.textContent).toContain('# Two');
    expect(diffs.textContent).toContain('bye');
  });

  it('previews a file as the commit left it and as it was before, through the file preview', async () => {
    const context = setup();
    const rows = await openCommit(context);
    rows[0].click();
    context.press('预览', detail(context));
    await settled();

    expect(context.fileQueries().at(-1)).toEqual({ rev: COMMIT, file: 'notes.md', path: '/repo' });
    const [box, source] = context.renderInto.mock.calls.at(-1);
    expect(box.classList.contains('git-preview')).toBe(true);
    expect(source).toMatchObject({
      name: '/repo/notes.md', content: 'text of ' + COMMIT, versioned: true,
      rawUrl: '/n/x/api/git/raw?rev=' + COMMIT + '&file=notes.md&path=%2Frepo&token=t',
    });

    context.press('改动前', detail(context));
    await settled();
    expect(context.fileQueries().at(-1)).toEqual({ rev: COMMIT + '^', file: 'notes.md', path: '/repo' });
    expect(context.renderInto.mock.calls.at(-1)[1].content).toBe('text of ' + COMMIT + '^');
  });

  it('opens a binary file as itself, and only the versions it has can be picked', async () => {
    const context = setup();
    const rows = await openCommit(context);
    rows[1].click();
    await settled();
    expect(context.fileQueries().at(-1)).toMatchObject({ rev: COMMIT, file: 'logo.png' });
    expect(context.buttonFor('改动前', detail(context)).disabled).toBe(true);
    expect(context.buttonFor('改动后', detail(context)).classList.contains('is-active')).toBe(true);

    // Asked for, its diff is there, and says why it is empty.
    context.press('差异', detail(context));
    expect(context.frame().querySelector('.git-commit-file-diff').textContent).toContain('二进制文件');

    rows[2].click();
    context.press('预览', detail(context));
    await settled();
    expect(context.buttonFor('改动后', detail(context)).disabled).toBe(true);
    expect(context.fileQueries().at(-1)).toMatchObject({ rev: COMMIT + '^', file: 'old.txt' });
  });
});

describe('a changed file in the Git block', () => {
  const select = async (context, path, staged) => {
    context.frame().querySelector(`.git-file[data-path="${path}"][data-staged="${staged ? 1 : 0}"]`).click();
    await settled();
  };

  it('previews the file on disk, and the index as it was before', async () => {
    const context = setup();
    await settled();
    await select(context, 'notes.md', false);
    context.press('预览');
    await settled();
    expect(context.renderInto.mock.calls.at(-1)[1]).toEqual({ path: '/repo/notes.md', machine: '/n/x' });

    context.press('改动前');
    await settled();
    expect(context.fileQueries().at(-1)).toEqual({ rev: 'INDEX', file: 'notes.md', path: '/repo' });
  });

  it('previews a staged file from the index, with nothing before a file that is new', async () => {
    const context = setup();
    await settled();
    await select(context, 'logo.png', true);
    // Binary: straight to the file itself.
    expect(context.fileQueries().at(-1)).toMatchObject({ rev: 'INDEX', file: 'logo.png' });
    expect(context.buttonFor('改动前').disabled).toBe(true);
  });

  it('keeps showing files as themselves on the next file, starting at its new version', async () => {
    const context = setup();
    await settled();
    await select(context, 'notes.md', false);
    context.press('预览');
    await settled();
    context.press('改动前');
    await settled();

    await select(context, 'new.txt', false);
    expect(context.buttonFor('预览').classList.contains('is-active')).toBe(true);
    expect(context.buttonFor('改动前').disabled).toBe(true);
    expect(context.renderInto.mock.calls.at(-1)[1]).toEqual({ path: '/repo/new.txt', machine: '/n/x' });
  });

  it('does not draw the preview again on a background refresh that changed nothing', async () => {
    const context = setup();
    await settled();
    await select(context, 'notes.md', false);
    context.press('预览');
    await settled();
    const drawn = context.renderInto.mock.calls.length;

    context.status.branch = 'renamed';
    context.win.dispatchEvent(new context.win.Event('focus'));
    await settled();
    expect(context.get.mock.calls.filter(([path]) => path === '/api/git/status').length).toBeGreaterThan(1);
    expect(context.renderInto.mock.calls.length).toBe(drawn);
  });
});
