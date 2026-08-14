import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFilesRouter } from '../../server/api/files.js';

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
    app.use('/api/files', createFilesRouter([root]));
    const res = await request(app).get('/api/files/info').query({ path: file });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.size).toBe(expected.size);
    expect(res.body.data.mtimeMs).toBeCloseTo(expected.mtimeMs, 0);
  });
});
