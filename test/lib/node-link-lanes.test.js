import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { NodeLink, freeLoopbackPort } from '../../lib/hub/node-link.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanups.push(() => { server.closeAllConnections?.(); server.close(); });
  return server.address().port;
}
async function fixture() {
  const bulk = [];
  let failApi = false;
  const node = http.createServer((req, res) => {
    if (failApi && req.url === '/api/node/info') { req.socket.destroy(); return; }
    if (req.url === '/bulk') { res.writeHead(200); res.write('waiting'); bulk.push(res); }
    else res.end('{"protocol":1}');
  });
  const port = await listen(node);
  const wss = new WebSocketServer({ server: node });
  wss.on('connection', ws => ws.on('message', data => ws.send(data)));
  cleanups.push(() => { for (const ws of wss.clients) ws.terminate(); wss.close(); });
  const forwards = [];
  const connection = {
    id: 'lanes', server: { transport: { terminal: 'ssh' } },
    fetchPairing: async () => ({ protocol: 1, host: '127.0.0.1', port, tls: false, token: 'fixture' }),
    openForward: ({ localPort, remoteHost, remotePort }) => {
      const child = new EventEmitter();
      const sockets = new Set();
      const server = net.createServer(socket => {
        sockets.add(socket);
        const target = net.connect({ host: remoteHost, port: remotePort });
        sockets.add(target);
        const end = () => { sockets.delete(socket); sockets.delete(target); socket.destroy(); target.destroy(); };
        socket.on('error', end); target.on('error', end);
        socket.on('close', end); target.on('close', end);
        socket.pipe(target); target.pipe(socket);
      });
      server.listen(localPort, '127.0.0.1');
      child.exitCode = null;
      child.kill = vi.fn(() => {
        if (child.exitCode !== null) return;
        child.exitCode = 0;
        for (const socket of sockets) socket.destroy();
        server.close();
        child.emit('exit', 0, null);
      });
      cleanups.push(() => { for (const socket of sockets) socket.destroy(); server.close(); });
      forwards.push({ child, port: localPort });
      return { child, whenFailed: new Promise(resolve => child.once('exit', () => resolve(new Error('forward ended')))) };
    },
  };
  const link = new NodeLink({ connection });
  cleanups.push(() => link.close());
  const hub = http.createServer((req, res) => link.proxy(req, res, req.url));
  const hubPort = await listen(hub);
  hub.on('upgrade', (req, socket, head) => link.proxyUpgrade(req, socket, head, req.url).catch(() => socket.destroy()));
  async function ws(path) {
    const socket = new WebSocket(`ws://127.0.0.1:${hubPort}${path}`);
    cleanups.push(() => socket.terminate());
    await once(socket, 'open');
    return socket;
  }
  return { link, forwards, bulk, ws, hubPort, failApi: () => { failApi = true; } };
}
async function echo(ws) {
  const reply = once(ws, 'message');
  ws.send('still alive');
  expect(String((await reply)[0])).toBe('still alive');
}

