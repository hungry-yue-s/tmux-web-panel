import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { LinkPool } from '../server/hub/link-pool.js';
import { ServerRegistry, LOCAL_SERVER_ID } from '../server/servers/registry.js';
import { ErrorCode } from '../server/servers/errors.js';

const REMOTE = { name: 'API Linux', address: { host: '10.0.0.21', port: 22, user: 'deploy' }, ssh: {} };

describe('LinkPool', () => {
  let dir;
  let registry;
  let pool;
  let created;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'link-pool-'));
    registry = new ServerRegistry({ configDir: dir });
    await registry.load();
    await registry.create(REMOTE);
    created = [];
    pool = new LinkPool({
      registry,
      configDir: dir,
      createConnection: (server) => ({ id: server.id, server }),
      createLink: (connection) => {
        const link = { connection, close: vi.fn() };
        created.push(link);
        return link;
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

  it('closes links on invalidate and on shutdown', () => {
    const first = pool.link('api-linux');
    pool.invalidate('api-linux');
    expect(first.close).toHaveBeenCalledOnce();

    const second = pool.link('api-linux');
    pool.closeAll();
    expect(second.close).toHaveBeenCalledOnce();
  });
});
