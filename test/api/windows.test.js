import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';

vi.mock('../../server/tmux.js', () => ({
  listSessions: vi.fn(),
  listWindows: vi.fn(),
  renameWindow: vi.fn(),
  killWindow: vi.fn(),
  renameWindowById: vi.fn(),
  killWindowById: vi.fn(),
  moveWindowById: vi.fn(),
  createWindow: vi.fn(),
  selectLayout: vi.fn(),
}));

const tmux = await import('../../server/tmux.js');
const windowsRouter = (await import('../../server/api/windows.js')).default;

function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions/:name/windows', windowsRouter);
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
          try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); }
          catch (e) { reject(e); }
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const W = (id, index, opts = {}) => ({
  id, index, name: opts.name || 'w' + index, active: opts.active || false,
  bell: opts.bell || false, width: 80, height: 24, activity: 0,
});

describe('PUT /api/sessions/:name/windows/by-id/:windowId', () => {
  let server, port;
  beforeEach(async () => {
    const started = await startApp();
    server = started.server;
    port = started.port;
    vi.clearAllMocks();
  });
  afterEach(() => { server.close(); });

  it('renames when windowId belongs to :name', async () => {
    tmux.listWindows.mockResolvedValue([W('@5', 0, { active: true })]);
    tmux.renameWindowById.mockResolvedValue();
    const res = await request(port, 'PUT', '/api/sessions/main/windows/by-id/@5', { newName: 'newname' });
    expect(res.status).toBe(200);
    expect(tmux.renameWindowById).toHaveBeenCalledWith('@5', 'newname');
  });

  it('returns 400 on bad windowId', async () => {
    const res = await request(port, 'PUT', '/api/sessions/main/windows/by-id/bad', { newName: 'x' });
    expect(res.status).toBe(400);
  });

  it('returns 400 on missing newName', async () => {
    const res = await request(port, 'PUT', '/api/sessions/main/windows/by-id/@5', {});
    expect(res.status).toBe(400);
  });

  it('returns 409 moved_window when id is in another session', async () => {
    tmux.listWindows.mockImplementation((sess) => {
      if (sess === 'main') return Promise.resolve([W('@7', 0, { active: true })]);
      if (sess === 'other') return Promise.resolve([W('@5', 0, { active: true })]);
      return Promise.resolve([]);
    });
    tmux.listSessions.mockResolvedValue([{ name: 'main', windows: 1 }, { name: 'other', windows: 1 }]);

    const res = await request(port, 'PUT', '/api/sessions/main/windows/by-id/@5', { newName: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('moved_window');
    expect(res.body.data.currentSession).toBe('other');
  });

  it('returns 404 when windowId nowhere', async () => {
    tmux.listWindows.mockResolvedValue([W('@7', 0)]);
    tmux.listSessions.mockResolvedValue([{ name: 'main', windows: 1 }]);
    const res = await request(port, 'PUT', '/api/sessions/main/windows/by-id/@999', { newName: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/sessions/:name/windows/by-id/:windowId', () => {
  let server, port;
  beforeEach(async () => {
    const started = await startApp();
    server = started.server;
    port = started.port;
    vi.clearAllMocks();
  });
  afterEach(() => { server.close(); });

  it('deletes when id matches :name', async () => {
    tmux.listWindows.mockResolvedValue([W('@5', 0, { active: true })]);
    tmux.killWindowById.mockResolvedValue();
    const res = await request(port, 'DELETE', '/api/sessions/main/windows/by-id/@5');
    expect(res.status).toBe(200);
    expect(tmux.killWindowById).toHaveBeenCalledWith('@5');
  });

  it('returns 400 on bad windowId', async () => {
    const res = await request(port, 'DELETE', '/api/sessions/main/windows/by-id/bad');
    expect(res.status).toBe(400);
  });
});

describe('POST /api/sessions/:name/windows/by-id/:windowId/move', () => {
  let server, port;
  beforeEach(async () => {
    const started = await startApp();
    server = started.server;
    port = started.port;
    vi.clearAllMocks();
  });
  afterEach(() => { server.close(); });

  function mockSrcDst({ srcCount = 2, dstExists = true } = {}) {
    const main = Array.from({ length: srcCount }, (_, i) =>
      W(i === 0 ? '@5' : '@' + (100 + i), i, { active: i === 0 })
    );
    tmux.listSessions.mockResolvedValue([
      { name: 'main', windows: main.length },
      ...(dstExists ? [{ name: 'other', windows: 1 }] : []),
    ]);
    tmux.listWindows.mockImplementation((sessName) => {
      if (sessName === 'main') return Promise.resolve(main);
      if (sessName === 'other') return Promise.resolve([W('@7', 0, { active: true })]);
      return Promise.resolve([]);
    });
  }

  it('moves successfully', async () => {
    mockSrcDst({ srcCount: 2 });
    tmux.moveWindowById.mockResolvedValue();
    const res = await request(port, 'POST', '/api/sessions/main/windows/by-id/@5/move', { targetSession: 'other' });
    expect(res.status).toBe(200);
    expect(tmux.moveWindowById).toHaveBeenCalledWith('@5', 'other');
  });

  it('400 when targetSession equals source', async () => {
    mockSrcDst();
    const res = await request(port, 'POST', '/api/sessions/main/windows/by-id/@5/move', { targetSession: 'main' });
    expect(res.status).toBe(400);
  });

  it('404 when target session does not exist', async () => {
    mockSrcDst({ dstExists: false });
    const res = await request(port, 'POST', '/api/sessions/main/windows/by-id/@5/move', { targetSession: 'other' });
    expect(res.status).toBe(404);
  });

  it('409 requires_confirmation when source has only 1 window', async () => {
    mockSrcDst({ srcCount: 1 });
    const res = await request(port, 'POST', '/api/sessions/main/windows/by-id/@5/move', { targetSession: 'other' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('requires_confirmation');
  });

  it('proceeds with confirmDestroySource:true', async () => {
    mockSrcDst({ srcCount: 1 });
    tmux.moveWindowById.mockResolvedValue();
    const res = await request(port, 'POST', '/api/sessions/main/windows/by-id/@5/move', {
      targetSession: 'other',
      confirmDestroySource: true,
    });
    expect(res.status).toBe(200);
  });

  it('409 moved_window when id is in another session', async () => {
    tmux.listSessions.mockResolvedValue([
      { name: 'main', windows: 1 },
      { name: 'other', windows: 1 },
    ]);
    tmux.listWindows.mockImplementation((sessName) => {
      if (sessName === 'main') {
        return Promise.resolve([W('@99', 0, { active: true })]);
      }
      if (sessName === 'other') {
        return Promise.resolve([W('@5', 0, { active: true })]);
      }
      return Promise.resolve([]);
    });

    const res = await request(port, 'POST', '/api/sessions/main/windows/by-id/@5/move', { targetSession: 'other' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('moved_window');
    expect(res.body.data.currentSession).toBe('other');
  });
});
