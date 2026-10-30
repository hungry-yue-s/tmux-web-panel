import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConsoleReaper } from '../server/terminal/console-reaper.js';

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
});
