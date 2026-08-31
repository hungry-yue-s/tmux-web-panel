import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ServerRegistry, LOCAL_SERVER_ID, isValidHost, slugify, normalizeServerInput } from '../server/servers/registry.js';
import { ErrorCode } from '../server/servers/errors.js';

const REMOTE = {
  name: 'API Linux',
  address: { host: '10.0.0.21', port: 22, user: 'deploy' },
  ssh: { identityFile: '~/.ssh/id_ed25519' },
};

describe('ServerRegistry', () => {
  let dir;
  let registry;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'server-registry-'));
    registry = new ServerRegistry({ configDir: dir });
    await registry.load();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('requires a configDir', () => {
    expect(() => new ServerRegistry({})).toThrow(/configDir/);
  });

  it('synthesizes an immutable local server without writing it to disk', async () => {
    const list = registry.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: LOCAL_SERVER_ID, kind: 'local', immutable: true });

    await expect(fs.access(path.join(dir, 'servers.json'))).rejects.toThrow();
  });

  it('creates a remote server and derives a url-safe id', async () => {
    const created = await registry.create(REMOTE);

    expect(created.id).toBe('api-linux');
    expect(created.kind).toBe('remote');
    expect(created.address).toEqual({ host: '10.0.0.21', port: 22, user: 'deploy' });
    expect(created.createdAt).toBeTruthy();
    expect(registry.list().map((s) => s.id)).toEqual([LOCAL_SERVER_ID, 'api-linux']);
  });

  it('deduplicates generated ids', async () => {
    const a = await registry.create(REMOTE);
    const b = await registry.create(REMOTE);
    expect(a.id).toBe('api-linux');
    expect(b.id).toBe('api-linux-2');
  });

  it('rejects a duplicate explicit id and the reserved local id', async () => {
    await registry.create({ ...REMOTE, id: 'box' });
    await expect(registry.create({ ...REMOTE, id: 'box' })).rejects.toMatchObject({
      code: ErrorCode.SERVER_EXISTS,
    });
    await expect(registry.create({ ...REMOTE, id: LOCAL_SERVER_ID })).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
    });
  });

  it('persists atomically with 0600 file and 0700 directory permissions', async () => {
    await registry.create(REMOTE);

    const filePath = path.join(dir, 'servers.json');
    const fileStat = await fs.stat(filePath);
    const dirStat = await fs.stat(dir);
    expect(fileStat.mode & 0o777).toBe(0o600);
    expect(dirStat.mode & 0o777).toBe(0o700);

    // No temp file left behind by the rename.
    const entries = await fs.readdir(dir);
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
  });

  it('round-trips through a reload', async () => {
    await registry.create(REMOTE);
    const reloaded = await new ServerRegistry({ configDir: dir }).load();

    expect(reloaded.get('api-linux')).toMatchObject({
      name: 'API Linux',
      address: { host: '10.0.0.21', port: 22, user: 'deploy' },
    });
    expect(reloaded.loadErrors).toEqual([]);
    expect(reloaded.writesBlocked).toBe(false);
  });

  it('never stores secrets', async () => {
    await expect(registry.create({ ...REMOTE, ssh: { password: 'hunter2' } })).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
    });
    await expect(registry.create({ ...REMOTE, ssh: { privateKey: '-----BEGIN' } })).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
    });

    await registry.create(REMOTE);
    const raw = await fs.readFile(path.join(dir, 'servers.json'), 'utf8');
    expect(raw).not.toMatch(/password|passphrase|privateKey|BEGIN OPENSSH/i);
  });

  it('keeps the identity file path out of API responses', async () => {
    const created = await registry.create(REMOTE);
    const publicView = registry.toPublic(created);

    expect(publicView.ssh).toEqual({ configHost: null, usesIdentityFile: true, usesProxyJump: false });
    expect(JSON.stringify(publicView)).not.toContain('id_ed25519');
  });

  describe('validation', () => {
    it('rejects control characters and oversized fields', async () => {
      await expect(registry.create({ ...REMOTE, name: 'bad\u0000name' })).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
      });
      await expect(registry.create({ ...REMOTE, name: 'x'.repeat(65) })).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
      });
    });

    it('rejects hosts that could smuggle ssh options', async () => {
      for (const host of ['-oProxyCommand=curl evil.sh', 'a b', 'host;rm -rf /', 'host$(id)']) {
        await expect(registry.create({ ...REMOTE, address: { host } })).rejects.toMatchObject({
          code: ErrorCode.VALIDATION_ERROR,
          details: { field: 'address.host' },
        });
      }
    });

    it('accepts IPv6 hosts, bracketed and with a zone', () => {
      expect(isValidHost('::1')).toBe(true);
      expect(isValidHost('[2001:db8::1]')).toBe(true);
      expect(isValidHost('fe80::1%en0')).toBe(true);
      expect(isValidHost('2001:db8::1')).toBe(true);
      expect(isValidHost('example.com')).toBe(true);
      expect(isValidHost('10.0.0.5')).toBe(true);
      expect(isValidHost('not:a:host')).toBe(false);
      expect(isValidHost('')).toBe(false);
    });

    it('stores an IPv6 host unchanged', async () => {
      const created = await registry.create({ ...REMOTE, address: { host: '[2001:db8::1]', user: 'deploy' } });
      expect(created.address.host).toBe('[2001:db8::1]');
    });

    it('accepts identity file paths containing spaces', async () => {
      const created = await registry.create({
        ...REMOTE,
        ssh: { identityFile: '/Users/me/My Keys/id_ed25519' },
      });
      expect(created.ssh.identityFile).toBe('/Users/me/My Keys/id_ed25519');
    });

    it('rejects a non-boolean enabled flag', async () => {
      await expect(registry.create({ ...REMOTE, enabled: 'false' })).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
        details: { field: 'enabled' },
      });
      await expect(registry.create({ ...REMOTE, enabled: 0 })).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
      });
    });

    it('validates the port range', async () => {
      for (const port of [0, 65536, -1, 'ssh', 22.5]) {
        await expect(registry.create({ ...REMOTE, address: { host: 'h', port } })).rejects.toMatchObject({
          code: ErrorCode.VALIDATION_ERROR,
          details: { field: 'address.port' },
        });
      }
      const created = await registry.create({ ...REMOTE, address: { host: 'h', port: '2222' } });
      expect(created.address.port).toBe(2222);
    });

    it('defaults the port to 22', () => {
      expect(normalizeServerInput({ name: 'x', address: { host: 'h' } }).address.port).toBe(22);
    });

    it('allows omitting host when a ssh config alias is given', () => {
      const normalized = normalizeServerInput({ name: 'x', ssh: { configHost: 'build-mac' } });
      expect(normalized.ssh.configHost).toBe('build-mac');
      expect(normalized.address.host).toBeNull();
    });

    it('requires host when there is no config alias', () => {
      expect(() => normalizeServerInput({ name: 'x' })).toThrow(/address.host is required/);
    });
  });

  describe('update', () => {
    it('renames without touching the id or createdAt', async () => {
      const created = await registry.create(REMOTE);
      const updated = await registry.update('api-linux', { name: 'Renamed' });

      expect(updated.id).toBe('api-linux');
      expect(updated.name).toBe('Renamed');
      expect(updated.createdAt).toBe(created.createdAt);
      expect(updated.address).toEqual(created.address);
    });

    it('refuses to change the id', async () => {
      await registry.create(REMOTE);
      await expect(registry.update('api-linux', { id: 'other', name: 'x' })).rejects.toMatchObject({
        code: ErrorCode.SERVER_IMMUTABLE,
      });
    });

    it('allows renaming local but not rewiring it', async () => {
      const renamed = await registry.update(LOCAL_SERVER_ID, { name: 'This Mac' });
      expect(renamed.name).toBe('This Mac');

      const reloaded = await new ServerRegistry({ configDir: dir }).load();
      expect(reloaded.get(LOCAL_SERVER_ID).name).toBe('This Mac');

      await expect(
        registry.update(LOCAL_SERVER_ID, { name: 'x', address: { host: 'elsewhere' } }),
      ).rejects.toMatchObject({ code: ErrorCode.SERVER_IMMUTABLE });
    });

    it('reports a missing server', async () => {
      await expect(registry.update('ghost', { name: 'x' })).rejects.toMatchObject({
        code: ErrorCode.SERVER_NOT_FOUND,
      });
    });
  });

  describe('remove', () => {
    it('removes a remote server', async () => {
      await registry.create(REMOTE);
      await registry.remove('api-linux');
      expect(registry.get('api-linux')).toBeNull();
      expect(registry.has('api-linux')).toBe(false);
    });

    it('refuses to remove the local server', async () => {
      await expect(registry.remove(LOCAL_SERVER_ID)).rejects.toMatchObject({
        code: ErrorCode.SERVER_IMMUTABLE,
      });
    });
  });

  describe('corrupt files', () => {
    it('keeps valid entries when one entry is invalid', async () => {
      await fs.writeFile(
        path.join(dir, 'servers.json'),
        JSON.stringify({
          version: 1,
          servers: [
            { id: 'good', name: 'Good', address: { host: '10.0.0.1', port: 22 }, ssh: {} },
            { id: 'BAD ID', name: 'Bad', address: { host: '10.0.0.2' }, ssh: {} },
            { id: 'nohost', name: 'No host', address: {}, ssh: {} },
          ],
        }),
        'utf8',
      );

      const loaded = await new ServerRegistry({ configDir: dir }).load();

      expect(loaded.listRemote().map((s) => s.id)).toEqual(['good']);
      expect(loaded.loadErrors).toHaveLength(2);
      expect(loaded.writesBlocked).toBe(false);
    });

    it('drops a duplicate id but keeps the first occurrence', async () => {
      await fs.writeFile(
        path.join(dir, 'servers.json'),
        JSON.stringify({
          version: 1,
          servers: [
            { id: 'dup', name: 'First', address: { host: '10.0.0.1' }, ssh: {} },
            { id: 'dup', name: 'Second', address: { host: '10.0.0.2' }, ssh: {} },
          ],
        }),
        'utf8',
      );

      const loaded = await new ServerRegistry({ configDir: dir }).load();
      expect(loaded.listRemote()).toHaveLength(1);
      expect(loaded.get('dup').name).toBe('First');
      expect(loaded.loadErrors).toHaveLength(1);
    });

    it('blocks writes and preserves the file when JSON is unparseable', async () => {
      const filePath = path.join(dir, 'servers.json');
      const corrupt = '{ "servers": [ this is not json';
      await fs.writeFile(filePath, corrupt, 'utf8');

      const loaded = await new ServerRegistry({ configDir: dir }).load();

      expect(loaded.writesBlocked).toBe(true);
      expect(loaded.writeBlockReason).toBe('file_unparseable');
      expect(loaded.loadErrors).toEqual([{ id: null, reason: 'file_unparseable' }]);

      // Any mutation must be refused rather than clobbering the user's file.
      await expect(loaded.create(REMOTE)).rejects.toThrow(/refusing to overwrite/);
      await expect(fs.readFile(filePath, 'utf8')).resolves.toBe(corrupt);

      // And the refused server must not linger in memory as a phantom entry.
      expect(loaded.listRemote()).toEqual([]);
      expect(loaded.get('api-linux')).toBeNull();
      expect(loaded.has('api-linux')).toBe(false);
      expect(loaded.list().map((s) => s.id)).toEqual([LOCAL_SERVER_ID]);
    });

    it('refuses a rename on a corrupt registry without changing memory', async () => {
      await fs.writeFile(path.join(dir, 'servers.json'), 'not json at all', 'utf8');
      const loaded = await new ServerRegistry({ configDir: dir }).load();

      await expect(loaded.update(LOCAL_SERVER_ID, { name: 'Renamed' })).rejects.toThrow(/refusing to overwrite/);
      expect(loaded.get(LOCAL_SERVER_ID).name).toBe('本机');
    });

    it('ignores a missing file and stays writable', async () => {
      const loaded = await new ServerRegistry({ configDir: path.join(dir, 'fresh') }).load();
      expect(loaded.loadErrors).toEqual([]);
      expect(loaded.writesBlocked).toBe(false);
      await expect(loaded.create(REMOTE)).resolves.toBeTruthy();
    });

    it('accepts a bare array for forward/backward compatibility', async () => {
      await fs.writeFile(
        path.join(dir, 'servers.json'),
        JSON.stringify([{ id: 'plain', name: 'Plain', address: { host: '10.0.0.9' }, ssh: {} }]),
        'utf8',
      );
      const loaded = await new ServerRegistry({ configDir: dir }).load();
      expect(loaded.get('plain').name).toBe('Plain');
    });
  });

  describe('write failures roll back memory', () => {
    it('drops a created server when the write fails', async () => {
      registry._writeUnsafe = async () => { throw new Error('ENOSPC'); };

      await expect(registry.create(REMOTE)).rejects.toThrow('ENOSPC');
      expect(registry.listRemote()).toEqual([]);
      expect(registry.get('api-linux')).toBeNull();
    });

    it('restores the previous record when an update fails', async () => {
      const created = await registry.create(REMOTE);
      registry._writeUnsafe = async () => { throw new Error('EIO'); };

      await expect(registry.update('api-linux', { name: 'Broken' })).rejects.toThrow('EIO');
      expect(registry.get('api-linux')).toEqual(created);
    });

    it('restores a removed server, preserving order, when the write fails', async () => {
      await registry.create({ ...REMOTE, id: 'one', name: 'One' });
      await registry.create({ ...REMOTE, id: 'two', name: 'Two' });
      await registry.create({ ...REMOTE, id: 'three', name: 'Three' });
      registry._writeUnsafe = async () => { throw new Error('EROFS'); };

      await expect(registry.remove('two')).rejects.toThrow('EROFS');
      expect(registry.listRemote().map((s) => s.id)).toEqual(['one', 'two', 'three']);
    });

    it('restores the local alias when its write fails', async () => {
      registry._writeUnsafe = async () => { throw new Error('EIO'); };

      await expect(registry.update(LOCAL_SERVER_ID, { name: 'Nope' })).rejects.toThrow('EIO');
      expect(registry.get(LOCAL_SERVER_ID).name).toBe('本机');
    });
  });

  it('reload drops records that are no longer in the file', async () => {
    await registry.create({ ...REMOTE, id: 'keep', name: 'Keep' });
    await registry.create({ ...REMOTE, id: 'gone', name: 'Gone' });
    await registry.update(LOCAL_SERVER_ID, { name: 'Aliased' });
    expect(registry.listRemote().map((s) => s.id)).toEqual(['keep', 'gone']);

    // Rewrite the file behind the registry's back, then reload the same instance.
    await fs.writeFile(
      path.join(dir, 'servers.json'),
      JSON.stringify({ version: 1, servers: [{ id: 'keep', name: 'Keep', address: { host: '10.0.0.21' }, ssh: {} }] }),
      'utf8',
    );
    await registry.load();

    expect(registry.listRemote().map((s) => s.id)).toEqual(['keep']);
    expect(registry.get('gone')).toBeNull();
    expect(registry.has('gone')).toBe(false);
    expect(registry.get(LOCAL_SERVER_ID).name).toBe('本机');
  });

  it('serializes concurrent writes without losing entries', async () => {
    await Promise.all([
      registry.create({ ...REMOTE, id: 'one', name: 'One' }),
      registry.create({ ...REMOTE, id: 'two', name: 'Two' }),
      registry.create({ ...REMOTE, id: 'three', name: 'Three' }),
    ]);

    const reloaded = await new ServerRegistry({ configDir: dir }).load();
    expect(reloaded.listRemote().map((s) => s.id).sort()).toEqual(['one', 'three', 'two']);
  });
});

describe('slugify', () => {
  it('produces url-safe ids', () => {
    expect(slugify('API Linux')).toBe('api-linux');
    expect(slugify('  Build Mac  ')).toBe('build-mac');
    expect(slugify('a//b')).toBe('a-b');
    expect(slugify('本机')).toBe('server');
    expect(slugify('')).toBe('server');
  });
});
