import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { WorkspaceService } from '../server/workspace/service.js';
import { SSH_ACTIONS } from '../server/workspace/ssh-provider.js';
import { TMUX_ACTIONS } from '../server/workspace/tmux-provider.js';
import { ServerRegistry, LOCAL_SERVER_ID } from '../server/servers/registry.js';
import { HealthService, ServerState } from '../server/servers/health-service.js';
import { AppError, ErrorCode } from '../server/servers/errors.js';

const SEP = '\x1f';

const REMOTE = {
  id: 'api-linux',
  name: 'API Linux',
  address: { host: '10.0.0.21', port: 22, user: 'deploy' },
  ssh: {},
};

function fakePty() {
  const pty = {
    killed: [],
    onData(fn) { pty._data = fn; },
    onExit(fn) { pty._exit = fn; },
    write() {},
    resize() {},
    kill(signal) { pty.killed.push(signal); },
    emit(data) { pty._data(data); },
    exit(code = 0) { pty._exit({ exitCode: code, signal: null }); },
  };
  return pty;
}

/** tmux executor returning a fixed one-session tree. */
function tmuxTreeExecutor() {
  return {
    exec: vi.fn(async (bin, args) => {
      const sub = args[0];
      if (sub === 'list-sessions') {
        return { stdout: ['$1', 'DataAnt', '1', '1', '1700000000'].join(SEP) + '\n', stderr: '' };
      }
      if (sub === 'list-windows') {
        return { stdout: ['@5', '0', 'logs', '1', '80', '24', '0', '1'].join(SEP) + '\n', stderr: '' };
      }
      if (sub === 'list-panes') {
        return { stdout: ['%12', '0', '0', '80', '24', '1', 'zsh', ''].join(SEP) + '\n', stderr: '' };
      }
      if (sub === 'display-message') {
        if (args[3] === '%99') {
          throw Object.assign(new Error("can't find pane: %99"), { stderr: "can't find pane: %99" });
        }
        return { stdout: ['%12', '$1', 'DataAnt', '@5', '0'].join(SEP) + '\n', stderr: '' };
      }
      if (sub === 'new-session') return { stdout: '$9\n', stderr: '' };
      if (sub === 'new-window') return { stdout: '@21\n', stderr: '' };
      if (sub === 'split-window') return { stdout: '%33\n', stderr: '' };
      if (sub === '-V') return { stdout: 'tmux 3.5a\n', stderr: '' };
      return { stdout: '', stderr: '' };
    }),
  };
}

