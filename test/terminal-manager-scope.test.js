import { describe, it, expect, vi, beforeEach } from 'vitest';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock('node-pty', () => ({ default: { spawn } }));

import { TerminalManager, buildTmuxAttachCommand } from '../server/terminal.js';

function fakeTerm() {
  const handlers = {};
  return {
    handlers,
    onData: vi.fn((fn) => { handlers.data = fn; return { dispose: vi.fn() }; }),
    onExit: vi.fn((fn) => { handlers.exit = fn; }),
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

describe('TerminalManager server scoping', () => {
  beforeEach(() => {
    spawn.mockReset();
    spawn.mockImplementation(() => fakeTerm());
  });

  it('gives each server its own quota for the same pane id', () => {
    const manager = new TerminalManager({ maxConnectionsPerPane: 2 });

    // Fill the quota for %0 on one remote server.
    const a1 = manager.create(fakeWs(), '%0', 80, 24, false, { serverId: 'api-linux' });
    const a2 = manager.create(fakeWs(), '%0', 80, 24, false, { serverId: 'api-linux' });
    const refused = fakeWs();
    const a3 = manager.create(refused, '%0', 80, 24, false, { serverId: 'api-linux' });

    expect(a1).toBeTruthy();
    expect(a2).toBeTruthy();
    expect(a3).toBeNull();
    expect(refused.close).toHaveBeenCalledWith(1013, expect.stringContaining('%0'));

    // The identical pane id on a different server must still be available.
    const b1 = manager.create(fakeWs(), '%0', 80, 24, false, { serverId: 'build-mac' });
    const b2 = manager.create(fakeWs(), '%0', 80, 24, false, { serverId: 'build-mac' });
    expect(b1).toBeTruthy();
    expect(b2).toBeTruthy();

    // And so must the local one.
    expect(manager.create(fakeWs(), '%0')).toBeTruthy();

    expect(manager.paneConnectionCount.get('api-linux:%0')).toBe(2);
    expect(manager.paneConnectionCount.get('build-mac:%0')).toBe(2);
    expect(manager.paneConnectionCount.get('local:%0')).toBe(1);
  });

  it('treats the legacy entry point as the local server', () => {
    const manager = new TerminalManager({ maxConnectionsPerPane: 1 });

    expect(manager.create(fakeWs(), '%3')).toBeTruthy();
    expect(manager.paneConnectionCount.get('local:%3')).toBe(1);

    // A second legacy connection hits the same key.
    expect(manager.create(fakeWs(), '%3')).toBeNull();
    // An explicit local serverId shares that key too.
    expect(manager.create(fakeWs(), '%3', 80, 24, false, { serverId: 'local' })).toBeNull();
  });

  it('releases the quota under the same scoped key', () => {
    const manager = new TerminalManager({ maxConnectionsPerPane: 1 });
    const id = manager.create(fakeWs(), '%7', 80, 24, false, { serverId: 'api-linux' });
    expect(manager.paneConnectionCount.get('api-linux:%7')).toBe(1);

    manager.destroy(id);

    expect(manager.paneConnectionCount.has('api-linux:%7')).toBe(false);
    expect(manager.create(fakeWs(), '%7', 80, 24, false, { serverId: 'api-linux' })).toBeTruthy();
  });

  it('does not leak one server\'s cleanup into another', () => {
    const manager = new TerminalManager({ maxConnectionsPerPane: 1 });
    const remote = manager.create(fakeWs(), '%1', 80, 24, false, { serverId: 'api-linux' });
    manager.create(fakeWs(), '%1', 80, 24, false, { serverId: 'build-mac' });

    manager.destroy(remote);

    expect(manager.paneConnectionCount.has('api-linux:%1')).toBe(false);
    expect(manager.paneConnectionCount.get('build-mac:%1')).toBe(1);
  });
});

describe('TerminalManager spawn override', () => {
  beforeEach(() => {
    spawn.mockReset();
    spawn.mockImplementation(() => fakeTerm());
  });

  it('uses the local shell by default', () => {
    const manager = new TerminalManager();
    manager.create(fakeWs(), '%1');

    const [file, args] = spawn.mock.calls[0];
    expect(file).toBe('sh');
    expect(args[0]).toBe('-c');
    expect(args[1]).toBe(buildTmuxAttachCommand('%1', { nozoom: false }));
  });

  it('honors a remote spawn spec while keeping env and locale behavior', () => {
    const oldLang = process.env.LANG;
    delete process.env.LANG;
    try {
      const manager = new TerminalManager();
      const remoteCommand = buildTmuxAttachCommand('%1', { nozoom: true });
      manager.create(fakeWs(), '%1', 100, 30, true, {
        serverId: 'api-linux',
        spawn: { file: 'ssh', args: ['-tt', 'deploy@host', '--', remoteCommand] },
      });

      const [file, args, options] = spawn.mock.calls[0];
      expect(file).toBe('ssh');
      expect(args[args.length - 1]).toBe(remoteCommand);
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

  it('scopedCount reports per-server attachment', () => {
    const manager = new TerminalManager({ maxConnectionsPerPane: 3 });
    manager.create(fakeWs(), '%0', 80, 24, false, { serverId: 'api-linux' });
    manager.create(fakeWs(), '%0', 80, 24, false, { serverId: 'api-linux' });
    manager.create(fakeWs(), '%0');

    expect(manager.scopedCount('api-linux', '%0')).toBe(2);
    expect(manager.scopedCount('local', '%0')).toBe(1);
    expect(manager.scopedCount(null, '%0')).toBe(1);
    expect(manager.scopedCount('build-mac', '%0')).toBe(0);
  });
});

describe('buildTmuxAttachCommand', () => {
  it('detaches other clients in both modes so this client owns the size', () => {
    expect(buildTmuxAttachCommand('%5', { nozoom: false })).toContain("tmux attach-session -d -t '%5'");
    expect(buildTmuxAttachCommand('%5', { nozoom: true })).toContain("tmux attach-session -d -t '%5'");
  });

  it('only installs the unzoom trap in zoom mode', () => {
    expect(buildTmuxAttachCommand('%5', { nozoom: false })).toContain('trap');
    expect(buildTmuxAttachCommand('%5', { nozoom: true })).not.toContain('trap');
  });

  it('force-unzooms first in split mode', () => {
    expect(buildTmuxAttachCommand('%5', { nozoom: true })).toContain('window_zoomed_flag');
  });
});
