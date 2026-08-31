import { describe, it, expect, vi } from 'vitest';

import { createTmuxApi, sessionTarget, validateSessionId } from '../server/tmux.js';

/** Records every argv the API sends and replays canned stdout. */
function fakeExecutor(responses = {}) {
  const calls = [];
  const executor = {
    id: 'fake',
    transport: 'ssh',
    exec: vi.fn(async (command, args) => {
      calls.push({ command, args });
      const key = args[0];
      const handler = responses[key];
      if (typeof handler === 'function') return handler(args);
      if (typeof handler === 'string') return { stdout: handler, stderr: '' };
      return { stdout: '', stderr: '' };
    }),
  };
  return { executor, calls };
}

const SEP = '=:=';

describe('createTmuxApi', () => {
  it('rejects an executor without exec()', () => {
    expect(() => createTmuxApi(null)).toThrow(/requires an executor/);
    expect(() => createTmuxApi({})).toThrow(/requires an executor/);
  });

  it('asks list-sessions for the stable session id', async () => {
    const { executor, calls } = fakeExecutor({
      'list-sessions': ['$1', 'main', '2', '1', '1700000000'].join(SEP),
    });
    const api = createTmuxApi(executor);

    const sessions = await api.listSessions();

    expect(calls[0].command).toBe('tmux');
    expect(calls[0].args[2]).toContain('#{session_id}');
    expect(sessions).toEqual([
      { id: '$1', name: 'main', windows: 2, attached: true, lastActivity: '1700000000' },
    ]);
  });

  it('treats "no server running" as an empty session list', async () => {
    const { executor } = fakeExecutor({
      'list-sessions': () => {
        const err = new Error('exit 1');
        err.stderr = 'no server running on /tmp/tmux-501/default';
        throw err;
      },
    });

    await expect(createTmuxApi(executor).listSessions()).resolves.toEqual([]);
  });

  it('propagates failures that are not a missing tmux server', async () => {
    const { executor } = fakeExecutor({
      'list-sessions': () => {
        const err = new Error('permission denied');
        err.stderr = 'error connecting to /tmp/tmux-0/default (Permission denied)';
        throw err;
      },
    });

    await expect(createTmuxApi(executor).listSessions()).rejects.toThrow(/permission denied/);
  });

  it('accepts a stable session id as a target', async () => {
    const { executor, calls } = fakeExecutor();
    const api = createTmuxApi(executor);

    await api.listWindows('$3');
    await api.listPanes('$3', '0');

    expect(calls[0].args).toEqual(expect.arrayContaining(['-t', '$3']));
    expect(calls[1].args).toEqual(expect.arrayContaining(['-t', '$3:0']));
  });

  it('still accepts session names and rejects invalid ones', async () => {
    const { executor, calls } = fakeExecutor();
    const api = createTmuxApi(executor);

    await api.listWindows('my-session');
    expect(calls[0].args).toEqual(expect.arrayContaining(['-t', 'my-session']));

    await expect(api.listWindows('bad;name')).rejects.toThrow(/Invalid session name/);
    await expect(api.listPanes('main', 'notanindex')).rejects.toThrow(/Invalid window index/);
  });

  it('never passes a shell string — argv stays an array', async () => {
    const { executor, calls } = fakeExecutor();
    await createTmuxApi(executor).killPane('%12');

    expect(Array.isArray(calls[0].args)).toBe(true);
    expect(calls[0].args).toEqual(['kill-pane', '-t', '%12']);
  });

  it('validates pane ids before sending keys', async () => {
    const { executor } = fakeExecutor();
    const api = createTmuxApi(executor);

    await expect(api.sendKeys('%1; rm -rf /', 'ls')).rejects.toThrow(/Invalid pane ID/);
    await expect(api.killPane('$(id)')).rejects.toThrow(/Invalid pane ID/);
  });

  it('returns stable ids from creation helpers', async () => {
    const { executor, calls } = fakeExecutor({
      'new-session': '$9\n',
      'new-window': '@21\n',
      'split-window': '%33\n',
    });
    const api = createTmuxApi(executor);

    expect(await api.createSessionReturningId('work')).toBe('$9');
    expect(await api.createWindowReturningId('$9', 'logs')).toBe('@21');
    expect(await api.splitPaneReturningId('%1', 'horizontal')).toBe('%33');

    expect(calls[0].args).toEqual(expect.arrayContaining(['-F', '#{session_id}']));
    expect(calls[1].args).toEqual(expect.arrayContaining(['-F', '#{window_id}']));
    expect(calls[2].args).toEqual(expect.arrayContaining(['-F', '#{pane_id}']));
  });

  it('parses the tmux version and tolerates prerelease builds', async () => {
    const cases = [
      ['tmux 3.5a\n', '3.5a'],
      ['tmux next-3.6\n', '3.6'],
      ['tmux 3.4\n', '3.4'],
    ];
    for (const [stdout, expected] of cases) {
      const { executor } = fakeExecutor({ '-V': stdout });
      expect(await createTmuxApi(executor).version()).toBe(expected);
    }
  });

  it('returns null when the version output is unrecognizable', async () => {
    const { executor } = fakeExecutor({ '-V': 'command not found\n' });
    expect(await createTmuxApi(executor).version()).toBeNull();
  });

  it('keeps two executors fully independent', async () => {
    const a = fakeExecutor({ 'list-sessions': ['$1', 'alpha', '1', '1', '1'].join(SEP) });
    const b = fakeExecutor({ 'list-sessions': ['$1', 'beta', '1', '1', '1'].join(SEP) });

    const [first, second] = await Promise.all([
      createTmuxApi(a.executor).listSessions(),
      createTmuxApi(b.executor).listSessions(),
    ]);

    // Same tmux ids on different hosts must not collapse into one another.
    expect(first[0].name).toBe('alpha');
    expect(second[0].name).toBe('beta');
    expect(a.executor.exec).toHaveBeenCalledTimes(1);
    expect(b.executor.exec).toHaveBeenCalledTimes(1);
  });

  it('honors a custom tmux binary from the executor', async () => {
    const { executor, calls } = fakeExecutor();
    executor.tmuxBin = '/opt/homebrew/bin/tmux';

    await createTmuxApi(executor).listSessions();

    expect(calls[0].command).toBe('/opt/homebrew/bin/tmux');
  });

  it('targets a session id without the exact-match prefix when moving windows', async () => {
    const { executor, calls } = fakeExecutor();
    const api = createTmuxApi(executor);

    await api.moveWindowById('@4', '$2');
    await api.moveWindowById('@4', 'other');

    expect(calls[0].args).toEqual(['move-window', '-s', '@4', '-t', '$2:']);
    expect(calls[1].args).toEqual(['move-window', '-s', '@4', '-t', '=other:']);
  });
});

describe('sessionTarget', () => {
  it('passes stable ids through untouched', () => {
    expect(sessionTarget('$12')).toBe('$12');
    expect(validateSessionId('$12')).toBe(true);
    expect(validateSessionId('@12')).toBe(false);
    expect(validateSessionId('12')).toBe(false);
  });

  it('rejects names that would not survive tmux validation', () => {
    expect(() => sessionTarget('a:b')).toThrow(/Invalid session name/);
    expect(() => sessionTarget('')).toThrow(/Invalid session name/);
  });
});