describe('WorkspaceService', () => {
  let dir;
  let registry;
  let health;
  let workspace;
  let now;
  let changes;
  let spawned;
  let tmuxApi;
  let providerName;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-service-'));
    registry = new ServerRegistry({ configDir: dir });
    await registry.load();
    await registry.create(REMOTE);
    now = 1_000_000;
    changes = [];
    spawned = [];
    providerName = 'tmux';

    const { createTmuxApi } = await import('../server/tmux.js');
    tmuxApi = createTmuxApi(tmuxTreeExecutor());

    const pool = {
      get: () => ({ runScript: async () => ({ stdout: '', stderr: '' }) }),
      tmuxFor: () => tmuxApi,
      invalidate: vi.fn(),
    };

    health = new HealthService({ registry, pool, now: () => now });
    // Drive the provider decision directly; probing itself is covered elsewhere.
    health.probe = vi.fn(async (serverId) => {
      const status = {
        serverId,
        state: providerName === 'unavailable' ? ServerState.OFFLINE : ServerState.ONLINE,
        latencyMs: 5,
        checkedAt: new Date(now).toISOString(),
        lastOnlineAt: new Date(now).toISOString(),
        error: providerName === 'unavailable'
          ? new AppError(ErrorCode.SERVER_OFFLINE, 'unreachable').toJSON()
          : null,
        facts: { hostname: 'api-01', platform: 'linux', arch: 'x64' },
        capabilities: {
          ssh: { available: providerName !== 'unavailable' },
          tmux: { available: providerName === 'tmux', version: providerName === 'tmux' ? '3.5a' : null, reason: null },
          metrics: { available: true, level: 'basic' },
          files: { available: false },
        },
        workspace: providerName === 'tmux'
          ? { provider: 'tmux', transport: 'ssh', persistence: 'tmux' }
          : providerName === 'ssh'
            ? { provider: 'ssh', transport: 'ssh', persistence: 'process-memory' }
            : { provider: 'unavailable', transport: 'ssh', persistence: 'none' },
      };
      health._entry(serverId).status = status;
      return status;
    });

    workspace = new WorkspaceService({
      registry,
      pool,
      health,
      now: () => now,
      onChange: (serverId, revision) => changes.push({ serverId, revision }),
      spawnSshPty: (ctx) => {
        const pty = fakePty();
        spawned.push({ ctx, pty });
        return pty;
      },
    });
  });

  afterEach(async () => {
    workspace.destroyAll();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('requires its dependencies', () => {
    expect(() => new WorkspaceService({})).toThrow(/registry/);
    expect(() => new WorkspaceService({ registry })).toThrow(/pool/);
    expect(() => new WorkspaceService({ registry, pool: {} })).toThrow(/health/);
  });

  describe('tmux provider', () => {
    it('returns a unified tree with stable ids and tmux actions', async () => {
      const result = await workspace.getWorkspace('api-linux');

      expect(result).toMatchObject({
        serverId: 'api-linux',
        provider: 'tmux',
        transport: 'ssh',
        persistence: 'tmux',
        pendingProvider: null,
      });
      expect(result.actions).toEqual(TMUX_ACTIONS);
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]).toMatchObject({ id: '$1', name: 'DataAnt' });
      expect(result.sessions[0].windows[0]).toMatchObject({ id: '@5', index: 0, name: 'logs' });
      expect(result.sessions[0].windows[0].panes[0]).toMatchObject({ id: '%12', command: 'zsh' });
    });

    it('resolves a pane that exists and rejects one that does not', async () => {
      await expect(workspace.resolvePane('api-linux', '%12')).resolves.toMatchObject({
        serverId: 'api-linux',
        provider: 'tmux',
        sessionId: '$1',
        windowId: '@5',
        paneId: '%12',
      });
      await expect(workspace.resolvePane('api-linux', '%99')).rejects.toMatchObject({
        code: ErrorCode.PANE_NOT_FOUND,
      });
    });

    it('reads one window by stable id without rebuilding the tree', async () => {
      await expect(workspace.getWindowPanes('api-linux', '@5')).resolves.toMatchObject({
        provider: 'tmux',
        panes: [{ id: '%12', command: 'zsh' }],
      });
    });

    it('bumps the revision exactly once per mutation', async () => {
      await workspace.createSession('api-linux', { name: 'work' });
      expect(changes).toEqual([{ serverId: 'api-linux', revision: 1 }]);

      await workspace.createWindow('api-linux', '$1', { name: 'logs' });
      expect(changes).toHaveLength(2);
      expect(workspace.revision('api-linux')).toBe(2);
    });

    it('does not bump when a mutation fails', async () => {
      await expect(workspace.splitPane('api-linux', '@5', { direction: 'diagonal' })).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
      });
      expect(changes).toEqual([]);
      expect(workspace.revision('api-linux')).toBe(0);
    });
  });

  describe('ssh provider', () => {
    beforeEach(() => { providerName = 'ssh'; });

    it('reports ssh semantics and non-persistence in its actions', async () => {
      const result = await workspace.getWorkspace('api-linux');

      expect(result).toMatchObject({ provider: 'ssh', transport: 'ssh', persistence: 'process-memory' });
      expect(result.actions).toEqual(SSH_ACTIONS);
      expect(result.actions.persistentAfterRestart).toBe(false);
      expect(result.actions.tmuxLayout).toBe(false);
      expect(result.sessions).toEqual([]);
    });

    it('creates a session with one window and one pane', async () => {
      const created = await workspace.createSession('api-linux', { name: 'API 调试' });

      expect(created.id).toMatch(/^ses_/);
      expect(created.windowId).toMatch(/^win_/);
      expect(created.paneId).toMatch(/^pane_/);

      const tree = await workspace.getWorkspace('api-linux');
      expect(tree.sessions).toHaveLength(1);
      expect(tree.sessions[0].windows[0].panes).toHaveLength(1);
    });

    it('bumps the revision exactly once per ssh mutation', async () => {
      await workspace.createSession('api-linux', { name: 'one' });

      // The provider also emits an internal change event; it must not double count.
      expect(changes).toEqual([{ serverId: 'api-linux', revision: 1 }]);
      expect(workspace.revision('api-linux')).toBe(1);
    });

    it('bumps once for a split and once for a close', async () => {
      const session = await workspace.createSession('api-linux', { name: 'one' });
      const tree = await workspace.getWorkspace('api-linux');
      const windowId = tree.sessions[0].windows[0].id;

      await workspace.splitPane('api-linux', windowId, { direction: 'horizontal' });
      expect(workspace.revision('api-linux')).toBe(2);

      await workspace.closePane('api-linux', session.paneId);
      expect(workspace.revision('api-linux')).toBe(3);
      expect(changes.map((c) => c.revision)).toEqual([1, 2, 3]);
    });

    it('still bumps for an asynchronous pane exit', async () => {
      const session = await workspace.createSession('api-linux', { name: 'one' });
      const runtime = workspace.sshRuntime('api-linux', session.paneId);
      runtime.subscribe({ send: () => {} });
      const before = workspace.revision('api-linux');

      spawned[0].pty.exit(0);

      expect(workspace.revision('api-linux')).toBe(before + 1);
    });

    it('rejects tmux-only actions with UNSUPPORTED', async () => {
      const provider = await workspace.getProvider('api-linux');
      expect(provider.actions.capturePane).toBe(false);
      expect(() => workspace._requireAction(provider, 'capturePane')).toThrow(
        expect.objectContaining({ code: ErrorCode.UNSUPPORTED }),
      );
    });
  });

  describe('provider changes', () => {
    it('rejects a mutation whose expected provider no longer matches', async () => {
      providerName = 'ssh';
      await expect(workspace.createSession('api-linux', { name: 'x' }, 'tmux')).rejects.toMatchObject({
        code: ErrorCode.PROVIDER_CHANGED,
      });
    });

    it('accepts a mutation whose expected provider still matches', async () => {
      providerName = 'ssh';
      await expect(workspace.createSession('api-linux', { name: 'x' }, 'ssh')).resolves.toBeTruthy();
    });

    it('keeps live ssh panes when tmux appears, pinning the provider', async () => {
      providerName = 'ssh';
      const session = await workspace.createSession('api-linux', { name: 'keep me' });
      const runtime = workspace.sshRuntime('api-linux', session.paneId);
      runtime.subscribe({ send: () => {} });
      expect(runtime.alive).toBe(true);

      // tmux got installed between probes.
      providerName = 'tmux';
      health.invalidate('api-linux');
      const tree = await workspace.getWorkspace('api-linux');

      // The running shell must survive; the switch waits for it.
      expect(tree.provider).toBe('ssh');
      expect(tree.pendingProvider).toBe('tmux');
      expect(runtime.alive).toBe(true);
      expect(tree.sessions[0].name).toBe('keep me');
      expect(workspace.sshRuntime('api-linux', session.paneId)).toBe(runtime);
    });

    it('adopts tmux once the last ssh pane is gone', async () => {
      providerName = 'ssh';
      const session = await workspace.createSession('api-linux', { name: 'temp' });
      const runtime = workspace.sshRuntime('api-linux', session.paneId);
      runtime.subscribe({ send: () => {} });

      providerName = 'tmux';
      health.invalidate('api-linux');
      expect((await workspace.getWorkspace('api-linux')).provider).toBe('ssh');

      // The remote shell exits, so nothing is at risk any more.
      spawned[0].pty.exit(0);
      health.invalidate('api-linux');
      const tree = await workspace.getWorkspace('api-linux');

      expect(tree.provider).toBe('tmux');
      expect(tree.pendingProvider).toBeNull();
      expect(tree.sessions[0].name).toBe('DataAnt');
    });

    it('switches immediately when the ssh workspace was never used', async () => {
      providerName = 'ssh';
      await workspace.getWorkspace('api-linux');

      providerName = 'tmux';
      health.invalidate('api-linux');

      expect((await workspace.getWorkspace('api-linux')).provider).toBe('tmux');
    });

    it('only abandons live panes on an explicit forced switch', async () => {
      providerName = 'ssh';
      const session = await workspace.createSession('api-linux', { name: 'doomed' });
      workspace.sshRuntime('api-linux', session.paneId).subscribe({ send: () => {} });

      providerName = 'tmux';
      health.invalidate('api-linux');
      await workspace.getWorkspace('api-linux');
      expect(workspace.hasActiveRuntimes('api-linux')).toBe(true);

      expect(workspace.forceProviderSwitch('api-linux')).toBe(true);

      expect(workspace.hasActiveRuntimes('api-linux')).toBe(false);
      expect(spawned[0].pty.killed).toContain('SIGHUP');
      expect((await workspace.getWorkspace('api-linux')).provider).toBe('tmux');
    });

    it('keeps live panes reachable when the server goes temporarily offline', async () => {
      providerName = 'ssh';
      const session = await workspace.createSession('api-linux', { name: 'survive' });
      const runtime = workspace.sshRuntime('api-linux', session.paneId);
      runtime.subscribe({ send: () => {} });

      // Network blip: the probe now says unreachable.
      providerName = 'unavailable';
      health.invalidate('api-linux');
      const tree = await workspace.getWorkspace('api-linux');

      expect(tree.provider).toBe('ssh');
      expect(tree.pendingProvider).toBe('unavailable');
      expect(runtime.alive).toBe(true);
      expect(tree.sessions[0].name).toBe('survive');
      await expect(workspace.resolvePane('api-linux', session.paneId)).resolves.toMatchObject({
        paneId: session.paneId,
      });
    });

    it('refuses a forced switch when tmux is not the pending target', async () => {
      providerName = 'ssh';
      const session = await workspace.createSession('api-linux', { name: 'busy' });
      workspace.sshRuntime('api-linux', session.paneId).subscribe({ send: () => {} });

      providerName = 'unavailable';
      health.invalidate('api-linux');
      await workspace.getWorkspace('api-linux');

      expect(() => workspace.forceProviderSwitch('api-linux')).toThrow(
        expect.objectContaining({ code: ErrorCode.VALIDATION_ERROR }),
      );
      expect(workspace.hasActiveRuntimes('api-linux')).toBe(true);
    });

    it('refuses a forced switch when nothing is pending', () => {
      expect(() => workspace.forceProviderSwitch('api-linux')).toThrow(
        expect.objectContaining({ code: ErrorCode.VALIDATION_ERROR }),
      );
    });

    it('does not destroy the ssh workspace just because a probe failed', async () => {
      providerName = 'ssh';
      await workspace.createSession('api-linux', { name: 'structure' });

      providerName = 'unavailable';
      health.invalidate('api-linux');
      await expect(workspace.getWorkspace('api-linux')).rejects.toMatchObject({
        code: ErrorCode.WORKSPACE_UNAVAILABLE,
      });

      // Connectivity returns: the same session structure must still be there.
      providerName = 'ssh';
      health.invalidate('api-linux');
      const tree = await workspace.getWorkspace('api-linux');
      expect(tree.sessions.map((s) => s.name)).toEqual(['structure']);
    });
  });

  describe('probe scheduling', () => {
    it('probes once when capabilities are unknown', async () => {
      await workspace.getWorkspace('api-linux');
      await workspace.getWorkspace('api-linux');
      await workspace.getWorkspace('api-linux');

      expect(health.probe).toHaveBeenCalledTimes(1);
    });

    it('does not re-probe an offline server on every request', async () => {
      providerName = 'unavailable';

      for (let i = 0; i < 5; i += 1) {
        await expect(workspace.getWorkspace('api-linux')).rejects.toMatchObject({
          code: ErrorCode.WORKSPACE_UNAVAILABLE,
        });
      }

      // Repeated page loads must not bypass the health backoff.
      expect(health.probe).toHaveBeenCalledTimes(1);
    });

    it('re-probes after an explicit invalidation', async () => {
      await workspace.getWorkspace('api-linux');
      health.invalidate('api-linux');
      await workspace.getWorkspace('api-linux');

      expect(health.probe).toHaveBeenCalledTimes(2);
    });

    it('surfaces the cached failure reason', async () => {
      providerName = 'unavailable';
      await expect(workspace.getWorkspace('api-linux')).rejects.toMatchObject({
        code: ErrorCode.WORKSPACE_UNAVAILABLE,
        message: 'unreachable',
        retryable: true,
      });
    });
  });

  describe('lifecycle', () => {
    it('refuses a disabled server', async () => {
      await registry.update('api-linux', { enabled: false });
      await expect(workspace.getWorkspace('api-linux')).rejects.toMatchObject({
        code: ErrorCode.SERVER_DISABLED,
      });
    });

    it('reports active runtimes for the delete guard', async () => {
      providerName = 'ssh';
      const session = await workspace.createSession('api-linux', { name: 'busy' });
      workspace.sshRuntime('api-linux', session.paneId).subscribe({ send: () => {} });

      expect(workspace.hasActiveRuntimes('api-linux')).toBe(true);
      expect(workspace.activeRuntimeCount('api-linux')).toBe(1);
    });

    it('releaseServer ends every pty and forgets the revision', async () => {
      providerName = 'ssh';
      const session = await workspace.createSession('api-linux', { name: 'gone' });
      workspace.sshRuntime('api-linux', session.paneId).subscribe({ send: () => {} });

      workspace.releaseServer('api-linux');

      expect(spawned[0].pty.killed).toContain('SIGHUP');
      expect(workspace.hasActiveRuntimes('api-linux')).toBe(false);
      expect(workspace.revision('api-linux')).toBe(0);
    });

    it('releaseServer clears a pending switch so a rebuilt id starts clean', async () => {
      providerName = 'ssh';
      const session = await workspace.createSession('api-linux', { name: 'pending' });
      workspace.sshRuntime('api-linux', session.paneId).subscribe({ send: () => {} });
      providerName = 'tmux';
      health.invalidate('api-linux');
      await workspace.getWorkspace('api-linux');
      expect(workspace.pendingProvider('api-linux')).toBe('tmux');

      workspace.releaseServer('api-linux');

      expect(workspace.pendingProvider('api-linux')).toBeNull();
    });

    it('destroyAll clears pending switches and revisions', async () => {
      providerName = 'ssh';
      const session = await workspace.createSession('api-linux', { name: 'pending' });
      workspace.sshRuntime('api-linux', session.paneId).subscribe({ send: () => {} });
      providerName = 'tmux';
      health.invalidate('api-linux');
      await workspace.getWorkspace('api-linux');

      workspace.destroyAll();

      expect(workspace.pendingProvider('api-linux')).toBeNull();
      expect(workspace.revision('api-linux')).toBe(0);
    });

    it('reaps idle panes past the ttl', async () => {
      providerName = 'ssh';
      const session = await workspace.createSession('api-linux', { name: 'idle' });
      const runtime = workspace.sshRuntime('api-linux', session.paneId);
      const client = { send: () => {} };
      runtime.subscribe(client);
      runtime.unsubscribe(client);

      now += 31 * 60 * 1000;
      const reaped = workspace.reapIdlePanes();

      expect(reaped['api-linux']).toEqual([session.paneId]);
      expect(workspace.sshRuntime('api-linux', session.paneId)).toBeNull();
    });

    it('keeps a pane that is still attached', async () => {
      providerName = 'ssh';
      const session = await workspace.createSession('api-linux', { name: 'attached' });
      workspace.sshRuntime('api-linux', session.paneId).subscribe({ send: () => {} });

      now += 60 * 60 * 1000;
      expect(workspace.reapIdlePanes()).toEqual({});
    });

    it('destroyAll ends everything at shutdown', async () => {
      providerName = 'ssh';
      await workspace.createSession('api-linux', { name: 'a' });
      await workspace.createSession('api-linux', { name: 'b' });

      workspace.destroyAll();

      for (const { pty } of spawned) expect(pty.killed.length).toBeGreaterThan(0);
    });
  });

  it('isolates identical tmux ids across two servers', async () => {
    await registry.create({ ...REMOTE, id: 'second', name: 'Second' });

    const first = await workspace.resolvePane('api-linux', '%12');
    const second = await workspace.resolvePane('second', '%12');

    expect(first.serverId).toBe('api-linux');
    expect(second.serverId).toBe('second');
    expect(first.paneId).toBe(second.paneId);
  });

  it('keeps revisions independent per server', async () => {
    await registry.create({ ...REMOTE, id: 'second', name: 'Second' });

    await workspace.createSession('api-linux', { name: 'a' });
    expect(workspace.revision('api-linux')).toBe(1);
    expect(workspace.revision('second')).toBe(0);
    expect(workspace.revision(LOCAL_SERVER_ID)).toBe(0);
  });
});
