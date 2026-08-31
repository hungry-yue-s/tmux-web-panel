import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

import {
  MAX_DIMENSION,
  MAX_INPUT_BYTES,
  ServerMessage,
  clampDimension,
  parseClientMessage,
  parseTerminalPath,
  parseTerminalQuery,
} from '../server/terminal/protocol.js';
import { TerminalGateway } from '../server/terminal/gateway.js';
import { AppError, ErrorCode } from '../server/servers/errors.js';
import { PaneRuntime } from '../server/terminal/pane-runtime.js';

describe('parseTerminalPath', () => {
  it('parses the server-scoped address', () => {
    expect(parseTerminalPath('/ws/terminal/api-linux/%251')).toEqual({
      serverId: 'api-linux',
      paneId: '%1',
      legacy: false,
    });
  });

  it('keeps the legacy address on the local server', () => {
    expect(parseTerminalPath('/ws/terminal/%251')).toEqual({
      serverId: 'local',
      paneId: '%1',
      legacy: true,
    });
  });

  it('decodes application pane ids', () => {
    expect(parseTerminalPath('/ws/terminal/api-linux/pane_abc123')).toMatchObject({ paneId: 'pane_abc123' });
  });

  it('returns null for malformed percent-encoding instead of throwing', () => {
    for (const bad of [
      '/ws/terminal/api-linux/%',
      '/ws/terminal/api-linux/%zz',
      '/ws/terminal/%E0%A4%A',
      '/ws/terminal/api%/%1',
    ]) {
      expect(() => parseTerminalPath(bad)).not.toThrow();
      expect(parseTerminalPath(bad)).toBeNull();
    }
  });

  it('rejects control characters and empty or oversized ids', () => {
    expect(parseTerminalPath('/ws/terminal/api-linux/%01')).toBeNull();
    expect(parseTerminalPath('/ws/terminal/')).toBeNull();
    expect(parseTerminalPath('/ws/terminal/a/' + 'x'.repeat(200))).toBeNull();
  });

  it('rejects extra path segments and other prefixes', () => {
    expect(parseTerminalPath('/ws/terminal/a/b/c')).toBeNull();
    expect(parseTerminalPath('/ws/status')).toBeNull();
    expect(parseTerminalPath(null)).toBeNull();
  });

  it('rejects an invalid server id', () => {
    expect(parseTerminalPath('/ws/terminal/BAD ID/%251')).toBeNull();
    expect(parseTerminalPath('/ws/terminal/-nope/%251')).toBeNull();
  });
});

describe('clampDimension', () => {
  it('falls back for anything not a clean integer', () => {
    for (const bad of ['80junk', 'abc', '', null, undefined, '1.5', 'NaN', '-5', '0', Infinity]) {
      expect(clampDimension(bad, 80)).toBe(80);
    }
  });

  it('accepts integers and caps the maximum', () => {
    expect(clampDimension('120', 80)).toBe(120);
    expect(clampDimension(120, 80)).toBe(120);
    expect(clampDimension(999999, 80)).toBe(MAX_DIMENSION);
  });
});

describe('parseTerminalQuery', () => {
  it('reads only dimensions and the zoom flag', () => {
    const params = new URLSearchParams('cols=120&rows=34&nozoom=1&host=evil.example&command=rm');
    expect(parseTerminalQuery(params)).toEqual({ cols: 120, rows: 34, nozoom: true });
  });

  it('defaults when absent', () => {
    expect(parseTerminalQuery(new URLSearchParams(''))).toEqual({ cols: 80, rows: 24, nozoom: false });
  });
});

