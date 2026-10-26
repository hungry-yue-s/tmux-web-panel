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

describe('parseTerminalPath', () => {
  it('parses /ws/terminal/:paneId on this machine', () => {
    expect(parseTerminalPath('/ws/terminal/%251')).toEqual({ paneId: '%1' });
  });

  it('decodes application pane ids', () => {
    expect(parseTerminalPath('/ws/terminal/pane_abc123')).toEqual({ paneId: 'pane_abc123' });
  });

  it('returns null for malformed percent-encoding instead of throwing', () => {
    for (const bad of ['/ws/terminal/%', '/ws/terminal/%zz', '/ws/terminal/%E0%A4%A']) {
      expect(() => parseTerminalPath(bad)).not.toThrow();
      expect(parseTerminalPath(bad)).toBeNull();
    }
  });

  it('rejects control characters and empty or oversized ids', () => {
    expect(parseTerminalPath('/ws/terminal/%01')).toBeNull();
    expect(parseTerminalPath('/ws/terminal/')).toBeNull();
    expect(parseTerminalPath('/ws/terminal/' + 'x'.repeat(200))).toBeNull();
  });

  it('rejects a server segment: other machines are reached through the hub relay', () => {
    expect(parseTerminalPath('/ws/terminal/api-linux/%251')).toBeNull();
    expect(parseTerminalPath('/ws/status')).toBeNull();
    expect(parseTerminalPath(null)).toBeNull();
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
    expect(JSON.parse(ServerMessage.ready({ paneId: '%1', provider: 'tmux', persistence: 'tmux' }))).toEqual({
      type: 'ready', paneId: '%1', provider: 'tmux', persistence: 'tmux',
    });
    expect(JSON.parse(ServerMessage.output('x'))).toEqual({ type: 'output', data: 'x' });
    expect(JSON.parse(ServerMessage.clipboard('c'))).toEqual({ type: 'clipboard', data: 'c' });
    expect(JSON.parse(ServerMessage.error({ code: 'SERVER_OFFLINE', message: 'no', retryable: true }))).toEqual({
      type: 'error', code: 'SERVER_OFFLINE', message: 'no', retryable: true,
    });
    expect(JSON.parse(ServerMessage.exit({ code: 0, signal: null, reason: 'tmux_client_exit' }))).toEqual({
      type: 'exit', code: 0, signal: null, reason: 'tmux_client_exit',
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

describe('TerminalGateway', () => {
  let workspace;
  let terminalManager;
  let gateway;

  beforeEach(() => {
    workspace = {
      resolvePane: vi.fn(async (paneId) => ({
        provider: 'tmux', persistence: 'tmux', sessionId: '$1', windowId: '@5', paneId,
      })),
    };
    terminalManager = { maxConnectionsPerPane: 5, create: vi.fn(() => 'conn-1') };
    gateway = new TerminalGateway({ workspace, terminalManager });
  });

  it('closes with an error frame on a malformed address', async () => {
    const ws = new FakeWs();
    await gateway.handle(ws, '/ws/terminal/%zz', new URLSearchParams());

    expect(ws.framesOfType('error')[0].code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(ws.closed.code).toBe(1008);
    expect(terminalManager.create).not.toHaveBeenCalled();
  });

  it('never throws out of the upgrade handler', async () => {
    const ws = new FakeWs();
    await expect(gateway.handle(ws, '/ws/terminal/%', new URLSearchParams())).resolves.toBeNull();
  });

  it('refuses a pane that does not exist before spawning anything', async () => {
    workspace.resolvePane.mockRejectedValue(new AppError(ErrorCode.PANE_NOT_FOUND, 'nope'));
    const ws = new FakeWs();

    await gateway.handle(ws, '/ws/terminal/%2599', new URLSearchParams());

    expect(ws.framesOfType('error')[0].code).toBe(ErrorCode.PANE_NOT_FOUND);
    expect(terminalManager.create).not.toHaveBeenCalled();
  });

  it('ignores host, user and command query parameters', async () => {
    const ws = new FakeWs();
    const params = new URLSearchParams('cols=100&rows=30&host=evil.example&user=root&command=rm+-rf+/');

    await gateway.handle(ws, '/ws/terminal/%2512', params);

    const [, paneId, cols, rows, nozoom, options] = terminalManager.create.mock.calls[0];
    expect(paneId).toBe('%12');
    expect(cols).toBe(100);
    expect(rows).toBe(30);
    expect(nozoom).toBe(false);
    expect(JSON.stringify(options)).not.toContain('evil.example');
  });

  it('clamps absurd dimensions and passes nozoom through', async () => {
    const ws = new FakeWs();
    await gateway.handle(ws, '/ws/terminal/%2512', new URLSearchParams('cols=99999&rows=abc&nozoom=1'));

    const [, , cols, rows, nozoom] = terminalManager.create.mock.calls[0];
    expect(cols).toBe(MAX_DIMENSION);
    expect(rows).toBe(24);
    expect(nozoom).toBe(true);
  });

  it('attaches with the local spawn: the manager gets no spawn override', async () => {
    const ws = new FakeWs();
    await gateway.handle(ws, '/ws/terminal/%2512', new URLSearchParams());

    const options = terminalManager.create.mock.calls[0][5];
    expect(options.spawn).toBeUndefined();
  });

  it('announces ready with the provider', async () => {
    const ws = new FakeWs();
    await gateway.handle(ws, '/ws/terminal/%2512', new URLSearchParams());

    expect(ws.framesOfType('ready')[0]).toEqual({ type: 'ready', paneId: '%12', provider: 'tmux', persistence: 'tmux' });
  });

  it('sends a structured exit when the attach client ends', async () => {
    const ws = new FakeWs();
    await gateway.handle(ws, '/ws/terminal/%2512', new URLSearchParams());

    const options = terminalManager.create.mock.calls[0][5];
    options.onPtyExit({ code: 0, signal: null, reason: 'tmux_client_exit' });

    expect(ws.framesOfType('exit')[0]).toEqual({ type: 'exit', code: 0, signal: null, reason: 'tmux_client_exit' });
  });

  it('reports a connection-limit refusal as a retryable structured error', async () => {
    // Mirror what the real manager does: report, close, return null.
    terminalManager.create.mockImplementation((ws, paneId, cols, rows, nozoom, options) => {
      options.onReject({ code: ErrorCode.CONNECTION_LIMIT, message: `Connection limit reached for pane ${paneId}` });
      ws.close(1013, 'limit');
      return null;
    });
    const ws = new FakeWs();

    await expect(gateway.handle(ws, '/ws/terminal/%2512', new URLSearchParams())).resolves.toBeNull();

    expect(ws.framesOfType('error')[0]).toMatchObject({ code: ErrorCode.CONNECTION_LIMIT, retryable: true });
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

    await gateway.handle(ws, '/ws/terminal/%2512', new URLSearchParams());

    expect(ws.framesOfType('error')[0]).toMatchObject({ code: 'VALIDATION_ERROR', retryable: false });
  });
});
