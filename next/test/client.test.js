import { request } from 'node:http';
import { Context } from 'cordis';
import { afterEach, describe, expect, it } from 'vitest';
import ClientService from '../plugins/client/index.js';
import HttpService from '../plugins/http/index.js';
import UiService from '../plugins/ui/index.js';

let running = [];

afterEach(async () => {
  for (const fiber of running.splice(0)) await fiber.dispose();
});

async function start({ ui = true } = {}) {
  const ctx = new Context();
  ctx.provide('launch', { host: '127.0.0.1', port: 0, tls: null, httpPort: null, managedRuntime: false });
  const http = ctx.plugin(HttpService, { port: 0 });
  await http;
  running.push(http);
  if (ui) await ctx.plugin(UiService);
  await ctx.plugin(ClientService);
  return { ctx, base: `http://127.0.0.1:${ctx.get('http').port}` };
}

function rawGet(base, path) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

function importMapOf(html) {
  const match = /<script type="importmap">(.*?)<\/script>/s.exec(html);
  return JSON.parse(match[1]);
}

describe('client service', () => {
  it('puts an import map of content-hashed module URLs and the boot script into the main page', async () => {
    const { base } = await start();
    const html = await (await fetch(`${base}/`)).text();
    const { imports } = importMapOf(html);
    expect(imports.cordis).toMatch(/^\/client\/vendor\/cordis\/index\.js\?h=[0-9a-f]{12}$/);
    expect(imports.cosmokit).toMatch(/^\/client\/vendor\/cosmokit\/index\.mjs\?h=/);
    expect(imports['@twp/client']).toMatch(/^\/client\/lib\/index\.js\?h=/);
    expect(imports['/client/core/api.js']).toMatch(/^\/client\/core\/api\.js\?h=/);
    expect(html).toMatch(/<script type="module" src="\/client\/boot\.js\?h=[0-9a-f]{12}"><\/script>/);
    // Before any module script of the page itself.
    expect(html.indexOf('type="importmap"')).toBeLessThan(html.indexOf('type="module"'));
  });

  it('caches a hashed URL for a year and revalidates an unhashed one', async () => {
    const { base } = await start();
    const { imports } = importMapOf(await (await fetch(`${base}/`)).text());
    const hashed = await fetch(base + imports.cordis);
    expect(hashed.status).toBe(200);
    expect(hashed.headers.get('content-type')).toMatch(/^text\/javascript/);
    expect(hashed.headers.get('cache-control')).toContain('immutable');
    const plain = await fetch(`${base}/client/vendor/cordis/index.js`);
    expect(plain.headers.get('cache-control')).toBe('no-cache');
    const stale = await fetch(`${base}/client/vendor/cordis/index.js?h=000000000000`);
    expect(stale.headers.get('cache-control')).toBe('no-cache');
  });

  it('serves nothing outside its roots', async () => {
    const { base } = await start();
    expect(await rawGet(base, '/client/..%2f..%2fpackage.json')).toBe(404);
    expect(await rawGet(base, '/client/%2e%2e/kernel/app.js')).toBe(404);
    expect(await rawGet(base, '/client/vendor/cordis/../package.json')).toBe(404);
    expect(await rawGet(base, '/client/nope.js')).toBe(404);
  });

  it('lists the core services, then each entry, publicly, and drops an entry with its plugin', async () => {
    const { ctx, base } = await start({ ui: false });
    const fiber = ctx.plugin({
      name: 'feature',
      inject: ['client'],
      apply(ctx) {
        ctx.client.entry(new URL('./fixtures/client-entry/index.js', import.meta.url), { refresh: 1 });
      },
    });
    await fiber;
    const manifest = await (await fetch(`${base}/client/manifest.json`)).json();
    expect(manifest.entries[0].url).toBe('/client/core/api.js');
    const entry = manifest.entries[1];
    expect(entry.url).toMatch(/^\/@plugin\/[0-9a-f]{10}\/index\.js$/);
    expect(entry.config).toEqual({ refresh: 1 });
    expect((await fetch(base + entry.url)).status).toBe(200);

    await fiber.dispose();
    const after = await (await fetch(`${base}/client/manifest.json`)).json();
    expect(after.entries).toHaveLength(1);
    expect((await fetch(base + entry.url)).status).toBe(404);
  });

  it('leaves the main page alone when the client service goes away', async () => {
    const { ctx, base } = await start();
    expect(await (await fetch(`${base}/`)).text()).toContain('type="importmap"');
    ctx.registry.delete(ClientService);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const html = await (await fetch(`${base}/`)).text();
    expect(html).not.toContain('type="importmap"');
    expect(html).toContain('/js/ms-app.js');
  });
});
