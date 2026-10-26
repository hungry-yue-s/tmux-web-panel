import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  HealthService,
  ServerState,
  IDLE_POLL_MS,
  VIEWED_POLL_MS,
  statusFromNodeInfo,
} from '../server/servers/health-service.js';
import { ServerRegistry, LOCAL_SERVER_ID } from '../server/servers/registry.js';
import { AppError, ErrorCode } from '../server/servers/errors.js';

const REMOTE = {
  id: 'api-linux',
  name: 'API Linux',
  address: { host: '10.0.0.21', port: 22, user: 'deploy' },
  ssh: {},
};

/** What a node's /api/node/info answers. */
function nodeInfo({ hostname = 'api-01', platform = 'linux', tmux = '3.5a', reason = null, version = '1.0.0' } = {}) {
  return {
    protocol: 1,
    version,
    hostname,
    platform,
    arch: 'x64',
    tmux: { available: Boolean(tmux), version: tmux, reason: tmux ? null : reason || 'command_not_found' },
    capabilities: {
      metrics: { available: true, level: 'full' },
      files: { available: true },
      processStats: { available: platform !== 'windows' },
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('statusFromNodeInfo', () => {
  it('derives the whole status from one node self-description', () => {
    const status = statusFromNodeInfo('api-linux', nodeInfo(), { transport: 'ssh', latencyMs: 12, now: 0 });
    expect(status).toMatchObject({
      serverId: 'api-linux',
      state: ServerState.ONLINE,
      latencyMs: 12,
      facts: { hostname: 'api-01', platform: 'linux', arch: 'x64', version: '1.0.0' },
      workspace: { provider: 'tmux', transport: 'ssh', persistence: 'tmux' },
    });
    expect(status.capabilities).toMatchObject({
      ssh: { available: true },
      tmux: { available: true, version: '3.5a' },
      files: { available: true },
    });
  });

  it('is degraded with no workspace when the node has no usable tmux', () => {
    const status = statusFromNodeInfo('x', nodeInfo({ tmux: null }), { transport: 'local', latencyMs: 1, now: 0 });
    expect(status.state).toBe(ServerState.DEGRADED);
    expect(status.capabilities.tmux).toMatchObject({ available: false, reason: 'command_not_found' });
    expect(status.workspace.provider).toBe('unavailable');
  });
});

describe('HealthService', () => {
  let dir;
  let registry;
  let now;
  let statuses;
  let localInfo;
  let remoteInfo;
  let links;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'server-health-'));
    registry = new ServerRegistry({ configDir: dir });
    await registry.load();
    now = 1_000_000;
    statuses = [];
    localInfo = vi.fn(async () => nodeInfo({ hostname: 'panel-host' }));
    remoteInfo = vi.fn(async () => nodeInfo());
    links = { link: vi.fn(() => ({ info: remoteInfo })) };
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function makeService() {
    return new HealthService({
      registry,
      links,
      localInfo,
      now: () => now,
      onStatus: (status) => statuses.push(status),
    });
  }

  it('requires a registry, a link pool and local info', () => {
    expect(() => new HealthService({ links, localInfo })).toThrow(/registry/);
    expect(() => new HealthService({ registry, localInfo })).toThrow(/link pool/);
    expect(() => new HealthService({ registry, links })).toThrow(/localInfo/);
  });

  it('starts unknown rather than pretending to be online', () => {
    const health = makeService();
    expect(health.getStatus(LOCAL_SERVER_ID)).toMatchObject({
      state: ServerState.UNKNOWN,
      latencyMs: null,
      checkedAt: null,
    });
  });

  describe('local server', () => {
    it('reports this node in-process, without a link', async () => {
      const status = await makeService().probe(LOCAL_SERVER_ID);

      expect(links.link).not.toHaveBeenCalled();
      expect(status.state).toBe(ServerState.ONLINE);
      expect(status.facts.hostname).toBe('panel-host');
      expect(status.workspace).toEqual({ provider: 'tmux', transport: 'local', persistence: 'tmux' });
    });

    it('degrades when tmux is missing', async () => {
      localInfo.mockResolvedValue(nodeInfo({ tmux: null }));
      const status = await makeService().probe(LOCAL_SERVER_ID);
      expect(status.state).toBe(ServerState.DEGRADED);
      expect(status.workspace.provider).toBe('unavailable');
    });
  });

  describe('remote server', () => {
    beforeEach(async () => {
      await registry.create(REMOTE);
    });

    it('asks the node over its link', async () => {
      const status = await makeService().probe('api-linux');

      expect(links.link).toHaveBeenCalledWith('api-linux');
      expect(remoteInfo).toHaveBeenCalledTimes(1);
      expect(status.state).toBe(ServerState.ONLINE);
      expect(status.facts).toMatchObject({ hostname: 'api-01', platform: 'linux' });
      expect(status.workspace).toEqual({ provider: 'tmux', transport: 'ssh', persistence: 'tmux' });
    });

    it('reports a Windows node like any other', async () => {
      remoteInfo.mockResolvedValue(nodeInfo({ platform: 'windows', tmux: '3.8' }));
      const status = await makeService().probe('api-linux');
      expect(status.state).toBe(ServerState.ONLINE);
      expect(status.facts.platform).toBe('windows');
      expect(status.capabilities.tmux.version).toBe('3.8');
    });

    const errorCases = [
      [ErrorCode.SSH_AUTH_REQUIRED, ServerState.AUTH_REQUIRED],
      [ErrorCode.SSH_HOST_KEY_UNKNOWN, ServerState.HOST_KEY_ERROR],
      [ErrorCode.SSH_HOST_KEY_CHANGED, ServerState.HOST_KEY_ERROR],
      [ErrorCode.SSH_TIMEOUT, ServerState.OFFLINE],
      [ErrorCode.SERVER_OFFLINE, ServerState.OFFLINE],
      [ErrorCode.NODE_NOT_INSTALLED, ServerState.OFFLINE],
      [ErrorCode.NODE_NOT_RUNNING, ServerState.OFFLINE],
      [ErrorCode.NODE_INCOMPATIBLE, ServerState.OFFLINE],
    ];

    for (const [code, expected] of errorCases) {
      it(`maps ${code} to ${expected} and keeps the code for the repair hint`, async () => {
        remoteInfo.mockRejectedValue(new AppError(code, 'nope'));

        const status = await makeService().probe('api-linux');

        expect(status.state).toBe(expected);
        expect(status.error.code).toBe(code);
        expect(status.workspace.provider).toBe('unavailable');
      });
    }

    it('keeps the last success time when a probe fails', async () => {
      const health = makeService();
      await health.probe('api-linux');
      const firstOnline = health.getStatus('api-linux').lastOnlineAt;

      now += 60_000;
      remoteInfo.mockRejectedValue(new AppError(ErrorCode.SERVER_OFFLINE, 'gone'));
      const status = await health.probe('api-linux');

      expect(status.state).toBe(ServerState.OFFLINE);
      expect(status.lastOnlineAt).toBe(firstOnline);
      expect(status.latencyMs).toBeNull();
    });

    it('backs off on consecutive failures up to five minutes', async () => {
      const health = makeService();
      remoteInfo.mockRejectedValue(new AppError(ErrorCode.SERVER_OFFLINE, 'gone'));

      const observed = [];
      for (let i = 0; i < 5; i += 1) {
        await health.probe('api-linux', { force: true });
        observed.push(health._entry('api-linux').nextPollAt - now);
      }

      expect(observed).toEqual([30_000, 60_000, 120_000, 300_000, 300_000]);
    });

    it('polls the viewed server more often than idle ones', async () => {
      const health = makeService();
      health.setViewedServer('api-linux');

      await health.probe('api-linux');
      expect(health._entry('api-linux').nextPollAt - now).toBe(VIEWED_POLL_MS);

      health.setViewedServer(LOCAL_SERVER_ID);
      await health.probe('api-linux', { force: true });
      expect(health._entry('api-linux').nextPollAt - now).toBe(IDLE_POLL_MS);
    });

    it('collapses concurrent probes onto one in-flight request', async () => {
      const health = makeService();
      const gate = deferred();
      remoteInfo.mockImplementation(() => gate.promise);

      const all = Promise.all([health.probe('api-linux'), health.probe('api-linux'), health.probe('api-linux')]);
      gate.resolve(nodeInfo());
      await all;

      expect(remoteInfo).toHaveBeenCalledTimes(1);
    });
  });

  describe('generation guards', () => {
    beforeEach(async () => {
      await registry.create(REMOTE);
    });

    it('discards a probe that finishes after the server was edited', async () => {
      const health = makeService();
      const gate = deferred();
      remoteInfo.mockImplementation(() => gate.promise);

      const inFlight = health.probe('api-linux');
      health.invalidate('api-linux'); // stands in for an edit
      gate.resolve(nodeInfo({ hostname: 'stale-host' }));
      await inFlight;

      expect(health.getStatus('api-linux').state).toBe(ServerState.UNKNOWN);
      expect(health.getStatus('api-linux').facts.hostname).not.toBe('stale-host');
    });

    it('a forced probe wins even when a slower probe finishes last', async () => {
      const health = makeService();
      const slow = deferred();
      const fast = deferred();
      remoteInfo
        .mockImplementationOnce(() => slow.promise)
        .mockImplementationOnce(() => fast.promise);

      const slowProbe = health.probe('api-linux');
      const forcedProbe = health.probe('api-linux', { force: true });

      fast.resolve(nodeInfo({ hostname: 'fresh-host' }));
      await forcedProbe;
      expect(health.getStatus('api-linux').facts.hostname).toBe('fresh-host');

      slow.resolve(nodeInfo({ hostname: 'stale-host' }));
      await slowProbe;

      expect(health.getStatus('api-linux').facts.hostname).toBe('fresh-host');
      expect(remoteInfo).toHaveBeenCalledTimes(2);
    });

    it('a stale failure cannot overwrite a forced success', async () => {
      const health = makeService();
      const slow = deferred();
      const fast = deferred();
      remoteInfo
        .mockImplementationOnce(() => slow.promise)
        .mockImplementationOnce(() => fast.promise);

      const slowProbe = health.probe('api-linux');
      const forcedProbe = health.probe('api-linux', { force: true });

      fast.resolve(nodeInfo());
      await forcedProbe;
      slow.reject(new AppError(ErrorCode.SERVER_OFFLINE, 'late failure'));
      await slowProbe;

      expect(health.getStatus('api-linux').state).toBe(ServerState.ONLINE);
      expect(health.getStatus('api-linux').error).toBeNull();
    });

    it('forget stops a late result from resurrecting a deleted server', async () => {
      const health = makeService();
      const gate = deferred();
      remoteInfo.mockImplementation(() => gate.promise);

      const inFlight = health.probe('api-linux');
      health.forget('api-linux');
      gate.resolve(nodeInfo());
      await inFlight;

      expect(health._entries.has('api-linux')).toBe(false);
    });
  });

  describe('disabled servers', () => {
    beforeEach(async () => {
      await registry.create(REMOTE);
      await registry.update('api-linux', { enabled: false });
    });

    it('reports disabled without opening a link', async () => {
      const status = await makeService().probe('api-linux');

      expect(status.state).toBe(ServerState.DISABLED);
      expect(links.link).not.toHaveBeenCalled();
    });

    it('publishes the disabled transition once, not on every tick', async () => {
      const health = makeService();
      await health.probe('api-linux');
      const afterFirst = statuses.filter((s) => s.serverId === 'api-linux').length;

      for (let i = 0; i < 4; i += 1) {
        now += IDLE_POLL_MS + 1_000;
        await health.tick();
      }

      expect(statuses.filter((s) => s.serverId === 'api-linux')).toHaveLength(afterFirst);
    });

    it('advances nextPollAt so the scheduler does not spin', async () => {
      const health = makeService();
      await health.probe('api-linux');
      expect(health._entry('api-linux').nextPollAt).toBe(now + IDLE_POLL_MS);
    });

    it('tick skips disabled servers entirely', async () => {
      const health = makeService();
      await health.tick();

      expect(links.link).not.toHaveBeenCalled();
      expect(statuses.some((s) => s.serverId === 'api-linux')).toBe(false);
      expect(statuses.some((s) => s.serverId === LOCAL_SERVER_ID)).toBe(true);
    });

    it('resumes probing once re-enabled', async () => {
      const health = makeService();
      await health.probe('api-linux');
      await registry.update('api-linux', { enabled: true });
      health.invalidate('api-linux');

      const status = await health.probe('api-linux');
      expect(status.state).toBe(ServerState.ONLINE);
    });
  });

  describe('tick scheduling', () => {
    it('only probes servers whose time has come', async () => {
      await registry.create(REMOTE);
      const health = makeService();

      await health.tick();
      expect(remoteInfo).toHaveBeenCalledTimes(1);

      await health.tick(); // nothing is due yet
      expect(remoteInfo).toHaveBeenCalledTimes(1);

      now += IDLE_POLL_MS + 1;
      await health.tick();
      expect(remoteInfo).toHaveBeenCalledTimes(2);
    });

    it('surfaces every server in the status map', async () => {
      await registry.create(REMOTE);
      const health = makeService();
      await health.tick();

      expect(Object.keys(health.getAllStatuses()).sort()).toEqual(['api-linux', LOCAL_SERVER_ID].sort());
    });

    it('never lets one failing server block the others', async () => {
      await registry.create(REMOTE);
      remoteInfo.mockRejectedValue(new AppError(ErrorCode.SERVER_OFFLINE, 'gone'));
      const health = makeService();

      await expect(health.tick()).resolves.toBeUndefined();
      expect(health.getStatus(LOCAL_SERVER_ID).state).toBe(ServerState.ONLINE);
      expect(health.getStatus('api-linux').state).toBe(ServerState.OFFLINE);
    });
  });

  it('publishes status updates for subscribers', async () => {
    const health = makeService();
    await health.probe(LOCAL_SERVER_ID);

    const local = statuses.filter((s) => s.serverId === LOCAL_SERVER_ID);
    expect(local[0].state).toBe(ServerState.CHECKING);
    expect(local[local.length - 1].state).toBe(ServerState.ONLINE);
  });

  it('never publishes connection secrets', async () => {
    await registry.create({ ...REMOTE, ssh: { identityFile: '/keys/secret_key' } });
    const health = makeService();
    await health.probe('api-linux');

    expect(JSON.stringify(statuses)).not.toContain('secret_key');
  });
});
