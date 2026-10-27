import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';

import { createWorkspaceRouter } from '../server/api/workspace.js';
import { createMetricsRouter } from '../server/api/metrics.js';
import { AppError, ErrorCode } from '../server/servers/errors.js';
import { listen, request } from './api-helpers.js';

/**
 * A machine's own API. No route carries a serverId: a hub reaches this same
 * API on another machine through /n/:serverId.
 */
describe('machine API (node)', () => {
  let workspaceService;
  let metricsService;
  let server;
  let port;

  beforeEach(async () => {
    workspaceService = {
      getWorkspace: vi.fn(async () => ({
        provider: 'tmux',
        persistence: 'tmux',
        revision: 3,
        actions: { createSession: true },
        sessions: [{ id: '$1', name: 'DataAnt', windows: [] }],
      })),
      getWindowPanes: vi.fn(async () => ({ revision: 3, panes: [{ id: '%12' }] })),
      createSession: vi.fn(async () => ({ id: '$9', name: 'new' })),
      renameSession: vi.fn(async () => ({ id: '$1', name: 'renamed' })),
      closeSession: vi.fn(async () => {}),
      createWindow: vi.fn(async () => ({ id: '@21' })),
      renameWindow: vi.fn(async () => ({ id: '@5', name: 'logs' })),
      closeWindow: vi.fn(async () => {}),
      splitPane: vi.fn(async () => ({ id: '%33' })),
      updatePane: vi.fn(async () => ({ id: '%12' })),
      closePane: vi.fn(async () => {}),
    };
    metricsService = {
      current: vi.fn(async () => ({ cpuPercent: 18.4, availability: { cpu: 'available' } })),
      history: vi.fn(() => ({ windowSeconds: 300, points: [] })),
      drilldown: vi.fn(async () => ({ partial: true, procs: [] })),
    };
    const app = express();
    app.use(express.json());
    app.use('/api/workspace', createWorkspaceRouter({ workspaceService }));
    app.use('/api/metrics', createMetricsRouter({ metricsService }));
    ({ server, port } = await listen(app));
  });

  afterEach(() => {
    server.close();
  });

  describe('workspace', () => {
    it('GET returns the provider, actions and tree', async () => {
      const res = await request(port, 'GET', '/api/workspace');

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ provider: 'tmux', persistence: 'tmux', revision: 3 });
      expect(res.body.data.sessions[0].id).toBe('$1');
    });

    it('GET window panes uses the stable window id', async () => {
      const res = await request(port, 'GET', '/api/workspace/windows/%405/panes');
      expect(res.status).toBe(200);
      expect(res.body.data.panes).toEqual([{ id: '%12' }]);
      expect(workspaceService.getWindowPanes).toHaveBeenCalledWith('@5');
    });

    it('routes every mutation to its service method without any provider header', async () => {
      const calls = [
        ['POST', '/api/workspace/sessions', { name: 'n' }, 'createSession', 201],
        ['PATCH', '/api/workspace/sessions/%241', { name: 'x' }, 'renameSession', 200],
        ['DELETE', '/api/workspace/sessions/%241', undefined, 'closeSession', 204],
        ['POST', '/api/workspace/sessions/%241/windows', { name: 'w' }, 'createWindow', 201],
        ['PATCH', '/api/workspace/windows/%405', { name: 'w' }, 'renameWindow', 200],
        ['DELETE', '/api/workspace/windows/%405', undefined, 'closeWindow', 204],
        ['POST', '/api/workspace/windows/%405/panes', { direction: 'horizontal' }, 'splitPane', 201],
        ['PATCH', '/api/workspace/panes/%2512', { label: 'l' }, 'updatePane', 200],
        ['DELETE', '/api/workspace/panes/%2512', undefined, 'closePane', 204],
      ];

      for (const [method, urlPath, body, name, status] of calls) {
        const res = await request(port, method, urlPath, body);
        expect(res.status).toBe(status);
        expect(workspaceService[name]).toHaveBeenCalled();
      }
    });

    it('decodes tmux ids from the path', async () => {
      await request(port, 'PATCH', '/api/workspace/panes/%2512', { label: 'build' });
      expect(workspaceService.updatePane).toHaveBeenCalledWith('%12', { label: 'build' });
    });

    it('rejects a control character in an id', async () => {
      const res = await request(port, 'DELETE', '/api/workspace/panes/%01');
      expect(res.status).toBe(400);
      expect(workspaceService.closePane).not.toHaveBeenCalled();
    });

    it('rejects a cross-origin write', async () => {
      const res = await request(port, 'POST', '/api/workspace/sessions', { name: 'x' }, { Origin: 'https://evil.example' });
      expect(res.status).toBe(403);
      expect(workspaceService.createSession).not.toHaveBeenCalled();
    });

    it('surfaces a structured error with its repair action', async () => {
      workspaceService.getWorkspace.mockRejectedValue(
        new AppError(ErrorCode.WORKSPACE_UNAVAILABLE, 'No tmux server is running', { retryable: true, action: 'retry_probe' }),
      );

      const res = await request(port, 'GET', '/api/workspace');

      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ code: ErrorCode.WORKSPACE_UNAVAILABLE, retryable: true, action: 'retry_probe' });
    });

    it('never leaks an internal error message', async () => {
      workspaceService.getWorkspace.mockRejectedValue(new Error('ENOENT /Users/secret/.ssh/id_ed25519'));

      const res = await request(port, 'GET', '/api/workspace');

      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe(ErrorCode.INTERNAL);
      expect(JSON.stringify(res.body)).not.toContain('id_ed25519');
    });
  });

  describe('metrics', () => {
    it('serves the current snapshot, honoring force', async () => {
      const res = await request(port, 'GET', '/api/metrics/current?force=1');
      expect(res.status).toBe(200);
      expect(res.body.data.cpuPercent).toBe(18.4);
      expect(metricsService.current).toHaveBeenCalledWith({ force: true });
    });

    it('passes the history window through', async () => {
      await request(port, 'GET', '/api/metrics/history?window=600');
      expect(metricsService.history).toHaveBeenCalledWith({ windowSeconds: '600' });
    });

    it('returns 200 with a partial drilldown rather than an error', async () => {
      const res = await request(port, 'GET', '/api/metrics/drilldown?session=a&windowIndex=0');
      expect(res.status).toBe(200);
      expect(res.body.data.partial).toBe(true);
      expect(metricsService.drilldown).toHaveBeenCalledWith({ session: 'a', windowIndex: '0' });
    });
  });
});
