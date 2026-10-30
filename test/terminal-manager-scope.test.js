import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock('node-pty', () => ({ default: { spawn } }));

import { TerminalManager, buildTmuxAttachCommand, buildTmuxAttachArgs, localAttachSpawnSpec } from '../server/terminal.js';

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
    const windows = () => new TerminalManager({ platform: 'win32', tmux: async () => '$7\n', consoleReaper: reaper });
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
