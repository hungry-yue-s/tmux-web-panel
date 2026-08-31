import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ServerService } from '../server/servers/server-service.js';
import { ServerRegistry, LOCAL_SERVER_ID } from '../server/servers/registry.js';
import { ErrorCode } from '../server/servers/errors.js';

const REMOTE = {
  name: 'API Linux',
  address: { host: '10.0.0.21', port: 22, user: 'deploy' },
  ssh: {},
};

describe('ServerService', () => {
  let dir;
  let registry;
  let pool;
  let health;
  let workspace;
  let metrics;
  let service;
  let activePanes;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'server-service-'));
    registry = new ServerRegistry({ configDir: dir });
    await registry.load();
    activePanes = 0;
    pool = { invalidate: vi.fn(), requireRemote: vi.fn(() => ({})) };
    health = {
      invalidate: vi.fn(),
      forget: vi.fn(),
      probe: vi.fn(async () => ({ state: 'online' })),
      getStatus: vi.fn(() => ({ state: 'online' })),
    };
    workspace = {
      releaseServer: vi.fn(),
      hasActiveRuntimes: vi.fn(() => activePanes > 0),
      activeRuntimeCount: vi.fn(() => activePanes),
      pendingProvider: vi.fn(() => null),
    };
    metrics = { forget: vi.fn() };
    service = new ServerService({ registry, pool, health, workspace, metrics });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('requires its dependencies', () => {
    expect(() => new ServerService({ pool, health })).toThrow(/registry/);
    expect(() => new ServerService({ registry, health })).toThrow(/pool/);
    expect(() => new ServerService({ registry, pool })).toThrow(/health/);
  });

  describe('list and get', () => {
    it('includes the local server and surfaces registry load problems', async () => {
      const result = service.list();
      expect(result.servers.map((s) => s.id)).toEqual([LOCAL_SERVER_ID]);
      expect(result.writable).toBe(true);
      expect(result.loadErrors).toEqual([]);
    });

    it('reports a read-only registry', async () => {
      await fs.writeFile(path.join(dir, 'servers.json'), 'not json', 'utf8');
      await registry.load();
      expect(service.list().writable).toBe(false);
    });

    it('never exposes the identity file path', async () => {
      await service.create({ ...REMOTE, ssh: { identityFile: '/keys/secret_key' } });
      expect(JSON.stringify(service.list())).not.toContain('secret_key');
      expect(JSON.stringify(service.get('api-linux'))).not.toContain('secret_key');
    });

    it('reports active panes and any pending provider switch', async () => {
      await service.create(REMOTE);
      activePanes = 2;
      workspace.pendingProvider.mockReturnValue('tmux');

      expect(service.get('api-linux').workspace).toEqual({ activePanes: 2, pendingProvider: 'tmux' });
    });
  });

  describe('create', () => {
    it('reports checking rather than connected, and probes in the background', async () => {
      health.getStatus.mockReturnValue({ state: 'checking' });
      const created = await service.create(REMOTE);

      expect(created.status.state).toBe('checking');
      expect(health.probe).toHaveBeenCalledWith('api-linux', { force: true });
    });

    it('clears stale metrics so a recycled id starts clean', async () => {
      await service.create(REMOTE);
      expect(metrics.forget).toHaveBeenCalledWith('api-linux');
    });

    it('does not resurrect a deleted server\'s metrics under the same id', async () => {
      await service.create({ ...REMOTE, id: 'reused' });
      metrics.forget.mockClear();
      await service.remove('reused');
      metrics.forget.mockClear();

      await service.create({ ...REMOTE, id: 'reused', address: { host: '10.9.9.9', user: 'other' } });

      expect(metrics.forget).toHaveBeenCalledWith('reused');
    });
  });

  describe('update', () => {
    beforeEach(async () => {
      await service.create(REMOTE);
      pool.invalidate.mockClear();
      health.invalidate.mockClear();
      metrics.forget.mockClear();
      workspace.releaseServer.mockClear();
    });

    it('a rename keeps the workspace and metrics', async () => {
      await service.update('api-linux', { name: 'Renamed' });

      expect(workspace.releaseServer).not.toHaveBeenCalled();
      expect(metrics.forget).not.toHaveBeenCalled();
      // The executor still needs the fresh record.
      expect(pool.invalidate).toHaveBeenCalledWith('api-linux');
    });

    it('a host change drops the workspace and metrics', async () => {
      await service.update('api-linux', { address: { host: '10.9.9.9', user: 'deploy' } });

      expect(workspace.releaseServer).toHaveBeenCalledWith('api-linux', 'server_reconfigured');
      expect(metrics.forget).toHaveBeenCalledWith('api-linux');
      expect(health.invalidate).toHaveBeenCalledWith('api-linux');
    });

    it('does not carry the old host\'s samples to a new host', async () => {
      await service.update('api-linux', { address: { host: '10.9.9.9', user: 'deploy' } });
      expect(metrics.forget).toHaveBeenCalledTimes(1);

      metrics.forget.mockClear();
      await service.update('api-linux', { ssh: { identityFile: '~/.ssh/other' } });
      expect(metrics.forget).toHaveBeenCalledWith('api-linux');
    });

    it('refuses to rewire a server with live panes unless forced', async () => {
      activePanes = 1;

      await expect(service.update('api-linux', { address: { host: '10.9.9.9' } })).rejects.toMatchObject({
        code: ErrorCode.SERVER_IN_USE,
        details: { activePanes: 1 },
      });
      expect(workspace.releaseServer).not.toHaveBeenCalled();
      expect(registry.get('api-linux').address.host).toBe('10.0.0.21');
    });

    it('rewires when explicitly forced', async () => {
      activePanes = 1;

      await service.update('api-linux', { address: { host: '10.9.9.9', user: 'deploy' } }, { force: true });

      expect(workspace.releaseServer).toHaveBeenCalled();
      expect(registry.get('api-linux').address.host).toBe('10.9.9.9');
    });

    it('allows a rename even with live panes', async () => {
      activePanes = 1;
      await expect(service.update('api-linux', { name: 'Still Fine' })).resolves.toBeTruthy();
    });
  });

  describe('remove', () => {
    beforeEach(async () => {
      await service.create(REMOTE);
    });

    it('refuses while panes are live, without touching anything', async () => {
      activePanes = 1;

      await expect(service.remove('api-linux')).rejects.toMatchObject({
        code: ErrorCode.SERVER_IN_USE,
        details: { activePanes: 1 },
      });
      expect(workspace.releaseServer).not.toHaveBeenCalled();
      expect(registry.get('api-linux')).toBeTruthy();
    });

    it('removes and cleans every derived cache when forced', async () => {
      activePanes = 1;

      await service.remove('api-linux', { force: true });

      expect(registry.get('api-linux')).toBeNull();
      expect(workspace.releaseServer).toHaveBeenCalledWith('api-linux', 'server_removed');
      expect(pool.invalidate).toHaveBeenCalledWith('api-linux');
      expect(health.forget).toHaveBeenCalledWith('api-linux');
      expect(metrics.forget).toHaveBeenCalledWith('api-linux');
    });

    it('keeps the runtimes when the durable delete fails', async () => {
      registry._writeUnsafe = async () => { throw new Error('EIO'); };
      workspace.releaseServer.mockClear();

      await expect(service.remove('api-linux')).rejects.toThrow('EIO');

      // Destroying the user's shells for a delete that did not happen would be
      // unrecoverable data loss.
      expect(workspace.releaseServer).not.toHaveBeenCalled();
      expect(health.forget).not.toHaveBeenCalled();
      expect(registry.get('api-linux')).toBeTruthy();
    });

    it('refuses to remove the local server', async () => {
      await expect(service.remove(LOCAL_SERVER_ID)).rejects.toMatchObject({
        code: ErrorCode.SERVER_IMMUTABLE,
      });
    });

    it('reports an unknown server', async () => {
      await expect(service.remove('ghost')).rejects.toMatchObject({ code: ErrorCode.SERVER_NOT_FOUND });
    });
  });

  describe('host key flow', () => {
    beforeEach(async () => {
      await service.create(REMOTE);
    });

    it('scans through the pooled executor so trust can find the candidates', async () => {
      const scanHostKeys = vi.fn(async () => ({ keys: [{ algorithm: 'ssh-ed25519', fingerprint: 'SHA256:x' }] }));
      pool.requireRemote.mockReturnValue({ scanHostKeys });

      await service.scanHostKey('api-linux');

      expect(pool.requireRemote).toHaveBeenCalledWith('api-linux', { allowDisabled: true });
      expect(scanHostKeys).toHaveBeenCalled();
    });

    it('re-probes immediately after a key is trusted', async () => {
      const trustHostKey = vi.fn(async () => ({ fingerprint: 'SHA256:x' }));
      pool.requireRemote.mockReturnValue({ trustHostKey });
      health.probe.mockClear();

      await service.trustHostKey('api-linux', 'SHA256:x');

      expect(trustHostKey).toHaveBeenCalledWith('SHA256:x');
      expect(health.invalidate).toHaveBeenCalledWith('api-linux');
      expect(health.probe).toHaveBeenCalled();
    });

    it('works on a disabled server so the user can repair it', async () => {
      await service.update('api-linux', { enabled: false });
      pool.requireRemote.mockReturnValue({ scanHostKeys: vi.fn(async () => ({ keys: [] })) });

      await service.scanHostKey('api-linux');

      expect(pool.requireRemote).toHaveBeenCalledWith('api-linux', { allowDisabled: true });
    });
  });

  it('works without optional dependencies', async () => {
    const minimal = new ServerService({ registry, pool, health });
    await expect(minimal.create({ ...REMOTE, id: 'minimal' })).resolves.toBeTruthy();
    await expect(minimal.remove('minimal')).resolves.toBeUndefined();
  });
});
