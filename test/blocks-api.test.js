import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtemp, writeFile, readFile, rm, stat, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFilesRouter, createPathGuard } from '../server/api/files.js';
import {
  createGitRouter, parseStatus, parseLineChanges, parseLog, fallbackCommitMessage,
} from '../server/api/git.js';
import { createSqliteRouter, quoteIdent } from '../server/api/sqlite.js';
import { createOpenRouter, createNotebookRouter } from '../server/api/open.js';
import { IS_WINDOWS, toPosixPath } from '../server/msys.js';

// Paths in the API are the ones panes show: MSYS paths on Windows.
const apiPath = (native) => (IS_WINDOWS ? toPosixPath(native) : native);

let dir;
let app;
let events;

beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'twp-blocks-')));
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

    res = await request(app).get('/api/git/line-changes').query({ path: path + '/a.txt' });
    expect(res.body.data.changes).toEqual([{ type: 'modified', start: 2, end: 2 }]);

    res = await request(app).post('/api/git/undo-commit').send({ path });
    expect(res.body.data.message).toBe('add four');
    res = await request(app).get('/api/git/status').query({ path });
    expect(res.body.data.files[0]).toMatchObject({ path: 'a.txt', staged: true, unstaged: true });
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

describe('twp open and notebooks', () => {
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
