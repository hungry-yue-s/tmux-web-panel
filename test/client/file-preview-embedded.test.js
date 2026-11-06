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
