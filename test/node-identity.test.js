import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  NODE_PROTOCOL,
  PAIRING_RELATIVE_PATH,
  initNodeIdentity,
  loadOrCreateNodeToken,
  loopbackFor,
  pairingFilePath,
  parsePairing,
} from '../server/node/identity.js';
import { collectNodeInfo, nodePlatform } from '../server/node/info.js';
import { tokenAuth, wsTokenAuth } from '../server/auth.js';

describe('node identity', () => {
  let home;
  let configDir;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'node-identity-'));
    configDir = path.join(home, 'cfg');
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it('keeps the token across restarts so hubs stay paired', async () => {
    const first = await loadOrCreateNodeToken(configDir);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    await expect(loadOrCreateNodeToken(configDir)).resolves.toBe(first);
  });

  it('writes the pairing file at the fixed, SSH-relative location', async () => {
    const identity = await initNodeIdentity({ configDir, port: 7681, listenHost: '0.0.0.0', home });

    expect(identity.pairingPath).toBe(pairingFilePath(home));
    expect(identity.pairingPath).toBe(path.join(home, ...PAIRING_RELATIVE_PATH.split('/')));
    const pairing = JSON.parse(await fs.readFile(identity.pairingPath, 'utf8'));
    expect(pairing).toEqual({
      protocol: NODE_PROTOCOL,
      host: '127.0.0.1',
      port: 7681,
      tls: false,
      tlsFingerprint: null,
      token: await loadOrCreateNodeToken(configDir),
    });
    expect(parsePairing(JSON.stringify(pairing))).toEqual(pairing);
  });

  it.skipIf(process.platform === 'win32')('keeps the pairing file owner-only', async () => {
    const identity = await initNodeIdentity({ configDir, port: 7681, listenHost: '127.0.0.1', home });
    expect((await fs.stat(identity.pairingPath)).mode & 0o777).toBe(0o600);
  });

  it('accepts exactly its own token', async () => {
    const identity = await initNodeIdentity({ configDir, port: 7681, listenHost: '0.0.0.0', home });
    const token = identity.pairing.token;

    expect(identity.isNodeToken(token)).toBe(true);
    expect(identity.isNodeToken('f'.repeat(64))).toBe(false);
    expect(identity.isNodeToken(token.slice(1))).toBe(false);
    expect(identity.isNodeToken(undefined)).toBe(false);
  });

  it('targets loopback for wildcard listeners and keeps a specific address', () => {
    expect(loopbackFor('0.0.0.0')).toBe('127.0.0.1');
    expect(loopbackFor('127.0.0.1')).toBe('127.0.0.1');
    expect(loopbackFor('::')).toBe('::1');
    expect(loopbackFor('192.168.1.5')).toBe('192.168.1.5');
  });

  it('rejects a pairing file a hub must not trust', () => {
    const ok = { protocol: 1, host: '127.0.0.1', port: 7681, tls: false, tlsFingerprint: null, token: 'a'.repeat(64) };
    for (const bad of [
      'not json',
      JSON.stringify({ ...ok, token: 'short' }),
      JSON.stringify({ ...ok, port: 70000 }),
      JSON.stringify({ ...ok, protocol: 0 }),
      JSON.stringify({ ...ok, host: 'a b' }),
      JSON.stringify({ ...ok, tls: true, tlsFingerprint: 'nope' }),
    ]) {
      expect(parsePairing(bad)).toBeNull();
    }
  });
});

describe('collectNodeInfo', () => {
  it('describes the machine and its tmux in one call', async () => {
    const info = await collectNodeInfo({ tmuxVersion: async () => '3.5a', platform: 'linux', arch: 'arm64', host: 'box' });
    expect(info).toMatchObject({
      protocol: NODE_PROTOCOL,
      hostname: 'box',
      platform: 'linux',
      arch: 'arm64',
      tmux: { available: true, version: '3.5a', reason: null },
      capabilities: { files: { available: true }, processStats: { available: true } },
    });
  });

  it('never fails because tmux is missing', async () => {
    const missing = Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' });
    const info = await collectNodeInfo({ tmuxVersion: async () => { throw missing; }, platform: 'win32' });
    expect(info.tmux).toEqual({ available: false, version: null, reason: 'command_not_found' });
    expect(info.platform).toBe('windows');
    expect(info.capabilities.processStats.available).toBe(false);
    expect(nodePlatform('darwin')).toBe('darwin');
  });
});

describe('node token authentication', () => {
  const isServiceToken = (token) => token === 'n'.repeat(64);

  function run(middleware, req) {
    const res = { status: vi.fn(() => res), json: vi.fn(), redirect: vi.fn() };
    const next = vi.fn();
    middleware({ headers: {}, query: {}, ...req }, res, next);
    return { next, res };
  }

  it('accepts a hub\'s node token alongside login tokens', () => {
    const tokens = new Map([['login', { expiresAt: null }]]);
    const auth = tokenAuth(tokens, { isServiceToken });

    expect(run(auth, { headers: { authorization: 'Bearer login' } }).next).toHaveBeenCalled();
    expect(run(auth, { headers: { authorization: 'Bearer ' + 'n'.repeat(64) } }).next).toHaveBeenCalled();
    const denied = run(auth, { headers: { authorization: 'Bearer nope' } });
    expect(denied.next).not.toHaveBeenCalled();
    expect(denied.res.status).toHaveBeenCalledWith(401);
  });

  it('does not accept a node token where none is configured', () => {
    const auth = tokenAuth(new Map());
    expect(run(auth, { headers: { authorization: 'Bearer ' + 'n'.repeat(64) } }).next).not.toHaveBeenCalled();
  });

  it('lets a relayed socket authenticate with the Bearer header', () => {
    const tokens = new Map([['login', { expiresAt: null }]]);
    const req = (headers, url = '/ws/status') => ({ url, headers: { host: 'x', ...headers } });

    expect(wsTokenAuth(tokens, req({ authorization: 'Bearer ' + 'n'.repeat(64) }), { isServiceToken })).toBe(true);
    expect(wsTokenAuth(tokens, req({}, '/ws/status?token=login'), { isServiceToken })).toBe(true);
    expect(wsTokenAuth(tokens, req({ authorization: 'Bearer ' + 'n'.repeat(64) }))).toBe(false);
    expect(wsTokenAuth(tokens, req({ authorization: 'Bearer wrong' }), { isServiceToken })).toBe(false);
  });
});
