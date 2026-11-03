import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { NodeLink } from '../server/hub/node-link.js';

// In-memory requests only: no listener, network connection, SSH or tmux process.
function fixture() {
  const requests = [];
  const agent = () => ({ freeSockets: {}, destroy: vi.fn() });
  const link = new NodeLink({ connection: { id: 'fixture', server: { transport: { api: 'direct', terminal: 'direct' } } } });
  link.ensure = async () => {};
  link._pairing = { tls: false, token: 'fixture-only-node-token' };
  link._tunnel = { port: 8123, child: { exitCode: 0, kill: vi.fn() } };
  link._agent = agent();
  link._upgradeAgent = agent();
  const direct = { status: 'up', agent: agent(), upgradeAgent: agent() };
  link._direct = direct;
  const route = { via: 'direct', host: 'fixture.invalid', port: 8123, agent: direct.agent, upgradeAgent: direct.upgradeAgent, direct };
  link._route = () => route;
  link._traceRequest = () => {};
  const request = vi.fn(() => {
    const upstream = new PassThrough();
    requests.push(upstream);
    return upstream;
  });
  link._client = () => ({ request });
  return { link, direct, route, request, requests, dispose: () => requests.forEach(upstream => upstream.destroy()) };
}

function socket() {
  const value = new EventEmitter();
  value.destroyed = false;
  value.write = vi.fn(() => true);
  value.pipe = vi.fn(destination => destination);
  value.end = vi.fn();
  value.destroy = vi.fn(() => {
    if (value.destroyed) return;
    value.destroyed = true;
    value.emit('close');
  });
  return value;
}

function pendingUpgrade(f) {
  const browser = socket();
  const node = socket();
  f.link._openUpgrade({ req: {}, socket: browser, head: Buffer.alloc(0), path: '/ws/terminal/%251',
    headers: {}, tunnel: f.link._tunnel, began: performance.now(), ensureMs: 0, route: f.route });
  const request = f.requests.at(-1);
  return { browser, node, accept: () => request.emit('upgrade', {
    statusCode: 101, statusMessage: 'Switching Protocols', rawHeaders: [],
  }, node, Buffer.alloc(0)) };
}

function upgraded(f) {
  const stream = pendingUpgrade(f);
  stream.accept();
  return stream;
}

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

describe('direct node-link lifecycle', () => {
  it.each(['reset', 'close'])('settles an in-flight direct read safely after link %s without replay', async (operation) => {
    const f = fixture();
    const req = new PassThrough();
    req.method = 'GET';
    req.headers = {};
    const res = new EventEmitter();
    Object.assign(res, { destroyed: false, writableEnded: false, writableFinished: false, headersSent: false });
    res.status = vi.fn(() => res);
    res.json = vi.fn(() => { res.writableEnded = true; });
    res.destroy = vi.fn();
    try {
      await f.link.proxy(req, res, '/api/workspace');
      f.link[operation]();
      expect(f.link._tunnel).toBeNull();
      // Agent destruction reports the old request's error after reset cleared its route.
      expect(() => f.requests[0].emit('error', Object.assign(new Error('fixture reset'), { code: 'ECONNRESET' }))).not.toThrow();
      expect(f.request).toHaveBeenCalledOnce();
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledOnce();
    } finally { f.dispose(); req.destroy(); }
  });

  it.each(['reset', 'close'])('ends upgraded direct sockets on link %s, without ending another link', (operation) => {
    const f = fixture();
    const other = fixture();
    let stream, unrelated;
    try {
      stream = upgraded(f);
      unrelated = upgraded(other);
      // A failed health check changes future routing, not an already healthy terminal.
      f.link._directFailed(f.direct, 'fixture-failed');
      expect(stream.browser.destroyed).toBe(false);
      expect(stream.node.destroyed).toBe(false);

      f.link[operation]();
      expect(stream.node.destroyed).toBe(true);
      expect(stream.browser.destroyed).toBe(true);
      expect(unrelated.node.destroyed).toBe(false);
      expect(unrelated.browser.destroyed).toBe(false);
      expect(f.request).toHaveBeenCalledOnce();
    } finally {
      stream?.node.destroy();
      unrelated?.node.destroy();
      f.dispose(); other.dispose();
    }
  });

  it.each(['reset', 'close', 'new tunnel', 'browser left'])(
    'rejects a late direct upgrade after %s without accepting or replaying it', (operation) => {
      const f = fixture();
      const pending = pendingUpgrade(f);
      try {
        if (operation === 'new tunnel') f.link._tunnel = { port: 8124 };
        else if (operation === 'browser left') pending.browser.destroy();
        else f.link[operation]();
        pending.accept();
        expect(pending.node.destroyed).toBe(true);
        expect(pending.browser.destroyed).toBe(true);
        expect(pending.browser.write).not.toHaveBeenCalled();
        expect(pending.node.pipe).not.toHaveBeenCalled();
        expect(f.request).toHaveBeenCalledOnce();
      } finally { pending.node.destroy(); f.dispose(); }
    },
  );
});
