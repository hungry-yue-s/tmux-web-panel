import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtemp, writeFile, readFile, rm, stat, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFilesRouter, createPathGuard } from '../../lib/api/files.js';
import {
  createGitRouter, parseStatus, parseLineChanges, parseLog, fallbackCommitMessage, parseCommitFiles, blobSpec,
} from '../../lib/api/git.js';
import { createSqliteRouter, quoteIdent } from '../../lib/api/sqlite.js';
import { createOpenRouter, createNotebookRouter } from '../../lib/api/open.js';
import { IS_WINDOWS, toPosixPath } from '../../lib/msys.js';

// Paths in the API are the ones panes show: MSYS paths on Windows.
const apiPath = (native) => (IS_WINDOWS ? toPosixPath(native) : native);

let dir;
let app;
let events;

beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'anymux-blocks-')));
  const roots = [apiPath(dir)];
  const pathGuard = createPathGuard(roots);
  events = [];
  app = express();
  app.use(express.json());
  app.use('/api/files', createFilesRouter(roots));
  app.use('/api/git', createGitRouter({ pathGuard, generateMessage: async () => null }));
  app.use('/api/sqlite', createSqliteRouter({ pathGuard }));
  app.use('/api/notebook', createNotebookRouter({ pathGuard, run: async () => ({ ok: true }) }));
  app.use('/api/open', createOpenRouter({ pathGuard, broadcast: (event) => events.push(event) }));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('git parsers', () => {
  it('parses porcelain status with branch tracking, renames and untracked files', () => {
    const out = '## main...origin/main [ahead 2, behind 1]\0M  a.js\0 M b.js\0R  new.js\0old.js\0?? c.txt\0';
    const status = parseStatus(out);
    expect(status).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1 });
    expect(status.files.map((f) => [f.path, f.staged, f.unstaged])).toEqual([
      ['a.js', true, false], ['b.js', false, true], ['new.js', true, false], ['c.txt', false, true],
    ]);
    expect(status.files[2].from).toBe('old.js');
    expect(status.files[3].untracked).toBe(true);
  });

  it('turns -U0 hunks into added, modified and deleted line ranges', () => {
    const diff = '@@ -0,0 +1,2 @@\n+a\n+b\n@@ -5 +7 @@\n-x\n+y\n@@ -9,2 +10,0 @@\n-p\n-q\n';
    expect(parseLineChanges(diff)).toEqual([
      { type: 'added', start: 1, end: 2 },
      { type: 'modified', start: 7, end: 7 },
      { type: 'deleted', start: 10, end: 10 },
    ]);
  });

  it('splits graph prefixes from commit records', () => {
    const rows = parseLog('* \x1fabc\x1fab\x1fMe\x1f2 days ago\x1fHEAD -> main, tag: v1\x1fsubject\n|\\\n');
    expect(rows[0].graph).toBe('* ');
    expect(rows[0].commit).toMatchObject({ short: 'ab', refs: ['HEAD -> main', 'tag: v1'], subject: 'subject' });
    expect(rows[1]).toEqual({ graph: '|\\', commit: null });
  });

  it('keeps every parent of a merge and distinguishes roots from older records', () => {
    const record = (hash, parents) => `* \x1f${hash}\x1f${hash}\x1fMe\x1fnow\x1f\x1fsubject\x1f${parents}`;
    const rows = parseLog(record('merge', 'one two three') + '\n' + record('root', ''));
    expect(rows.map((r) => r.commit.parents)).toEqual([['one', 'two', 'three'], []]);
  });

  it('pairs a commit\'s file statuses with their line counts', () => {
    const names = 'M\0a.js\0R087\0old name.md\0new name.md\0A\0logo.png\0';
    const stats = '3\t1\ta.js\0' + '2\t2\t\0old name.md\0new name.md\0' + '-\t-\tlogo.png\0';
    expect(parseCommitFiles(names, stats)).toEqual([
      { path: 'a.js', from: null, status: 'M', added: 3, removed: 1, binary: false },
      { path: 'new name.md', from: 'old name.md', status: 'R', added: 2, removed: 2, binary: false },
      { path: 'logo.png', from: null, status: 'A', added: 0, removed: 0, binary: true },
    ]);
    expect(parseCommitFiles('', '')).toEqual([]);
  });

  it('names a file in the index, HEAD or a commit, and nothing else', () => {
    expect(blobSpec('INDEX', 'docs/a b.md')).toBe(':docs/a b.md');
    expect(blobSpec('HEAD^', 'a.md')).toBe('HEAD^:a.md');
    expect(blobSpec('abc1234', 'a.md')).toBe('abc1234:a.md');
    for (const [rev, file] of [['HEAD', ''], ['HEAD', '../x'], ['HEAD', 'a/../../x'], ['HEAD', '/x'], ['HEAD', 'a\nb'], ['HEAD~1', 'a'], ['main', 'a'], ['', 'a']]) {
      expect(() => blobSpec(rev, file), `${rev} ${file}`).toThrow();
    }
  });

  it('summarises staged files when no agent writes the message', () => {
    expect(fallbackCommitMessage('A\tsrc/a.js\nA\tsrc/b.js\n')).toBe('chore: add a.js, b.js');
    expect(fallbackCommitMessage('M\ta\nD\tb\nM\tc\nM\td\n')).toBe('chore: update a, b, c and 1 more');
  });
});

