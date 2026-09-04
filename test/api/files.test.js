import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { createFilesRouter } from '../../server/api/files.js';
import { getArchiveType } from '../../server/api/archive.js';

const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('files info API', () => {
  it('returns size and mtimeMs for lightweight preview change detection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tmux-panel-files-'));
    tempDirs.push(root);
    const file = join(root, 'live.md');
    await writeFile(file, '# live\n');
    const expected = await stat(file);

    const app = express();
    app.use(express.json());
    app.use('/api/files', createFilesRouter([root]));
    const res = await request(app).get('/api/files/info').query({ path: file });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.size).toBe(expected.size);
    expect(res.body.data.mtimeMs).toBeCloseTo(expected.mtimeMs, 0);
  });
});

describe('Markdown task API', () => {
  async function setup(content, filename = 'tasks.md') {
    const root = await mkdtemp(join(tmpdir(), 'tmux-panel-tasks-'));
    tempDirs.push(root);
    const file = join(root, filename);
    await writeFile(file, content);
    const app = express();
    app.use(express.json());
    app.use('/api/files', createFilesRouter([root]));
    return { root, file, app };
  }

  async function taskRequest(app, file, line, expectedLine, checked) {
    const revision = await stat(file);
    return request(app)
      .patch('/api/files/markdown-task')
      .send({
        path: file,
        line,
        checked,
        expectedLine,
        expectedMtimeMs: revision.mtimeMs,
        expectedSize: revision.size,
      });
  }

  it('changes only one task marker byte and preserves CRLF content', async () => {
    const content = '---\r\ntitle: Tasks\r\n---\r\n- [ ] first\r\n  - [X] nested\r\n1. [ ] ordered\r\n';
    const { app, file } = await setup(content);

    const res = await taskRequest(app, file, 4, '  - [X] nested', false);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { line: 4, checked: false } });
    const updated = await readFile(file, 'utf8');
    expect(updated).toBe('---\r\ntitle: Tasks\r\n---\r\n- [ ] first\r\n  - [ ] nested\r\n1. [ ] ordered\r\n');
  });

  it('rejects stale revisions and non-task lines without changing the file', async () => {
    const { app, file } = await setup('- [ ] first\nplain text\n');
    const revision = await stat(file);
    await writeFile(file, '- [ ] changed elsewhere\nplain text\n');

    const stale = await request(app)
      .patch('/api/files/markdown-task')
      .send({
        path: file,
        line: 0,
        checked: true,
        expectedLine: '- [ ] first',
        expectedMtimeMs: revision.mtimeMs,
        expectedSize: revision.size,
      });
    expect(stale.status).toBe(409);
    expect(await readFile(file, 'utf8')).toBe('- [ ] changed elsewhere\nplain text\n');

    const current = await stat(file);
    const invalid = await request(app)
      .patch('/api/files/markdown-task')
      .send({
        path: file,
        line: 1,
        checked: true,
        expectedLine: 'plain text',
        expectedMtimeMs: current.mtimeMs,
        expectedSize: current.size,
      });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe('not_markdown_task');
  });

  it('rejects non-Markdown files and symlinks that resolve outside the allowed root', async () => {
    const { root, app } = await setup('plain\n', 'plain.txt');
    const plain = join(root, 'plain.txt');
    const plainRevision = await stat(plain);
    const nonMarkdown = await request(app)
      .patch('/api/files/markdown-task')
      .send({
        path: plain,
        line: 0,
        checked: true,
        expectedLine: 'plain',
        expectedMtimeMs: plainRevision.mtimeMs,
        expectedSize: plainRevision.size,
      });
    expect(nonMarkdown.status).toBe(400);
    expect(nonMarkdown.body.error).toBe('not_markdown');

    const outside = await mkdtemp(join(tmpdir(), 'tmux-panel-outside-'));
    tempDirs.push(outside);
    const outsideFile = join(outside, 'outside.md');
    await writeFile(outsideFile, '- [ ] outside\n');
    const escape = join(root, 'escape.md');
    await symlink(outsideFile, escape);

    expect((await request(app).get('/api/files/info').query({ path: escape })).status).toBe(403);
    expect((await request(app).get('/api/files/content').query({ path: escape })).status).toBe(403);
    const rejectedWrite = await request(app)
      .patch('/api/files/markdown-task')
      .send({
        path: escape,
        line: 0,
        checked: true,
        expectedLine: '- [ ] outside',
        expectedMtimeMs: 0,
        expectedSize: 0,
      });
    expect(rejectedWrite.status).toBe(403);
  });
});

