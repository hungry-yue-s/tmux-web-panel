import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createStaticAssets } from '../server/static-assets.js';
import { createOutputBatcher } from '../server/terminal.js';

describe('static assets for slow links', () => {
  let dir;
  let app;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'twp-static-'));
    mkdirSync(join(dir, 'js'));
    mkdirSync(join(dir, 'fonts'));
    writeFileSync(join(dir, 'js', 'app.js'), 'console.log(1)');
    writeFileSync(join(dir, 'fonts', 'core.0123456789.woff2'), 'wOF2');
    writeFileSync(join(dir, 'index.html'), '<script src="/js/app.js?v=3"></script><link rel="preload" href="/fonts/core.0123456789.woff2"><a href="/js/missing.js">');
    app = express();
    app.use(createStaticAssets(dir));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('pins asset URLs to a content hash and lets pages revalidate', async () => {
    const page = await request(app).get('/');
    expect(page.headers['cache-control']).toBe('no-cache');
    const hash = /\/js\/app\.js\?h=([0-9a-f]{12})"/.exec(page.text)[1];
    // Names that already carry a hash, and files that do not exist, are left alone.
    expect(page.text).toContain('href="/fonts/core.0123456789.woff2"');
    expect(page.text).toContain('href="/js/missing.js"');

    const again = await request(app).get('/').set('If-None-Match', page.headers.etag);
    expect(again.status).toBe(304);

    const asset = await request(app).get('/js/app.js?h=' + hash);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const font = await request(app).get('/fonts/core.0123456789.woff2');
    expect(font.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const plain = await request(app).get('/js/app.js');
    expect(plain.headers['cache-control']).toBe('no-cache');

    // Editing the file changes its URL on the next page load.
    writeFileSync(join(dir, 'js', 'app.js'), 'console.log(2)');
    utimesSync(join(dir, 'js', 'app.js'), new Date(), new Date(Date.now() + 5000));
    const next = await request(app).get('/');
    expect(next.text).not.toContain(hash);
  });

  it('does not serve files outside the public directory through a page', async () => {
    const res = await request(app).get('/..%2F..%2Fetc.html');
    expect(res.status).toBe(404);
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
    const source = readFileSync(resolve(import.meta.dirname, '../public/js/terminal-fonts.js'), 'utf8');
    const data = readFileSync(resolve(import.meta.dirname, '../public/js/terminal-fonts-data.js'), 'utf8');
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
    expect(loads.at(-1)).toMatch(/tpm-700-han-a/);
  });
});
