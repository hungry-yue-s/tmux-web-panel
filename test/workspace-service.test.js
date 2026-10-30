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

  it('marks a window whose panes could not be read as incomplete, so nothing gets cleaned up', async () => {
    workspace.provider.tmux.listPanesByWindowId = async () => { throw new Error('temporary failure'); };
    const result = await workspace.getWorkspace();
    expect(result.complete).toBe(false);
    expect(result.sessions[0].windows[0]).toMatchObject({ id: '@5', panes: [], panesComplete: false });
  });

  it('does not mistake a window with no panes for a complete answer', async () => {
    workspace.provider.tmux.listPanesByWindowId = async () => [];
    expect((await workspace.getWorkspace()).complete).toBe(false);
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

describe('WorkspaceService reading the tree in one tmux call', () => {
  const INSTANCE = '1873:1700000000';
  const line = (tag, ...fields) => [tag, ...fields].join(SEP);
  const session = (id, name, windows) => line('S', id, name, windows, '1', '1700000000');
  const windowLine = (sessionId, id, index, name) => line('W', sessionId, id, index, name, '1', '80', '24', '0', '1');
  const paneLine = (windowId, id) => line('P', windowId, id, '0', '0', '80', '24', '1', 'zsh', '');

  /** Answers the chained read, and fails the test's way on anything piecemeal. */
  function batchExecutor(lines) {
    return {
      exec: vi.fn(async (bin, args) => {
        if (args[0] === 'display-message' && args.includes(';')) {
          return { stdout: [line('I', INSTANCE), ...lines].join('\n') + '\n', stderr: '' };
        }
        throw Object.assign(new Error('unexpected'), { stderr: 'unexpected' });
      }),
    };
  }

  const ONE = [session('$1', 'work', '2'), windowLine('$1', '@1', '0', 'a'), windowLine('$1', '@2', '1', 'b'), paneLine('@1', '%1'), paneLine('@2', '%2')];

  it('takes one tmux process for what used to take six', async () => {
    const executor = batchExecutor(ONE);
    const result = await new WorkspaceService({ tmux: createTmuxApi(executor) }).getWorkspace();

    expect(executor.exec).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ instanceId: INSTANCE, complete: true });
    expect(result.sessions[0].windows.map((w) => [w.id, w.panes.map((p) => p.id)])).toEqual([['@1', ['%1']], ['@2', ['%2']]]);
    expect(result.sessions[0]).toMatchObject({ id: '$1', name: 'work', windowCount: 2 });
  });

  it('keeps a linked window in both sessions, with its panes listed once', async () => {
    const executor = batchExecutor([
      session('$1', 'one', '1'), session('$2', 'two', '1'),
      windowLine('$1', '@1', '0', 'shared'), windowLine('$2', '@1', '3', 'shared'),
      // `list-panes -a` prints a linked window's panes once per session.
      paneLine('@1', '%1'), paneLine('@1', '%2'), paneLine('@1', '%1'), paneLine('@1', '%2'),
    ]);
    const result = await new WorkspaceService({ tmux: createTmuxApi(executor) }).getWorkspace();

    expect(result.complete).toBe(true);
    for (const entry of result.sessions) {
      expect(entry.windows).toHaveLength(1);
      expect(entry.windows[0].id).toBe('@1');
      expect(entry.windows[0].panes.map((p) => p.id)).toEqual(['%1', '%2']);
    }
    expect(result.sessions[0].windows[0].index).toBe(0);
    expect(result.sessions[1].windows[0].index).toBe(3);
  });

  it('counts a window linked twice into one session twice, as tmux does', async () => {
    const executor = batchExecutor([
      session('$1', 'one', '2'),
      windowLine('$1', '@1', '0', 'x'), windowLine('$1', '@1', '4', 'x'),
      paneLine('@1', '%1'), paneLine('@1', '%1'),
    ]);
    const result = await new WorkspaceService({ tmux: createTmuxApi(executor) }).getWorkspace();
    expect(result.complete).toBe(true);
    expect(result.sessions[0].windows).toHaveLength(2);
  });

  it('reports a session missing windows as incomplete', async () => {
    const executor = batchExecutor([session('$1', 'work', '2'), windowLine('$1', '@1', '0', 'a'), paneLine('@1', '%1')]);
    expect((await new WorkspaceService({ tmux: createTmuxApi(executor) }).getWorkspace()).complete).toBe(false);
  });

  it('reports a window without panes as incomplete', async () => {
    const executor = batchExecutor([session('$1', 'work', '1'), windowLine('$1', '@1', '0', 'a')]);
    const result = await new WorkspaceService({ tmux: createTmuxApi(executor) }).getWorkspace();
    expect(result.complete).toBe(false);
    expect(result.sessions[0].windows[0].panesComplete).toBe(false);
  });

  it('reads no server as an empty, complete workspace with no instance', async () => {
    const executor = {
      exec: vi.fn(async () => { throw Object.assign(new Error('x'), { stderr: 'no server running on /tmp/tmux-1/default' }); }),
    };
    const result = await new WorkspaceService({ tmux: createTmuxApi(executor) }).getWorkspace();
    expect(result).toMatchObject({ instanceId: null, complete: true, sessions: [] });
  });

  /** One tmux call fails; piece by piece it works, with one broken session. */
  function pieceByPiece({ failChain = 'boom' } = {}) {
    return {
      exec: vi.fn(async (bin, args) => {
        const sub = args[0];
        if (args.includes(';')) {
          if (failChain) throw Object.assign(new Error(failChain), { stderr: failChain });
          return { stdout: [line('I', INSTANCE), line('S', '', 'old', '1', '0', '1')].join('\n') + '\n', stderr: '' };
        }
        if (sub === 'display-message') return { stdout: `${INSTANCE}\n`, stderr: '' };
        if (sub === 'list-sessions') {
          return {
            stdout: [['$1', 'good', '1', '1', '1'], ['$2', 'bad', '1', '0', '1']].map((f) => f.join(SEP)).join('\n') + '\n',
            stderr: '',
          };
        }
        if (sub === 'list-windows') {
          if (args[2] === '$2') throw new Error('broken session');
          return { stdout: ['@1', '0', 'w', '1', '80', '24', '0', '1'].join(SEP) + '\n', stderr: '' };
        }
        if (sub === 'list-panes') return { stdout: ['%1', '0', '0', '80', '24', '1', 'zsh', ''].join(SEP) + '\n', stderr: '' };
        return { stdout: '', stderr: '' };
      }),
    };
  }

  it('falls back to reading piece by piece, so one broken session does not cost the whole tree', async () => {
    const executor = pieceByPiece();
    const result = await new WorkspaceService({ tmux: createTmuxApi(executor) }).getWorkspace();
    expect(result.complete).toBe(false);
    expect(result.instanceId).toBe(INSTANCE);
    expect(result.sessions.map((s) => s.name)).toEqual(['good', 'bad']);
    expect(result.sessions[0].windows).toHaveLength(1);
    expect(result.sessions[1].windows).toEqual([]);
  });

  it('falls back for a tmux that reports no session ids', async () => {
    const executor = pieceByPiece({ failChain: null });
    const result = await new WorkspaceService({ tmux: createTmuxApi(executor) }).getWorkspace();
    expect(result.sessions.map((s) => s.name)).toEqual(['good', 'bad']);
  });

  it('still rejects a piecemeal read that spans a restart', async () => {
    const tmux = createTmuxApi(pieceByPiece());
    tmux.getServerInstance = vi.fn().mockResolvedValueOnce(INSTANCE).mockResolvedValueOnce('1874:1700000010');
    await expect(new WorkspaceService({ tmux }).getWorkspace()).rejects.toMatchObject({ code: ErrorCode.WORKSPACE_UNAVAILABLE });
  });

  it('shares one read between callers at the same moment', async () => {
    let finish;
    const executor = {
      exec: vi.fn(() => new Promise((resolve) => { finish = resolve; })),
    };
    const service = new WorkspaceService({ tmux: createTmuxApi(executor) });
    const a = service.getWorkspace();
    const b = service.getWorkspace();
    expect(executor.exec).toHaveBeenCalledOnce();
    finish({ stdout: [line('I', INSTANCE), ...ONE].join('\n') + '\n', stderr: '' });
    expect(await a).toBe(await b);
    // Only while it runs: a later call reads again.
    service.getWorkspace();
    expect(executor.exec).toHaveBeenCalledTimes(2);
  });

  it('never answers a caller after a change with a read from before it', async () => {
    const finishes = [];
    const executor = {
      exec: vi.fn((bin, args) => {
        if (args[0] === 'new-window') return Promise.resolve({ stdout: '@21\n', stderr: '' });
        return new Promise((resolve) => { finishes.push(resolve); });
      }),
    };
    const service = new WorkspaceService({ tmux: createTmuxApi(executor) });
    const before = service.getWorkspace();
    await service.createWindow('$1', { name: 'new' });
    const after = service.getWorkspace();
    expect(after).not.toBe(before);
    expect(finishes).toHaveLength(2);
    const answer = { stdout: [line('I', INSTANCE), ...ONE].join('\n') + '\n', stderr: '' };
    finishes.forEach((finish) => finish(answer));
    expect((await after).revision).toBe(1);
    await before;
  });

  it('forgets a failed read, so the next caller tries again', async () => {
    const executor = {
      exec: vi.fn(async () => { throw Object.assign(new Error('x'), { stderr: 'boom' }); }),
    };
    const service = new WorkspaceService({ tmux: createTmuxApi(executor) });
    await expect(service.getWorkspace()).rejects.toBeTruthy();
    await expect(service.getWorkspace()).rejects.toBeTruthy();
    expect(executor.exec.mock.calls.length).toBeGreaterThan(1);
  });
});
