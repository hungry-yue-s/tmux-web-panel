import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ExecutorPool } from '../server/transport/executor-pool.js';
import { OpenSSHExecutor } from '../server/transport/openssh-executor.js';
import { ServerRegistry, LOCAL_SERVER_ID } from '../server/servers/registry.js';
import { ErrorCode } from '../server/servers/errors.js';
import { localExecutor } from '../server/tmux.js';

const REMOTE = {
  id: 'api-linux',
  name: 'API Linux',
  address: { host: '10.0.0.21', port: 22, user: 'deploy' },
  ssh: {},
};

describe('ExecutorPool', () => {
  let dir;
  let registry;
  let pool;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'executor-pool-'));
    registry = new ServerRegistry({ configDir: dir });
    await registry.load();
    pool = new ExecutorPool({ registry, configDir: dir });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('requires a registry and a configDir', () => {
    expect(() => new ExecutorPool({ configDir: dir })).toThrow(/registry/);
    expect(() => new ExecutorPool({ registry })).toThrow(/configDir/);
  });

  it('returns the shared frozen local executor on repeated lookups', () => {
    const first = pool.get(LOCAL_SERVER_ID);
    // The local executor is frozen; a second lookup must not try to mutate it.
    const second = pool.get(LOCAL_SERVER_ID);
    const third = pool.get(LOCAL_SERVER_ID);

    expect(first).toBe(localExecutor);
    expect(second).toBe(localExecutor);
    expect(third).toBe(localExecutor);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('keeps returning the same local tmux api', () => {
    expect(pool.tmuxFor(LOCAL_SERVER_ID)).toBe(pool.tmuxFor(LOCAL_SERVER_ID));
  });

  it('survives a local rename without throwing on the frozen executor', async () => {
    pool.get(LOCAL_SERVER_ID);
    await registry.update(LOCAL_SERVER_ID, { name: 'This Mac' });

    expect(() => pool.get(LOCAL_SERVER_ID)).not.toThrow();
    expect(pool.get(LOCAL_SERVER_ID)).toBe(localExecutor);
  });

  it('reuses one remote executor so a pending host-key scan survives requests', async () => {
    await registry.create(REMOTE);

    const first = pool.get('api-linux');
    first._pendingScan = { marker: 'kept' };
    const second = pool.get('api-linux');

    expect(second).toBe(first);
    expect(second._pendingScan).toEqual({ marker: 'kept' });
    expect(first).toBeInstanceOf(OpenSSHExecutor);
  });

  it('refreshes the record on a rename but keeps the pending scan', async () => {
    await registry.create(REMOTE);
    const executor = pool.get('api-linux');
    executor._pendingScan = { marker: 'kept' };

    await registry.update('api-linux', { name: 'Renamed' });
    const again = pool.get('api-linux');

    expect(again).toBe(executor);
    expect(again.server.name).toBe('Renamed');
    expect(again._pendingScan).toEqual({ marker: 'kept' });
  });

  it('replaces the executor when the connection changes, dropping the scan', async () => {
    await registry.create(REMOTE);
    const executor = pool.get('api-linux');
    executor._pendingScan = { marker: 'stale' };

    await registry.update('api-linux', { name: 'API Linux', address: { host: '10.0.0.99' } });
    const replaced = pool.get('api-linux');

    expect(replaced).not.toBe(executor);
    expect(replaced._pendingScan).toBeNull();
    expect(replaced.server.address.host).toBe('10.0.0.99');
  });

  it('replaces the executor when the port, user or identity file changes', async () => {
    await registry.create(REMOTE);
    let executor = pool.get('api-linux');

    for (const patch of [
      { address: { host: '10.0.0.21', port: 2222 } },
      { address: { host: '10.0.0.21', port: 2222, user: 'root' } },
      { ssh: { identityFile: '~/.ssh/other' } },
      { ssh: { proxyJump: 'bastion' } },
      { ssh: { knownHostAlias: 'canon' } },
    ]) {
      await registry.update('api-linux', patch);
      const next = pool.get('api-linux');
      expect(next).not.toBe(executor);
      executor = next;
    }
  });

  it('refuses to execute against a disabled server', async () => {
    await registry.create(REMOTE);
    await registry.update('api-linux', { enabled: false });

    expect(() => pool.get('api-linux')).toThrow(expect.objectContaining({ code: ErrorCode.SERVER_DISABLED }));
    expect(() => pool.tmuxFor('api-linux')).toThrow(expect.objectContaining({ code: ErrorCode.SERVER_DISABLED }));
    // Host-key repair flows may opt in explicitly.
    expect(() => pool.get('api-linux', { allowDisabled: true })).not.toThrow();
  });

  it('reports an unknown server', () => {
    expect(() => pool.get('ghost')).toThrow(expect.objectContaining({ code: ErrorCode.SERVER_NOT_FOUND }));
  });

  it('rejects remote-only actions on the local server', () => {
    expect(() => pool.requireRemote(LOCAL_SERVER_ID)).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION_ERROR }),
    );
  });

  it('invalidate forces a new executor', async () => {
    await registry.create(REMOTE);
    const first = pool.get('api-linux');
    pool.invalidate('api-linux');
    expect(pool.get('api-linux')).not.toBe(first);
  });

  it('binds a separate tmux api per server', async () => {
    await registry.create(REMOTE);
    expect(pool.tmuxFor('api-linux')).not.toBe(pool.tmuxFor(LOCAL_SERVER_ID));
  });
});