describe('parseClientMessage', () => {
  it('accepts the documented frames', () => {
    expect(parseClientMessage('{"type":"input","data":"ls\\r"}')).toEqual({ type: 'input', data: 'ls\r' });
    expect(parseClientMessage('{"type":"resize","cols":120,"rows":34,"focusEpoch":17}')).toEqual({
      type: 'resize', cols: 120, rows: 34, focusEpoch: 17,
    });
    expect(parseClientMessage('{"type":"focus","focusEpoch":17}')).toEqual({ type: 'focus', focusEpoch: 17 });
  });

  it('drops malformed and unknown frames', () => {
    for (const bad of [
      'not json',
      '{"type":"input"}',
      '{"type":"input","data":5}',
      '{"type":"resize","cols":0,"rows":24}',
      '{"type":"resize","cols":"120","rows":34}',
      '{"type":"resize","cols":99999,"rows":34}',
      '{"type":"focus"}',
      '{"type":"evict"}',
      'null',
    ]) {
      expect(parseClientMessage(bad)).toBeNull();
    }
  });

  it('rejects an oversized input frame', () => {
    const huge = JSON.stringify({ type: 'input', data: 'x'.repeat(MAX_INPUT_BYTES + 1) });
    expect(parseClientMessage(huge)).toBeNull();
  });

  it('treats an absent focusEpoch as unset rather than zero', () => {
    expect(parseClientMessage('{"type":"resize","cols":80,"rows":24}').focusEpoch).toBeNull();
  });
});

describe('ServerMessage', () => {
  it('emits the documented server frames', () => {
    expect(JSON.parse(ServerMessage.ready({
      serverId: 's', paneId: '%1', provider: 'ssh', persistence: 'process-memory', replayedBytes: 16,
    }))).toEqual({
      type: 'ready', serverId: 's', paneId: '%1', provider: 'ssh', persistence: 'process-memory', replayedBytes: 16,
    });
    expect(JSON.parse(ServerMessage.output('x'))).toEqual({ type: 'output', data: 'x' });
    expect(JSON.parse(ServerMessage.clipboard('c'))).toEqual({ type: 'clipboard', data: 'c' });
    expect(JSON.parse(ServerMessage.provider({ provider: 'tmux', persistence: 'tmux' }))).toEqual({
      type: 'provider', provider: 'tmux', persistence: 'tmux',
    });
    expect(JSON.parse(ServerMessage.error({ code: 'SERVER_OFFLINE', message: 'no', retryable: true }))).toEqual({
      type: 'error', code: 'SERVER_OFFLINE', message: 'no', retryable: true,
    });
    expect(JSON.parse(ServerMessage.exit({ code: 0, signal: null, reason: 'remote_shell_exit' }))).toEqual({
      type: 'exit', code: 0, signal: null, reason: 'remote_shell_exit',
    });
  });
});

/** WebSocket stand-in that records frames. */
class FakeWs extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.CONNECTING = 0;
    this.readyState = 1;
    this.sent = [];
    this.closed = null;
  }

  send(data) { this.sent.push(JSON.parse(data)); }

  close(code, reason) {
    this.closed = { code, reason };
    this.readyState = 3;
  }

  framesOfType(type) { return this.sent.filter((f) => f.type === type); }
}

function fakePty() {
  const pty = {
    killed: [],
    written: [],
    onData(fn) { pty._data = fn; },
    onExit(fn) { pty._exit = fn; },
    write(d) { pty.written.push(d); },
    resize() {},
    kill(s) { pty.killed.push(s); },
    emit(d) { pty._data(d); },
    exit(code = 0) { pty._exit({ exitCode: code, signal: null }); },
  };
  return pty;
}