describe('git block API', () => {
  let repo;
  beforeAll(async () => {
    repo = join(dir, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@e', ...args]);
    await writeFile(join(repo, 'a.txt'), 'one\ntwo\nthree\n');
    git('add', '.');
    git('commit', '-q', '-m', 'first');
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'T']);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 't@e']);
  });

  it('stages selected lines through a patch, commits and undoes the commit', async () => {
    const path = apiPath(repo);
    await writeFile(join(repo, 'a.txt'), 'one\nTWO\nthree\nfour\n');
    let res = await request(app).get('/api/git/status').query({ path });
    expect(res.body.data.files).toMatchObject([{ path: 'a.txt', staged: false, unstaged: true }]);

    res = await request(app).get('/api/git/diff').query({ path, file: 'a.txt' });
    const diff = res.body.data.diff;
    // Stage only the added "four" line: keep its '+', turn the other change into context.
    const lines = diff.split('\n');
    const at = lines.findIndex((l) => l.startsWith('@@'));
    const body = lines.slice(at + 1).filter(Boolean).map((l) => {
      if (l === '+four') return l;
      if (l.startsWith('+')) return null;
      if (l.startsWith('-')) return ' ' + l.slice(1);
      return l;
    }).filter((l) => l !== null);
    const patch = lines.slice(0, at + 1).join('\n') + '\n' + body.join('\n') + '\n';
    res = await request(app).post('/api/git/apply').send({ path, patch, cached: true });
    expect(res.body.success).toBe(true);
    const staged = execFileSync('git', ['-C', repo, 'diff', '--cached'], { encoding: 'utf8' });
    expect(staged).toContain('+four');
    expect(staged).not.toContain('+TWO');

    res = await request(app).post('/api/git/commit-message').send({ path });
    expect(res.body.data).toEqual({ message: 'chore: update a.txt', source: 'summary' });

    res = await request(app).post('/api/git/commit').send({ path, message: 'add four' });
    expect(res.body.data.subject).toBe('add four');

    res = await request(app).get('/api/git/log').query({ path });
    expect(res.body.data.rows.filter((r) => r.commit).map((r) => r.commit.subject)).toEqual(['add four', 'first']);
    const commits = res.body.data.rows.filter((r) => r.commit).map((r) => r.commit);
    expect(commits[0].parents).toEqual([commits[1].hash]);
    expect(commits[1].parents).toEqual([]);

    res = await request(app).get('/api/git/line-changes').query({ path: path + '/a.txt' });
    expect(res.body.data.changes).toEqual([{ type: 'modified', start: 2, end: 2 }]);

    res = await request(app).post('/api/git/undo-commit').send({ path });
    expect(res.body.data.message).toBe('add four');
    res = await request(app).get('/api/git/status').query({ path });
    expect(res.body.data.files[0]).toMatchObject({ path: 'a.txt', staged: true, unstaged: true });
  });

  describe('a commit\'s files and their versions', () => {
    const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    let history;
    let path;
    beforeAll(async () => {
      history = join(dir, 'history');
      path = apiPath(history);
      execFileSync('git', ['init', '-q', '-b', 'main', history]);
      const git = (...args) => execFileSync('git', ['-C', history, '-c', 'user.name=T', '-c', 'user.email=t@e', ...args], { encoding: 'utf8' });
      await writeFile(join(history, 'notes.md'), '# One\n\n- [ ] task\n');
      await writeFile(join(history, 'old name.txt'), 'kept\nas it was\nhere\n');
      await writeFile(join(history, 'gone.txt'), 'bye\n');
      git('add', '.');
      git('commit', '-q', '-m', 'first');
      await writeFile(join(history, 'notes.md'), '# Two\n\n- [x] task\n');
      await writeFile(join(history, 'logo.png'), PNG);
      git('mv', 'old name.txt', 'new name.txt');
      git('rm', '-q', 'gone.txt');
      git('add', '.');
      git('commit', '-q', '-m', 'second');
      // A merge brings in a file from a branch.
      git('checkout', '-q', '-b', 'side', 'HEAD~1');
      await writeFile(join(history, 'side.txt'), 'from the side\n');
      git('add', '.');
      git('commit', '-q', '-m', 'side');
      git('checkout', '-q', 'main');
      git('merge', '-q', '--no-ff', '-m', 'merge side', 'side');
      await writeFile(join(history, 'notes.md'), '# Three\n');
      git('add', 'notes.md');
    });
    const hashOf = (subject) => execFileSync('git', ['-C', history, 'log', '--all', '--format=%H %s'], { encoding: 'utf8' })
      .split('\n').find((line) => line.endsWith(' ' + subject)).split(' ')[0];

    it('lists the files a commit changed, with renames, deletions and binary files', async () => {
      const res = await request(app).get('/api/git/show').query({ path, commit: hashOf('second') });
      const byPath = Object.fromEntries(res.body.data.files.map((f) => [f.path, f]));
      expect(byPath['notes.md']).toMatchObject({ status: 'M', added: 2, removed: 2, binary: false });
      expect(byPath['logo.png']).toMatchObject({ status: 'A', binary: true });
      expect(byPath['gone.txt']).toMatchObject({ status: 'D', added: 0, removed: 1 });
      expect(byPath['new name.txt']).toMatchObject({ status: 'R', from: 'old name.txt', added: 0, removed: 0 });
      expect(res.body.data.diff).toContain('diff --git a/notes.md b/notes.md');
    });

    it('shows a merge against its first parent, with its files', async () => {
      const res = await request(app).get('/api/git/show').query({ path, commit: hashOf('merge side') });
      expect(res.body.data.files).toEqual([{ path: 'side.txt', from: null, status: 'A', added: 1, removed: 0, binary: false }]);
      expect(res.body.data.diff).toContain('+from the side');
    });

    it('reads a text file as a commit, its parent and the index have it', async () => {
      const second = hashOf('second');
      let res = await request(app).get('/api/git/file').query({ path, rev: second, file: 'notes.md' });
      expect(res.body.data).toMatchObject({ isMarkdown: true, isText: true, content: '# Two\n\n- [x] task\n', tooLarge: false });
      res = await request(app).get('/api/git/file').query({ path, rev: second + '^', file: 'notes.md' });
      expect(res.body.data.content).toBe('# One\n\n- [ ] task\n');
      res = await request(app).get('/api/git/file').query({ path, rev: 'INDEX', file: 'notes.md' });
      expect(res.body.data.content).toBe('# Three\n');
      res = await request(app).get('/api/git/file').query({ path, rev: 'HEAD', file: 'new name.txt' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data.content).toBe('kept\nas it was\nhere\n');
    });

    it('describes a binary file without its content, and serves its bytes as they were', async () => {
      const second = hashOf('second');
      let res = await request(app).get('/api/git/file').query({ path, rev: second, file: 'logo.png' });
      expect(res.body.data).toMatchObject({ isImage: true, isText: false, size: PNG.length });
      expect(res.body.data.content).toBeUndefined();
      res = await request(app).get('/api/git/raw').query({ path, rev: second, file: 'logo.png' })
        .buffer(true).parse((r, done) => { const parts = []; r.on('data', (c) => parts.push(c)); r.on('end', () => done(null, Buffer.concat(parts))); });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(Buffer.compare(res.body, PNG)).toBe(0);
    });

    it('leaves a large commit\'s diff out, to be asked for file by file', async () => {
      const git = (...args) => execFileSync('git', ['-C', history, '-c', 'user.name=T', '-c', 'user.email=t@e', ...args], { encoding: 'utf8' });
      const big = Array.from({ length: 9000 }, (_, i) => `line ${i} ${'x'.repeat(30)}`).join('\n') + '\n';
      await writeFile(join(history, 'big.txt'), big);
      await writeFile(join(history, 'small.txt'), 'small\n');
      git('add', 'big.txt', 'small.txt');
      // Only these: notes.md stays staged for the other tests.
      git('commit', '-q', '-m', 'large one', '--', 'big.txt', 'small.txt');
      const large = hashOf('large one');

      let res = await request(app).get('/api/git/show').query({ path, commit: large });
      expect(res.body.data.diffOmitted).toBe(true);
      expect(res.body.data.diff).not.toContain('diff --git');
      expect(res.body.data.diff).toContain('large one');
      expect(res.body.data.files.map((f) => [f.path, f.added])).toEqual([['big.txt', 9000], ['small.txt', 1]]);

      res = await request(app).get('/api/git/show-file').query({ path, commit: large, file: 'small.txt' });
      expect(res.body.data.diff).toContain('diff --git a/small.txt b/small.txt');
      expect(res.body.data.diff).toContain('+small');
      expect(res.body.data.diff).not.toContain('big.txt');
    });

    it('gives one file of a commit, a renamed one under both its names', async () => {
      const second = hashOf('second');
      const res = await request(app).get('/api/git/show-file').query({ path, commit: second, file: 'new name.txt', from: 'old name.txt' });
      expect(res.body.data.diff).toContain('rename from old name.txt');
      expect(res.body.data.diff).toContain('rename to new name.txt');
      expect(res.body.data.diff).not.toContain('notes.md');
      for (const query of [{ file: '../x' }, { file: 'a', from: '/etc/passwd' }, { file: '' }, { commit: 'HEAD', file: 'a' }]) {
        const bad = await request(app).get('/api/git/show-file').query({ path, commit: second, ...query });
        expect(bad.status, JSON.stringify(query)).toBe(400);
      }
    });

    it('says when that version has no such file, and refuses anything but a version and a path in it', async () => {
      const second = hashOf('second');
      let res = await request(app).get('/api/git/file').query({ path, rev: second + '^', file: 'logo.png' });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('not_in_revision');
      for (const [rev, file] of [['HEAD', '../outside.txt'], ['HEAD', '/etc/passwd'], ['main', 'notes.md'], ['HEAD~2', 'notes.md'], ['--output=x', 'notes.md']]) {
        res = await request(app).get('/api/git/file').query({ path, rev, file });
        expect(res.status, `${rev} ${file}`).toBe(400);
      }
      res = await request(app).get('/api/git/raw').query({ path, rev: 'HEAD', file: '../outside.txt' });
      expect(res.status).toBe(400);
    });
  });

  it('rejects paths outside the allowed roots and non-repositories', async () => {
    let res = await request(app).get('/api/git/status').query({ path: IS_WINDOWS ? '/c/Windows' : '/etc' });
    expect(res.status).toBe(403);
    res = await request(app).get('/api/git/status').query({ path: apiPath(dir) });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_a_git_repository');
  });
});

