import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { LinkPool, NOT_INSTALLED_TTL_MS } from '../../lib/hub/link-pool.js';
import { AppError } from '../../lib/servers/errors.js';
import { ServerRegistry, LOCAL_SERVER_ID } from '../../lib/servers/registry.js';
import { ErrorCode } from '../../lib/servers/errors.js';

const REMOTE = { name: 'API Linux', address: { host: '10.0.0.21', port: 22, user: 'deploy' }, ssh: {} };

describe('LinkPool', () => {
  let dir;
  let registry;
  let pool;
  let created;
  let basics;
  let now;
  let ensure;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'link-pool-'));
    registry = new ServerRegistry({ configDir: dir });
    await registry.load();
    await registry.create(REMOTE);
    created = [];
    basics = [];
    now = 1_000_000;
    ensure = vi.fn(async () => {});
    pool = new LinkPool({
      registry,
      configDir: dir,
      now: () => now,
      createConnection: (server) => ({ id: server.id, server }),
      createLink: (connection) => {
        const link = { connection, close: vi.fn(), ready: false, ensure };
        created.push(link);
        return link;
      },
      createBasicHost: (connection) => {
        const host = { connection, destroy: vi.fn(), reap: vi.fn() };
        basics.push(host);
        return host;
      },
    });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('keeps one link per server so the forward is shared', () => {
    expect(pool.link('api-linux')).toBe(pool.link('api-linux'));
    expect(pool.connection('api-linux')).toBe(pool.link('api-linux').connection);
    expect(created).toHaveLength(1);
  });

  it('keeps the link across a rename but replaces it when the target changes', async () => {
    const first = pool.link('api-linux');
    await registry.update('api-linux', { name: 'Renamed' });
    expect(pool.link('api-linux')).toBe(first);
    expect(first.connection.server.name).toBe('Renamed');

    await registry.update('api-linux', { address: { host: '10.9.9.9', user: 'deploy' } });
    const second = pool.link('api-linux');
    expect(second).not.toBe(first);
    expect(first.close).toHaveBeenCalled();
  });

  it('refuses the local server and a disabled one, unless repair needs it', async () => {
    expect(() => pool.link(LOCAL_SERVER_ID)).toThrow(/local server/);
    await registry.update('api-linux', { enabled: false });
    expect(() => pool.link('api-linux')).toThrow(expect.objectContaining({ code: ErrorCode.SERVER_DISABLED }));
    expect(pool.connection('api-linux', { allowDisabled: true })).toBeTruthy();
  });

  it('reports node mode once the link pairs', async () => {
    await expect(pool.mode('api-linux')).resolves.toBe('node');
    created[0].ready = true;
    await expect(pool.mode('api-linux')).resolves.toBe('node');
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  it('reports basic mode when the panel is not installed, and trusts that briefly', async () => {
    ensure.mockRejectedValue(new AppError(ErrorCode.NODE_NOT_INSTALLED, 'no pairing file'));
    await expect(pool.mode('api-linux')).resolves.toBe('basic');
    await expect(pool.mode('api-linux')).resolves.toBe('basic');
    expect(ensure).toHaveBeenCalledTimes(1);

    now += NOT_INSTALLED_TTL_MS;
    await pool.mode('api-linux');
    expect(ensure).toHaveBeenCalledTimes(2);

    // After an installation the next request tries pairing again at once.
    ensure.mockResolvedValue();
    pool.recheck('api-linux');
    await expect(pool.mode('api-linux')).resolves.toBe('node');
  });

  it('lets other link failures through rather than guessing a mode', async () => {
    ensure.mockRejectedValue(new AppError(ErrorCode.SSH_AUTH_REQUIRED, 'denied'));
    await expect(pool.mode('api-linux')).rejects.toMatchObject({ code: ErrorCode.SSH_AUTH_REQUIRED });
  });

  it('keeps one basic host per server and ends its shells with the entry', async () => {
    const host = pool.basic('api-linux');
    expect(pool.basic('api-linux')).toBe(host);
    expect(host.connection).toBe(pool.connection('api-linux'));
    pool.reapBasic();
    expect(host.reap).toHaveBeenCalled();
    await registry.update('api-linux', { address: { host: '10.9.9.9', user: 'deploy' } });
    pool.link('api-linux');
    expect(host.destroy).toHaveBeenCalledWith('server_reconfigured');
  });

  it('detects the machine without basic mode, through a basic host when there is one', async () => {
    const bare = new LinkPool({
      registry,
      configDir: dir,
      createConnection: (server) => ({ id: server.id, server, runScript: vi.fn(async () => ({ stdout: 'kernel=Linux\narch=x86_64\nhostname=api\ntmux=tmux 3.4\n' })) }),
      createLink: (connection) => ({ connection, close: vi.fn(), ready: false, ensure }),
    });
    expect(await bare.detect('api-linux')).toMatchObject({ posix: true, platform: 'linux', tmux: { available: true, version: '3.4' } });
    expect(() => bare.basic('api-linux')).toThrow('Basic mode is not available');

    const host = pool.basic('api-linux');
    host.detect = vi.fn(async () => ({ platform: 'darwin' }));
    expect(await pool.detect('api-linux')).toEqual({ platform: 'darwin' });
    expect(host.detect).toHaveBeenCalledWith({ force: true });
  });

  it('ends only the basic hosts when basic mode goes away, keeping the links', () => {
    const link = pool.link('api-linux');
    const host = pool.basic('api-linux');
    pool.closeBasic();
    expect(host.destroy).toHaveBeenCalledWith('basic_unavailable');
    expect(link.close).not.toHaveBeenCalled();
    expect(pool.link('api-linux')).toBe(link);
    expect(pool.basic('api-linux')).not.toBe(host);
  });

  it('closes links on invalidate and on shutdown', () => {
    const first = pool.link('api-linux');
    pool.invalidate('api-linux');
    expect(first.close).toHaveBeenCalledOnce();

    const second = pool.link('api-linux');
    pool.closeAll();
    expect(second.close).toHaveBeenCalledOnce();
  });
});