describe('TerminalGateway', () => {
  let registry;
  let workspace;
  let pool;
  let terminalManager;
  let gateway;
  let resolved;
  let runtime;
  let pty;

  beforeEach(() => {
    resolved = {
      serverId: 'api-linux',
      provider: 'tmux',
      transport: 'ssh',
      persistence: 'tmux',
      sessionId: '$1',
      windowId: '@5',
      paneId: '%12',
    };
    pty = fakePty();
    runtime = null;
    registry = { has: vi.fn(() => true) };
    workspace = {
      resolvePane: vi.fn(async () => resolved),
      sshRuntime: vi.fn(() => runtime),
    };
    pool = { get: vi.fn(() => ({ ptyArgs: (cmd) => ['-tt', '-o', 'BatchMode=yes', 'deploy@10.0.0.21', '--', cmd] })) };
    terminalManager = { maxConnectionsPerPane: 5, create: vi.fn(() => 'conn-1') };
    gateway = new TerminalGateway({ registry, workspace, pool, terminalManager });
  });

  function makeRuntime(overrides = {}) {
    return new PaneRuntime({
      serverId: 'api-linux',
      sessionId: 'ses_1',
      windowId: 'win_1',
      paneId: 'pane_1',
      spawn: () => pty,
      ...overrides,
    });
  }

  describe('address handling', () => {
    it('closes with an error frame on a malformed address', async () => {
      const ws = new FakeWs();
      await gateway.handle(ws, '/ws/terminal/api-linux/%zz', new URLSearchParams());

      expect(ws.framesOfType('error')[0].code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(ws.closed.code).toBe(1008);
      expect(terminalManager.create).not.toHaveBeenCalled();
    });

    it('never throws out of the upgrade handler', async () => {
      const ws = new FakeWs();
      await expect(gateway.handle(ws, '/ws/terminal/%', new URLSearchParams())).resolves.toBeNull();
    });

    it('rejects an unregistered server before touching the workspace', async () => {
      registry.has.mockReturnValue(false);
      const ws = new FakeWs();

      await gateway.handle(ws, '/ws/terminal/ghost/%2512', new URLSearchParams());

      expect(workspace.resolvePane).not.toHaveBeenCalled();
      expect(ws.framesOfType('error')[0].code).toBe(ErrorCode.SERVER_NOT_FOUND);
    });

    it('refuses a pane that does not belong to the server', async () => {
      workspace.resolvePane.mockRejectedValue(new AppError(ErrorCode.PANE_NOT_FOUND, 'nope'));
      const ws = new FakeWs();

      await gateway.handle(ws, '/ws/terminal/api-linux/%2599', new URLSearchParams());

      expect(ws.framesOfType('error')[0].code).toBe(ErrorCode.PANE_NOT_FOUND);
      expect(terminalManager.create).not.toHaveBeenCalled();
    });

    it('ignores host, user and command query parameters', async () => {
      const ws = new FakeWs();
      const params = new URLSearchParams('cols=100&rows=30&host=evil.example&user=root&command=rm+-rf+/');

      await gateway.handle(ws, '/ws/terminal/api-linux/%2512', params);

      const [, , cols, rows] = terminalManager.create.mock.calls[0];
      expect(cols).toBe(100);
      expect(rows).toBe(30);
      const options = terminalManager.create.mock.calls[0][5];
      expect(JSON.stringify(options.spawn)).not.toContain('evil.example');
      expect(JSON.stringify(options.spawn)).not.toContain('rm -rf');
    });

    it('clamps absurd dimensions', async () => {
      const ws = new FakeWs();
      await gateway.handle(ws, '/ws/terminal/api-linux/%2512', new URLSearchParams('cols=99999&rows=abc'));

      const [, , cols, rows] = terminalManager.create.mock.calls[0];
      expect(cols).toBe(MAX_DIMENSION);
      expect(rows).toBe(24);
    });
  });

  describe('tmux provider', () => {
    it('uses the plain local spawn for the local server', async () => {
      resolved.serverId = 'local';
      resolved.transport = 'local';
      const ws = new FakeWs();

      await gateway.handle(ws, '/ws/terminal/local/%2512', new URLSearchParams());

      const options = terminalManager.create.mock.calls[0][5];
      expect(options.spawn).toBeUndefined();
      expect(options.serverId).toBe('local');
      expect(pool.get).not.toHaveBeenCalled();
    });

    it('runs the fixed attach template through ssh for a remote server', async () => {
      const ws = new FakeWs();

      await gateway.handle(ws, '/ws/terminal/api-linux/%2512', new URLSearchParams());

      const options = terminalManager.create.mock.calls[0][5];
      expect(options.spawn.file).toBe('ssh');
      expect(options.spawn.args[0]).toBe('-tt');
      const remoteCommand = options.spawn.args[options.spawn.args.length - 1];
      expect(remoteCommand).toContain("tmux attach-session -d -t '%12'");
      expect(remoteCommand).toContain('tmux select-pane');
    });

    it('passes nozoom through to the template', async () => {
      const ws = new FakeWs();
      await gateway.handle(ws, '/ws/terminal/api-linux/%2512', new URLSearchParams('nozoom=1'));

      const options = terminalManager.create.mock.calls[0][5];
      const remoteCommand = options.spawn.args[options.spawn.args.length - 1];
      expect(remoteCommand).not.toContain('trap');
    });

    it('announces ready with the provider', async () => {
      const ws = new FakeWs();
      await gateway.handle(ws, '/ws/terminal/api-linux/%2512', new URLSearchParams());

      expect(ws.framesOfType('ready')[0]).toMatchObject({
        serverId: 'api-linux', paneId: '%12', provider: 'tmux', persistence: 'tmux',
      });
    });

    it('sends a structured exit when the attach client ends', async () => {
      const ws = new FakeWs();
      await gateway.handle(ws, '/ws/terminal/api-linux/%2512', new URLSearchParams());

      const options = terminalManager.create.mock.calls[0][5];
      options.onPtyExit({ code: 0, signal: null, reason: 'tmux_client_exit' });

      expect(ws.framesOfType('exit')[0]).toEqual({
        type: 'exit', code: 0, signal: null, reason: 'tmux_client_exit',
      });
    });

    it('reports a tmux refusal as a structured error, like the ssh path', async () => {
      // Mirror what the real manager does: report, close, return null.
      terminalManager.create.mockImplementation((ws, paneId, cols, rows, nozoom, options) => {
        options.onReject({ code: ErrorCode.CONNECTION_LIMIT, message: `Connection limit reached for pane ${paneId}` });
        ws.close(1013, 'limit');
        return null;
      });
      const ws = new FakeWs();

      await expect(gateway.handle(ws, '/ws/terminal/api-linux/%2512', new URLSearchParams())).resolves.toBeNull();

      expect(ws.framesOfType('error')[0]).toMatchObject({
        code: ErrorCode.CONNECTION_LIMIT,
        retryable: true,
      });
      expect(ws.closed.code).toBe(1013);
      expect(ws.framesOfType('ready')).toEqual([]);
    });

    it('reports an invalid pane refusal without marking it retryable', async () => {
      terminalManager.create.mockImplementation((ws, paneId, cols, rows, nozoom, options) => {
        options.onReject({ code: 'VALIDATION_ERROR', message: 'Invalid paneId format' });
        ws.close(1008, 'invalid');
        return null;
      });
      const ws = new FakeWs();

      await gateway.handle(ws, '/ws/terminal/api-linux/%2512', new URLSearchParams());

      expect(ws.framesOfType('error')[0]).toMatchObject({ code: 'VALIDATION_ERROR', retryable: false });
    });
  });

  describe('ssh provider', () => {
    beforeEach(() => {
      resolved = { ...resolved, provider: 'ssh', persistence: 'process-memory', paneId: 'pane_1' };
      runtime = makeRuntime();
    });

    it('subscribes to the existing runtime and replays the buffer', async () => {
      runtime.start();
      pty.emit('earlier output');
      const ws = new FakeWs();

      await gateway.handle(ws, '/ws/terminal/api-linux/pane_1', new URLSearchParams());

      expect(ws.framesOfType('ready')[0]).toMatchObject({
        provider: 'ssh',
        persistence: 'process-memory',
        replayedBytes: Buffer.byteLength('earlier output'),
      });
      expect(ws.framesOfType('output')[0].data).toBe('earlier output');
      expect(runtime.subscribers.size).toBe(1);
    });

    it('extracts OSC 52 from replay and live output', async () => {
      const ws = new FakeWs();
      await gateway.handle(ws, '/ws/terminal/api-linux/pane_1', new URLSearchParams());

      const payload = Buffer.from('copied text', 'utf8').toString('base64');
      pty.emit(`before\x1b]52;c;${payload}\x07after`);

      expect(ws.framesOfType('clipboard').map((f) => f.data)).toEqual(['copied text']);
      const output = ws.framesOfType('output').map((f) => f.data).join('');
      expect(output).toContain('before');
      expect(output).toContain('after');
      expect(output).not.toContain('\x1b]52;');
    });

    it('handles an OSC 52 sequence split across chunks', async () => {
      const ws = new FakeWs();
      await gateway.handle(ws, '/ws/terminal/api-linux/pane_1', new URLSearchParams());

      const payload = Buffer.from('split copy', 'utf8').toString('base64');
      pty.emit(`\x1b]52;c;${payload.slice(0, 4)}`);
      expect(ws.framesOfType('clipboard')).toEqual([]);
      pty.emit(`${payload.slice(4)}\x07done`);

      expect(ws.framesOfType('clipboard').map((f) => f.data)).toEqual(['split copy']);
    });

    it('forwards input and resize to the runtime', async () => {
      const ws = new FakeWs();
      await gateway.handle(ws, '/ws/terminal/api-linux/pane_1', new URLSearchParams());

      ws.emit('message', JSON.stringify({ type: 'input', data: 'ls\r' }));
      ws.emit('message', JSON.stringify({ type: 'resize', cols: 120, rows: 40, focusEpoch: 9 }));

      expect(pty.written).toEqual(['ls\r']);
      expect(runtime.cols).toBe(120);
      expect(runtime.rows).toBe(40);
    });

    it('ignores malformed frames', async () => {
      const ws = new FakeWs();
      await gateway.handle(ws, '/ws/terminal/api-linux/pane_1', new URLSearchParams());

      ws.emit('message', 'not json');
      ws.emit('message', JSON.stringify({ type: 'evict' }));

      expect(pty.written).toEqual([]);
    });

    it('detaches without killing the PTY when the socket closes', async () => {
      const ws = new FakeWs();
      await gateway.handle(ws, '/ws/terminal/api-linux/pane_1', new URLSearchParams());

      ws.emit('close');

      // A refresh must be able to reconnect to the same shell.
      expect(runtime.subscribers.size).toBe(0);
      expect(runtime.alive).toBe(true);
      expect(pty.killed).toEqual([]);
    });

    it('sends a structured exit and closes when the shell ends', async () => {
      const ws = new FakeWs();
      await gateway.handle(ws, '/ws/terminal/api-linux/pane_1', new URLSearchParams());

      pty.exit(3);

      expect(ws.framesOfType('exit')[0]).toMatchObject({ code: 3, reason: 'remote_shell_exit' });
      expect(ws.closed.code).toBe(1000);
    });

    it('reports a missing runtime rather than spawning one', async () => {
      runtime = null;
      const ws = new FakeWs();

      await gateway.handle(ws, '/ws/terminal/api-linux/pane_1', new URLSearchParams());

      expect(ws.framesOfType('error')[0].code).toBe(ErrorCode.PANE_NOT_FOUND);
    });

    it('enforces a subscriber limit like tmux does', async () => {
      gateway.maxConnectionsPerPane = 2;
      const first = new FakeWs();
      const second = new FakeWs();
      const third = new FakeWs();

      await gateway.handle(first, '/ws/terminal/api-linux/pane_1', new URLSearchParams());
      await gateway.handle(second, '/ws/terminal/api-linux/pane_1', new URLSearchParams());
      await gateway.handle(third, '/ws/terminal/api-linux/pane_1', new URLSearchParams());

      expect(runtime.subscribers.size).toBe(2);
      expect(third.framesOfType('error')[0].code).toBe(ErrorCode.CONNECTION_LIMIT);
      expect(third.closed.code).toBe(1013);
    });

    it('lets two clients share one pane', async () => {
      const a = new FakeWs();
      const b = new FakeWs();
      await gateway.handle(a, '/ws/terminal/api-linux/pane_1', new URLSearchParams());
      await gateway.handle(b, '/ws/terminal/api-linux/pane_1', new URLSearchParams());

      pty.emit('shared');

      expect(a.framesOfType('output').map((f) => f.data)).toContain('shared');
      expect(b.framesOfType('output').map((f) => f.data)).toContain('shared');
    });
  });
});
