import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createServersRouter } from '../server/api/servers.js';
import { ServerService } from '../server/servers/server-service.js';
import { ServerRegistry, LOCAL_SERVER_ID } from '../server/servers/registry.js';
import { ErrorCode } from '../server/servers/errors.js';
import { listen, request } from './api-helpers.js';

const REMOTE = {
  name: 'API Linux',
  address: { host: '10.0.0.21', port: 22, user: 'deploy' },
  ssh: {},
};

describe('server registry API (hub)', () => {
  let dir;
  let registry;
  let server;
  let port;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'server-api-'));
    registry = new ServerRegistry({ configDir: dir });
    await registry.load();
    const links = { invalidate: vi.fn(), connection: vi.fn(() => ({})) };
    const health = {
      invalidate: vi.fn(),
      forget: vi.fn(),
      probe: vi.fn(async () => ({ state: 'online', latencyMs: 12 })),
      getStatus: vi.fn(() => ({ state: 'checking' })),
    };
    const app = express();
    app.use(express.json());
    app.use('/api/servers', createServersRouter({ serverService: new ServerService({ registry, links, health }) }));
    ({ server, port } = await listen(app));
  });

  afterEach(async () => {
    server.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

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
    expect(res.body.error).toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
      retryable: false,
      details: { field: 'address.host' },
    });
  });

  it('POST accepts a password without returning it, including on GET and PATCH', async () => {
    const res = await request(port, 'POST', '/api/servers', { ...REMOTE, ssh: { password: 'hunter2' } });
    expect(res.status).toBe(201);
    expect(res.body.data.ssh.authMethod).toBe('password');
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    for (const url of ['/api/servers', '/api/servers/' + res.body.data.id]) {
      const result = await request(port, 'GET', url);
      expect(result.status).toBe(200);
      expect(JSON.stringify(result.body)).not.toMatch(/hunter2|encryptedPassword/);
    }
    const updated = await request(port, 'PATCH', '/api/servers/' + res.body.data.id, { ssh: { password: 'replacement' } });
    expect(updated.status).toBe(200);
    expect(JSON.stringify(updated.body)).not.toMatch(/replacement|encryptedPassword/);
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

  it('PATCH renames and rewires without a confirmation step', async () => {
    await request(port, 'POST', '/api/servers', REMOTE);

    const renamed = await request(port, 'PATCH', '/api/servers/api-linux', { name: 'Renamed' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data.name).toBe('Renamed');

    const rewired = await request(port, 'PATCH', '/api/servers/api-linux', { address: { host: '10.9.9.9', user: 'deploy' } });
    expect(rewired.status).toBe(200);
    expect(registry.get('api-linux').address.host).toBe('10.9.9.9');
  });

  it('DELETE removes a server and refuses the local one', async () => {
    await request(port, 'POST', '/api/servers', REMOTE);

    expect((await request(port, 'DELETE', '/api/servers/api-linux')).status).toBe(204);
    expect(registry.get('api-linux')).toBeNull();

    const local = await request(port, 'DELETE', `/api/servers/${LOCAL_SERVER_ID}`);
    expect(local.status).toBe(400);
    expect(local.body.error.code).toBe(ErrorCode.SERVER_IMMUTABLE);
  });

  it('POST probe returns the fresh status', async () => {
    await request(port, 'POST', '/api/servers', REMOTE);
    const res = await request(port, 'POST', '/api/servers/api-linux/probe');

    expect(res.status).toBe(200);
    expect(res.body.data.state).toBe('online');
  });

  describe('cross-origin protection', () => {
    it('rejects a credentialed write from another origin', async () => {
      const res = await request(port, 'POST', '/api/servers', REMOTE, { Origin: 'https://evil.example' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_ORIGIN');
    });

    it('allows a same-origin write and any read', async () => {
      expect((await request(port, 'POST', '/api/servers', REMOTE, { Origin: `http://127.0.0.1:${port}` })).status).toBe(201);
      expect((await request(port, 'GET', '/api/servers', undefined, { Origin: 'https://evil.example' })).status).toBe(200);
    });
  });
});
