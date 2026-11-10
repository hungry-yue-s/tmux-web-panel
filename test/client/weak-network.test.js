import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Context } from 'cordis';
import HttpService from '../../plugins/http/index.js';
import UiService from '../../plugins/ui/index.js';
import { createOutputBatcher } from '../../lib/terminal.js';

// Plain http.request: fetch() adds Cache-Control: no-cache to conditional
// requests, which (correctly) rules out a 304.
function rawStatus(base, path, headers = {}) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname, port, path, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('static assets for slow links', () => {
  let dir;
  let base;
  let http;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'anymux-static-'));
    mkdirSync(join(dir, 'js'));
    mkdirSync(join(dir, 'fonts'));
    writeFileSync(join(dir, 'js', 'fixture-app.js'), 'console.log(1)');
    writeFileSync(join(dir, 'fonts', 'core.0123456789.woff2'), 'wOF2');
    writeFileSync(join(dir, 'fixture.html'), '<script src="/js/fixture-app.js?v=3"></script><link rel="preload" href="/fonts/core.0123456789.woff2"><a href="/js/missing.js">');
    const ctx = new Context();
    ctx.provide('launch', { host: '127.0.0.1', port: 0, tls: null, httpPort: null, managedRuntime: false });
    http = ctx.plugin(HttpService, { port: 0 });
    await http;
    await ctx.plugin(UiService);
    ctx.get('ui').serve(dir);
    base = `http://127.0.0.1:${ctx.get('http').port}`;
  });
  afterAll(async () => {
    await http?.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('pins asset URLs to a content hash and lets pages revalidate', async () => {
    const page = await fetch(`${base}/fixture.html`);
    expect(page.headers.get('cache-control')).toBe('no-cache');
    const text = await page.text();
    const hash = /\/js\/fixture-app\.js\?h=([0-9a-f]{12})"/.exec(text)[1];
    // Names that already carry a hash, and files that do not exist, are left alone.
    expect(text).toContain('href="/fonts/core.0123456789.woff2"');
    expect(text).toContain('href="/js/missing.js"');

    expect(await rawStatus(base, '/fixture.html', { 'If-None-Match': page.headers.get('etag') })).toBe(304);

    const asset = await fetch(`${base}/js/fixture-app.js?h=${hash}`);
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const font = await fetch(`${base}/fonts/core.0123456789.woff2`);
    expect(font.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const plain = await fetch(`${base}/js/fixture-app.js`);
    expect(plain.headers.get('cache-control')).toBe('no-cache');

    // Editing the file changes its URL on the next page load.
    writeFileSync(join(dir, 'js', 'fixture-app.js'), 'console.log(2)');
    utimesSync(join(dir, 'js', 'fixture-app.js'), new Date(), new Date(Date.now() + 5000));
    const next = await (await fetch(`${base}/fixture.html`)).text();
    expect(next).not.toContain(hash);
  });

  it('does not serve files outside the public directory through a page', async () => {
    expect(await rawStatus(base, '/..%2F..%2Fetc.html')).toBe(404);
    expect(await rawStatus(base, '/js/..%2F..%2Fpackage.json')).toBe(404);
  });
});

describe('terminal output batching', () => {
  afterEach(() => vi.useRealTimers());

  it('sends an idle chunk on the next tick and gathers a burst into one message', () => {
    vi.useFakeTimers();
    const sent = [];
    let clock = 1000;
    const batcher = createOutputBatcher((data) => sent.push(data), { now: () => clock });
    batcher.push('a');
    vi.advanceTimersByTime(0);
    expect(sent).toEqual(['a']);
    clock += 5;
    batcher.push('b');
    batcher.push('c');
    batcher.push('d');
    vi.advanceTimersByTime(3);
    expect(sent).toEqual(['a']);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual(['a', 'bcd']);
  });

  it('flushes at once when a burst grows large, and on demand', () => {
    vi.useFakeTimers();
    const sent = [];
    const batcher = createOutputBatcher((data) => sent.push(data));
    batcher.push('x'.repeat(70 * 1024));
    expect(sent).toHaveLength(1);
    batcher.push('tail');
    batcher.flush();
    expect(sent[1]).toBe('tail');
    batcher.push('dropped');
    batcher.dispose();
    vi.runAllTimers();
    expect(sent).toHaveLength(2);
  });
});

describe('terminal font slices at runtime', () => {
  it('picks the common-character slice over the interval slice and loads each slice once', async () => {
    const source = readFileSync(resolve(import.meta.dirname, '../../plugins/terminal/client/js/terminal-fonts.js'), 'utf8');
    const data = readFileSync(resolve(import.meta.dirname, '../../plugins/terminal/client/js/terminal-fonts-data.js'), 'utf8');
    const loads = [];
    class FakeFontFace {
      constructor(family, src, descriptors) {
        this.family = family;
        this.src = src;
        this.weight = descriptors.weight;
        this.status = 'unloaded';
      }
      load() {
        loads.push(this.src + '@' + this.weight);
        this.status = 'loaded';
        return Promise.resolve(this);
      }
    }
    const window = {};
    const document = { fonts: { add() {}, load: () => Promise.resolve([]) } };
    new Function('window', 'document', 'FontFace', data + source + '\nwindow.TerminalFonts = TerminalFonts;')(window, document, FakeFontFace);
    const fonts = window.TerminalFonts;

    // 中 is a common character: its han-a slice wins over the han-b interval holding it.
    expect(fonts._test.sliceFor('中'.codePointAt(0)).slice.id).toMatch(/^han-a/);
    expect(fonts._test.sliceFor(0xF0001) && fonts._test.sliceFor(0xF0001).slice.id).toMatch(/^pua-/);
    expect(fonts._test.sliceFor('A'.codePointAt(0))).toBeNull();

    expect(await fonts.ensure('ls -la', 400)).toBe(false);
    expect(loads).toHaveLength(0);
    expect(await fonts.ensure('中文 中', 400)).toBe(true);
    const afterFirst = loads.length;
    expect(afterFirst).toBeGreaterThan(0);
    expect(await fonts.ensure('中文', 400)).toBe(false);
    expect(loads).toHaveLength(afterFirst);
    expect(loads.every((l) => l.endsWith('@400'))).toBe(true);
    await fonts.ensure('中', 700);
    expect(loads.at(-1)).toMatch(/amm-700-han-a/);
  });
});
