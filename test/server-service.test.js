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
  let links;
  let health;
  let service;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'server-service-'));
    registry = new ServerRegistry({ configDir: dir });
    await registry.load();
    links = { invalidate: vi.fn(), connection: vi.fn(() => ({})) };
    health = {
      invalidate: vi.fn(),
      forget: vi.fn(),
      probe: vi.fn(async () => ({ state: 'online' })),
      getStatus: vi.fn(() => ({ state: 'online' })),
    };
    service = new ServerService({ registry, links, health });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('requires its dependencies', () => {
    expect(() => new ServerService({ links, health })).toThrow(/registry/);
    expect(() => new ServerService({ registry, health })).toThrow(/link pool/);
    expect(() => new ServerService({ registry, links })).toThrow(/health/);
  });

  describe('list and get', () => {
    it('includes the local server and surfaces registry load problems', () => {
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
  });

  describe('create', () => {
    it('reports checking rather than connected, and probes in the background', async () => {
      health.getStatus.mockReturnValue({ state: 'checking' });
      const created = await service.create(REMOTE);

      expect(created.status.state).toBe('checking');
      expect(health.probe).toHaveBeenCalledWith('api-linux', { force: true });
    });

    it('drops any link left under a recycled id', async () => {
      await service.create(REMOTE);
      expect(links.invalidate).toHaveBeenCalledWith('api-linux');
    });
  });

  describe('update', () => {
    beforeEach(async () => {
      await service.create(REMOTE);
      links.invalidate.mockClear();
      health.invalidate.mockClear();
    });

    it('a rename keeps the open forward', async () => {
      await service.update('api-linux', { name: 'Renamed' });
      expect(links.invalidate).not.toHaveBeenCalled();
      expect(registry.get('api-linux').name).toBe('Renamed');
    });

    it('a connection change closes the forward and re-checks', async () => {
      await service.update('api-linux', { address: { host: '10.9.9.9', user: 'deploy' } });

      expect(links.invalidate).toHaveBeenCalledWith('api-linux');
      expect(health.invalidate).toHaveBeenCalledWith('api-linux');
      expect(health.probe).toHaveBeenCalled();
    });

    it('never needs confirmation: panes live in tmux on the node, not in the link', async () => {
      await expect(service.update('api-linux', { address: { host: '10.9.9.9', user: 'deploy' } })).resolves.toBeTruthy();
      expect(registry.get('api-linux').address.host).toBe('10.9.9.9');
    });
  });

  describe('remove', () => {
    beforeEach(async () => {
      await service.create(REMOTE);
    });

    it('removes and cleans every derived cache', async () => {
      await service.remove('api-linux');

      expect(registry.get('api-linux')).toBeNull();
      expect(links.invalidate).toHaveBeenCalledWith('api-linux');
      expect(health.forget).toHaveBeenCalledWith('api-linux');
    });

    it('keeps the link when the durable delete fails', async () => {
      registry._writeUnsafe = async () => { throw new Error('EIO'); };
      links.invalidate.mockClear();

      await expect(service.remove('api-linux')).rejects.toThrow('EIO');

      expect(links.invalidate).not.toHaveBeenCalled();
      expect(health.forget).not.toHaveBeenCalled();
      expect(registry.get('api-linux')).toBeTruthy();
    });

    it('refuses to remove the local server', async () => {
      await expect(service.remove(LOCAL_SERVER_ID)).rejects.toMatchObject({ code: ErrorCode.SERVER_IMMUTABLE });
    });

    it('reports an unknown server', async () => {
      await expect(service.remove('ghost')).rejects.toMatchObject({ code: ErrorCode.SERVER_NOT_FOUND });
    });
  });

  describe('host key flow', () => {
    beforeEach(async () => {
      await service.create(REMOTE);
    });

    it('scans through the pooled connection so trust can find the candidates', async () => {
      const scanHostKeys = vi.fn(async () => ({ keys: [{ algorithm: 'ssh-ed25519', fingerprint: 'SHA256:x' }] }));
      links.connection.mockReturnValue({ scanHostKeys });

      await service.scanHostKey('api-linux');

      expect(links.connection).toHaveBeenCalledWith('api-linux', { allowDisabled: true });
      expect(scanHostKeys).toHaveBeenCalled();
    });

    it('re-probes immediately after a key is trusted', async () => {
      const trustHostKey = vi.fn(async () => ({ fingerprint: 'SHA256:x' }));
      links.connection.mockReturnValue({ trustHostKey });
      health.probe.mockClear();

      await service.trustHostKey('api-linux', 'SHA256:x');

      expect(trustHostKey).toHaveBeenCalledWith('SHA256:x');
      expect(health.invalidate).toHaveBeenCalledWith('api-linux');
      expect(health.probe).toHaveBeenCalled();
    });

    it('works on a disabled server so the user can repair it', async () => {
      await service.update('api-linux', { enabled: false });
      links.connection.mockReturnValue({ scanHostKeys: vi.fn(async () => ({ keys: [] })) });

      await service.scanHostKey('api-linux');

      expect(links.connection).toHaveBeenCalledWith('api-linux', { allowDisabled: true });
    });
  });
});