function writeZipBuffer(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data || '', 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(0, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, name]));
    offset += local.length + name.length + data.length;
  }
  const cdBuffer = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuffer, eocd]);
}

function writeTarBuffer(entries) {
  const blocks = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 'utf8');
    header.write('0000644 ', 100, 'latin1');
    const size = entry.isDir ? 0 : Buffer.byteLength(entry.data || '', 'utf8');
    header.write(size.toString(8).padStart(11, '0') + ' ', 124, 'latin1');
    header.write('00000000000 ', 136, 'latin1');
    header.write('        ', 148, 'latin1');
    header.write(entry.isDir ? '5' : '0', 156, 'latin1');
    header.write('ustar', 257, 'latin1');
    header.write('00', 263, 'latin1');
    blocks.push(header);
    if (!entry.isDir && size > 0) {
      const data = Buffer.from(entry.data, 'utf8');
      const padded = Buffer.alloc(Math.ceil(size / 512) * 512);
      data.copy(padded);
      blocks.push(padded);
    }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

describe('files archive API', () => {
  async function setup() {
    const root = await mkdtemp(join(tmpdir(), 'tmux-panel-arch-'));
    tempDirs.push(root);
    const app = express();
    app.use(express.json());
    app.use('/api/files', createFilesRouter([root]));
    return { root, app };
  }

  it('detects common archive extensions', () => {
    expect(getArchiveType('/x/a.zip')).toBe('zip');
    expect(getArchiveType('/x/a.tar')).toBe('tar');
    expect(getArchiveType('/x/a.tgz')).toBe('targz');
    expect(getArchiveType('/x/a.tar.gz')).toBe('targz');
    expect(getArchiveType('/x/a.tar.xz')).toBe('tarxz');
    expect(getArchiveType('/x/a.rar')).toBe('unsupported');
    expect(getArchiveType('/x/a.txt')).toBeNull();
  });

  it('lists zip entries', async () => {
    const { root, app } = await setup();
    const file = join(root, 'a.zip');
    await writeFile(file, writeZipBuffer([
      { name: 'nested/', data: '' },
      { name: 'nested/b.md', data: 'hello' },
      { name: 'a.txt', data: 'world!' },
    ]));

    const res = await request(app).get('/api/files/archive').query({ path: file });
    expect(res.status).toBe(200);
    expect(res.body.data.archiveType).toBe('zip');
    const names = res.body.data.entries.map((e) => e.name);
    expect(names).toContain('a.txt');
    expect(names).toContain('nested/b.md');
    const txt = res.body.data.entries.find((e) => e.name === 'a.txt');
    expect(txt.size).toBe(6);
  });

  it('lists tar and tar.gz entries', async () => {
    const { root, app } = await setup();
    const entries = [
      { name: 'dir/', isDir: true },
      { name: 'dir/c.txt', data: 'data' },
    ];
    const tar = join(root, 'a.tar');
    await writeFile(tar, writeTarBuffer(entries));
    const tgz = join(root, 'a.tgz');
    await writeFile(tgz, gzipSync(writeTarBuffer(entries)));

    for (const path of [tar, tgz]) {
      const res = await request(app).get('/api/files/archive').query({ path });
      expect(res.status).toBe(200);
      const names = res.body.data.entries.map((e) => e.name);
      expect(names).toContain('dir/c.txt');
    }
  });

  it('rejects non-archive paths', async () => {
    const { root, app } = await setup();
    const file = join(root, 'plain.txt');
    await writeFile(file, 'not an archive');
    const res = await request(app).get('/api/files/archive').query({ path: file });
    expect(res.status).toBe(400);
  });

  it('marks archives as non-text in /info', async () => {
    const { root, app } = await setup();
    const file = join(root, 'a.zip');
    await writeFile(file, writeZipBuffer([{ name: 'a.txt', data: 'x' }]));
    const res = await request(app).get('/api/files/info').query({ path: file });
    expect(res.status).toBe(200);
    expect(res.body.data.isArchive).toBe(true);
    expect(res.body.data.isText).toBe(false);
  });
});
