import { request } from 'node:http';
import { Context } from 'cordis';
import { afterEach, describe, expect, it } from 'vitest';
import HttpService, { HttpError } from '../plugins/http/index.js';
import { compilePath, matchPath } from '../plugins/http/router.js';

let running = [];

afterEach(async () => {
  for (const fiber of running.splice(0)) await fiber.dispose();
});

async function startHttp() {
  const ctx = new Context();
  ctx.provide('launch', { host: '127.0.0.1', port: 0, tls: null, httpPort: null });
  const fiber = ctx.plugin(HttpService, { port: 0 });
  await fiber;
  running.push(fiber);
  const http = ctx.get('http');
  return { ctx, base: `http://127.0.0.1:${http.port}` };
}

function rawGet(base, path) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path, method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('router', () => {
  it('matches params and a trailing wildcard', () => {
    expect(matchPath(compilePath('/api/panes/:id'), '/api/panes/%251')).toEqual({ id: '%1' });
    expect(matchPath(compilePath('/client/*'), '/client/a/b.js')).toEqual({ '*': 'a/b.js' });
    expect(matchPath(compilePath('/client/*'), '/client')).toEqual({ '*': '' });
    expect(matchPath(compilePath('/'), '/')).toEqual({});
    expect(matchPath(compilePath('/'), '/x')).toBeNull();
    expect(() => matchPath(compilePath('/a/:x'), '/a/%E0%A4%A')).toThrow(HttpError);
  });
});

describe('HttpService', () => {
  it('routes belong to the plugin that added them and go away with it', async () => {
    const { ctx, base } = await startHttp();
    const fiber = ctx.plugin({
      name: 'echo',
      inject: ['http'],
      apply(ctx) {
        ctx.http.get('/api/echo/:word', ({ params }) => ({ word: params.word }));
      },
    });
    await fiber;
    let response = await fetch(`${base}/api/echo/hi`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ word: 'hi' });
    await fiber.dispose();
    response = await fetch(`${base}/api/echo/hi`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found' } });
  });

  it('answers 405 for a known path with another method, 204 for no result, and maps errors', async () => {
    const { ctx, base } = await startHttp();
    await ctx.plugin({
      name: 'mixed',
      inject: ['http'],
      apply(ctx) {
        ctx.http.post('/api/thing', async ({ body }) => ({ got: await body() }));
        ctx.http.delete('/api/thing', () => undefined);
        ctx.http.get('/api/denied', () => { throw new HttpError(403, 'FORBIDDEN', 'No'); });
        ctx.http.get('/api/crash', () => { throw new Error('secret detail'); });
      },
    });
    expect((await fetch(`${base}/api/thing`)).status).toBe(405);
    const posted = await fetch(`${base}/api/thing`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}' });
    expect(await posted.json()).toEqual({ got: { a: 1 } });
    const notJson = await fetch(`${base}/api/thing`, { method: 'POST', body: 'x' });
    expect(notJson.status).toBe(415);
    expect((await fetch(`${base}/api/thing`, { method: 'DELETE' })).status).toBe(204);
    const denied = await fetch(`${base}/api/denied`);
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.code).toBe('FORBIDDEN');
    const crashed = await fetch(`${base}/api/crash`);
    expect(crashed.status).toBe(500);
    expect(JSON.stringify(await crashed.json())).not.toContain('secret');
  });

  it('runs middleware before routes and lets it refuse a request', async () => {
    const { ctx, base } = await startHttp();
    await ctx.plugin({
      name: 'guarded',
      inject: ['http'],
      apply(ctx) {
        ctx.http.use((req, _res, next) => {
          if (req.headers.authorization !== 'Bearer ok') throw new HttpError(401, 'AUTH_REQUIRED', 'Login required');
          next();
        });
        ctx.http.get('/api/me', () => ({ me: true }));
      },
    });
    expect((await fetch(`${base}/api/me`)).status).toBe(401);
    expect((await fetch(`${base}/api/me`, { headers: { Authorization: 'Bearer ok' } })).status).toBe(200);
  });

  it('prefers exact routes over wildcards regardless of registration order', async () => {
    const { ctx, base } = await startHttp();
    await ctx.plugin({
      name: 'order',
      inject: ['http'],
      apply(ctx) {
        ctx.http.get('/files/*', () => ({ from: 'wildcard' }));
        ctx.http.get('/files/special', () => ({ from: 'exact' }));
      },
    });
    expect(await (await fetch(`${base}/files/special`)).json()).toEqual({ from: 'exact' });
    expect(await (await fetch(`${base}/files/other`)).json()).toEqual({ from: 'wildcard' });
  });

  it('rejects malformed escapes with 400', async () => {
    const { ctx, base } = await startHttp();
    await ctx.plugin({ name: 'p', inject: ['http'], apply(ctx) { ctx.http.get('/api/x/:id', () => ({})); } });
    expect(await rawGet(base, '/api/x/%E0%A4%A')).toBe(400);
  });

  it('refuses an upgrade nobody handles and stops listening when disposed', async () => {
    const { base } = await startHttp();
    const { hostname, port } = new URL(base);
    const status = await new Promise((resolve, reject) => {
      const req = request({ hostname, port, path: '/ws/nothing', headers: { Connection: 'Upgrade', Upgrade: 'websocket' } });
      req.on('response', (res) => resolve(res.statusCode));
      req.on('upgrade', () => reject(new Error('upgraded')));
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(404);
    for (const fiber of running.splice(0)) await fiber.dispose();
    await expect(fetch(`${base}/`)).rejects.toThrow();
  });
});
