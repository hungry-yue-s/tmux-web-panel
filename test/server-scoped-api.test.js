import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createServersRouter } from '../server/api/servers.js';
import { createWorkspaceRouter } from '../server/api/workspace.js';
import { createServerMetricsRouter } from '../server/api/metrics.js';
import { ServerService } from '../server/servers/server-service.js';
import { ServerRegistry, LOCAL_SERVER_ID } from '../server/servers/registry.js';
import { AppError, ErrorCode } from '../server/servers/errors.js';

const REMOTE = {
  name: 'API Linux',
  address: { host: '10.0.0.21', port: 22, user: 'deploy' },
  ssh: {},
};

function startApp(routers) {
  const app = express();
  app.use(express.json());
  for (const router of routers) app.use('/api/servers', router);
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

function request(port, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: urlPath,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('server-scoped API', () => {
  let dir;
  let registry;
  let serverService;
  let workspaceService;
  let metricsService;
  let server;
  let port;
  let activePanes;
  let workspacePayload;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'server-api-'));
    registry = new ServerRegistry({ configDir: dir });
    await registry.load();
    activePanes = 0;
    workspacePayload = {
      serverId: 'api-linux',
      provider: 'tmux',
      transport: 'ssh',
      persistence: 'tmux',
      pendingProvider: null,
      revision: 3,
      actions: { createSession: true },
      sessions: [{ id: '$1', name: 'DataAnt', windows: [] }],
    };

    const pool = { invalidate: vi.fn(), requireRemote: vi.fn(() => ({})) };
    const health = {
      invalidate: vi.fn(),
      forget: vi.fn(),
      probe: vi.fn(async () => ({ state: 'online', latencyMs: 12 })),
      getStatus: vi.fn(() => ({ state: 'checking' })),
    };
    const workspace = {
      hasActiveRuntimes: () => activePanes > 0,
      activeRuntimeCount: () => activePanes,
      pendingProvider: () => null,
      releaseServer: vi.fn(),
    };
    const metrics = { forget: vi.fn() };

    serverService = new ServerService({ registry, pool, health, workspace, metrics });

    workspaceService = {
      getWorkspace: vi.fn(async () => workspacePayload),
      getWindowPanes: vi.fn(async () => ({ provider: 'tmux', revision: 3, panes: [{ id: '%12' }] })),
      createSession: vi.fn(async () => ({ id: '$9', name: 'new' })),
      renameSession: vi.fn(async () => ({ id: '$1', name: 'renamed' })),
      closeSession: vi.fn(async () => {}),
      createWindow: vi.fn(async () => ({ id: '@21' })),
      renameWindow: vi.fn(async () => ({ id: '@5', name: 'logs' })),
      closeWindow: vi.fn(async () => {}),
      splitPane: vi.fn(async () => ({ id: '%33' })),
      updatePane: vi.fn(async () => ({ id: '%12' })),
      closePane: vi.fn(async () => {}),
      forceProviderSwitch: vi.fn(() => true),
    };

    metricsService = {
      current: vi.fn(async () => ({ serverId: 'api-linux', cpuPercent: 18.4, availability: { cpu: 'available' } })),
      history: vi.fn(() => ({ serverId: 'api-linux', windowSeconds: 300, points: [] })),
      drilldown: vi.fn(async () => ({ serverId: 'api-linux', partial: true, procs: [] })),
    };

    ({ server, port } = await startApp([
      createServerMetricsRouter({ metricsService }),
      createWorkspaceRouter({ workspaceService }),
      createServersRouter({ serverService }),
    ]));
  });

  afterEach(async () => {
    server.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe('registry routes', () => {
    it('GET /api/servers returns the envelope with the local server', async () => {
      const res = await request(port, 'GET', '/api/servers');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.error).toBeNull();
      expect(res.body.meta.requestId).toMatch(/^req_/);
      expect(res.body.data.servers.map((s) => s.id)).toEqual([LOCAL_SERVER_ID]);
    });

    it('POST /api/servers answers 201 with a checking status', async () => {
      const res = await request(port, 'POST', '/api/servers', REMOTE);

      expect(res.status).toBe(201);
      expect(res.body.data.id).toBe('api-linux');
      // Saving a record is not the same as having a connection.
      expect(res.body.data.status.state).toBe('checking');
    });

    it('POST rejects a validation error with a field hint', async () => {
      const res = await request(port, 'POST', '/api/servers', { name: 'x', address: { host: 'a b' } });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
        retryable: false,
        details: { field: 'address.host' },
      });
    });

    it('POST refuses a password outright', async () => {
      const res = await request(port, 'POST', '/api/servers', { ...REMOTE, ssh: { password: 'hunter2' } });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).not.toContain('hunter2');
    });

    it('GET /api/servers/:id reports an unknown server', async () => {
      const res = await request(port, 'GET', '/api/servers/ghost');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(ErrorCode.SERVER_NOT_FOUND);
    });

    it('rejects an invalid server id shape', async () => {
      const res = await request(port, 'GET', '/api/servers/NOT%20VALID');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
    });

    it('PATCH renames without disturbing the workspace', async () => {
      await request(port, 'POST', '/api/servers', REMOTE);
      const res = await request(port, 'PATCH', '/api/servers/api-linux', { name: 'Renamed' });

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Renamed');
    });

    it('PATCH refuses to rewire a server with live panes', async () => {
      await request(port, 'POST', '/api/servers', REMOTE);
      activePanes = 2;

      const res = await request(port, 'PATCH', '/api/servers/api-linux', { address: { host: '10.9.9.9' } });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({
        code: ErrorCode.SERVER_IN_USE,
        details: { activePanes: 2 },
      });
    });

    it('PATCH honors ?force=1 so the user can confirm', async () => {
      await request(port, 'POST', '/api/servers', REMOTE);
      activePanes = 2;

      const res = await request(port, 'PATCH', '/api/servers/api-linux?force=1', {
        address: { host: '10.9.9.9', user: 'deploy' },
      });

      expect(res.status).toBe(200);
      expect(registry.get('api-linux').address.host).toBe('10.9.9.9');
    });

    it('PATCH accepts force=true as well', async () => {
      await request(port, 'POST', '/api/servers', REMOTE);
      activePanes = 1;

      const res = await request(port, 'PATCH', '/api/servers/api-linux?force=true', {
        address: { host: '10.8.8.8', user: 'deploy' },
      });

      expect(res.status).toBe(200);
    });

    it('DELETE refuses while panes are live, then accepts force', async () => {
      await request(port, 'POST', '/api/servers', REMOTE);
      activePanes = 1;

      const refused = await request(port, 'DELETE', '/api/servers/api-linux');
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe(ErrorCode.SERVER_IN_USE);

      const forced = await request(port, 'DELETE', '/api/servers/api-linux?force=1');
      expect(forced.status).toBe(204);
      expect(registry.get('api-linux')).toBeNull();
    });

    it('DELETE refuses the local server', async () => {
      const res = await request(port, 'DELETE', `/api/servers/${LOCAL_SERVER_ID}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ErrorCode.SERVER_IMMUTABLE);
    });

    it('POST probe returns the fresh status', async () => {
      await request(port, 'POST', '/api/servers', REMOTE);
      const res = await request(port, 'POST', '/api/servers/api-linux/probe');

      expect(res.status).toBe(200);
      expect(res.body.data.state).toBe('online');
    });
  });

  describe('cross-origin protection', () => {
    it('rejects a credentialed write from another origin', async () => {
      const res = await request(port, 'POST', '/api/servers', REMOTE, { Origin: 'https://evil.example' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_ORIGIN');
    });

    it('allows a same-origin write', async () => {
      const res = await request(port, 'POST', '/api/servers', REMOTE, { Origin: `http://127.0.0.1:${port}` });
      expect(res.status).toBe(201);
    });

    it('allows a read from another origin', async () => {
      const res = await request(port, 'GET', '/api/servers', undefined, { Origin: 'https://evil.example' });
      expect(res.status).toBe(200);
    });
  });

  describe('workspace routes', () => {
    beforeEach(async () => {
      await request(port, 'POST', '/api/servers', REMOTE);
    });

    it('GET workspace returns the provider, actions and tree', async () => {
      const res = await request(port, 'GET', '/api/servers/api-linux/workspace');

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        provider: 'tmux',
        persistence: 'tmux',
        revision: 3,
      });
      expect(res.body.data.sessions[0].id).toBe('$1');
    });

    it('GET sessions is a thin projection of the workspace', async () => {
      const res = await request(port, 'GET', '/api/servers/api-linux/sessions');
      expect(res.body.data).toMatchObject({ provider: 'tmux', revision: 3 });
      expect(res.body.data.sessions).toHaveLength(1);
    });

    it('GET window panes uses the stable window id', async () => {
      const res = await request(port, 'GET', '/api/servers/api-linux/windows/%405/panes');
      expect(res.status).toBe(200);
      expect(res.body.data.panes).toEqual([{ id: '%12' }]);
      expect(workspaceService.getWindowPanes).toHaveBeenCalledWith('api-linux', '@5');
    });

    it('requires the provider header on a mutation', async () => {
      const res = await request(port, 'POST', '/api/servers/api-linux/sessions', { name: 'work' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
        details: { field: 'X-Workspace-Provider' },
      });
      expect(workspaceService.createSession).not.toHaveBeenCalled();
    });

    it('rejects an unknown provider header', async () => {
      const res = await request(
        port, 'POST', '/api/servers/api-linux/sessions', { name: 'work' },
        { 'X-Workspace-Provider': 'telnet' },
      );
      expect(res.status).toBe(400);
    });

    it('passes the expected provider through to the service', async () => {
      const res = await request(
        port, 'POST', '/api/servers/api-linux/sessions', { name: 'work' },
        { 'X-Workspace-Provider': 'tmux' },
      );

      expect(res.status).toBe(201);
      expect(workspaceService.createSession).toHaveBeenCalledWith('api-linux', { name: 'work' }, 'tmux');
    });

    it('surfaces PROVIDER_CHANGED as 409', async () => {
      workspaceService.createSession.mockRejectedValue(
        new AppError(ErrorCode.PROVIDER_CHANGED, 'now ssh', { details: { provider: 'ssh' } }),
      );

      const res = await request(
        port, 'POST', '/api/servers/api-linux/sessions', { name: 'work' },
        { 'X-Workspace-Provider': 'tmux' },
      );

      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({
        code: ErrorCode.PROVIDER_CHANGED,
        retryable: true,
        action: 'refresh_workspace',
      });
    });

    it('routes every mutation to its service method', async () => {
      const headers = { 'X-Workspace-Provider': 'tmux' };
      const calls = [
        ['PATCH', '/api/servers/api-linux/sessions/%241', { name: 'x' }, 'renameSession'],
        ['DELETE', '/api/servers/api-linux/sessions/%241', undefined, 'closeSession'],
        ['POST', '/api/servers/api-linux/sessions/%241/windows', { name: 'w' }, 'createWindow'],
        ['PATCH', '/api/servers/api-linux/windows/%405', { name: 'w' }, 'renameWindow'],
        ['DELETE', '/api/servers/api-linux/windows/%405', undefined, 'closeWindow'],
        ['POST', '/api/servers/api-linux/windows/%405/panes', { direction: 'horizontal' }, 'splitPane'],
        ['PATCH', '/api/servers/api-linux/panes/%2512', { label: 'l' }, 'updatePane'],
        ['DELETE', '/api/servers/api-linux/panes/%2512', undefined, 'closePane'],
      ];

      for (const [method, urlPath, body, method_name] of calls) {
        const res = await request(port, method, urlPath, body, headers);
        expect([200, 201, 204]).toContain(res.status);
        expect(workspaceService[method_name]).toHaveBeenCalled();
      }
    });

    it('decodes tmux ids from the path', async () => {
      await request(
        port, 'PATCH', '/api/servers/api-linux/panes/%2512', { label: 'build' },
        { 'X-Workspace-Provider': 'tmux' },
      );
      expect(workspaceService.updatePane).toHaveBeenCalledWith('api-linux', '%12', { label: 'build' }, 'tmux');
    });

    it('rejects a control character in an id', async () => {
      const res = await request(
        port, 'DELETE', '/api/servers/api-linux/panes/%01', undefined,
        { 'X-Workspace-Provider': 'tmux' },
      );
      expect(res.status).toBe(400);
    });

    it('surfaces UNSUPPORTED for an action the provider lacks', async () => {
      workspaceService.splitPane.mockRejectedValue(
        new AppError(ErrorCode.UNSUPPORTED, 'not on ssh', { details: { action: 'splitPane' } }),
      );

      const res = await request(
        port, 'POST', '/api/servers/api-linux/windows/%405/panes', {},
        { 'X-Workspace-Provider': 'ssh' },
      );

      expect(res.status).toBe(501);
      expect(res.body.error.code).toBe(ErrorCode.UNSUPPORTED);
    });

    it('surfaces WORKSPACE_UNAVAILABLE with a repair action', async () => {
      workspaceService.getWorkspace.mockRejectedValue(
        new AppError(ErrorCode.WORKSPACE_UNAVAILABLE, 'unreachable', { retryable: true, action: 'retry_probe' }),
      );

      const res = await request(port, 'GET', '/api/servers/api-linux/workspace');

      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ retryable: true, action: 'retry_probe' });
    });

    it('adopting a provider is an explicit endpoint', async () => {
      const res = await request(port, 'POST', '/api/servers/api-linux/workspace/adopt-provider');
      expect(res.status).toBe(200);
      expect(workspaceService.forceProviderSwitch).toHaveBeenCalledWith('api-linux');
    });
  });

  describe('metrics routes', () => {
    beforeEach(async () => {
      await request(port, 'POST', '/api/servers', REMOTE);
    });

    it('serves the current snapshot', async () => {
      const res = await request(port, 'GET', '/api/servers/api-linux/metrics/current');
      expect(res.status).toBe(200);
      expect(res.body.data.cpuPercent).toBe(18.4);
    });

    it('passes the history window through', async () => {
      await request(port, 'GET', '/api/servers/api-linux/metrics/history?window=600');
      expect(metricsService.history).toHaveBeenCalledWith('api-linux', { windowSeconds: '600' });
    });

    it('returns 200 with a partial drilldown rather than an error', async () => {
      const res = await request(port, 'GET', '/api/servers/api-linux/metrics/drilldown');
      expect(res.status).toBe(200);
      expect(res.body.data.partial).toBe(true);
    });

    it('is not shadowed by the /:serverId route', async () => {
      const res = await request(port, 'GET', '/api/servers/api-linux/metrics/current');
      // A wrongly ordered mount would have returned the server detail instead.
      expect(res.body.data.cpuPercent).toBeDefined();
      expect(res.body.data.kind).toBeUndefined();
    });
  });

  it('never leaks an internal error message', async () => {
    workspaceService.getWorkspace.mockRejectedValue(new Error('ENOENT /Users/secret/.ssh/id_ed25519'));
    await request(port, 'POST', '/api/servers', REMOTE);

    const res = await request(port, 'GET', '/api/servers/api-linux/workspace');

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe(ErrorCode.INTERNAL);
    expect(JSON.stringify(res.body)).not.toContain('id_ed25519');
  });
});
