import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { EventEmitter } from 'node:events';

import { createNodeProxy, isRelayable, parseNodePath, relayNodeUpgrade } from '../server/hub/proxy.js';
import { requireSameOrigin } from '../server/api/same-origin.js';
import { AppError, ErrorCode } from '../server/servers/errors.js';
import { listen, request } from './api-helpers.js';

describe('parseNodePath', () => {
  it('splits the server id from the machine path and keeps the query', () => {
    expect(parseNodePath('/n/api-linux/api/files/raw?path=%2Ftmp')).toEqual({
      serverId: 'api-linux', path: '/api/files/raw?path=%2Ftmp', pathname: '/api/files/raw',
    });
    expect(parseNodePath('/n/local/ws/status')).toMatchObject({ serverId: 'local', path: '/ws/status' });
  });

  it('ignores everything else', () => {
    for (const url of ['/api/workspace', '/n/', '/n/BAD ID/api', '/nx/a/api', '/n/-x/api']) {
      expect(parseNodePath(url)).toBeNull();
    }
  });
});

describe('isRelayable', () => {
  it('relays machine API paths and refuses the hub-only ones', () => {
    for (const path of ['/api/workspace', '/api/files/list', '/api/upload', '/api/node/info', '/api/agent-hub']) {
      expect(isRelayable(path)).toBe(true);
    }
    for (const path of ['/api/auth/login', '/api/servers', '/api/servers/x/probe', '/api/plugins/a/mcp',
      '/api/managed-resources', '/login.html', '/s/abc']) {
      expect(isRelayable(path)).toBe(false);
    }
  });

  it('relays only the status and terminal sockets', () => {
    expect(isRelayable('/ws/status', { upgrade: true })).toBe(true);
    expect(isRelayable('/ws/terminal/%251', { upgrade: true })).toBe(true);
    expect(isRelayable('/ws/other', { upgrade: true })).toBe(false);
  });
});

