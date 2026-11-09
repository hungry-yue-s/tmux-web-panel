import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, get } from 'node:http';
import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';
import { apply } from '../../plugins/auth/index.js';
import { hashPassword, isTrustedLocalRequest } from '../../lib/auth.js';

const cleanups = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture({ nodeOnly = false, trustLocal } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'twp-local-auth-')), app = express(), hooks = [], effects = [];
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const ctx = {
    launch: { auth: !nodeOnly, nodeOnly, authCredentials: { username: 'test', ...hashPassword('fixture') }, configDir: dir, tokenFileName: 'tokens.json' },
    node: { isNodeToken: token => token === 'node-secret' },
    http: { use: handler => app.use(handler), mount: (path, router) => app.use(path, express.json(), router), useUpgrade: handler => hooks.push(handler) },
    effect: effect => { const cleanup = effect(); if (cleanup) effects.push(cleanup); },
    inject() {}, provide: (_name, service) => { ctx.auth = service; },
  };
  apply(ctx, { trustLocal });
  app.get('/api/probe', (_req, res) => res.json({ ok: true }));
  app.get('/n/test/api/probe', ctx.auth.loginOnly, (_req, res) => res.json({ ok: true }));
  app.get('/login.html', (_req, res) => res.send('login'));
  const server = createServer(app), wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    try {
      if (req.url.startsWith('/n/') && !ctx.auth.authorizeRelayUpgrade(req)) throw Error('unauthorized');
      for (const hook of hooks) hook({ req });
      wss.handleUpgrade(req, socket, head, ws => { ws.send('ok'); });
    } catch { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    for (const ws of wss.clients) ws.terminate(); wss.close();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    effects.reverse().forEach(close => close());
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const socketStatus = (path, headers = {}) => new Promise(resolve => {
    const ws = new WebSocket(base.replace('http', 'ws') + path, { headers });
    ws.on('message', () => { ws.close(); resolve('open'); });
    ws.on('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode); });
    ws.on('error', () => resolve('error'));
  });
  const httpStatus = (path, headers) => new Promise((resolve, reject) => {
    get(base + path, { headers }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  return { base, socketStatus, httpStatus, tokens: ctx.auth.tokens };
}

describe('local access without a login', () => {
  it('opens HTTP and both local and relayed sockets without storing a token', async () => {
    const f = await fixture();
    for (const path of ['/api/probe', '/n/test/api/probe']) expect((await fetch(f.base + path)).status).toBe(200);
    expect((await fetch(f.base + '/login.html', { redirect: 'manual' })).status).toBe(302);
    expect(await f.socketStatus('/ws/status', { Origin: f.base })).toBe('open');
    expect(await f.socketStatus('/n/test/ws/status', { Origin: f.base })).toBe('open');
    expect(await f.httpStatus('/api/probe', { Authorization: 'Bearer expired-browser-token' })).toBe(200);
    expect(f.tokens.size).toBe(0);
  });
  it('rejects cross-site, forwarded and non-loopback Host requests even from a local socket', async () => {
    const f = await fixture();
    for (const headers of [{ Origin: 'https://other.example' }, { Host: 'panel.example' }, { 'X-Forwarded-For': '10.0.0.2' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
      expect(await f.httpStatus('/api/probe', headers), JSON.stringify(headers)).toBe(401);
      expect(await f.socketStatus('/ws/status', headers)).toBe(401);
    }
  });
  it('keeps node-only and explicit strict mode authenticated', async () => {
    for (const config of [{ nodeOnly: true }, { trustLocal: false }]) {
      const f = await fixture(config);
      expect((await fetch(f.base + '/api/probe')).status).toBe(401);
      expect(await f.socketStatus('/ws/status', { Origin: f.base })).toBe(401);
      expect((await fetch(f.base + '/api/probe', { headers: { Authorization: 'Bearer node-secret' } })).status).toBe(200);
    }
  });
  it('does not grant a paired Node token access to the Hub relay', async () => {
    const f = await fixture(), headers = { Authorization: 'Bearer node-secret' };
    expect((await fetch(f.base + '/api/probe', { headers })).status).toBe(200);
    expect((await fetch(f.base + '/n/test/api/probe', { headers })).status).toBe(401);
    expect(await f.socketStatus('/n/test/ws/status', headers)).toBe(401);
    expect(await f.httpStatus('/n/test/api/probe?token=node-secret')).toBe(401);
    expect(await f.socketStatus('/n/test/ws/status?token=node-secret')).toBe(401);
  });
});

describe('local request boundary', () => {
  const req = (remoteAddress = '127.0.0.1', headers = {}, socket = {}) => ({ url: '/api/probe', headers: { host: '127.0.0.1:7681', ...headers }, socket: { remoteAddress, localPort: 7681, ...socket } });
  it('uses the actual socket and accepts IPv4, IPv6 and mapped loopback', () => {
    expect(isTrustedLocalRequest(req())).toBe(true);
    expect(isTrustedLocalRequest(req('::1', { host: '[::1]:7681', origin: 'http://[::1]:7681' }))).toBe(true);
    expect(isTrustedLocalRequest(req('::ffff:127.0.0.1', { host: 'localhost:7681' }))).toBe(true);
    expect(isTrustedLocalRequest(req('10.0.0.2'))).toBe(false);
    expect(isTrustedLocalRequest(req('10.0.0.2', { 'x-forwarded-for': '127.0.0.1' }))).toBe(false);
  });
  it('rejects port, scheme, referer and malformed authority tricks', () => {
    for (const headers of [{ host: 'localhost:7682' }, { host: 'localhost.evil:7681' }, { host: 'evil@localhost:7681' }, { origin: 'https://127.0.0.1:7681' }, { origin: 'null' }, { referer: 'https://other.example/' }, { 'x-forwarded-host': 'localhost:7681' }]) expect(isTrustedLocalRequest(req('127.0.0.1', headers))).toBe(false);
    expect(isTrustedLocalRequest(req('127.0.0.1', { host: 'localhost:7681', origin: 'https://localhost:7681' }, { encrypted: true }))).toBe(true);
  });
});
