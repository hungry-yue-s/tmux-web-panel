import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import { createSceneDiscoverRouter } from '../../server/api/scene-discover.js';

function makeApp(scanners) {
  const app = express();
  app.use('/api/scene/discover', createSceneDiscoverRouter(scanners));
  return app;
}

function get(app, path) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      http.get(`http://localhost:${port}${path}`, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(body) }); });
      }).on('error', err => { server.close(); reject(err); });
    });
  });
}

describe('GET /api/scene/discover', () => {
  it('returns all 4 scene discovery results', async () => {
    const scanners = {
      terminal: vi.fn().mockResolvedValue({ topCommands: [{ command: 'git', count: 10 }], topFullCommands: [] }),
      claude: vi.fn().mockResolvedValue({ slashCommands: [{ id: 'plan' }] }),
      vim: vi.fn().mockResolvedValue({ leaderKey: ' ', customKeymaps: [] }),
      lazygit: vi.fn().mockResolvedValue({ hasCustomConfig: true, customCommands: [] }),
    };
    const app = makeApp(scanners);
    const res = await get(app, '/api/scene/discover');
    expect(res.status).toBe(200);
    expect(res.body.terminal.topCommands[0].command).toBe('git');
    expect(res.body.claude.slashCommands[0].id).toBe('plan');
    expect(res.body.vim.leaderKey).toBe(' ');
    expect(res.body.lazygit.hasCustomConfig).toBe(true);
    expect(res.body.timestamp).toBeDefined();
  });

  it('returns empty structures if a scanner throws', async () => {
    const scanners = {
      terminal: vi.fn().mockRejectedValue(new Error('fail')),
      claude: vi.fn().mockResolvedValue({ slashCommands: [] }),
      vim: vi.fn().mockResolvedValue({ customKeymaps: [] }),
      lazygit: vi.fn().mockResolvedValue({ customCommands: [] }),
    };
    const app = makeApp(scanners);
    const res = await get(app, '/api/scene/discover');
    expect(res.status).toBe(200);
    expect(res.body.terminal).toEqual({ topCommands: [], topFullCommands: [], aliases: [] });
  });
});