describe('createNodeProxy', () => {
  let links;
  let link;
  let authorized;
  let basic;
  let server;
  let port;

  beforeEach(async () => {
    authorized = true;
    link = { proxy: vi.fn(async (_req, res, path) => res.json({ relayed: path })) };
    basic = vi.fn((_req, res, serverId, target) => res.json({ basic: serverId, path: target.path }));
    links = { link: vi.fn(() => link), mode: vi.fn(async () => 'node') };
    const registry = { has: (id) => id === 'api-linux' || id === 'local' };
    const app = express();
    app.use(createNodeProxy({
      registry,
      links,
      authorize: (_req, res, next) => (authorized ? next() : res.status(401).json({ error: 'Authentication required' })),
      sameOrigin: requireSameOrigin,
      basic,
    }));
    // What /n/local/... must fall through to.
    app.get('/api/workspace', (req, res) => res.json({ local: true, url: req.url }));
    ({ server, port } = await listen(app));
  });

  afterEach(() => server.close());

  it('serves /n/local from this process, without a link', async () => {
    const res = await request(port, 'GET', '/n/local/api/workspace?x=1');
    expect(res.body).toEqual({ local: true, url: '/api/workspace?x=1' });
    expect(links.link).not.toHaveBeenCalled();
  });

  it('relays another server\'s machine path through its link', async () => {
    const res = await request(port, 'GET', '/n/api-linux/api/files/list?path=%2Fhome');
    expect(res.body).toEqual({ relayed: '/api/files/list?path=%2Fhome' });
    expect(links.link).toHaveBeenCalledWith('api-linux');
  });

  it('hands a basic-mode server to the hub\'s own handler instead of a link', async () => {
    links.mode.mockResolvedValue('basic');
    const res = await request(port, 'GET', '/n/api-linux/api/workspace?x=1');
    expect(res.body).toEqual({ basic: 'api-linux', path: '/api/workspace?x=1' });
    expect(link.proxy).not.toHaveBeenCalled();
  });

  it('requires the hub login before relaying', async () => {
    authorized = false;
    const res = await request(port, 'GET', '/n/api-linux/api/workspace');
    expect(res.status).toBe(401);
    expect(link.proxy).not.toHaveBeenCalled();
  });

  it('never relays hub-only paths', async () => {
    const res = await request(port, 'POST', '/n/api-linux/api/servers', {});
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe(ErrorCode.UNSUPPORTED);
    expect(link.proxy).not.toHaveBeenCalled();
  });

  it('rejects a cross-origin write before it reaches the node', async () => {
    const res = await request(port, 'POST', '/n/api-linux/api/workspace/sessions', {}, { Origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(link.proxy).not.toHaveBeenCalled();
  });

  it('answers an unknown server with the structured envelope', async () => {
    const res = await request(port, 'GET', '/n/ghost/api/workspace');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe(ErrorCode.SERVER_NOT_FOUND);
  });

  it('surfaces a link failure such as a disabled server', async () => {
    links.mode.mockRejectedValue(new AppError(ErrorCode.SERVER_DISABLED, 'disabled'));
    const res = await request(port, 'GET', '/n/api-linux/api/workspace');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(ErrorCode.SERVER_DISABLED);
  });
});

describe('relayNodeUpgrade', () => {
  function socket() {
    const s = new EventEmitter();
    s.end = vi.fn();
    s.destroy = vi.fn();
    s.resume = vi.fn();
    return s;
  }

  const registry = { has: (id) => id === 'api-linux' };

  it('leaves non-relay paths to the caller and rewrites /n/local in place', () => {
    const links = { link: vi.fn() };
    const plain = { url: '/ws/status' };
    expect(relayNodeUpgrade(plain, socket(), null, { registry, links, authorize: () => true })).toBe(false);

    const local = { url: '/n/local/ws/terminal/%251?cols=80' };
    expect(relayNodeUpgrade(local, socket(), null, { registry, links, authorize: () => true })).toBe(false);
    expect(local.url).toBe('/ws/terminal/%251?cols=80');
    expect(links.link).not.toHaveBeenCalled();
  });

  it('relays an authorized socket to the server\'s link, or to the basic handler', async () => {
    const proxyUpgrade = vi.fn(async () => {});
    const links = { link: vi.fn(() => ({ proxyUpgrade })), mode: vi.fn(async () => 'node') };
    const req = { url: '/n/api-linux/ws/terminal/%251' };
    const s = socket();

    expect(relayNodeUpgrade(req, s, Buffer.alloc(0), { registry, links, authorize: () => true })).toBe(true);
    await vi.waitFor(() => expect(proxyUpgrade).toHaveBeenCalledWith(req, s, expect.any(Buffer), '/ws/terminal/%251'));

    const basic = vi.fn();
    links.mode.mockResolvedValue('basic');
    relayNodeUpgrade(req, s, null, { registry, links, authorize: () => true, basic });
    await vi.waitFor(() => expect(basic).toHaveBeenCalledWith(req, s, null, 'api-linux', expect.objectContaining({ pathname: '/ws/terminal/%251' })));
  });

  it('attaches nothing for a browser that left while the mode was being looked up', async () => {
    let answer;
    const proxyUpgrade = vi.fn(async () => {});
    const basic = vi.fn();
    const links = { link: vi.fn(() => ({ proxyUpgrade })), mode: vi.fn(() => new Promise((resolve) => { answer = resolve; })) };
    const s = socket();
    relayNodeUpgrade({ url: '/n/api-linux/ws/terminal/%251' }, s, null, { registry, links, authorize: () => true, basic });
    s.destroyed = true;
    answer('node');
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(proxyUpgrade).not.toHaveBeenCalled();
    expect(basic).not.toHaveBeenCalled();
  });

  it('reads a waiting socket so it can notice that, and survives it being reset', () => {
    const links = { link: vi.fn(), mode: vi.fn(() => new Promise(() => {})) };
    const s = socket();
    relayNodeUpgrade({ url: '/n/api-linux/ws/terminal/%251' }, s, null, { registry, links, authorize: () => true });
    expect(s.resume).toHaveBeenCalledOnce();
    // Unheard, this would be an uncaught exception taking the whole panel down.
    expect(() => s.emit('error', new Error('ECONNRESET'))).not.toThrow();
    // A FIN alone never closes a half-open socket, so it has to count as leaving.
    s.emit('end');
    expect(s.destroy).toHaveBeenCalledOnce();
  });

  it('rejects an unauthorized, unknown or non-relayable socket without a link', () => {
    const links = { link: vi.fn() };
    const cases = [
      [{ url: '/n/api-linux/ws/status' }, () => false, '401'],
      [{ url: '/n/ghost/ws/status' }, () => true, '404'],
      [{ url: '/n/api-linux/ws/other' }, () => true, '404'],
    ];
    for (const [req, authorize, status] of cases) {
      const s = socket();
      expect(relayNodeUpgrade(req, s, null, { registry, links, authorize })).toBe(true);
      expect(s.end.mock.calls[0][0]).toContain(status);
    }
    expect(links.link).not.toHaveBeenCalled();
  });
});
