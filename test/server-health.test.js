import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  HealthService,
  ServerState,
  FACTS_SCRIPT,
  IDLE_POLL_MS,
  VIEWED_POLL_MS,
  normalizeArch,
  normalizePlatform,
  parseFacts,
  parseTmuxVersion,
} from '../server/servers/health-service.js';
import { ServerRegistry, LOCAL_SERVER_ID } from '../server/servers/registry.js';
import { AppError, ErrorCode } from '../server/servers/errors.js';

const REMOTE = {
  id: 'api-linux',
  name: 'API Linux',
  address: { host: '10.0.0.21', port: 22, user: 'deploy' },
  ssh: {},
};

function factsOutput({ kernel = 'Linux', arch = 'x86_64', hostname = 'api-01', tmux = 'tmux 3.5a' } = {}) {
  const lines = [`kernel=${kernel}`, `arch=${arch}`, `hostname=${hostname}`];
  if (tmux === null) lines.push('tmux_found=0');
  else lines.push('tmux_found=1', `tmux_version=${tmux}`);
  return lines.join('\n') + '\n';
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('fact parsing', () => {
  it('parses key=value probe output', () => {
    expect(parseFacts('kernel=Linux\narch=x86_64\n\nhostname=api-01\n')).toEqual({
      kernel: 'Linux',
      arch: 'x86_64',
      hostname: 'api-01',
    });
  });

  it('keeps values containing = intact', () => {
    expect(parseFacts('tmux_version=tmux 3.5a=beta')).toEqual({ tmux_version: 'tmux 3.5a=beta' });
  });

  it('normalizes platform and arch', () => {
    expect(normalizePlatform('Darwin')).toBe('darwin');
    expect(normalizePlatform('Linux')).toBe('linux');
    expect(normalizePlatform('unknown')).toBeNull();
    expect(normalizeArch('x86_64')).toBe('x64');
    expect(normalizeArch('aarch64')).toBe('arm64');
    expect(normalizeArch('arm64')).toBe('arm64');
    expect(normalizeArch('unknown')).toBeNull();
  });

  it('parses tmux versions and rejects error text', () => {
    expect(parseTmuxVersion('tmux 3.5a')).toBe('3.5a');
    expect(parseTmuxVersion('tmux next-3.6')).toBe('3.6');
    expect(parseTmuxVersion('sh: tmux: command not found')).toBeNull();
    expect(parseTmuxVersion('')).toBeNull();
  });
});

describe('FACTS_SCRIPT', () => {
  it('only reads — it never installs, upgrades or starts tmux', () => {
    expect(FACTS_SCRIPT).toContain('command -v tmux');
    expect(FACTS_SCRIPT).toContain('tmux -V');
    expect(FACTS_SCRIPT).not.toMatch(/apt|yum|brew|dnf|pacman|install|start-server|new-session/);
  });
});

describe('HealthService', () => {
  let dir;
  let registry;
  let now;
  let statuses;
  let runScript;
  let tmuxVersion;
  let pool;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'server-health-'));
    registry = new ServerRegistry({ configDir: dir });
    await registry.load();
    now = 1_000_000;
    statuses = [];
    runScript = vi.fn(async () => ({ stdout: factsOutput(), stderr: '' }));
    tmuxVersion = vi.fn(async () => '3.5a');
    pool = {
      get: vi.fn(() => ({ runScript })),
      tmuxFor: vi.fn(() => ({ version: tmuxVersion })),
    };
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function makeService() {
    return new HealthService({
      registry,
      pool,
      now: () => now,
      onStatus: (status) => statuses.push(status),
    });
  }

  it('requires a registry and a pool', () => {
    expect(() => new HealthService({ pool })).toThrow(/registry/);
    expect(() => new HealthService({ registry })).toThrow(/pool/);
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
    it('reports online with a tmux provider when tmux is usable', async () => {
      const status = await makeService().probe(LOCAL_SERVER_ID);

      expect(status.state).toBe(ServerState.ONLINE);
      expect(status.capabilities.tmux).toMatchObject({ available: true, version: '3.5a' });
      expect(status.workspace).toEqual({ provider: 'tmux', transport: 'local', persistence: 'tmux' });
    });

    it('degrades when the tmux binary is missing', async () => {
      tmuxVersion.mockRejectedValue(Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' }));

      const status = await makeService().probe(LOCAL_SERVER_ID);

      expect(status.state).toBe(ServerState.DEGRADED);
      expect(status.capabilities.tmux).toMatchObject({ available: false, reason: 'command_not_found' });
      expect(status.workspace.provider).toBe('unavailable');
    });

    it('degrades when the version output is unusable', async () => {
      tmuxVersion.mockResolvedValue(null);
      const status = await makeService().probe(LOCAL_SERVER_ID);
      expect(status.state).toBe(ServerState.DEGRADED);
      expect(status.capabilities.tmux.reason).toBe('version_unparseable');
    });
  });

  describe('remote server', () => {
    beforeEach(async () => {
      await registry.create(REMOTE);
    });

    it('selects the tmux provider when tmux exists', async () => {
      const status = await makeService().probe('api-linux');

      expect(runScript).toHaveBeenCalledWith(FACTS_SCRIPT, expect.objectContaining({ timeout: expect.any(Number) }));
      expect(status.state).toBe(ServerState.ONLINE);
      expect(status.facts).toEqual({ hostname: 'api-01', platform: 'linux', arch: 'x64' });
      expect(status.capabilities.tmux).toMatchObject({ available: true, version: '3.5a' });
      expect(status.workspace).toEqual({ provider: 'tmux', transport: 'ssh', persistence: 'tmux' });
    });

    it('falls back to the ssh provider when tmux is absent', async () => {
      runScript.mockResolvedValue({ stdout: factsOutput({ tmux: null }), stderr: '' });

      const status = await makeService().probe('api-linux');

      expect(status.state).toBe(ServerState.ONLINE);
      expect(status.capabilities.tmux).toMatchObject({ available: false, reason: 'command_not_found' });
      expect(status.workspace).toEqual({ provider: 'ssh', transport: 'ssh', persistence: 'process-memory' });
    });

    it('treats an unusable tmux as degraded but still usable over ssh', async () => {
      runScript.mockResolvedValue({
        stdout: factsOutput({ tmux: 'tmux: error while loading shared libraries' }),
        stderr: '',
      });

      const status = await makeService().probe('api-linux');

      expect(status.state).toBe(ServerState.DEGRADED);
      expect(status.capabilities.tmux).toMatchObject({ available: false, reason: 'version_unparseable' });
      expect(status.workspace.provider).toBe('ssh');
    });

    it('marks remote file browsing unsupported rather than reusing local results', async () => {
      const status = await makeService().probe('api-linux');
      expect(status.capabilities.files).toEqual({ available: false, reason: 'unsupported' });
    });

    it('reports no metrics capability for an unknown platform', async () => {
      runScript.mockResolvedValue({ stdout: factsOutput({ kernel: 'SunOS' }), stderr: '' });
      const status = await makeService().probe('api-linux');
      expect(status.capabilities.metrics).toEqual({ available: false, level: 'none' });
    });

    const errorCases = [
      [ErrorCode.SSH_AUTH_REQUIRED, ServerState.AUTH_REQUIRED],
      [ErrorCode.SSH_HOST_KEY_UNKNOWN, ServerState.HOST_KEY_ERROR],
      [ErrorCode.SSH_HOST_KEY_CHANGED, ServerState.HOST_KEY_ERROR],
      [ErrorCode.SSH_TIMEOUT, ServerState.OFFLINE],
      [ErrorCode.SERVER_OFFLINE, ServerState.OFFLINE],
    ];

    for (const [code, expected] of errorCases) {
      it(`maps ${code} to ${expected} without collapsing into a boolean`, async () => {
        runScript.mockRejectedValue(new AppError(code, 'nope'));

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
      runScript.mockRejectedValue(new AppError(ErrorCode.SERVER_OFFLINE, 'gone'));
      const status = await health.probe('api-linux');

      expect(status.state).toBe(ServerState.OFFLINE);
      expect(status.lastOnlineAt).toBe(firstOnline);
      expect(status.latencyMs).toBeNull();
    });

    it('backs off on consecutive failures up to five minutes', async () => {
      const health = makeService();
      runScript.mockRejectedValue(new AppError(ErrorCode.SERVER_OFFLINE, 'gone'));

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
      runScript.mockImplementation(() => gate.promise);

      const all = Promise.all([health.probe('api-linux'), health.probe('api-linux'), health.probe('api-linux')]);
      gate.resolve({ stdout: factsOutput(), stderr: '' });
      await all;

      expect(runScript).toHaveBeenCalledTimes(1);
    });
  });

  describe('generation guards', () => {
    beforeEach(async () => {
      await registry.create(REMOTE);
    });

    it('discards a probe that finishes after the server was edited', async () => {
      const health = makeService();
      const gate = deferred();
      runScript.mockImplementation(() => gate.promise);

      const inFlight = health.probe('api-linux');
      health.invalidate('api-linux'); // stands in for an edit
      gate.resolve({ stdout: factsOutput({ hostname: 'stale-host' }), stderr: '' });
      await inFlight;

      expect(health.getStatus('api-linux').state).toBe(ServerState.UNKNOWN);
      expect(health.getStatus('api-linux').facts.hostname).not.toBe('stale-host');
    });

    it('a forced probe wins even when a slower probe finishes last', async () => {
      const health = makeService();
      const slow = deferred();
      const fast = deferred();
      runScript
        .mockImplementationOnce(() => slow.promise)
        .mockImplementationOnce(() => fast.promise);

      const slowProbe = health.probe('api-linux');
      const forcedProbe = health.probe('api-linux', { force: true });

      // The forced probe answers first, then the orphaned one completes.
      fast.resolve({ stdout: factsOutput({ hostname: 'fresh-host' }), stderr: '' });
      await forcedProbe;
      expect(health.getStatus('api-linux').facts.hostname).toBe('fresh-host');

      slow.resolve({ stdout: factsOutput({ hostname: 'stale-host' }), stderr: '' });
      await slowProbe;

      expect(health.getStatus('api-linux').facts.hostname).toBe('fresh-host');
      expect(runScript).toHaveBeenCalledTimes(2);
    });

    it('a stale failure cannot overwrite a forced success', async () => {
      const health = makeService();
      const slow = deferred();
      const fast = deferred();
      runScript
        .mockImplementationOnce(() => slow.promise)
        .mockImplementationOnce(() => fast.promise);

      const slowProbe = health.probe('api-linux');
      const forcedProbe = health.probe('api-linux', { force: true });

      fast.resolve({ stdout: factsOutput(), stderr: '' });
      await forcedProbe;
      slow.reject(new AppError(ErrorCode.SERVER_OFFLINE, 'late failure'));
      await slowProbe;

      expect(health.getStatus('api-linux').state).toBe(ServerState.ONLINE);
      expect(health.getStatus('api-linux').error).toBeNull();
    });

    it('forget stops a late result from resurrecting a deleted server', async () => {
      const health = makeService();
      const gate = deferred();
      runScript.mockImplementation(() => gate.promise);

      const inFlight = health.probe('api-linux');
      health.forget('api-linux');
      gate.resolve({ stdout: factsOutput(), stderr: '' });
      await inFlight;

      expect(health._entries.has('api-linux')).toBe(false);
    });
  });

  describe('disabled servers', () => {
    beforeEach(async () => {
      await registry.create(REMOTE);
      await registry.update('api-linux', { enabled: false });
    });

    it('reports disabled without opening a connection', async () => {
      const health = makeService();
      const status = await health.probe('api-linux');

      expect(status.state).toBe(ServerState.DISABLED);
      expect(runScript).not.toHaveBeenCalled();
      expect(pool.get).not.toHaveBeenCalled();
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

      expect(pool.get).not.toHaveBeenCalled();
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
      expect(runScript).toHaveBeenCalledTimes(1);

      await health.tick(); // nothing is due yet
      expect(runScript).toHaveBeenCalledTimes(1);

      now += IDLE_POLL_MS + 1;
      await health.tick();
      expect(runScript).toHaveBeenCalledTimes(2);
    });

    it('surfaces every server in the status map', async () => {
      await registry.create(REMOTE);
      const health = makeService();
      await health.tick();

      expect(Object.keys(health.getAllStatuses()).sort()).toEqual(['api-linux', LOCAL_SERVER_ID].sort());
    });

    it('never lets one failing server block the others', async () => {
      await registry.create(REMOTE);
      runScript.mockRejectedValue(new AppError(ErrorCode.SERVER_OFFLINE, 'gone'));
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