describe('sqlite block API', () => {
  let db;
  beforeAll(async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const native = join(dir, 'app.db');
    const handle = new DatabaseSync(native);
    handle.exec('CREATE TABLE "my ""users""" (id INTEGER PRIMARY KEY, name TEXT, score REAL, avatar BLOB);'
      + "INSERT INTO \"my \"\"users\"\"\" (name, score, avatar) VALUES ('ann', 1.5, x'0102'), ('bob', 2, NULL);");
    handle.close();
    db = apiPath(native);
  });

  it('quotes identifiers', () => {
    expect(quoteIdent('a"b')).toBe('"a""b"');
  });

  it('lists tables, pages rows, edits cells and runs queries', async () => {
    let res = await request(app).get('/api/sqlite/schema').query({ path: db });
    expect(res.body.data.tables).toMatchObject([{ name: 'my "users"', rows: 2, editable: true }]);

    res = await request(app).get('/api/sqlite/rows').query({ path: db, table: 'my "users"', order: 'name', dir: 'desc' });
    expect(res.body.data.rows.map((r) => r.name)).toEqual(['bob', 'ann']);
    expect(res.body.data.rows[1].avatar).toEqual({ $blob: 2 });
    const bob = res.body.data.rows[0];

    res = await request(app).patch('/api/sqlite/cell').send({ path: db, table: 'my "users"', rowid: bob.__rowid__, column: 'name', value: 'rob' });
    expect(res.body.success).toBe(true);

    res = await request(app).post('/api/sqlite/query').send({ path: db, sql: 'SELECT name FROM "my ""users""" ORDER BY id' });
    expect(res.body.data.rows).toEqual([{ name: 'ann' }, { name: 'rob' }]);

    res = await request(app).post('/api/sqlite/query').send({ path: db, sql: 'DELETE FROM "my ""users"""' });
    expect(res.body.success).toBe(false);

    res = await request(app).post('/api/sqlite/query').send({ path: db, sql: 'DELETE FROM "my ""users""" WHERE name = \'ann\'', write: true });
    expect(res.body.data.changes).toBe(1);

    res = await request(app).patch('/api/sqlite/cell').send({ path: db, table: 'sqlite_master', rowid: 1, column: 'name', value: 'x' });
    expect(res.status).toBe(404);
  });

  it('reports SQLite files as non-text', async () => {
    const res = await request(app).get('/api/files/info').query({ path: db });
    expect(res.body.data).toMatchObject({ isSqlite: true, isText: false });
  });
});