describe('independent node SSH terminal lane', () => {
  it('reuses a separate terminal forward while an HTTP download is still pending', async () => {
    const f = await fixture();
    const download = http.get(`http://127.0.0.1:${f.hubPort}/bulk`);
    const [answer] = await once(download, 'response');
    cleanups.push(() => { download.destroy(); answer.destroy(); });
    answer.resume();
    const [legacy, panes] = await Promise.all([f.ws('/ws/terminal/%251'), f.ws('/ws/pane-stream/%252')]);
    expect(f.forwards).toHaveLength(2);
    expect(f.forwards[0].port).not.toBe(f.forwards[1].port);
    expect(f.bulk[0].writableEnded).toBe(false);
    await echo(legacy); await echo(panes);
  });

  it('closes only the sockets owned by a failed lane', async () => {
    const f = await fixture();
    const status = await f.ws('/ws/status');
    const terminal = await f.ws('/ws/pane-stream/%251');
    const apiClosed = once(status, 'close');
    f.forwards[0].child.exitCode = 255;
    f.forwards[0].child.emit('exit', 255, null);
    await apiClosed;
    await echo(terminal);
    const nextStatus = await f.ws('/ws/status');
    const terminalClosed = once(terminal, 'close');
    f.forwards[1].child.exitCode = 255;
    f.forwards[1].child.emit('exit', 255, null);
    await terminalClosed;
    await echo(nextStatus);
  });

  it('does not spawn a terminal forward when its only waiting browser has left', async () => {
    const f = await fixture();
    await f.link.ensure();
    let release;
    f.link._freePort = () => new Promise(resolve => { release = resolve; });
    const socket = new EventEmitter();
    socket.destroyed = false;
    const pending = f.link.ensureTerminalLane(socket).catch(() => null);
    await Promise.resolve();
    socket.destroyed = true; socket.emit('close');
    release(await freeLoopbackPort());
    await pending;
    expect(f.forwards).toHaveLength(1);
  });

  it('rejects an old terminal setup after reset without reviving its forward', async () => {
    const f = await fixture();
    await f.link.ensure();
    let release;
    f.link._freePort = () => new Promise(resolve => { release = resolve; });
    const pending = f.link.ensureTerminalLane().catch(() => null);
    await Promise.resolve();
    f.link.reset('fixture');
    release(await freeLoopbackPort());
    await pending;
    expect(f.forwards).toHaveLength(1);
    expect(f.link._terminalTunnel).toBeNull();
  });

  it('does not restore an obsolete API pairing when reset cancels its pending port allocation', async () => {
    const f = await fixture();
    let release;
    f.link._freePort = () => new Promise(resolve => { release = resolve; });
    const pending = f.link.ensure().catch(() => null);
    await Promise.resolve();
    f.link.reset('fixture');
    release(await freeLoopbackPort());
    await pending;
    expect(f.forwards).toHaveLength(0);
    expect(f.link.ready).toBe(false);
    f.link._freePort = freeLoopbackPort;
    await f.link.ensure();
    expect(f.forwards).toHaveLength(1);
  });

  it('reopens terminals independently when both old forwards have gone away', async () => {
    const f = await fixture();
    const status = await f.ws('/ws/status');
    const terminal = await f.ws('/ws/pane-stream/%251');
    const closed = Promise.all([once(status, 'close'), once(terminal, 'close')]);
    for (const forward of [...f.forwards]) {
      forward.child.exitCode = 255;
      forward.child.emit('exit', 255, null);
    }
    await closed;
    const reopened = await f.ws('/ws/pane-stream/%252');
    await echo(reopened);
    expect(f.forwards).toHaveLength(3);
  });

  it('does not cut an active terminal after both API health attempts fail', async () => {
    const f = await fixture();
    const terminal = await f.ws('/ws/pane-stream/%251');
    f.failApi();
    await expect(f.link.info()).rejects.toMatchObject({ code: 'NODE_NOT_RUNNING' });
    await echo(terminal);
    expect(f.forwards[0].child.kill).toHaveBeenCalledOnce();
    expect(f.forwards[1].child.kill).not.toHaveBeenCalled();
  });

  it('kills a cancelled terminal forward that has spawned but is not listening yet', async () => {
    const f = await fixture();
    await f.link.ensure();
    const child = new EventEmitter();
    child.exitCode = null;
    child.kill = vi.fn(() => { child.exitCode = 0; child.emit('exit', 0, null); });
    f.link.connection.openForward = () => ({ child, whenFailed: new Promise(() => {}) });
    const socket = new EventEmitter();
    socket.destroyed = false;
    const pending = f.link.ensureTerminalLane(socket).catch(() => null);
    while (!f.link._terminalConnecting?.child) await new Promise(resolve => setTimeout(resolve, 0));
    socket.destroyed = true; socket.emit('close');
    await pending;
    expect(child.kill).toHaveBeenCalledOnce();
    expect(f.link._terminalTunnel).toBeNull();
    expect(f.link._terminalConnecting).toBeNull();
  });
});
