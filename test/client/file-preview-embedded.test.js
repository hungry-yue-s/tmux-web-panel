import { describe, it, expect, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { BLOCKS } from '../helpers/blocks.js';

const source = readFileSync('plugins/files/client/js/file-preview.js', 'utf8');

/** The real file preview, rendering into a box of its own rather than its modal. */
function setup({ fetchImpl } = {}) {
  const dom = new JSDOM('<div id="box"></div>', { url: 'https://panel.test/' });
  const { window } = dom;
  const fetch = vi.fn(fetchImpl || (async (url) => {
    const parsed = new URL(url, window.location.href);
    const path = parsed.searchParams.get('path');
    if (parsed.pathname.endsWith('/api/files/info')) {
      return { status: 200, json: async () => ({ success: true, data: { absPath: path, isText: true, size: 8, mtimeMs: 5 } }) };
    }
    if (parsed.pathname.endsWith('/api/files/content')) {
      return { status: 200, json: async () => ({ success: true, data: { content: 'name,qty\nbolt,4\n', language: null } }) };
    }
    throw new Error('Unexpected fetch: ' + url);
  }));
  window.Api = { activeServerId: () => 'local', nodeUrl: (_id, path) => path };
  new Function('window', 'document', 'fetch', 'Auth', source)(window, window.document, fetch, {
    headers: () => ({ Authorization: 'Bearer t' }), wsTokenParam: () => 'token=t',
  });
  return { window, preview: window.FilePreview, fetch, box: window.document.getElementById('box') };
}

// A header cell carries its column filter's ▾.
const cells = (box) => [...box.querySelectorAll('.fp-xlsx-table td')].map((td) => td.textContent.replace('▾', ''));

describe('what a read-only render leaves out', () => {
  it('is the TODO.md board, which saves to the file on disk', () => {
    const w = {};
    new Function('window', 'Api', BLOCKS + '\nwindow.Blocks = Blocks;')(w, {});
    expect(typeof w.Blocks.rendererFor('/repo/TODO.md')).toBe('function');
    expect(w.Blocks.rendererFor('/repo/TODO.md', true)).toBeNull();
    // Nothing else it renders writes: notebooks and patches still get theirs.
    expect(typeof w.Blocks.rendererFor('/repo/a.ipynb', true)).toBe('function');
    expect(typeof w.Blocks.rendererFor('/repo/fix.patch', true)).toBe('function');
  });
});

describe('rendering a file outside the modal', () => {
  it('pages large code as plain text, with bounded DOM and no highlighter download', async () => {
    const { window, preview, box } = setup();
    const content = 'a'.repeat(3999) + '😀' + '\nsecond line\n' + 'b'.repeat(70000);
    await preview.renderInto(box, { info: { isText: true, language: 'json' }, name: '/repo/data.json', content, versioned: true });
    expect(window.document.querySelector('script[src*="highlight"]')).toBeNull();
    expect(box.textContent).toContain('分段纯文本');
    const code = () => box.querySelector('pre > code').textContent;
    const first = code();
    const chunks = [first];
    while (!box.querySelector('[aria-label="下一段"]').disabled) {
      box.querySelector('[aria-label="下一段"]').click();
      expect(code().length).toBeLessThanOrEqual(4000);
      expect(code().charCodeAt(0)).not.toBeGreaterThanOrEqual(0xdc00);
      chunks.push(code());
    }
    expect(chunks.join('')).toBe(content);
    while (!box.querySelector('[aria-label="上一段"]').disabled) box.querySelector('[aria-label="上一段"]').click();
    expect(code()).toBe(first);
    expect(box.querySelector('.fp-line-numbers').textContent).toBe('1');
    window.close();
  });

  it('also pages a long line in a small file, while normal code keeps syntax highlighting', async () => {
    const { window, preview, box } = setup();
    await preview.renderInto(box, { info: { isText: true }, name: '/repo/long.txt', content: 'x'.repeat(5000) });
    expect(box.querySelector('pre > code').textContent).toHaveLength(4000);
    expect(window.document.querySelector('script[src*="highlight"]')).toBeNull();
    await preview.renderInto(box, { info: { isText: true }, name: '/repo/small.js', content: 'const n = 1;' });
    expect(box.querySelector('.fp-code-pages')).toBeNull();
    expect(box.querySelector('pre > code').textContent).toBe('const n = 1;');
    expect(window.document.querySelector('script[src*="highlight"]')).not.toBeNull();
    window.close();
  });

  it('opens the segment containing a target line without applying a misleading Git gutter', async () => {
    const content = Array.from({ length: 1500 }, (_, i) => 'line ' + (i + 1)).join('\n');
    const { window, preview } = setup({ fetchImpl: async (url) => ({
      status: 200,
      json: async () => ({ success: true, data: url.includes('/info?')
        ? { absPath: '/repo/large.txt', isText: true, size: content.length }
        : { content } }),
    }) });
    const decorateGitGutter = vi.fn();
    window.Blocks = { rendererFor: () => null, decorateGitGutter };
    await preview.openFile('/repo/large.txt', null, { lineRef: 1000 });
    const body = window.document.querySelector('.fp-body');
    expect(body.querySelector('pre > code').textContent).toContain('line 1000\n');
    const numbers = body.querySelector('.fp-line-numbers').textContent.split('\n').map(Number);
    expect(numbers).toContain(1000);
    expect(decorateGitGutter).not.toHaveBeenCalled();
    const exported = new JSDOM((await preview._test.buildStandaloneDoc()).html);
    expect(exported.window.document.querySelector('pre > code').textContent).toBe(content);
    expect(exported.window.document.querySelector('.fp-code-pages')).toBeNull();
    exported.window.close();
    window.close();
  });

  it('keeps the segment being read across a content refresh', async () => {
    let content = 'a'.repeat(4000) + 'SECOND' + 'b'.repeat(5000);
    const { window, preview } = setup({ fetchImpl: async (url) => ({
      status: 200,
      json: async () => ({ success: true, data: url.includes('/info?')
        ? { absPath: '/repo/large.txt', isText: true, size: content.length }
        : { content } }),
    }) });
    await preview.openFile('/repo/large.txt');
    window.document.querySelector('[aria-label="下一段"]').click();
    content += 'tail';
    await preview._test.refreshCurrent(true);
    expect(window.document.querySelector('.fp-body pre > code').textContent.startsWith('SECOND')).toBe(true);
    // If the file shrinks, stay at its last available segment.
    content = 'c'.repeat(4500);
    await preview._test.refreshCurrent(true);
    expect(window.document.querySelector('.fp-body pre > code').textContent).toHaveLength(500);
    expect(window.document.querySelector('[aria-label="下一段"]').disabled).toBe(true);
    preview.close();
    window.close();
  });

  it('still highlights an ordinary modal after the lazy scripts finish loading', async () => {
    const { window, preview } = setup({ fetchImpl: async (url) => ({
      status: 200,
      json: async () => ({ success: true, data: url.includes('/info?')
        ? { absPath: '/repo/small.js', isText: true, size: 12, language: 'javascript' }
        : { content: 'const n = 1;', language: 'javascript' } }),
    }) });
    const highlight = vi.fn(() => ({ value: '<span class="hljs-keyword">const</span> n = 1;' }));
    window.hljs = { getLanguage: () => true, highlight };
    await preview.openFile('/repo/small.js');
    window.document.querySelector('script[src*="highlight"]').dispatchEvent(new window.Event('load'));
    window.document.querySelector('link[href*="highlight"]').dispatchEvent(new window.Event('load'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(highlight).toHaveBeenCalledWith('const n = 1;', { language: 'javascript', ignoreIllegals: true });
    expect(window.document.querySelector('.fp-body code .hljs-keyword').textContent).toBe('const');
    preview.close();
    window.close();
  });

  it('shows an image as the version it is given, with no modal', async () => {
    const { window, preview, fetch, box } = setup();
    const rawUrl = '/api/git/raw?rev=abc1234&file=logo.png&path=%2Frepo&token=t';
    await expect(preview.renderInto(box, { info: { isImage: true }, name: '/repo/logo.png', rawUrl, versioned: true })).resolves.toBe(true);

    expect(box.classList.contains('fp-embedded')).toBe(true);
    expect(box.querySelector('.fp-image-wrap img').getAttribute('src')).toBe(rawUrl);
    expect(window.document.querySelector('.fp-overlay')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('renders the text it is given with the renderer for its name, without reading the disk', async () => {
    const { preview, fetch, box } = setup();
    await preview.renderInto(box, { info: { isText: true }, name: '/repo/parts.csv', content: 'a,b\n1,2\n', versioned: true });
    expect(cells(box)).toEqual(['a', 'b', '1', '2']);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('says a database or an archive can only be shown as the file on disk, and offers the version for download', async () => {
    for (const info of [{ isSqlite: true }, { isArchive: true, archiveType: 'zip' }]) {
      const { preview, fetch, box } = setup();
      await preview.renderInto(box, { info, name: '/repo/data.bin', rawUrl: '/api/git/raw?rev=HEAD&file=data.bin', versioned: true });
      expect(box.textContent).toContain('只能按磁盘上的文件预览');
      expect(box.querySelector('.fp-error-download').textContent).toBe('下载这个版本');
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it('reads the file on disk the way the modal does, from the server it is told', async () => {
    const { preview, fetch, box } = setup();
    await expect(preview.renderInto(box, { path: '/repo/parts.csv', machine: '/n/remote' })).resolves.toBe(true);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/n/remote/api/files/info?path=%2Frepo%2Fparts.csv',
      '/n/remote/api/files/content?path=%2Frepo%2Fparts.csv',
    ]);
    expect(cells(box)).toEqual(['name', 'qty', 'bolt', '4']);
  });

  it('lets only the latest render land in a box', async () => {
    let answer;
    const { preview, box } = setup({
      fetchImpl: () => new Promise((resolve) => { answer = resolve; }),
    });
    const first = preview.renderInto(box, { path: '/repo/parts.csv' });
    await preview.renderInto(box, { info: { isImage: true }, name: '/repo/logo.png', rawUrl: '/raw', versioned: true });
    answer({ status: 200, json: async () => ({ success: true, data: { absPath: '/repo/parts.csv', isText: true } }) });

    await expect(first).resolves.toBe(false);
    expect(box.querySelector('img')).not.toBeNull();
    expect(box.querySelector('.fp-xlsx-table')).toBeNull();
  });

  it('says what went wrong when the file cannot be read', async () => {
    const { preview, box } = setup({
      fetchImpl: async () => ({ status: 404, json: async () => ({ success: false, error: 'Path not found' }) }),
    });
    await expect(preview.renderInto(box, { path: '/repo/gone.txt' })).resolves.toBe(false);
    expect(box.querySelector('.fp-error').textContent).toContain('Path not found');
  });
});
