import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ConsoleReaper, trackConsoleSpawn } from '../server/terminal/console-reaper.js';

describe('ConsoleReaper', () => {
  beforeEach(() => { vi.useFakeTimers({ now: 100_000 }); });
  afterEach(() => { vi.useRealTimers(); });

  function setup(consoles) {
    const list = vi.fn(async () => consoles);
    const kill = vi.fn();
    return { list, kill, reaper: new ConsoleReaper({ list, kill, delayMs: 5000 }) };
  }

  it('waits until tmux has let go of the console', async () => {
    const { reaper, list, kill } = setup([{ pid: 1, createdAt: 50_005 }]);
    reaper.clientEnded({ from: 50_000, to: 50_010 });
    await vi.advanceTimersByTimeAsync(4999);
    expect(list).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(kill).toHaveBeenCalledWith(1);
  });

  it('ends only the console created while that client was spawned', async () => {
    const { reaper, kill } = setup([
      { pid: 1, createdAt: 50_005 }, // the ended client
      { pid: 2, createdAt: 50_100 }, // a live client, spawned just after
      { pid: 3, createdAt: 49_900 }, // another pty of this process
    ]);
    reaper.clientEnded({ from: 50_000, to: 50_010 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(kill.mock.calls).toEqual([[1]]);
  });

  it('handles clients ending at different times in separate sweeps', async () => {
    const { reaper, kill } = setup([{ pid: 1, createdAt: 50_005 }, { pid: 2, createdAt: 60_005 }]);
    reaper.clientEnded({ from: 50_000, to: 50_010 });
    await vi.advanceTimersByTimeAsync(3000);
    reaper.clientEnded({ from: 60_000, to: 60_010 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(kill.mock.calls).toEqual([[1]]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(kill.mock.calls).toEqual([[1], [2]]);
  });

  it('forgets a client once swept, so a later sweep cannot hit a reused pid', async () => {
    const { reaper, list, kill } = setup([{ pid: 1, createdAt: 50_005 }]);
    reaper.clientEnded({ from: 50_000, to: 50_010 });
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(list).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it('survives a console that is already gone and a listing that fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const list = vi.fn().mockRejectedValueOnce(new Error('no powershell')).mockResolvedValue([{ pid: 9, createdAt: 70_005 }]);
    const kill = vi.fn(() => { throw new Error('ESRCH'); });
    const reaper = new ConsoleReaper({ list, kill, delayMs: 5000 });
    reaper.clientEnded({ from: 50_000, to: 50_010 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(error).toHaveBeenCalled();
    reaper.clientEnded({ from: 70_000, to: 70_010 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(kill).toHaveBeenCalledWith(9);
    error.mockRestore();
  });

  it('does not lose a client when the listing fails: the next sweep still ends its console', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const list = vi.fn().mockRejectedValueOnce(new Error('busy')).mockResolvedValue([{ pid: 1, createdAt: 50_005 }]);
    const kill = vi.fn();
    const reaper = new ConsoleReaper({ list, kill, delayMs: 5000 });
    reaper.clientEnded({ from: 50_000, to: 50_010 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(kill.mock.calls).toEqual([[1]]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(list).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it('gives up on a client after a few failed listings instead of retrying forever', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const list = vi.fn(async () => { throw new Error('no powershell'); });
    const reaper = new ConsoleReaper({ list, kill: vi.fn(), delayMs: 5000 });
    reaper.clientEnded({ from: 50_000, to: 50_010 });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(list).toHaveBeenCalledTimes(3);
    expect(reaper._ended).toEqual([]);
    expect(reaper._timer).toBeNull();
    error.mockRestore();
  });

  it('runs one sweep at a time, and picks up what ended during a slow one', async () => {
    let finish;
    const list = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValue([{ pid: 2, createdAt: 60_005 }]);
    const kill = vi.fn();
    const reaper = new ConsoleReaper({ list, kill, delayMs: 5000 });
    reaper.clientEnded({ from: 50_000, to: 50_010 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(list).toHaveBeenCalledTimes(1);

    reaper.clientEnded({ from: 60_000, to: 60_010 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(list).toHaveBeenCalledTimes(1);

    finish([{ pid: 1, createdAt: 50_005 }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(kill.mock.calls).toEqual([[1]]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(list).toHaveBeenCalledTimes(2);
    expect(kill.mock.calls).toEqual([[1], [2]]);
  });

  describe('never ending the console of a client that is alive', () => {
    function withLive(consoles, live) {
      const list = vi.fn(async () => consoles);
      const kill = vi.fn();
      return { list, kill, reaper: new ConsoleReaper({ list, kill, delayMs: 5000, live: new Set(live) }) };
    }

    it('takes no margin: a console created just after the window is not this client\'s', async () => {
      const { reaper, kill } = withLive([{ pid: 101, createdAt: 50_005 }, { pid: 202, createdAt: 50_015 }], []);
      reaper.clientEnded({ from: 50_000, to: 50_010 });
      await vi.advanceTimersByTimeAsync(5000);
      expect(kill.mock.calls).toEqual([[101]]);
    });

    it('leaves a console a running client\'s window could own, even when it touches the ended one', async () => {
      const running = { from: 50_010, to: 50_016 };
      const { reaper, kill, list } = withLive([{ pid: 101, createdAt: 50_010 }], [running]);
      reaper.clientEnded({ from: 50_000, to: 50_010 });
      await vi.advanceTimersByTimeAsync(5000);
      expect(list).toHaveBeenCalledOnce();
      expect(kill).not.toHaveBeenCalled();
    });

    it('treats a spawn still in progress as owning everything from its start', async () => {
      const inProgress = { from: 50_008, to: Infinity };
      const { reaper, kill } = withLive([{ pid: 101, createdAt: 50_009 }], [inProgress]);
      reaper.clientEnded({ from: 50_000, to: 50_010 });
      await vi.advanceTimersByTimeAsync(5000);
      expect(kill).not.toHaveBeenCalled();
    });

    it('ends it once that client has exited too, and the console can only be a dead one\'s', async () => {
      const running = { from: 50_010, to: 50_016 };
      const live = new Set([running]);
      const list = vi.fn(async () => [{ pid: 101, createdAt: 50_010 }]);
      const kill = vi.fn();
      const reaper = new ConsoleReaper({ list, kill, delayMs: 5000, live });
      reaper.clientEnded({ from: 50_000, to: 50_010 });
      await vi.advanceTimersByTimeAsync(5000);
      expect(kill).not.toHaveBeenCalled();

      live.delete(running);
      reaper.clientEnded(running);
      await vi.advanceTimersByTimeAsync(5000);
      expect(kill.mock.calls).toEqual([[101]]);
    });

    it('does not guess between two consoles in one window, and stops asking after a while', async () => {
      const { reaper, kill, list } = withLive([{ pid: 1, createdAt: 50_002 }, { pid: 2, createdAt: 50_004 }], []);
      reaper.clientEnded({ from: 50_000, to: 50_010 });
      await vi.advanceTimersByTimeAsync(300_000);
      expect(kill).not.toHaveBeenCalled();
      expect(list).toHaveBeenCalledTimes(3);
      expect(reaper._ended).toEqual([]);
    });

    it('does not take a console out from under a client that ended too recently', async () => {
      const { reaper, kill } = withLive([{ pid: 1, createdAt: 50_010 }], []);
      reaper.clientEnded({ from: 50_000, to: 50_010 });
      await vi.advanceTimersByTimeAsync(4000);
      reaper.clientEnded({ from: 50_010, to: 50_020 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(kill).not.toHaveBeenCalled();
    });

    it('ends a console two ended clients share just once', async () => {
      const { reaper, kill } = withLive([{ pid: 1, createdAt: 50_010 }], []);
      reaper.clientEnded({ from: 50_000, to: 50_010 });
      reaper.clientEnded({ from: 50_010, to: 50_020 });
      await vi.advanceTimersByTimeAsync(5000);
      expect(kill.mock.calls).toEqual([[1]]);
    });

    it('forgets a window with no console in it: nothing there to end', async () => {
      const { reaper, list, kill } = withLive([{ pid: 7, createdAt: 60_000 }], []);
      reaper.clientEnded({ from: 50_000, to: 50_010 });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(list).toHaveBeenCalledOnce();
      expect(kill).not.toHaveBeenCalled();
    });
  });

  describe('trackConsoleSpawn', () => {
    function fakeTerm() {
      const term = { exited: null, onExit: (fn) => { term.exited = fn; } };
      return term;
    }

    it('keeps a spawned pty\'s window live until it exits, even if nothing else knows it anymore', async () => {
      const term = fakeTerm();
      const { spawnWindow } = trackConsoleSpawn(() => term);
      const at = Date.now();
      expect(spawnWindow).toEqual({ from: at, to: at });

      const list = vi.fn(async () => [{ pid: 1, createdAt: at }]);
      const kill = vi.fn();
      // The default record, the one every pty.spawn of this process reports to.
      const reaper = new ConsoleReaper({ list, kill, delayMs: 5000 });
      reaper.clientEnded({ from: at, to: at });
      await vi.advanceTimersByTimeAsync(5000);
      expect(kill).not.toHaveBeenCalled();

      term.exited({ exitCode: 0 });
      await vi.advanceTimersByTimeAsync(5000);
      expect(kill.mock.calls).toEqual([[1]]);
    });

    it('forgets a spawn that failed', async () => {
      expect(() => trackConsoleSpawn(() => { throw new Error('no conpty'); })).toThrow('no conpty');
      const at = Date.now();
      const kill = vi.fn();
      const reaper = new ConsoleReaper({ list: async () => [{ pid: 1, createdAt: at }], kill, delayMs: 5000 });
      reaper.clientEnded({ from: at, to: at });
      await vi.advanceTimersByTimeAsync(5000);
      expect(kill.mock.calls).toEqual([[1]]);
    });

    it('is the only way this codebase starts a pty, so no console goes unaccounted for', () => {
      const files = readdirSync('server', { recursive: true })
        .filter((name) => String(name).endsWith('.js'))
        .map((name) => join('server', String(name)));
      const spawns = [];
      for (const file of files) {
        const text = readFileSync(file, 'utf8');
        for (const match of text.matchAll(/.*\bpty\.spawn\(.*/g)) spawns.push([file, match[0]]);
      }
      expect(spawns.length).toBeGreaterThanOrEqual(2);
      for (const [file, line] of spawns) {
        expect(`${file}: ${line}`).toMatch(/trackConsoleSpawn\(\(\) => pty\.spawn\(/);
      }
    });
  });

  it('still ends only what it can place, after a retry too', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const list = vi.fn().mockRejectedValueOnce(new Error('busy')).mockResolvedValue([
      { pid: 1, createdAt: 50_005 },
      { pid: 7, createdAt: 45_000 },
    ]);
    const kill = vi.fn();
    const reaper = new ConsoleReaper({ list, kill, delayMs: 5000 });
    reaper.clientEnded({ from: 50_000, to: 50_010 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(kill.mock.calls).toEqual([[1]]);
    error.mockRestore();
  });
});
