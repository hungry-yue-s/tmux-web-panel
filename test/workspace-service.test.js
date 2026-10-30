import { describe, it, expect, beforeEach, vi } from 'vitest';

import { WorkspaceService } from '../server/workspace/service.js';
import { TMUX_ACTIONS } from '../server/workspace/tmux-provider.js';
import { createTmuxApi } from '../server/tmux.js';
import { ErrorCode } from '../server/servers/errors.js';

const SEP = '=:=';

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
        if (args[2] === '#{pid}:#{start_time}') return { stdout: '1873:1700000000\n', stderr: '' };
        if (args[3] === '%99') {
          throw Object.assign(new Error("can't find pane: %99"), { stderr: "can't find pane: %99" });
        }
        return { stdout: ['%12', '$1', 'DataAnt', '@5', '0'].join(SEP) + '\n', stderr: '' };
      }
      if (sub === 'new-session') return { stdout: '$9\n', stderr: '' };
      if (sub === 'new-window') return { stdout: '@21\n', stderr: '' };
      if (sub === 'split-window') return { stdout: '%33\n', stderr: '' };
      return { stdout: '', stderr: '' };
    }),
  };
}

describe('WorkspaceService', () => {
  let workspace;
  let changes;

  beforeEach(() => {
    changes = [];
    workspace = new WorkspaceService({
      tmux: createTmuxApi(tmuxTreeExecutor()),
      onChange: (revision) => changes.push(revision),
    });
  });

  it('requires a tmux API', () => {
    expect(() => new WorkspaceService({})).toThrow(/tmux/);
  });

  it('returns this machine\'s tree with stable ids and tmux actions', async () => {
    const result = await workspace.getWorkspace();

    expect(result).toMatchObject({ provider: 'tmux', persistence: 'tmux', revision: 0,
      instanceId: '1873:1700000000', complete: true });
    // A machine's own API never names a server; the hub's /n/:serverId does.
    expect(result).not.toHaveProperty('serverId');
    expect(result.actions).toEqual(TMUX_ACTIONS);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({ id: '$1', name: 'DataAnt' });
    expect(result.sessions[0].windows[0]).toMatchObject({ id: '@5', index: 0, name: 'logs' });
    expect(result.sessions[0].windows[0].panes[0]).toMatchObject({ id: '%12', command: 'zsh' });
  });

  it('resolves a pane that exists and rejects one that does not', async () => {
    await expect(workspace.resolvePane('%12')).resolves.toMatchObject({
      provider: 'tmux',
      sessionId: '$1',
      windowId: '@5',
      paneId: '%12',
    });
    await expect(workspace.resolvePane('%99')).rejects.toMatchObject({ code: ErrorCode.PANE_NOT_FOUND });
    await expect(workspace.resolvePane('not-a-pane')).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
  });

  it('marks a partial window listing as unsafe for cache cleanup', async () => {
    workspace.provider.tmux.listWindows = async () => { throw new Error('temporary failure'); };
    const result = await workspace.getWorkspace();
    expect(result.complete).toBe(false);
    expect(result.sessions[0].windows).toEqual([]);
  });

  it('rejects a snapshot spanning a tmux restart', async () => {
    workspace.provider.tmux.getServerInstance = vi.fn()
      .mockResolvedValueOnce('1873:1700000000').mockResolvedValueOnce('1874:1700000010');
    await expect(workspace.getWorkspace()).rejects.toMatchObject({ code: ErrorCode.WORKSPACE_UNAVAILABLE });
  });

  it('reads one window by stable id without rebuilding the tree', async () => {
    await expect(workspace.getWindowPanes('@5')).resolves.toMatchObject({
      revision: 0,
      panes: [{ id: '%12', command: 'zsh' }],
    });
  });

  it('bumps the revision exactly once per mutation', async () => {
    await workspace.createSession({ name: 'work' });
    expect(changes).toEqual([1]);

    await workspace.createWindow('$1', { name: 'logs' });
    expect(changes).toEqual([1, 2]);
    expect(workspace.revision).toBe(2);
  });

  it('does not bump when a mutation fails', async () => {
    await expect(workspace.splitPane('@5', { direction: 'diagonal' })).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
    });
    expect(changes).toEqual([]);
    expect(workspace.revision).toBe(0);
  });
});
