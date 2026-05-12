import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PinStore } from '../../server/pins.js';
import { createPinsRouter } from '../../server/api/pins.js';

vi.mock('../../server/tmux.js', () => ({
  listSessions: vi.fn(),
  listWindows: vi.fn(),
}));
const tmux = await import('../../server/tmux.js');

async function startApp(store) {
  const app = express();
  app.use(express.json());
  app.use('/api/pins', createPinsRouter({ pinStore: store }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: 'localhost', port, path: urlPath, method, headers: { 'content-type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null });
          } catch (e) { reject(e); }
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('pins API', () => {
  let tmpDir, pinsPath, store, server, port;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pins-api-'));
    pinsPath = path.join(tmpDir, 'pins.json');
    store = new PinStore(pinsPath);
    await store.load();
    tmux.listSessions.mockResolvedValue([{ name: 'main', windows: 2 }]);
    tmux.listWindows.mockResolvedValue([
      { id: '@5', index: 0, name: 'a', active: true, width: 80, height: 24, bell: false, activity: 0 },
      { id: '@12', index: 1, name: 'b', active: false, width: 80, height: 24, bell: false, activity: 0 },
    ]);
    const started = await startApp(store);
    server = started.server;
    port = started.port;
  });

  afterEach(async () => {
    server.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('GET /api/pins returns pins envelope', async () => {
    await store.set('@5', true);
    const res = await request(port, 'GET', '/api/pins');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { pins: ['@5'] }, error: null });
  });

  it('GET /api/pins sweeps orphans', async () => {
    await store.set('@5', true);
    await store.set('@999', true);
    const res = await request(port, 'GET', '/api/pins');
    expect(res.body.data.pins.sort()).toEqual(['@5']);
  });

  it('PUT /api/pins/:windowId pins existing window', async () => {
    const res = await request(port, 'PUT', '/api/pins/@5', { pinned: true });
    expect(res.status).toBe(200);
    expect(store.has('@5')).toBe(true);
  });

  it('PUT rejects invalid windowId format', async () => {
    const res = await request(port, 'PUT', '/api/pins/notanid', { pinned: true });
    expect(res.status).toBe(400);
  });

  it('PUT rejects non-boolean pinned', async () => {
    const res = await request(port, 'PUT', '/api/pins/@5', { pinned: 'yes' });
    expect(res.status).toBe(400);
  });

  it('PUT rejects pinning unknown window', async () => {
    const res = await request(port, 'PUT', '/api/pins/@999', { pinned: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unknown_window_id');
  });

  it('PUT pinned:false is idempotent for unknown id', async () => {
    const res = await request(port, 'PUT', '/api/pins/@999', { pinned: false });
    expect(res.status).toBe(200);
  });
});
