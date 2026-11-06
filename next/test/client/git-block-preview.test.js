import { describe, it, expect, vi, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';

const INSTANCE = '1873:1700000000';
const PREVIEW = fs.readFileSync('plugins/files/client/js/file-preview.js', 'utf8');
const HOST = fs.readFileSync('plugins/files/client/js/block-host.js', 'utf8');
const BLOCKS = fs.readFileSync('plugins/files/client/js/blocks.js', 'utf8');
const WORKSPACE_BLOCKS = fs.readFileSync('plugins/files/client/js/blocks-workspace.js', 'utf8');

const COMMIT = 'c1c1c1c1c1c1c1c1';
const NOTES_DIFF = 'diff --git a/notes.md b/notes.md\nindex 1..2 100644\n--- a/notes.md\n+++ b/notes.md\n@@ -1,2 +1,2 @@\n-# One\n+# Two\n same\n';
const LOGO_DIFF = 'diff --git a/logo.png b/logo.png\nnew file mode 100644\nindex 0000000..1111111\nBinary files /dev/null and b/logo.png differ\n';
const OLD_DIFF = 'diff --git a/old.txt b/old.txt\ndeleted file mode 100644\nindex 3..0000000\n--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n';
const NEW_DIFF = 'diff --git a/new.txt b/new.txt\nnew file mode 100644\nindex 0000000..4\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+hello\n';

let dom;
afterEach(() => dom?.window.close());

/** The real file preview, BlockHost and Git block, with the git API answered here. */
function setup(answers = {}) {
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
  // A path listed here fails with that error until it is taken out again.
  const fail = {};
  const get = vi.fn(async (path, query) => {
    if (fail[path]) throw fail[path];
    if (answers[path]) return answers[path](query);
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
  return { win, doc, get, frame, press, buttonFor, renderInto, fileQueries, status, fail };
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

describe('a large commit in the Git history', () => {
  const HEADER = COMMIT + '\nT <t@e>\nnow\n\nbig one\n';
  const text = (name, n = 2) => `diff --git a/${name} b/${name}\nindex 1..2 100644\n--- a/${name}\n+++ b/${name}\n@@ -1,${n} +1,${n} @@\n`
    + Array.from({ length: n }, (_, i) => `-old ${i}\n+new ${name} ${i}\n`).join('');
  const file = (path, added, removed, extra = {}) => ({ path, from: null, status: 'M', added, removed, binary: false, ...extra });

  /** /show-file answers held until let go, counting how many wait at once. */
  function heldFiles() {
    const held = [];
    let waiting = 0;
    let most = 0;
    const answer = (query) => new Promise((resolve) => {
      waiting += 1;
      most = Math.max(most, waiting);
      held.push({ file: query.file, query, go: () => { waiting -= 1; resolve({ diff: text(query.file) }); } });
    });
    return { held, answer, most: () => most, releaseAll: async () => { while (held.some((h) => !h.done)) { held.filter((h) => !h.done).forEach((h) => { h.done = true; h.go(); }); await settled(); } } };
  }

  async function openCommit(context) {
    await settled();
    context.press('历史');
    await settled();
    context.frame().querySelector('.git-log-row.has-commit').click();
    await settled();
  }
  const detail = (context) => context.frame().querySelector('.git-log-detail');
  const sections = (context) => [...detail(context).querySelectorAll('.git-lazy-file')];
  const sectionFor = (context, path) => sections(context).find((s) => s.querySelector('.blk-diff-filename').textContent === path);

  it('lists its files at once and loads each file\'s diff on its own, a few at a time', async () => {
    const files = heldFiles();
    const small = ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'];
    const context = setup({
      '/api/git/show': () => ({
        diff: HEADER, diffOmitted: true,
        files: [...small.map((p) => file(p, 2, 2)), file('huge.js', 3000, 0), file('logo.png', 0, 0, { binary: true })],
      }),
      '/api/git/show-file': files.answer,
    });
    await openCommit(context);

    expect(detail(context).querySelector('.git-commit-card h3').textContent).toBe('big one');
    expect(sections(context)).toHaveLength(7);
    expect(files.held.map((h) => h.file)).toEqual(['a.js', 'b.js', 'c.js']);
    await files.releaseAll();
    expect(files.most()).toBe(3);
    expect(files.held.map((h) => h.file).sort()).toEqual(small);
    expect(files.held[0].query).toMatchObject({ commit: COMMIT, path: '/repo' });
    expect(sectionFor(context, 'a.js').querySelectorAll('.blk-line')).toHaveLength(4);

    // Not loaded unless asked: a file with a great many changed lines, and a binary one.
    expect(sectionFor(context, 'logo.png').textContent).toContain('二进制文件');
    const ask = sectionFor(context, 'huge.js').querySelector('button.git-lazy-note');
    expect(ask.textContent).toBe('改动较多（+3000 −0），点击加载');
    ask.click();
    await settled();
    expect(files.held.at(-1).file).toBe('huge.js');
  });

  it('reuses a diff it already has when a file is picked on its own, and asks only once otherwise', async () => {
    const files = heldFiles();
    const context = setup({
      '/api/git/show': () => ({ diff: HEADER, diffOmitted: true, files: [file('a.js', 2, 2), file('huge.js', 3000, 0)] }),
      '/api/git/show-file': files.answer,
    });
    await openCommit(context);
    await files.releaseAll();
    const asked = () => files.held.map((h) => h.file);
    expect(asked()).toEqual(['a.js']);

    const rows = [...detail(context).querySelectorAll('.git-commit-file-list .git-file')];
    rows[0].click();
    await settled();
    expect(asked()).toEqual(['a.js']);
    expect(detail(context).querySelector('.git-commit-file-diff').textContent).toContain('new a.js 0');

    rows[1].click();
    await files.releaseAll();
    context.press('全部文件', detail(context));
    rows[1].click();
    await settled();
    expect(asked()).toEqual(['a.js', 'huge.js']);
  });

  it('shows the commit picked last, whatever order the answers come in', async () => {
    const answers = {};
    const context = setup({
      '/api/git/log': () => ({ rows: ['first', 'second'].map((subject, i) => ({ graph: '* ', commit: { hash: 'ab' + i + 'cdef0', short: 'ab' + i, refs: [], subject, author: 'T', date: 'now' } })) }),
      '/api/git/show': (query) => new Promise((resolve) => { answers[query.commit] = resolve; }),
    });
    await settled();
    context.press('历史');
    await settled();
    const commits = [...context.frame().querySelectorAll('.git-log-row.has-commit')];
    commits[0].click();
    commits[1].click();
    answers.ab1cdef0({ diff: 'ab1cdef0\nT <t@e>\nnow\n\nsecond\n', files: [] });
    await settled();
    answers.ab0cdef0({ diff: 'ab0cdef0\nT <t@e>\nnow\n\nfirst\n', files: [] });
    await settled();
    expect(detail(context).querySelector('.git-commit-card h3').textContent).toBe('second');
  });

  it('lists the first 300 files, and the rest when asked', async () => {
    const many = Array.from({ length: 350 }, (_, i) => file(`f${i}.txt`, 1, 0));
    const context = setup({ '/api/git/show': () => ({ diff: HEADER, diffOmitted: true, files: many }) });
    await openCommit(context);
    const rows = () => detail(context).querySelectorAll('.git-commit-file-list .git-file').length;
    expect(rows()).toBe(300);
    context.press('显示其余 50 个文件', detail(context));
    expect(rows()).toBe(350);
  });
});

describe('a Git refresh that fails', () => {
  const failure = () => Object.assign(new Error('Network request failed'), { code: 'NETWORK_ERROR' });
  const note = (context) => context.frame().querySelector('.git-refresh-failed');
  const refresh = (context) => context.frame().querySelector('[aria-label="刷新"]').click();
  const backgroundRefresh = (context) => context.win.dispatchEvent(new context.win.Event('focus'));
  const select = async (context, path, staged) => {
    context.frame().querySelector(`.git-file[data-path="${path}"][data-staged="${staged ? 1 : 0}"]`).click();
    await settled();
  };

  it('leaves the changes and the diff on screen, says so, and clears that once one works', async () => {
    const context = setup();
    await settled();
    await select(context, 'notes.md', false);
    const diffLines = () => context.frame().querySelectorAll('.git-diff-scroll .blk-line').length;
    expect(diffLines()).toBeGreaterThan(0);
    expect(note(context).hidden).toBe(true);

    context.fail['/api/git/status'] = failure();
    backgroundRefresh(context);
    await settled();
    expect(context.frame().querySelectorAll('.git-file')).toHaveLength(3);
    expect(diffLines()).toBeGreaterThan(0);
    expect(context.frame().querySelector('.git-state').hidden).toBe(true);
    expect(note(context).hidden).toBe(false);
    expect(note(context).title).toContain('Network request failed');

    delete context.fail['/api/git/status'];
    backgroundRefresh(context);
    await settled();
    expect(note(context).hidden).toBe(true);
  });

  it('leaves the diff on screen when only its refresh fails', async () => {
    const context = setup();
    await settled();
    await select(context, 'notes.md', false);
    context.fail['/api/git/diff'] = failure();
    context.status.branch = 'changed';
    backgroundRefresh(context);
    await settled();
    expect(context.frame().querySelector('.git-diff-scroll').textContent).toContain('# Two');
    expect(note(context).hidden).toBe(false);
  });

  it('still says what went wrong when there was nothing to keep', async () => {
    const context = setup({ '/api/git/status': () => Promise.reject(failure()) });
    await settled();
    const state = context.frame().querySelector('.git-state');
    expect(state.hidden).toBe(false);
    expect(state.textContent).toContain('Network request failed');
    expect(note(context).hidden).toBe(true);
  });

  it('keeps the history and the commit open in it, through a refresh that changed nothing and one that failed', async () => {
    const context = setup();
    await settled();
    context.press('历史');
    await settled();
    context.frame().querySelector('.git-log-row.has-commit').click();
    await settled();
    const card = () => context.frame().querySelector('.git-log-detail .git-commit-card');
    const log = context.frame().querySelector('.git-log');
    expect(card()).not.toBeNull();

    refresh(context);
    await settled();
    expect(context.frame().querySelector('.git-log')).toBe(log);
    expect(card()).not.toBeNull();

    context.fail['/api/git/log'] = failure();
    refresh(context);
    await settled();
    expect(context.frame().querySelector('.git-log')).toBe(log);
    expect(card()).not.toBeNull();
    expect(note(context).hidden).toBe(false);
  });

  it('keeps the commit open when the history it is in has changed, as a relative date does', async () => {
    let date = 'now';
    const context = setup({
      '/api/git/log': () => ({ rows: [{ graph: '* ', commit: { hash: COMMIT, short: 'c1c1c1c', refs: [], subject: 'second', author: 'T', date } }] }),
    });
    await settled();
    context.press('历史');
    await settled();
    context.frame().querySelector('.git-log-row.has-commit').click();
    await settled();
    const shows = () => context.get.mock.calls.filter(([path]) => path === '/api/git/show').length;
    const detail = context.frame().querySelector('.git-log-detail');
    expect(shows()).toBe(1);

    date = 'a minute ago';
    context.frame().querySelector('[aria-label="刷新"]').click();
    await settled();
    // The list is new; the open commit is the same, not read again.
    expect(context.frame().querySelector('.git-log-row').textContent).toContain('a minute ago');
    expect(context.frame().querySelector('.git-log-detail')).toBe(detail);
    expect(detail.querySelector('.git-commit-card h3').textContent).toBe('second');
    expect(context.frame().querySelector('.git-log-row.is-active')).not.toBeNull();
    expect(shows()).toBe(1);
  });
});

describe('Git reads asked for more than once', () => {
  /** /api/git/status answers held until let go. */
  function heldStatus(context) {
    const held = [];
    return {
      held,
      answer: () => new Promise((resolve) => { held.push(() => resolve(JSON.parse(JSON.stringify(context.status)))); }),
      release: async () => { while (held.length) held.shift()(); await settled(); },
    };
  }
  const statusReads = (context) => context.get.mock.calls.filter(([path]) => path === '/api/git/status').length;

  it('asks once while a refresh is under way, however many ask', async () => {
    const answers = {};
    const context = setup(answers);
    // The first read answers at once; from here on, they are held.
    await settled();
    const status = heldStatus(context);
    answers['/api/git/status'] = () => status.answer();
    const before = statusReads(context);
    context.frame().querySelector('[aria-label="刷新"]').click();
    context.frame().querySelector('[aria-label="刷新"]').click();
    context.win.dispatchEvent(new context.win.Event('focus'));
    await settled();
    expect(statusReads(context) - before).toBe(1);
    await status.release();
  });

  it('asks again after a write, rather than take an answer from before it', async () => {
    const answers = {};
    const context = setup(answers);
    await settled();
    const status = heldStatus(context);
    answers['/api/git/status'] = () => status.answer();
    context.win.dispatchEvent(new context.win.Event('focus'));
    await settled();
    const before = statusReads(context);
    expect(status.held).toHaveLength(1);

    // Staging finishes while that read is still out.
    context.frame().querySelector('.git-file[data-path="notes.md"] [aria-label="暂存"]').click();
    await settled();
    expect(statusReads(context)).toBe(before);
    await status.release();
    expect(statusReads(context)).toBe(before + 1);
    await status.release();
  });

  it('shows the diff of the file picked last, whatever order the answers come in', async () => {
    const answers = {};
    const context = setup({
      '/api/git/diff': (query) => new Promise((resolve) => { answers[query.file] = resolve; }),
    });
    await settled();
    context.frame().querySelector('.git-file[data-path="notes.md"]').click();
    context.frame().querySelector('.git-file[data-path="new.txt"]').click();
    answers['new.txt']({ diff: NEW_DIFF });
    await settled();
    answers['notes.md']({ diff: NOTES_DIFF });
    await settled();
    const shown = context.frame().querySelector('.git-diff-title strong').textContent;
    expect(shown).toBe('new.txt');
  });
});