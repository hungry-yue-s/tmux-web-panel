import { request } from 'node:http';
import { Context } from 'cordis';
import { afterEach, describe, expect, it } from 'vitest';
import ClientService from '../plugins/client/index.js';
import HttpService from '../plugins/http/index.js';

let running = [];

afterEach(async () => {
  for (const fiber of running.splice(0)) await fiber.dispose();
});

async function startClient() {
  const ctx = new Context();
  const http = ctx.plugin(HttpService, { port: 0 });
  await http;
  running.push(http);
  await ctx.plugin(ClientService, { title: '测试面板' });
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
  it('renders the page with an import map of content-hashed module URLs', async () => {
    const { base } = await startClient();
    const page = await fetch(`${base}/`);
    expect(page.headers.get('cache-control')).toBe('no-cache');
    const html = await page.text();
    expect(html).toContain('<title>测试面板</title>');
    expect(html).toMatch(/src="\/client\/boot\.js\?h=[0-9a-f]{12}"/);
    const { imports } = importMapOf(html);
    expect(imports.cordis).toMatch(/^\/vendor\/cordis\/index\.js\?h=[0-9a-f]{12}$/);
    expect(imports.cosmokit).toMatch(/^\/vendor\/cosmokit\/index\.mjs\?h=/);
    expect(imports['@twp/client']).toMatch(/^\/client\/lib\/index\.js\?h=/);
    expect(imports['/client/core/shell.js']).toMatch(/^\/client\/core\/shell\.js\?h=/);
    // The same page again revalidates to 304.
    const again = await fetch(`${base}/`, { headers: { 'If-None-Match': page.headers.get('etag') } });
    expect(again.status).toBe(304);
  });

  it('caches a hashed URL for a year and revalidates an unhashed one', async () => {
    const { base } = await startClient();
    const { imports } = importMapOf(await (await fetch(`${base}/`)).text());
    const hashed = await fetch(base + imports.cordis);
    expect(hashed.status).toBe(200);
    expect(hashed.headers.get('content-type')).toMatch(/^text\/javascript/);
    expect(hashed.headers.get('cache-control')).toContain('immutable');
    const plain = await fetch(`${base}/vendor/cordis/index.js`);
    expect(plain.headers.get('cache-control')).toBe('no-cache');
    const stale = await fetch(`${base}/vendor/cordis/index.js?h=000000000000`);
    expect(stale.headers.get('cache-control')).toBe('no-cache');
  });

  it('serves nothing outside its roots', async () => {
    const { base } = await startClient();
    expect(await rawGet(base, '/client/..%2f..%2fpackage.json')).toBe(404);
    expect(await rawGet(base, '/client/%2e%2e/kernel/app.js')).toBe(404);
    expect(await rawGet(base, '/vendor/cordis/../package.json')).toBe(404);
    expect(await rawGet(base, '/client/nope.js')).toBe(404);
  });

  it('lists the core services, then each entry, and drops an entry with its plugin', async () => {
    const { ctx, base } = await startClient();
    const fiber = ctx.plugin({
      name: 'feature',
      inject: ['client'],
      apply(ctx) {
        ctx.client.entry(new URL('../plugins/workspace/client/index.js', import.meta.url), { refresh: 1 });
      },
    });
    await fiber;
    const manifest = await (await fetch(`${base}/api/client/manifest`)).json();
    expect(manifest.title).toBe('测试面板');
    expect(manifest.entries.slice(0, 2).map((entry) => entry.url)).toEqual(['/client/core/api.js', '/client/core/shell.js']);
    const entry = manifest.entries[2];
    expect(entry.url).toMatch(/^\/@plugin\/[0-9a-f]{10}\/index\.js$/);
    expect(entry.config).toEqual({ refresh: 1 });
    expect((await fetch(base + entry.url)).status).toBe(200);

    await fiber.dispose();
    const after = await (await fetch(`${base}/api/client/manifest`)).json();
    expect(after.entries).toHaveLength(2);
    expect((await fetch(base + entry.url)).status).toBe(404);
  });
});
