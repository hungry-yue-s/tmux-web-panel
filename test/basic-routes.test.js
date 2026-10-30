import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { EventEmitter } from 'node:events';

import { createBasicHttp } from '../server/hub/basic/basic-routes.js';
import { attachBasicTerminal } from '../server/hub/basic/basic-terminal.js';
import { ErrorCode } from '../server/servers/errors.js';
import { listen, request } from './api-helpers.js';

describe('createBasicHttp', () => {
  let host;
  let server;
  let port;

  beforeEach(async () => {
    host = {
      getWorkspace: vi.fn(async () => ({ provider: 'tmux', sessions: [] })),
      createSession: vi.fn(async (body) => ({ id: '$1', name: body.name })),
    };
    const handler = createBasicHttp({ links: { basic: () => host } });
    const app = express();
    // Stand-in for the proxy: hand every /n/box request to the basic handler.
    app.use((req, res) => {
      const path = req.url.replace(/^\/n\/box/, '');
      handler(req, res, 'box', { path, pathname: path.split('?')[0] });
    });
    ({ server, port } = await listen(app));
  });

  afterEach(() => server.close());

  it('serves the workspace API in the node\'s shape', async () => {
    const read = await request(port, 'GET', '/n/box/api/workspace');
    expect(read.status).toBe(200);
    expect(read.body.data).toEqual({ provider: 'tmux', sessions: [] });

    const created = await request(port, 'POST', '/n/box/api/workspace/sessions', { name: '工作' });
    expect(created.status).toBe(201);
    expect(host.createSession).toHaveBeenCalledWith({ name: '工作' });
  });

  it('answers every other machine path with NODE_NOT_INSTALLED', async () => {
    for (const path of ['/n/box/api/files/list?path=%2F', '/n/box/api/metrics/current', '/n/box/api/upload']) {
      const res = await request(port, 'GET', path);
      expect(res.status).toBe(503);
      expect(res.body.error).toMatchObject({ code: ErrorCode.NODE_NOT_INSTALLED, action: 'install_node' });
    }
    expect(host.getWorkspace).not.toHaveBeenCalled();
  });
});

class FakeWs extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = 1;
    this.sent = [];
  }

  send(data) { this.sent.push(JSON.parse(data)); }

  close(code) { this.closed = code; this.readyState = 3; }
}

describe('attachBasicTerminal', () => {
  it('attaches to remote tmux through the uploaded one-word script, in its own quota scope', async () => {
    const host = {
      resolvePane: vi.fn(async (paneId) => ({ provider: 'tmux', paneId })),
      attachArgs: vi.fn(async () => ['-tt', 'box', '.cache/tmux-web-panel/attach-3-0']),
      connection: { sshEnv: () => ({ ASKPASS: '1' }) },
    };
    const terminalManager = { create: vi.fn(() => 'conn-1') };
    const ws = new FakeWs();

    await attachBasicTerminal(ws, host, {
      serverId: 'box',
      pathname: '/ws/terminal/%253',
      searchParams: new URLSearchParams('cols=100&rows=30'),
      terminalManager,
    });

    const [, paneId, cols, rows, nozoom, options] = terminalManager.create.mock.calls[0];
    expect([paneId, cols, rows, nozoom]).toEqual(['%3', 100, 30, false]);
    expect(options.scope).toBe('box');
    expect(options.spawn.args.at(-1)).toBe('.cache/tmux-web-panel/attach-3-0');
    expect(options.spawn.env).toEqual({ ASKPASS: '1' });
    expect(ws.sent[0]).toEqual({ type: 'ready', paneId: '%3', provider: 'tmux', persistence: 'tmux' });
  });

  it('attaches nothing for a socket that closed while the pane was being checked', async () => {
    const host = {
      resolvePane: vi.fn(async (paneId) => ({ provider: 'tmux', paneId })),
      attachArgs: vi.fn(async () => ['-tt', 'box', 'attach']),
      connection: { sshEnv: () => ({}) },
    };
    const terminalManager = { create: vi.fn(() => 'conn-1') };

    const closedFirst = new FakeWs();
    closedFirst.readyState = 3;
    await attachBasicTerminal(closedFirst, host, { serverId: 'box', pathname: '/ws/terminal/%253', searchParams: new URLSearchParams(), terminalManager });
    expect(host.attachArgs).not.toHaveBeenCalled();

    const closedLater = new FakeWs();
    host.attachArgs.mockImplementationOnce(async () => { closedLater.readyState = 3; return ['-tt', 'box', 'attach']; });
    await attachBasicTerminal(closedLater, host, { serverId: 'box', pathname: '/ws/terminal/%253', searchParams: new URLSearchParams(), terminalManager });
    expect(terminalManager.create).not.toHaveBeenCalled();
  });

  it('subscribes to a hosted shell and replays its buffer', async () => {
    let subscriber;
    const runtime = {
      subscribers: new Set(),
      resize: vi.fn(),
      subscribe: vi.fn((s) => { subscriber = s; return 'earlier output'; }),
      unsubscribe: vi.fn(),
      write: vi.fn(),
      noteFocus: vi.fn(),
    };
    const host = {
      resolvePane: vi.fn(async (paneId) => ({ provider: 'ssh', paneId })),
      sshRuntime: vi.fn(() => runtime),
    };
    const ws = new FakeWs();

    await attachBasicTerminal(ws, host, {
      serverId: 'box', pathname: '/ws/terminal/pane_1', searchParams: new URLSearchParams(), terminalManager: {},
    });
    expect(ws.sent.map((f) => f.type)).toEqual(['ready', 'output']);
    expect(ws.sent[1].data).toBe('earlier output');

    ws.emit('message', JSON.stringify({ type: 'input', data: 'ls\r' }));
    expect(runtime.write).toHaveBeenCalledWith('ls\r');
    subscriber.send('live');
    expect(ws.sent.at(-1)).toEqual({ type: 'output', data: 'live' });
    ws.emit('close');
    expect(runtime.unsubscribe).toHaveBeenCalled();
  });

  it('refuses a pane the host does not have', async () => {
    const { AppError } = await import('../server/servers/errors.js');
    const host = { resolvePane: vi.fn(async () => { throw new AppError(ErrorCode.PANE_NOT_FOUND, 'gone'); }) };
    const ws = new FakeWs();
    await attachBasicTerminal(ws, host, {
      serverId: 'box', pathname: '/ws/terminal/%259', searchParams: new URLSearchParams(), terminalManager: {},
    });
    expect(ws.sent[0]).toMatchObject({ type: 'error', code: ErrorCode.PANE_NOT_FOUND });
    expect(ws.closed).toBe(1008);
  });
});
