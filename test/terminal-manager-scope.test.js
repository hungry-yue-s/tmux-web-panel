import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock('node-pty', () => ({ default: { spawn } }));

import { TerminalManager, buildTmuxAttachCommand, buildTmuxAttachArgs, createMarkerWatch, localAttachSpawnSpec } from '../server/terminal.js';
import { MAX_HELD_INPUT_BYTES } from '../server/terminal/protocol.js';

function fakeTerm() {
  const handlers = {};
  return {
    handlers,
    onData: vi.fn((fn) => { handlers.data = fn; return { dispose: vi.fn() }; }),
    onExit: vi.fn((fn) => {
      const earlier = handlers.exit;
      handlers.exit = earlier ? (info) => { earlier(info); fn(info); } : fn;
    }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    pid: 4242,
  };
}

function fakeWs() {
  const listeners = {};
  return {
    OPEN: 1,
    CONNECTING: 0,
    readyState: 1,
    listeners,
    on: vi.fn((name, fn) => { listeners[name] = fn; }),
    close: vi.fn(function close() { this.readyState = 3; }),
    send: vi.fn(),
    ping: vi.fn(),
    terminate: vi.fn(),
  };
}

describe('TerminalManager pane quota', () => {
  beforeEach(() => {
    spawn.mockReset();
    spawn.mockImplementation(() => fakeTerm());
  });

  it('limits attachments per pane id on this machine', () => {
    const manager = new TerminalManager({ maxConnectionsPerPane: 2 });

    expect(manager.create(fakeWs(), '%0')).toBeTruthy();
    expect(manager.create(fakeWs(), '%0')).toBeTruthy();
    const refused = fakeWs();
    expect(manager.create(refused, '%0')).toBeNull();
    expect(refused.close).toHaveBeenCalledWith(1013, expect.stringContaining('%0'));

    // Another pane keeps its own quota.
    expect(manager.create(fakeWs(), '%1')).toBeTruthy();
    expect(manager.paneConnectionCount.get('%0')).toBe(2);
    expect(manager.paneConnectionCount.get('%1')).toBe(1);
  });

  it('keeps a basic-mode host\'s pane ids in their own quota scope with its own spawn', () => {
    const manager = new TerminalManager({ maxConnectionsPerPane: 1 });
    expect(manager.create(fakeWs(), '%0')).toBeTruthy();
    const remote = manager.create(fakeWs(), '%0', 80, 24, false, {
      scope: 'box',
      spawn: { file: 'ssh', args: ['-tt', 'box', '.cache/tmux-web-panel/attach-0-0'], env: { A: '1' } },
    });
    expect(remote).toBeTruthy();
    expect(manager.paneConnectionCount.get('box:%0')).toBe(1);
    const [file, args, options] = spawn.mock.calls[1];
    expect(file).toBe('ssh');
    expect(args.at(-1)).toBe('.cache/tmux-web-panel/attach-0-0');
    expect(options.env.A).toBe('1');
    manager.destroy(remote);
    expect(manager.paneConnectionCount.has('box:%0')).toBe(false);
  });

  it('releases the quota when a connection is destroyed', () => {
    const manager = new TerminalManager({ maxConnectionsPerPane: 1 });
    const id = manager.create(fakeWs(), '%7');
    expect(manager.paneConnectionCount.get('%7')).toBe(1);

    manager.destroy(id);

    expect(manager.paneConnectionCount.has('%7')).toBe(false);
    expect(manager.create(fakeWs(), '%7')).toBeTruthy();
  });
});

describe('TerminalManager PTY termination', () => {
  beforeEach(() => {
    spawn.mockReset();
    spawn.mockImplementation(() => fakeTerm());
  });

  describe('on Windows', () => {
    let reaper;
    const windows = (options = {}) => new TerminalManager({ platform: 'win32', tmux: async () => '$7\n', consoleReaper: reaper, isRunning: () => false, ...options });
    let processKill;

    beforeEach(() => {
      vi.useFakeTimers();
      processKill = vi.spyOn(process, 'kill').mockReturnValue(true);
      reaper = { clientEnded: vi.fn() };
    });

    afterEach(() => {
      processKill.mockRestore();
      vi.useRealTimers();
    });

    const message = (ws, body) => ws.listeners.message(Buffer.from(JSON.stringify(body)));
    const started = (term) => term.handlers.data('\x1b[?1049h');

    // node-pty's kill ends everything on the console, and that can be the tmux server.
    it('ends only the client process, at any moment, never through node-pty', () => {
      const term = fakeTerm();
      spawn.mockReturnValue(term);
      const ws = fakeWs();
      windows().create(ws, '%1');

      ws.listeners.close();
      expect(processKill).toHaveBeenCalledTimes(1);
      expect(processKill).toHaveBeenCalledWith(4242);
      expect(term.kill).not.toHaveBeenCalled();
    });

    it('once a client has exited, releases its reader and hands its console to the reaper', () => {
      const term = fakeTerm();
      spawn.mockReturnValue(term);
      const ws = fakeWs();
      windows().create(ws, '%1');
      ws.listeners.close();
      expect(reaper.clientEnded).not.toHaveBeenCalled();

      term.handlers.exit({ exitCode: 0 });
      expect(term.kill).toHaveBeenCalledTimes(1);
      expect(reaper.clientEnded).toHaveBeenCalledWith({ from: expect.any(Number), to: expect.any(Number) });
    });

    it('does the same for a client that exits by itself', () => {
      const term = fakeTerm();
      spawn.mockReturnValue(term);
      const ws = fakeWs();
      windows().create(ws, '%1');

      term.handlers.exit({ exitCode: 0 });
      expect(reaper.clientEnded).toHaveBeenCalledTimes(1);
      expect(processKill).not.toHaveBeenCalled();
      expect(ws.close).toHaveBeenCalledWith(1000, expect.any(String));
    });

    it('does not end a client that has already left', () => {
      const term = fakeTerm();
      spawn.mockReturnValue(term);
      const ws = fakeWs();
      const manager = windows();
      const id = manager.create(ws, '%1');
      term.handlers.exit({ exitCode: 0 });
      manager.destroy(id);
      expect(processKill).not.toHaveBeenCalled();
    });

    it('waits for the process id: process.kill(0) would end the panel itself', async () => {
      const term = { ...fakeTerm(), pid: 0 };
      spawn.mockReturnValue(term);
      const ws = fakeWs();
      windows().create(ws, '%1');

      ws.listeners.close();
      await vi.advanceTimersByTimeAsync(50);
      expect(processKill).not.toHaveBeenCalled();

      term.pid = 555;
      await vi.advanceTimersByTimeAsync(10);
      expect(processKill).toHaveBeenCalledWith(555);
    });

    it('still closes the PTY of a client that is not tmux, like a hub\'s ssh', () => {
      const term = fakeTerm();
      spawn.mockReturnValue(term);
      const ws = fakeWs();
      windows().create(ws, '%1', 80, 24, false, { scope: 'box', spawn: { file: 'ssh', args: [] } });

      message(ws, { type: 'resize', cols: 120, rows: 40 });
      expect(term.resize).toHaveBeenCalledWith(120, 40);
      expect(spawn).toHaveBeenCalledTimes(1);

      ws.listeners.close();
      expect(term.kill).toHaveBeenCalledTimes(1);
      expect(processKill).not.toHaveBeenCalled();
    });

    it('never resizes a running client: a new one starts at the new size', async () => {
      const first = fakeTerm();
      const second = fakeTerm();
      spawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
      const ws = fakeWs();
      windows().create(ws, '%1', 100, 30);
      started(first);

      message(ws, { type: 'resize', cols: 120, rows: 40 });
      await vi.advanceTimersByTimeAsync(800);

      expect(first.resize).not.toHaveBeenCalled();
      const [file, args, options] = spawn.mock.calls[1];
      expect(file).toBe(spawn.mock.calls[0][0]);
      expect(args).toEqual(['-u', 'attach-session', '-d', '-t', '$7']);
      expect(options).toMatchObject({ cols: 120, rows: 40 });

      // The old client is ended the safe way, and only that one.
      expect(processKill).toHaveBeenCalledTimes(1);
      expect(processKill).toHaveBeenCalledWith(4242);
      expect(first.kill).not.toHaveBeenCalled();
      expect(second.kill).not.toHaveBeenCalled();

      // Input goes to the new client, and the old one leaving is not a disconnect.
      message(ws, { type: 'input', data: 'x' });
      expect(second.write).toHaveBeenCalledWith('x');
      expect(first.write).not.toHaveBeenCalled();
      first.handlers.exit({ exitCode: 0 });
      expect(ws.close).not.toHaveBeenCalled();
      expect(reaper.clientEnded).toHaveBeenCalledTimes(1);
      expect(second.kill).not.toHaveBeenCalled();

      // The current client exiting is a disconnect.
      second.handlers.exit({ exitCode: 0 });
      expect(ws.close).toHaveBeenCalledWith(1000, expect.any(String));
    });

    it('asks for the size it already has without touching anything', async () => {
      const term = fakeTerm();
      spawn.mockReturnValue(term);
      const ws = fakeWs();
      windows().create(ws, '%1', 100, 30);
      started(term);

      message(ws, { type: 'resize', cols: 100, rows: 30 });
      await vi.advanceTimersByTimeAsync(5000);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(term.resize).not.toHaveBeenCalled();
    });

    it('starts one client at a time and ends on the latest size', async () => {
      const terms = [fakeTerm(), fakeTerm(), fakeTerm()];
      let next = 0;
      spawn.mockImplementation(() => terms[next++]);
      const ws = fakeWs();
      windows().create(ws, '%1', 100, 30);

      // None of these may start a client before the first one has settled.
      message(ws, { type: 'resize', cols: 110, rows: 31 });
      message(ws, { type: 'resize', cols: 120, rows: 32 });
      await vi.advanceTimersByTimeAsync(300);
      expect(spawn).toHaveBeenCalledTimes(1);

      started(terms[0]);
      await vi.advanceTimersByTimeAsync(800);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(spawn.mock.calls[1][2]).toMatchObject({ cols: 120, rows: 32 });

      message(ws, { type: 'resize', cols: 130, rows: 33 });
      await vi.advanceTimersByTimeAsync(300);
      expect(spawn).toHaveBeenCalledTimes(2);

      started(terms[1]);
      await vi.advanceTimersByTimeAsync(800);
      expect(spawn).toHaveBeenCalledTimes(3);
      expect(spawn.mock.calls[2][2]).toMatchObject({ cols: 130, rows: 33 });
    });

    it('keeps the session a closed pane was in', async () => {
      const terms = [fakeTerm(), fakeTerm(), fakeTerm()];
      let next = 0;
      spawn.mockImplementation(() => terms[next++]);
      const answers = ['$7\n'];
      const manager = new TerminalManager({
        platform: 'win32',
        consoleReaper: reaper,
        isRunning: () => false,
        tmux: async () => {
          if (answers.length) return answers.shift();
          throw new Error("can't find pane");
        },
      });
      const ws = fakeWs();
      manager.create(ws, '%1', 100, 30);
      started(terms[0]);
      message(ws, { type: 'resize', cols: 120, rows: 40 });
      await vi.advanceTimersByTimeAsync(800);
      started(terms[1]);
      await vi.advanceTimersByTimeAsync(800);
      message(ws, { type: 'resize', cols: 130, rows: 41 });
      await vi.advanceTimersByTimeAsync(800);
      expect(spawn.mock.calls[2][1]).toEqual(['-u', 'attach-session', '-d', '-t', '$7']);
    });

    it('starts nothing for a connection that closed in the meantime', async () => {
      const term = fakeTerm();
      spawn.mockReturnValue(term);
      const ws = fakeWs();
      windows().create(ws, '%1', 100, 30);
      started(term);
      message(ws, { type: 'resize', cols: 120, rows: 40 });
      ws.listeners.close();
      await vi.advanceTimersByTimeAsync(5000);
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it('asks for the session once, and not at all when the gateway already verified it', async () => {
      const terms = [fakeTerm(), fakeTerm(), fakeTerm()];
      let next = 0;
      spawn.mockImplementation(() => terms[next++]);
      const tmux = vi.fn(async () => '$7\n');
      const ws = fakeWs();
      windows({ tmux }).create(ws, '%1', 100, 30, false, { sessionTarget: '$3' });
      started(terms[0]);
      message(ws, { type: 'resize', cols: 120, rows: 40 });
      await vi.advanceTimersByTimeAsync(800);
      started(terms[1]);
      await vi.advanceTimersByTimeAsync(800);
      message(ws, { type: 'resize', cols: 130, rows: 41 });
      await vi.advanceTimersByTimeAsync(800);

      expect(tmux).not.toHaveBeenCalled();
      expect(spawn.mock.calls[1][1]).toEqual(['-u', 'attach-session', '-d', '-t', '$3']);
      expect(spawn.mock.calls[2][1]).toEqual(['-u', 'attach-session', '-d', '-t', '$3']);
    });

    it('notices a client has started when the marker arrives split in two', async () => {
      const terms = [fakeTerm(), fakeTerm()];
      let next = 0;
      spawn.mockImplementation(() => terms[next++]);
      const ws = fakeWs();
      windows().create(ws, '%1', 100, 30);
      message(ws, { type: 'resize', cols: 120, rows: 40 });

      terms[0].handlers.data('\x1b[?10');
      terms[0].handlers.data('49h');
      // Started, so only the settle time is left; well short of the 1500ms fallback.
      await vi.advanceTimersByTimeAsync(800);
      expect(spawn).toHaveBeenCalledTimes(2);
    });

    it('falls back to a time limit when the marker never comes, and still waits out the settle time', async () => {
      const terms = [fakeTerm(), fakeTerm()];
      let next = 0;
      spawn.mockImplementation(() => terms[next++]);
      const ws = fakeWs();
      windows().create(ws, '%1', 100, 30);
      message(ws, { type: 'resize', cols: 120, rows: 40 });
      await vi.advanceTimersByTimeAsync(1500 + 799);
      expect(spawn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(spawn).toHaveBeenCalledTimes(2);
    });

    it('leaves no startup timers behind when a connection ends', async () => {
      const term = fakeTerm();
      spawn.mockReturnValue(term);
      const ws = fakeWs();
      const manager = windows();
      manager.create(ws, '%1', 100, 30);
      const waiting = vi.getTimerCount();
      expect(waiting).toBeGreaterThan(0);
      ws.listeners.close();
      await vi.advanceTimersByTimeAsync(0);
      // Only the heartbeat could outlive it, and that goes with the connection too.
      expect(vi.getTimerCount()).toBe(0);
    });

    it('lets a resize waiting on startup finish when the connection ends', async () => {
      const term = fakeTerm();
      spawn.mockReturnValue(term);
      const ws = fakeWs();
      const manager = windows();
      const id = manager.create(ws, '%1', 100, 30);
      const conn = manager.connections.get(id);
      message(ws, { type: 'resize', cols: 120, rows: 40 });
      expect(conn.resizing).toBe(true);
      ws.listeners.close();
      await vi.advanceTimersByTimeAsync(0);
      expect(conn.resizing).toBe(false);
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it('settles on the latest size only, after a burst of different ones', async () => {
      const terms = [fakeTerm(), fakeTerm()];
      let next = 0;
      spawn.mockImplementation(() => terms[next++]);
      const ws = fakeWs();
      windows().create(ws, '%1', 100, 30);
      started(terms[0]);
      for (let cols = 101; cols <= 140; cols += 1) message(ws, { type: 'resize', cols, rows: 30 });
      await vi.advanceTimersByTimeAsync(800);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(spawn.mock.calls[1][2]).toMatchObject({ cols: 140, rows: 30 });
      started(terms[1]);
      await vi.advanceTimersByTimeAsync(5000);
      expect(spawn).toHaveBeenCalledTimes(2);
    });

    describe('changing one client at a time', () => {
      /** Hands out fake clients with their own pids, and says which are still running. */
      function clients() {
        const running = new Set();
        const terms = [];
        spawn.mockImplementation(() => {
          const term = fakeTerm();
          term.pid = 5000 + terms.length;
          terms.push(term);
          running.add(term.pid);
          return term;
        });
        processKill.mockImplementation((pid, signal) => {
          if (signal === undefined) running.delete(pid);
          return true;
        });
        return { terms, running, manager: windows({ isRunning: (pid) => running.has(pid) }) };
      }
      const on = (session) => ({ sessionTarget: session });
      const killed = () => processKill.mock.calls.filter(([, signal]) => signal === undefined).map(([pid]) => pid);
      const settle = (term) => { started(term); return vi.advanceTimersByTimeAsync(800); };

      it('replaces a client by ending the old one first, and starts the next once it is gone', async () => {
        const { terms, running, manager } = clients();
        const ws = fakeWs();
        manager.create(ws, '%1', 100, 30, false, on('$1'));
        await settle(terms[0]);

        running.add(terms[0].pid);
        processKill.mockImplementation(() => true);
        message(ws, { type: 'resize', cols: 120, rows: 40 });
        await vi.advanceTimersByTimeAsync(50);
        expect(killed()).toEqual([terms[0].pid]);
        expect(spawn).toHaveBeenCalledTimes(1);

        running.delete(terms[0].pid);
        await vi.advanceTimersByTimeAsync(5);
        expect(spawn).toHaveBeenCalledTimes(2);
        expect(spawn.mock.calls[1][2]).toMatchObject({ cols: 120, rows: 40 });
      });

      it('keeps what is typed during a replacement, in order, for the next client', async () => {
        const { terms, running, manager } = clients();
        const ws = fakeWs();
        manager.create(ws, '%1', 100, 30, false, on('$1'));
        await settle(terms[0]);

        running.add(terms[0].pid);
        processKill.mockImplementation(() => true);
        message(ws, { type: 'resize', cols: 120, rows: 40 });
        await vi.advanceTimersByTimeAsync(20);
        message(ws, { type: 'input', data: 'one' });
        message(ws, { type: 'input', data: 'two' });
        expect(terms[0].write).not.toHaveBeenCalled();

        running.delete(terms[0].pid);
        await vi.advanceTimersByTimeAsync(5);
        expect(terms[1].write.mock.calls).toEqual([['one'], ['two']]);
        message(ws, { type: 'input', data: 'three' });
        expect(terms[1].write).toHaveBeenLastCalledWith('three');
      });

      it('does not take the old client leaving for a disconnect, whenever its exit arrives', async () => {
        const { terms, running, manager } = clients();
        const ws = fakeWs();
        const id = manager.create(ws, '%1', 100, 30, false, on('$1'));
        await settle(terms[0]);

        running.add(terms[0].pid);
        processKill.mockImplementation(() => true);
        message(ws, { type: 'resize', cols: 120, rows: 40 });
        await vi.advanceTimersByTimeAsync(20);
        // Still between clients when the exit comes in.
        terms[0].handlers.exit({ exitCode: 0 });
        expect(ws.close).not.toHaveBeenCalled();
        expect(manager.connections.has(id)).toBe(true);

        running.delete(terms[0].pid);
        await vi.advanceTimersByTimeAsync(5);
        expect(spawn).toHaveBeenCalledTimes(2);
        terms[1].handlers.exit({ exitCode: 0 });
        expect(ws.close).toHaveBeenCalledWith(1000, expect.any(String));
      });

      it('starts nothing when the connection closes while the old client is leaving', async () => {
        const { terms, running, manager } = clients();
        const ws = fakeWs();
        manager.create(ws, '%1', 100, 30, false, on('$1'));
        await settle(terms[0]);

        running.add(terms[0].pid);
        processKill.mockImplementation(() => true);
        message(ws, { type: 'resize', cols: 120, rows: 40 });
        await vi.advanceTimersByTimeAsync(20);
        ws.listeners.close();
        running.delete(terms[0].pid);
        await vi.advanceTimersByTimeAsync(2000);
        expect(spawn).toHaveBeenCalledTimes(1);
      });

      it('does not let a client leave while another is reading its answers, even on another session', async () => {
        const { terms, manager } = clients();
        const a = fakeWs();
        manager.create(a, '%1', 100, 30, false, on('$1'));
        await settle(terms[0]);
        manager.create(fakeWs(), '%2', 100, 30, false, on('$2'));

        a.listeners.close();
        await vi.advanceTimersByTimeAsync(400);
        expect(killed()).toEqual([]);

        await settle(terms[1]);
        expect(killed()).toEqual([terms[0].pid]);
      });

      it('ends a client of ours on the session before starting another, as -d would', async () => {
        const { terms, running, manager } = clients();
        const a = fakeWs();
        manager.create(a, '%1', 100, 30, false, on('$1'));
        await settle(terms[0]);
        running.add(terms[0].pid);
        processKill.mockImplementation(() => true);

        const attach = vi.fn(() => 'started');
        const result = manager.whenClientCanStart('$1', attach);
        await vi.advanceTimersByTimeAsync(50);
        expect(killed()).toEqual([terms[0].pid]);
        expect(attach).not.toHaveBeenCalled();

        running.delete(terms[0].pid);
        await vi.advanceTimersByTimeAsync(5);
        await expect(result).resolves.toBe('started');

        // The other side is told, as it was when tmux detached it.
        terms[0].handlers.exit({ exitCode: 0 });
        expect(a.close).toHaveBeenCalledWith(1000, expect.any(String));
      });

      it('leaves clients on other sessions attached', async () => {
        const { terms, manager } = clients();
        manager.create(fakeWs(), '%1', 100, 30, false, on('$1'));
        await settle(terms[0]);
        await expect(manager.whenClientCanStart('$2', () => 'started')).resolves.toBe('started');
        expect(killed()).toEqual([]);
      });

      it('waits for a client that is starting, then starts the next', async () => {
        const { terms, manager } = clients();
        manager.create(fakeWs(), '%1', 100, 30, false, on('$1'));
        const attach = vi.fn();
        manager.whenClientCanStart('$2', attach);
        await vi.advanceTimersByTimeAsync(300);
        expect(attach).not.toHaveBeenCalled();
        await settle(terms[0]);
        expect(attach).toHaveBeenCalledOnce();
      });

      it('holds nobody up for a client that is already being ended', async () => {
        const { manager } = clients();
        const a = fakeWs();
        manager.create(a, '%1', 100, 30, false, on('$1'));
        const attach = vi.fn();
        a.listeners.close();
        manager.whenClientCanStart('$2', attach);
        await vi.advanceTimersByTimeAsync(0);
        expect(attach).toHaveBeenCalledOnce();
      });

      it('holds nobody up for a client that exits by itself', async () => {
        const { terms, manager } = clients();
        manager.create(fakeWs(), '%1', 100, 30, false, on('$1'));
        const attach = vi.fn();
        manager.whenClientCanStart('$2', attach);
        await vi.advanceTimersByTimeAsync(100);
        terms[0].handlers.exit({ exitCode: 1 });
        await vi.advanceTimersByTimeAsync(0);
        expect(attach).toHaveBeenCalledOnce();
      });

      const attachOn = (manager, ws, pane) => () => (ws.readyState === 1 ? manager.create(ws, pane, 100, 30, false, on('$1')) : null);

      it('takes requests in order: each ends the one before it once, and one client is left', async () => {
        const { terms, running, manager } = clients();
        await Promise.all(['%1', '%2', '%1'].map((pane) => manager.whenClientCanStart('$1', attachOn(manager, fakeWs(), pane))));

        expect(spawn.mock.calls.map(([, args]) => args.at(-1))).toEqual(['%1', '%2', '%1']);
        // Once each: a pid may belong to something else after it has gone.
        expect(killed()).toEqual([terms[0].pid, terms[1].pid]);
        expect(running.has(terms[2].pid)).toBe(true);
      });

      it('ends a client only once, however many things ask', async () => {
        const { terms, manager } = clients();
        const ws = fakeWs();
        manager.create(ws, '%1', 100, 30, false, on('$1'));
        await settle(terms[0]);
        await manager.whenClientCanStart('$1', () => null);
        await manager.whenClientCanStart('$1', () => null);
        ws.listeners.close();
        await vi.advanceTimersByTimeAsync(0);
        expect(killed()).toEqual([terms[0].pid]);
      });

      it('starts nothing for requests the user has already moved on from', async () => {
        const { manager } = clients();
        const sockets = [fakeWs(), fakeWs(), fakeWs()];
        sockets[0].readyState = 3;
        sockets[1].readyState = 3;
        const results = await Promise.all([
          manager.whenClientCanStart('$1', attachOn(manager, sockets[0], '%1')),
          manager.whenClientCanStart('$1', attachOn(manager, sockets[1], '%2')),
          manager.whenClientCanStart('$1', attachOn(manager, sockets[2], '%1')),
        ]);
        expect(results.slice(0, 2)).toEqual([null, null]);
        expect(spawn).toHaveBeenCalledOnce();
        expect(killed()).toEqual([]);
      });

      it('stops waiting and starts nothing as soon as the caller no longer wants it', async () => {
        const { manager } = clients();
        manager.create(fakeWs(), '%1', 100, 30, false, on('$1'));
        const attach = vi.fn();
        await expect(manager.whenClientCanStart('$2', attach, { cancelled: () => true })).resolves.toBeNull();
        expect(attach).not.toHaveBeenCalled();
      });

      describe('a client whose exit has been reported', () => {
        it('is left alone if it was waiting for another client to finish starting', async () => {
          const { terms, manager } = clients();
          const ws = fakeWs();
          manager.create(ws, '%2', 100, 30, false, on('$2'));
          await settle(terms[0]);
          await manager.whenClientCanStart('$1', () => manager.create(fakeWs(), '%1', 100, 30, false, on('$1')));

          ws.listeners.close();
          expect(killed()).toEqual([]);
          terms[0].handlers.exit({ exitCode: 0 });
          // What is left of it is still released.
          expect(terms[0].kill).toHaveBeenCalledOnce();
          expect(reaper.clientEnded).toHaveBeenCalledOnce();

          await settle(terms[1]);
          expect(killed()).toEqual([]);
        });

        it('is not ended by anything that asks later', async () => {
          const { terms, manager } = clients();
          const ws = fakeWs();
          manager.create(ws, '%1', 100, 30, false, on('$1'));
          await settle(terms[0]);
          terms[0].handlers.exit({ exitCode: 0 });
          manager._endClient(terms[0]);
          await vi.advanceTimersByTimeAsync(100);
          expect(killed()).toEqual([]);
        });

        it('is not counted as stuck when the wait for it runs out, though its pid still answers', async () => {
          const { terms, running, manager } = clients();
          const ws = fakeWs();
          manager.create(ws, '%1', 100, 30, false, on('$1'));
          await settle(terms[0]);
          running.add(terms[0].pid);
          processKill.mockImplementation(() => true);
          ws.listeners.close();
          await vi.advanceTimersByTimeAsync(100);
          expect(killed()).toEqual([terms[0].pid]);

          terms[0].handlers.exit({ exitCode: 1 });
          await vi.advanceTimersByTimeAsync(1600);
          await expect(manager.whenClientCanStart('$2', () => 'started')).resolves.toBe('started');
          expect(killed()).toEqual([terms[0].pid]);
        });

        it('is not ended after the wait for what was written to it', async () => {
          const { terms, manager } = clients();
          const ws = fakeWs();
          manager.create(ws, '%1', 100, 30, false, on('$1'));
          await settle(terms[0]);
          message(ws, { type: 'input', data: 'abc' });
          ws.listeners.close();
          await vi.advanceTimersByTimeAsync(10);
          terms[0].handlers.exit({ exitCode: 0 });
          await vi.advanceTimersByTimeAsync(100);
          expect(killed()).toEqual([]);
        });
      });

      describe('what was written to a client just before it ends', () => {
        const typeInto = async (context) => {
          const ws = fakeWs();
          context.manager.create(ws, '%1', 100, 30, false, on('$1'));
          await settle(context.terms[0]);
          return ws;
        };

        it('gets time to be read before a replacement ends the client, and the next one waits', async () => {
          const context = clients();
          const ws = await typeInto(context);
          message(ws, { type: 'input', data: 'abc' });
          message(ws, { type: 'resize', cols: 120, rows: 40 });

          await vi.advanceTimersByTimeAsync(50);
          expect(killed()).toEqual([]);
          expect(spawn).toHaveBeenCalledOnce();

          await vi.advanceTimersByTimeAsync(20);
          expect(killed()).toEqual([context.terms[0].pid]);
          expect(spawn).toHaveBeenCalledTimes(2);
          expect(context.terms[0].write.mock.calls).toEqual([['abc']]);
        });

        it('gets longer the more was written, in bytes', async () => {
          const context = clients();
          const ws = await typeInto(context);
          message(ws, { type: 'input', data: '中'.repeat(10) });
          message(ws, { type: 'input', data: 'x'.repeat(30) });
          ws.listeners.close();

          await vi.advanceTimersByTimeAsync(40 + 60 * 8 - 10);
          expect(killed()).toEqual([]);
          await vi.advanceTimersByTimeAsync(20);
          expect(killed()).toEqual([context.terms[0].pid]);
        });

        it('stops waiting at the limit, however much it was', async () => {
          const context = clients();
          const ws = await typeInto(context);
          message(ws, { type: 'input', data: 'x'.repeat(60000) });
          ws.listeners.close();

          await vi.advanceTimersByTimeAsync(1490);
          expect(killed()).toEqual([]);
          await vi.advanceTimersByTimeAsync(20);
          expect(killed()).toEqual([context.terms[0].pid]);
        });

        it('does not wait for it at shutdown', async () => {
          const context = clients();
          const ws = await typeInto(context);
          message(ws, { type: 'input', data: 'x'.repeat(100) });
          context.manager.destroyAll();
          expect(killed()).toEqual([context.terms[0].pid]);
        });

        it('does not delay a client that nothing was written to', async () => {
          const context = clients();
          const ws = await typeInto(context);
          ws.listeners.close();
          expect(killed()).toEqual([context.terms[0].pid]);
        });
      });

      it('holds what is typed from the moment a new size is asked for', async () => {
        const { terms, running, manager } = clients();
        const ws = fakeWs();
        manager.create(ws, '%1', 100, 30, false, on('$1'));
        await settle(terms[0]);

        running.add(terms[0].pid);
        processKill.mockImplementation(() => true);
        message(ws, { type: 'resize', cols: 120, rows: 40 });
        // In the same tick: the old client is ended a moment later and would lose it.
        message(ws, { type: 'input', data: 'same tick' });
        expect(terms[0].write).not.toHaveBeenCalled();

        running.delete(terms[0].pid);
        await vi.advanceTimersByTimeAsync(10);
        expect(terms[1].write.mock.calls).toEqual([['same tick']]);
      });

      it('gives what it held to the current client when the size goes back before it changed', async () => {
        const { terms, manager } = clients();
        const ws = fakeWs();
        manager.create(ws, '%1', 100, 30, false, on('$1'));
        started(terms[0]);
        await vi.advanceTimersByTimeAsync(100);

        message(ws, { type: 'resize', cols: 120, rows: 40 });
        message(ws, { type: 'input', data: 'a' });
        message(ws, { type: 'resize', cols: 100, rows: 30 });
        message(ws, { type: 'input', data: 'b' });
        expect(terms[0].write).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(800);
        expect(spawn).toHaveBeenCalledOnce();
        expect(terms[0].write.mock.calls).toEqual([['a'], ['b']]);
        message(ws, { type: 'input', data: 'c' });
        expect(terms[0].write).toHaveBeenLastCalledWith('c');
      });

      it('writes straight through for a resize to the size it already has', async () => {
        const { terms, manager } = clients();
        const ws = fakeWs();
        manager.create(ws, '%1', 100, 30, false, on('$1'));
        message(ws, { type: 'resize', cols: 100, rows: 30 });
        message(ws, { type: 'input', data: 'now' });
        expect(terms[0].write).toHaveBeenCalledWith('now');
      });

      it('keeps holding for the next size when one more was asked for during a replacement', async () => {
        const { terms, running, manager } = clients();
        const ws = fakeWs();
        manager.create(ws, '%1', 100, 30, false, on('$1'));
        await settle(terms[0]);

        running.add(terms[0].pid);
        processKill.mockImplementation(() => true);
        message(ws, { type: 'resize', cols: 120, rows: 40 });
        await vi.advanceTimersByTimeAsync(20);
        message(ws, { type: 'input', data: 'first' });
        message(ws, { type: 'resize', cols: 130, rows: 40 });
        running.delete(terms[0].pid);
        await vi.advanceTimersByTimeAsync(5);
        expect(terms[1].write.mock.calls).toEqual([['first']]);

        // Client 1 will go as soon as it has settled, and this is for client 2.
        message(ws, { type: 'input', data: 'second' });
        expect(terms[1].write).toHaveBeenCalledOnce();
        await settle(terms[1]);
        running.delete(terms[1].pid);
        await vi.advanceTimersByTimeAsync(5);
        expect(spawn).toHaveBeenCalledTimes(3);
        expect(terms[1].write).toHaveBeenCalledOnce();
        expect(terms[2].write.mock.calls).toEqual([['second']]);
      });

      it('keeps everything held across a later size asked for before the first change happened', async () => {
        const { terms, running, manager } = clients();
        const ws = fakeWs();
        manager.create(ws, '%1', 100, 30, false, on('$1'));
        started(terms[0]);
        await vi.advanceTimersByTimeAsync(100);

        message(ws, { type: 'resize', cols: 120, rows: 40 });
        message(ws, { type: 'input', data: 'a' });
        message(ws, { type: 'resize', cols: 130, rows: 40 });
        message(ws, { type: 'input', data: 'b' });
        await vi.advanceTimersByTimeAsync(800);

        // One replacement for both sizes, at the latest, with both inputs once.
        expect(spawn).toHaveBeenCalledTimes(2);
        expect(spawn.mock.calls[1][2]).toMatchObject({ cols: 130, rows: 40 });
        expect(terms[0].write).not.toHaveBeenCalled();
        expect(terms[1].write.mock.calls).toEqual([['a'], ['b']]);
        expect(running.has(terms[1].pid)).toBe(true);
      });

      it('drops what it held when the connection closes first, and starts nothing', async () => {
        const { terms, manager } = clients();
        const ws = fakeWs();
        manager.create(ws, '%1', 100, 30, false, on('$1'));
        started(terms[0]);
        await vi.advanceTimersByTimeAsync(100);

        message(ws, { type: 'resize', cols: 120, rows: 40 });
        message(ws, { type: 'input', data: 'typed' });
        ws.readyState = 3;
        ws.listeners.close();
        await vi.advanceTimersByTimeAsync(3000);

        expect(spawn).toHaveBeenCalledOnce();
        expect(terms[0].write).not.toHaveBeenCalled();
      });

      describe('a connection another client takes over', () => {
        // The client is gone at once; node-pty reports its exit about a second later.
        async function takenOver() {
          const context = clients();
          const { terms, manager } = context;
          const oldWs = fakeWs();
          const onPtyExit = vi.fn();
          const oldId = manager.create(oldWs, '%1', 100, 30, false, { ...on('$1'), onPtyExit });
          await settle(terms[0]);
          const newWs = fakeWs();
          const newId = await manager.whenClientCanStart('$1', () => manager.create(newWs, '%1', 100, 30, false, on('$1')));
          await settle(terms[1]);
          return { ...context, oldWs, oldId, onPtyExit, newWs, newId };
        }

        it('ends at once, the way `-d` always showed it, without waiting for the exit', async () => {
          const { manager, oldWs, oldId, onPtyExit, newId } = await takenOver();
          expect(oldWs.close).toHaveBeenCalledWith(1000, expect.any(String));
          expect(onPtyExit).toHaveBeenCalledOnce();
          expect(manager.connections.has(oldId)).toBe(false);
          expect(manager.connections.has(newId)).toBe(true);
          expect(manager.paneConnectionCount.get('%1')).toBe(1);
        });

        it('cannot take the session back: a resize from its socket starts and ends nothing', async () => {
          const { terms, running, oldWs, newWs } = await takenOver();
          message(oldWs, { type: 'resize', cols: 120, rows: 40 });
          await vi.advanceTimersByTimeAsync(3000);

          expect(spawn).toHaveBeenCalledTimes(2);
          expect(killed()).toEqual([terms[0].pid]);
          expect(running.has(terms[1].pid)).toBe(true);
          expect(newWs.close).not.toHaveBeenCalled();
        });

        it('drops what its socket still delivers', async () => {
          const { terms, oldWs } = await takenOver();
          message(oldWs, { type: 'input', data: 'late' });
          expect(terms[0].write).not.toHaveBeenCalled();
          expect(terms[1].write).not.toHaveBeenCalled();
        });

        it('still releases its client when the exit does arrive, and nothing more', async () => {
          const { terms, manager, oldWs, onPtyExit, newWs, newId } = await takenOver();
          terms[0].handlers.exit({ exitCode: 1 });

          expect(terms[0].kill).toHaveBeenCalledOnce();
          expect(reaper.clientEnded).toHaveBeenCalledOnce();
          expect(onPtyExit).toHaveBeenCalledOnce();
          expect(oldWs.close).toHaveBeenCalledOnce();
          expect(manager.connections.has(newId)).toBe(true);
          expect(terms[1].kill).not.toHaveBeenCalled();
          expect(newWs.close).not.toHaveBeenCalled();
        });

        it('still holds the next client back until its client has gone', async () => {
          const { terms, running, manager } = clients();
          const oldWs = fakeWs();
          manager.create(oldWs, '%1', 100, 30, false, on('$1'));
          await settle(terms[0]);
          processKill.mockImplementation(() => true);

          const attach = vi.fn(() => null);
          manager.whenClientCanStart('$1', attach);
          await vi.advanceTimersByTimeAsync(50);
          expect(oldWs.close).toHaveBeenCalledWith(1000, expect.any(String));
          expect(attach).not.toHaveBeenCalled();

          running.delete(terms[0].pid);
          await vi.advanceTimersByTimeAsync(5);
          expect(attach).toHaveBeenCalledOnce();
        });

        it('cancels a replacement already in line behind the client taking over', async () => {
          const { terms, running, manager } = clients();
          const oldWs = fakeWs();
          manager.create(oldWs, '%1', 100, 30, false, on('$1'));
          await settle(terms[0]);

          let finishFirst;
          manager.whenClientCanStart('$2', () => new Promise((resolve) => { finishFirst = resolve; }));
          await vi.advanceTimersByTimeAsync(0);
          const newWs = fakeWs();
          const starting = manager.whenClientCanStart('$1', () => manager.create(newWs, '%1', 100, 30, false, on('$1')));
          message(oldWs, { type: 'resize', cols: 120, rows: 40 });
          await vi.advanceTimersByTimeAsync(0);
          finishFirst();
          await starting;
          await settle(terms[1]);
          await vi.advanceTimersByTimeAsync(3000);

          expect(spawn).toHaveBeenCalledTimes(2);
          expect(killed()).toEqual([terms[0].pid]);
          expect(running.has(terms[1].pid)).toBe(true);
          expect(newWs.close).not.toHaveBeenCalled();
        });

        it('cancels a resize still waiting for its client to settle', async () => {
          const { terms, running, manager } = clients();
          const oldWs = fakeWs();
          manager.create(oldWs, '%1', 100, 30, false, on('$1'));
          started(terms[0]);
          await vi.advanceTimersByTimeAsync(100);
          message(oldWs, { type: 'resize', cols: 120, rows: 40 });

          const newWs = fakeWs();
          await manager.whenClientCanStart('$1', () => manager.create(newWs, '%1', 100, 30, false, on('$1')));
          await settle(terms[1]);
          await vi.advanceTimersByTimeAsync(3000);

          expect(spawn).toHaveBeenCalledTimes(2);
          expect(killed()).toEqual([terms[0].pid]);
          expect(running.has(terms[1].pid)).toBe(true);
          expect(newWs.close).not.toHaveBeenCalled();
        });
      });

      it('closes rather than hold more input than the limit while a client changes', async () => {
        const { terms, running, manager } = clients();
        const ws = fakeWs();
        const id = manager.create(ws, '%1', 100, 30, false, on('$1'));
        await settle(terms[0]);
        processKill.mockImplementation(() => true);
        message(ws, { type: 'resize', cols: 120, rows: 40 });
        await vi.advanceTimersByTimeAsync(20);

        message(ws, { type: 'input', data: 'x'.repeat(MAX_HELD_INPUT_BYTES) });
        expect(ws.close).not.toHaveBeenCalled();
        message(ws, { type: 'input', data: 'y' });
        expect(ws.close).toHaveBeenCalledWith(1009, expect.any(String));
        expect(manager.connections.has(id)).toBe(false);

        running.delete(terms[0].pid);
        await vi.advanceTimersByTimeAsync(5);
        expect(spawn).toHaveBeenCalledTimes(1);
      });

      it('does not touch the current terminal for a request cancelled while it waited in line', async () => {
        const { terms, running, manager } = clients();
        const current = fakeWs();
        manager.create(current, '%1', 100, 30, false, on('$1'));
        await settle(terms[0]);

        // Ahead of it in line, something is taking a while.
        let cancelled = false;
        let finishFirst;
        manager.whenClientCanStart('$2', () => new Promise((resolve) => { finishFirst = resolve; }));
        await vi.advanceTimersByTimeAsync(0);
        const attach = vi.fn(() => null);
        const queued = manager.whenClientCanStart('$1', attach, { cancelled: () => cancelled });

        cancelled = true;
        finishFirst();
        await queued;

        expect(killed()).toEqual([]);
        expect(running.has(terms[0].pid)).toBe(true);
        expect(current.close).not.toHaveBeenCalled();
      });

      describe('a client that does not go when ended', () => {
        function stuck() {
          const context = clients();
          const { terms, running, manager } = context;
          const ws = fakeWs();
          manager.create(ws, '%1', 100, 30, false, on('$1'));
          return { ...context, ws, settleFirst: async () => { await settle(terms[0]); running.add(terms[0].pid); processKill.mockImplementation(() => true); } };
        }

        it('starts nothing next to it: the attach fails with something worth retrying', async () => {
          const { manager, settleFirst } = stuck();
          await settleFirst();
          const attach = vi.fn();
          const result = manager.whenClientCanStart('$1', attach).catch((err) => err);
          await vi.advanceTimersByTimeAsync(1600);
          const err = await result;
          expect(err.code).toBe('TERMINAL_BUSY');
          expect(err.retryable).toBe(true);
          expect(attach).not.toHaveBeenCalled();
        });

        it('blocks a client for another session too, as leaving hurts any of them', async () => {
          const { manager, settleFirst, ws } = stuck();
          await settleFirst();
          ws.listeners.close();
          await vi.advanceTimersByTimeAsync(1600);
          const attach = vi.fn();
          const result = manager.whenClientCanStart('$2', attach).catch((err) => err);
          await vi.advanceTimersByTimeAsync(1600);
          expect((await result).code).toBe('TERMINAL_BUSY');
          expect(attach).not.toHaveBeenCalled();
        });

        it('goes ahead on the next try once it has really gone, leaving its pid alone', async () => {
          const { terms, running, manager, settleFirst } = stuck();
          await settleFirst();
          const first = manager.whenClientCanStart('$1', vi.fn()).catch((err) => err);
          await vi.advanceTimersByTimeAsync(1600);
          expect((await first).code).toBe('TERMINAL_BUSY');
          expect(killed()).toEqual([terms[0].pid]);

          running.delete(terms[0].pid);
          await expect(manager.whenClientCanStart('$1', () => 'started')).resolves.toBe('started');
          expect(killed()).toEqual([terms[0].pid]);
        });

        it('never ends that pid again, as it may be someone else\'s by now: it only keeps waiting', async () => {
          const { terms, manager, settleFirst } = stuck();
          await settleFirst();
          const first = manager.whenClientCanStart('$1', vi.fn()).catch((err) => err);
          await vi.advanceTimersByTimeAsync(1600);
          await first;

          const attach = vi.fn();
          // No second wait either: nothing new was asked of it.
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const again = await manager.whenClientCanStart('$1', attach).catch((err) => err);
            expect(again.code).toBe('TERMINAL_BUSY');
          }
          await vi.advanceTimersByTimeAsync(5000);
          expect(killed()).toEqual([terms[0].pid]);
          expect(attach).not.toHaveBeenCalled();
        });

        it('goes ahead once its exit is reported, whatever the pid looks like by then', async () => {
          const { terms, manager, settleFirst } = stuck();
          await settleFirst();
          const first = manager.whenClientCanStart('$1', vi.fn()).catch((err) => err);
          await vi.advanceTimersByTimeAsync(1600);
          expect((await first).code).toBe('TERMINAL_BUSY');

          terms[0].handlers.exit({ exitCode: 1 });
          await expect(manager.whenClientCanStart('$1', () => 'started')).resolves.toBe('started');
          expect(killed()).toEqual([terms[0].pid]);
        });

        it('treats a client that never got a pid the same way', async () => {
          const term = { ...fakeTerm(), pid: 0 };
          term.onData = vi.fn((fn) => { term.handlers.data = fn; return { dispose: vi.fn() }; });
          spawn.mockReturnValue(term);
          const ws = fakeWs();
          const manager = windows();
          manager.create(ws, '%1', 100, 30, false, on('$1'));
          ws.listeners.close();
          await vi.advanceTimersByTimeAsync(5100);
          expect(processKill).not.toHaveBeenCalled();
          const attach = vi.fn();
          const result = manager.whenClientCanStart('$1', attach).catch((err) => err);
          await vi.advanceTimersByTimeAsync(5100);
          expect((await result).code).toBe('TERMINAL_BUSY');
          expect(attach).not.toHaveBeenCalled();

          // Not told yet, so this is not a second time: once the pid comes, it can be.
          term.pid = 7000;
          await expect(manager.whenClientCanStart('$1', () => 'started')).resolves.toBe('started');
          expect(killed()).toEqual([7000]);
        });

        it('replaces nothing during a resize: the connection closes so the page tries again', async () => {
          const { terms, ws, settleFirst } = stuck();
          await settleFirst();
          message(ws, { type: 'resize', cols: 120, rows: 40 });
          await vi.advanceTimersByTimeAsync(1600);
          expect(spawn).toHaveBeenCalledTimes(1);
          expect(ws.close).toHaveBeenCalledWith(1011, expect.any(String));
          expect(terms[0].kill).not.toHaveBeenCalled();
        });
      });

      it('does not hold back the clients when the panel shuts down', async () => {
        const { terms, manager } = clients();
        manager.create(fakeWs(), '%1', 100, 30, false, on('$1'));
        await settle(terms[0]);
        manager.create(fakeWs(), '%2', 100, 30, false, on('$2'));
        manager.destroyAll();
        expect(killed().sort()).toEqual([terms[0].pid, terms[1].pid].sort());
      });

      it('keeps a failure in one attach from blocking the next', async () => {
        const { manager } = clients();
        await expect(manager.whenClientCanStart('$1', () => { throw new Error('no conpty'); })).rejects.toThrow('no conpty');
        await expect(manager.whenClientCanStart('$1', () => 'started')).resolves.toBe('started');
      });
    });

    it('ends up on the original size with no new client when a burst returns to it', async () => {
      const term = fakeTerm();
      spawn.mockReturnValue(term);
      const ws = fakeWs();
      windows().create(ws, '%1', 100, 30);
      started(term);
      message(ws, { type: 'resize', cols: 120, rows: 40 });
      message(ws, { type: 'resize', cols: 100, rows: 30 });
      await vi.advanceTimersByTimeAsync(5000);
      expect(spawn).toHaveBeenCalledTimes(1);
    });
  });

  it('needs no turn off Windows', async () => {
    const manager = new TerminalManager({ platform: 'linux' });
    const attach = vi.fn(() => 'started');
    await expect(manager.whenClientCanStart('$1', attach)).resolves.toBe('started');
    expect(attach).toHaveBeenCalledOnce();
  });

  it('starts nothing for a socket that has already closed: nothing would ever end it', () => {
    const manager = new TerminalManager();
    const ws = fakeWs();
    ws.readyState = 3;
    expect(manager.create(ws, '%1')).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
    expect(manager.paneConnectionCount.has('%1')).toBe(false);
  });

  it('spots a marker however the stream is cut', () => {
    const marker = '\x1b[?1049h';
    for (let cut = 1; cut < marker.length; cut += 1) {
      const watch = createMarkerWatch(marker);
      expect(watch('before' + marker.slice(0, cut))).toBe(false);
      expect(watch(marker.slice(cut) + 'after')).toBe(true);
    }
    const watch = createMarkerWatch(marker);
    expect(watch('\x1b[?10')).toBe(false);
    expect(watch('48h')).toBe(false);
    expect(watch('\x1b')).toBe(false);
    expect(watch(marker.slice(1))).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('keeps the SIGKILL fallback after a WebSocket closes', () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    try {
      const term = fakeTerm();
      spawn.mockReturnValue(term);
      const manager = new TerminalManager();
      const ws = fakeWs();

      manager.create(ws, '%1');
      ws.listeners.close();

      expect(manager.connections.size).toBe(0);
      expect(kill).toHaveBeenCalledWith(-4242, 'SIGTERM');

      vi.advanceTimersByTime(500);

      expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
    } finally {
      kill.mockRestore();
      vi.useRealTimers();
    }
  });

  it.skipIf(process.platform === 'win32')('escalates after the PTY leader exits without targeting its raw PID', () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
      if (target === -4242 && signal === 'SIGKILL') throw new Error('ESRCH');
      return true;
    });
    try {
      const term = fakeTerm();
      spawn.mockReturnValue(term);
      const manager = new TerminalManager();
      const ws = fakeWs();

      manager.create(ws, '%1');
      ws.listeners.close();
      term.handlers.exit({ exitCode: 0, signal: null });
      vi.advanceTimersByTime(500);

      expect(kill).toHaveBeenCalledTimes(2);
      expect(kill).toHaveBeenNthCalledWith(1, -4242, 'SIGTERM');
      expect(kill).toHaveBeenNthCalledWith(2, -4242, 'SIGKILL');
    } finally {
      kill.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe('TerminalManager spawn', () => {
  beforeEach(() => {
    spawn.mockReset();
    spawn.mockImplementation(() => fakeTerm());
  });

  it('uses the local shell by default', () => {
    const manager = new TerminalManager();
    manager.create(fakeWs(), '%1');

    const [file, args] = spawn.mock.calls[0];
    expect({ file, args }).toEqual(localAttachSpawnSpec('%1', { nozoom: false }));
  });

  it('keeps the attach client UTF-8 even when the service has no locale', () => {
    const oldLang = process.env.LANG;
    delete process.env.LANG;
    try {
      const manager = new TerminalManager();
      manager.create(fakeWs(), '%1', 100, 30, true);

      const [file, args, options] = spawn.mock.calls[0];
      expect({ file, args }).toEqual(localAttachSpawnSpec('%1', { nozoom: true }));
      expect(options.cols).toBe(100);
      expect(options.rows).toBe(30);
      expect(options.name).toBe('xterm-256color');
      expect(options.env.LANG).toBe('C.UTF-8');
    } finally {
      if (oldLang === undefined) delete process.env.LANG;
      else process.env.LANG = oldLang;
    }
  });

  it('reports the pty exit to an observer before closing the socket', () => {
    const manager = new TerminalManager();
    const term = fakeTerm();
    spawn.mockReturnValue(term);
    const ws = fakeWs();
    const seen = [];

    manager.create(ws, '%1', 80, 24, false, { serverId: 'api-linux', onPtyExit: (info) => seen.push(info) });
    term.handlers.exit({ exitCode: 3, signal: null });

    expect(seen).toEqual([{ code: 3, signal: null, reason: 'tmux_client_exit' }]);
    expect(ws.close).toHaveBeenCalledWith(1000, expect.stringContaining('3'));
  });

  it('keeps the legacy close-only behavior without an observer', () => {
    const manager = new TerminalManager();
    const term = fakeTerm();
    spawn.mockReturnValue(term);
    const ws = fakeWs();

    manager.create(ws, '%1');
    expect(() => term.handlers.exit({ exitCode: 0, signal: null })).not.toThrow();

    expect(ws.send).not.toHaveBeenCalled();
    expect(ws.close).toHaveBeenCalledWith(1000, expect.stringContaining('0'));
  });

  it('survives an observer that throws', () => {
    const manager = new TerminalManager();
    const term = fakeTerm();
    spawn.mockReturnValue(term);
    const ws = fakeWs();

    manager.create(ws, '%1', 80, 24, false, { onPtyExit: () => { throw new Error('socket gone'); } });

    expect(() => term.handlers.exit({ exitCode: 1, signal: null })).not.toThrow();
    expect(ws.close).toHaveBeenCalled();
  });
});

describe('TerminalManager refusal reporting', () => {
  beforeEach(() => {
    spawn.mockReset();
    spawn.mockImplementation(() => fakeTerm());
  });

  it('reports a quota refusal before closing so a caller can send a frame', () => {
    const manager = new TerminalManager({ maxConnectionsPerPane: 1 });
    manager.create(fakeWs(), '%0', 80, 24, false, { serverId: 'api-linux' });

    const ws = fakeWs();
    const rejections = [];
    const result = manager.create(ws, '%0', 80, 24, false, {
      serverId: 'api-linux',
      onReject: (info) => rejections.push(info),
    });

    expect(result).toBeNull();
    expect(rejections).toEqual([{ code: 'CONNECTION_LIMIT', message: expect.stringContaining('%0') }]);
    expect(ws.close).toHaveBeenCalledWith(1013, expect.stringContaining('%0'));
  });

  it('reports an invalid pane id refusal', () => {
    const manager = new TerminalManager();
    const ws = fakeWs();
    const rejections = [];

    manager.create(ws, 'not-a-pane', 80, 24, false, { onReject: (info) => rejections.push(info) });

    expect(rejections[0].code).toBe('VALIDATION_ERROR');
    expect(ws.close).toHaveBeenCalledWith(1008, expect.stringContaining('not-a-pane'));
  });

  it('keeps close-only behavior for the legacy caller', () => {
    const manager = new TerminalManager({ maxConnectionsPerPane: 1 });
    manager.create(fakeWs(), '%0');

    const ws = fakeWs();
    expect(manager.create(ws, '%0')).toBeNull();
    expect(ws.send).not.toHaveBeenCalled();
    expect(ws.close).toHaveBeenCalledWith(1013, expect.any(String));
  });

  it('still closes the socket when the observer throws', () => {
    const manager = new TerminalManager({ maxConnectionsPerPane: 1 });
    manager.create(fakeWs(), '%0');

    const ws = fakeWs();
    expect(() => manager.create(ws, '%0', 80, 24, false, {
      onReject: () => { throw new Error('socket gone'); },
    })).not.toThrow();
    expect(ws.close).toHaveBeenCalledWith(1013, expect.any(String));
  });

  it('contains a synchronous PTY spawn failure to this socket', () => {
    spawn.mockImplementation(() => { throw new Error('posix_spawnp failed'); });
    const manager = new TerminalManager();
    const ws = fakeWs();
    const rejections = [];

    expect(() => manager.create(ws, '%0', 80, 24, false, {
      onReject: (info) => rejections.push(info),
    })).not.toThrow();
    expect(rejections).toEqual([{
      code: 'TERMINAL_SPAWN_FAILED',
      message: 'Terminal process could not be started',
    }]);
    expect(ws.close).toHaveBeenCalledWith(1011, 'Terminal process could not be started');
    expect(manager.connections.size).toBe(0);
  });

});

describe('localAttachSpawnSpec', () => {
  it('runs the attach command under sh on Unix', () => {
    expect(localAttachSpawnSpec('%1', { platform: 'linux' })).toEqual({
      file: 'sh', args: ['-c', buildTmuxAttachCommand('%1', { nozoom: false })],
    });
  });

  it('starts tmux directly with the same command queue on Windows', () => {
    const spec = localAttachSpawnSpec('%1', { nozoom: true, platform: 'win32' });
    expect(spec.file).toMatch(/tmux/);
    expect(spec.args).toEqual(buildTmuxAttachArgs('%1', { nozoom: true }));
  });
});

describe('buildTmuxAttachArgs', () => {
  it('mirrors the shell command as one tmux command queue', () => {
    expect(buildTmuxAttachArgs('%5', { nozoom: false })).toEqual([
      '-u', 'select-pane', '-t', '%5', ';',
      'if-shell', '-F', '-t', '%5', '#{window_zoomed_flag}', '', 'resize-pane -Z -t %5', ';',
      'attach-session', '-d', '-t', '%5',
    ]);
  });

  it('force-unzooms first in split mode', () => {
    const args = buildTmuxAttachArgs('%5', { nozoom: true });
    expect(args.slice(10, 12)).toEqual(['resize-pane -Z -t %5', '']);
  });
});

describe('buildTmuxAttachCommand', () => {
  it('detaches other clients in both modes so this client owns the size', () => {
    expect(buildTmuxAttachCommand('%5', { nozoom: false })).toContain("attach-session -d -t '%5'");
    expect(buildTmuxAttachCommand('%5', { nozoom: true })).toContain("attach-session -d -t '%5'");
  });

  it('never changes zoom when an old attachment exits', () => {
    expect(buildTmuxAttachCommand('%5', { nozoom: false })).not.toContain('trap');
    expect(buildTmuxAttachCommand('%5', { nozoom: true })).not.toContain('trap');
  });

  it('force-unzooms first in split mode', () => {
    expect(buildTmuxAttachCommand('%5', { nozoom: true })).toContain('window_zoomed_flag');
  });
});
