import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('node-pty', () => ({ default: { spawn: vi.fn() } }));

import { TerminalManager } from '../server/terminal.js';

/** Windows rules, with nothing real behind them: no tmux, no processes. */
function windows() {
  return new TerminalManager({ platform: 'win32', tmux: async () => '', consoleReaper: { clientEnded: vi.fn() }, isRunning: () => false });
}

describe('clients someone else started (mosh-server\'s tmux) on Windows', () => {
  afterEach(() => vi.restoreAllMocks());

  it('are ended through their owner before a new client starts on that session', async () => {
    const manager = windows();
    const order = [];
    manager.addClientOwner({ endClientsOn: vi.fn(async (target) => { order.push(`end ${target}`); return true; }) });
    const result = await manager.whenClientCanStart('$3', () => { order.push('attach'); return 'id'; });
    expect(result).toBe('id');
    expect(order).toEqual(['end $3', 'attach']);
  });

  it('keep the new client out while their end is unconfirmed', async () => {
    const manager = windows();
    const attach = vi.fn();
    manager.addClientOwner({ endClientsOn: async () => false });
    await expect(manager.whenClientCanStart('$3', attach)).rejects.toMatchObject({ code: 'TERMINAL_BUSY' });
    expect(attach).not.toHaveBeenCalled();
  });

  it('count as starting while held: none of ours leaves until the hold is over', async () => {
    const manager = windows();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    let over;
    manager.holdStart(new Promise((resolve) => { over = resolve; }));
    const client = { pid: 4242 };
    manager._endClient(client);
    expect(manager._waitingToEnd.has(client)).toBe(true);
    expect(kill).not.toHaveBeenCalled();
    over();
    await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(4242));
    expect(manager._waitingToEnd.has(client)).toBe(false);
  });

  it('take their turn like our own, one change at a time', async () => {
    const manager = windows();
    const order = [];
    let release;
    const first = manager.inClientTurn(() => new Promise((resolve) => { order.push('first'); release = resolve; }));
    const second = manager.inClientTurn(() => { order.push('second'); });
    await vi.waitFor(() => expect(order).toEqual(['first']));
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
  });

  it('change nothing elsewhere: no turn, no hold', async () => {
    const manager = new TerminalManager({ platform: 'linux' });
    manager.holdStart(new Promise(() => {}));
    expect(manager._starting.size).toBe(0);
    expect(await manager.inClientTurn(() => 'now')).toBe('now');
  });
});
