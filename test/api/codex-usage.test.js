import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import http from 'node:http';

function makeApp(createRouter) {
  const app = express();
  app.use('/api/codex-usage', createRouter());
  return app;
}

function get(app, path) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      http.get(`http://localhost:${port}${path}`, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        });
      }).on('error', (err) => {
        server.close();
        reject(err);
      });
    });
  });
}

function dirent(name, directory = false) {
  return {
    name,
    isDirectory: () => directory,
    isFile: () => !directory,
  };
}

describe('GET /api/codex-usage', () => {
  let mockReadFile;
  let mockReaddir;

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();

    mockReadFile = vi.fn();
    mockReaddir = vi.fn();

    vi.doMock('node:os', () => ({
      homedir: () => '/home/tester',
    }));
    vi.doMock('node:fs/promises', () => ({
      readFile: mockReadFile,
      readdir: mockReaddir,
    }));
  });

  it('returns aggregated Codex usage from session JSONL files', async () => {
    mockReaddir.mockImplementation((path) => {
      if (path === '/home/tester/.codex/sessions') return Promise.resolve([dirent('2026', true)]);
      if (path === '/home/tester/.codex/sessions/2026') return Promise.resolve([dirent('05', true)]);
      if (path === '/home/tester/.codex/sessions/2026/05') return Promise.resolve([dirent('13', true)]);
      if (path === '/home/tester/.codex/sessions/2026/05/13') return Promise.resolve([dirent('rollout-test.jsonl')]);
      return Promise.resolve([]);
    });

    const lines = [
      {
        timestamp: '2026-05-13T10:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'sess-1', cwd: '/home/tester/project', cli_version: '0.1.0', source: 'vscode' },
      },
      {
        timestamp: '2026-05-13T10:00:01.000Z',
        type: 'turn_context',
        payload: { model: 'gpt-5.5', cwd: '/home/tester/project' },
      },
      {
        timestamp: '2026-05-13T10:00:02.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'build a panel' }] },
      },
      {
        timestamp: '2026-05-13T10:00:03.000Z',
        type: 'response_item',
        payload: { type: 'function_call', name: 'exec_command' },
      },
      {
        timestamp: '2026-05-13T10:00:04.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 1000,
              cached_input_tokens: 400,
              output_tokens: 200,
              reasoning_output_tokens: 50,
              total_tokens: 1250,
            },
          },
          rate_limits: {
            limit_id: 'codex',
            plan_type: 'plus',
            primary: { used_percent: 42, window_minutes: 300, resets_at: 1778687536 },
            secondary: { used_percent: 12, window_minutes: 10080, resets_at: 1779109530 },
          },
        },
      },
    ].map(JSON.stringify).join('\n');

    mockReadFile.mockResolvedValue(lines);

    const { default: createRouter } = await import('../../server/api/codex-usage.js');
    const app = makeApp(createRouter);
    const res = await get(app, '/api/codex-usage');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.subscription.type).toBe('plus');
    expect(res.body.data.utilization.primary.used_percent).toBe(42);
    expect(res.body.data.aggregate.totalSessions).toBe(1);
    expect(res.body.data.aggregate.totalTokens).toBe(1250);
    expect(res.body.data.modelUsage['gpt-5.5'].inputTokens).toBe(1000);
    expect(res.body.data.aggregatedTools.exec_command).toBe(1);
    expect(res.body.data.recentSessions[0].first_prompt).toBe('build a panel');
  });
});