describe('file save', () => {
  it('writes only when the file is unchanged since it was loaded', async () => {
    const native = join(dir, 'note.md');
    await writeFile(native, '# hi\n');
    const path = apiPath(native);
    const info = await stat(native);
    let res = await request(app).put('/api/files/content').send({ path, content: '# hello\n', expectedMtimeMs: info.mtimeMs, expectedSize: info.size });
    expect(res.body.success).toBe(true);
    expect(await readFile(native, 'utf8')).toBe('# hello\n');

    res = await request(app).put('/api/files/content').send({ path, content: 'stale', expectedMtimeMs: info.mtimeMs, expectedSize: info.size });
    expect(res.status).toBe(409);
    expect(await readFile(native, 'utf8')).toBe('# hello\n');
  });
});

describe('anymux open and notebooks', () => {
  it('broadcasts files and urls to the browsers', async () => {
    const native = join(dir, 'open.txt');
    await writeFile(native, 'x');
    let res = await request(app).post('/api/open').send({ path: apiPath(native) });
    expect(res.body.success).toBe(true);
    res = await request(app).post('/api/open').send({ url: 'http://localhost:3000/a' });
    expect(res.body.success).toBe(true);
    res = await request(app).post('/api/open').send({ url: 'javascript:alert(1)' });
    expect(res.status).toBe(400);
    expect(events).toEqual([
      { type: 'open-file', path: apiPath(native), paneId: null },
      { type: 'open-url', url: 'http://localhost:3000/a', paneId: null },
    ]);
  });

  it('runs only .ipynb files', async () => {
    const nb = join(dir, 'a.ipynb');
    await writeFile(nb, '{}');
    let res = await request(app).post('/api/notebook/execute').send({ path: apiPath(nb) });
    expect(res.body.success).toBe(true);
    res = await request(app).post('/api/notebook/execute').send({ path: apiPath(join(dir, 'open.txt')) });
    expect(res.status).toBe(400);
  });
});
