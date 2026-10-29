import { describe, it, expect, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const source = readFileSync('public/js/file-preview.js', 'utf8');

function setup() {
  const dom = new JSDOM('<div id="main-layout"><div class="terminal-view"></div></div>', { url: 'https://panel.test/' });
  const { window } = dom;
  Object.defineProperty(window, 'innerWidth', { value: 1440 });
  window.URL.createObjectURL = vi.fn().mockImplementation(() => 'blob:https://panel.test/' + window.URL.createObjectURL.mock.calls.length);
  window.URL.revokeObjectURL = vi.fn();
  const headers = { Authorization: 'Bearer document-test' };
  let content = '<!doctype html><h1>Report</h1><script>window.reportReady = true;</script>';
  let revision = 1;
  const fetch = vi.fn(async (url) => {
    const parsed = new URL(url, window.location.href);
    const path = parsed.searchParams.get('path');
    if (parsed.pathname.endsWith('/info')) return { status: 200, json: async () => ({ success: true, data: {
      absPath: path, isText: !path.endsWith('.pdf'), isPdf: path.endsWith('.pdf'),
      language: path.endsWith('.pdf') ? null : 'html', size: content.length, mtimeMs: revision,
    } }) };
    if (parsed.pathname.endsWith('/content')) return { status: 200, json: async () => ({ success: true, data: { content, language: 'html' } }) };
    if (parsed.pathname.endsWith('/raw')) return { ok: true, blob: async () => new window.Blob(['%PDF-1.7'], { type: 'application/pdf' }) };
    throw new Error('Unexpected fetch: ' + url);
  });
  window.Api = { activeServerId: () => 'remote', nodeUrl: (_serverId, path) => '/n/remote' + path };
  new Function('window', 'document', 'fetch', 'Auth', source)(window, window.document, fetch, {
    headers: () => headers, wsTokenParam: () => 'token=document-test',
  });
  window.FilePreview.switchDockContext('remote', '@0');
  return { window, preview: window.FilePreview, fetch, headers, setContent(next) { content = next; revision++; } };
}

describe('HTML and PDF previews', () => {
  it.each(['report.html', 'report.HTM'])('renders %s in an isolated frame and preserves the source toggle through refresh', async (filename) => {
    const { window, preview, setContent } = setup();
    await preview.openFile('/tmp/' + filename, '%1');
    const frame = window.document.querySelector('.fp-html-wrap iframe');
    expect(frame.srcdoc).toContain('<h1>Report</h1>');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.referrerPolicy).toBe('no-referrer');
    expect(frame.srcdoc).not.toContain('document-test');
    const toggle = window.document.querySelector('.fp-document-toolbar button');
    toggle.click();
    expect(frame.hidden).toBe(true);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(window.document.querySelector('.fp-html-source code').textContent).toBe(frame.srcdoc);
    const exported = new JSDOM((await preview._test.buildStandaloneDoc()).html);
    expect(exported.window.document.querySelector('iframe').getAttribute('sandbox')).toBe('allow-scripts');
    expect(exported.window.document.querySelector('iframe').hidden).toBe(false);
    exported.window.close();
    setContent('<h1>Updated</h1>');
    await preview._test.refreshCurrent(false);
    expect(window.document.querySelector('.fp-html-source code').textContent).toBe('<h1>Updated</h1>');
    window.document.querySelector('.fp-document-toolbar button').click();
    expect(window.document.querySelector('.fp-html-wrap iframe').hidden).toBe(false);
    preview.close();
    window.close();
  });

  it('opens HTML line references in source view', async () => {
    const { window, preview } = setup();
    await preview.openFile('/tmp/report.html', '%1', { lineRef: 2 });
    expect(window.document.querySelector('.fp-html-wrap iframe').hidden).toBe(true);
    expect(window.document.querySelector('.fp-html-source code')).not.toBeNull();
    preview.close();
    window.close();
  });

  it('loads remote PDFs with authentication and releases replaced and closed object URLs', async () => {
    const { window, preview, fetch, headers } = setup();
    await preview.openFile('/tmp/report.pdf', '%1');
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/n/remote/api/files/raw?'), {
      headers, cache: 'no-store',
    });
    const frame = window.document.querySelector('.fp-pdf-wrap iframe');
    expect(frame.src).toBe('blob:https://panel.test/1');
    expect(window.document.querySelector('.fp-document-toolbar button').textContent).toBe('下载 PDF');
    expect(fetch.mock.calls.some(([url]) => url.includes('/content'))).toBe(false);
    window.open = vi.fn();
    window.document.querySelector('.fp-btn-more').click();
    window.document.querySelector('.fp-menu [aria-label="在新标签页打开"]').click();
    expect(window.open).toHaveBeenCalledWith(frame.src, '_blank');
    await preview._test.refreshCurrent(true);
    expect(window.URL.revokeObjectURL).toHaveBeenCalledWith('blob:https://panel.test/1');
    preview.close();
    expect(window.URL.revokeObjectURL).toHaveBeenCalledWith('blob:https://panel.test/2');
    window.close();
  });

  it('retains PDF URLs while docked or hidden and releases all tabs on close', async () => {
    const { window, preview } = setup();
    await preview.openFile('/tmp/one.pdf');
    window.document.querySelector('.fp-btn-placement').click();
    await preview.openFile('/tmp/two.pdf');
    window.document.querySelector('.fp-overlay:not(.fp-dock) .fp-btn-placement').click();
    window.document.querySelector('.fp-dock .fp-btn-placement').click();
    expect(window.URL.revokeObjectURL).not.toHaveBeenCalled();
    preview.closeDocked();
    expect(window.URL.revokeObjectURL.mock.calls).toEqual([
      ['blob:https://panel.test/1'], ['blob:https://panel.test/2'],
    ]);
    window.close();
  });

  it('releases PDF URLs when a slow response arrives after closing', async () => {
    const { window, preview, fetch } = setup();
    const originalFetch = fetch.getMockImplementation();
    let release;
    fetch.mockImplementation((url, options) => url.includes('/raw')
      ? new Promise((resolve) => { release = () => resolve({ ok: true, blob: async () => new window.Blob(['pdf']) }); })
      : originalFetch(url, options));
    const opening = preview.openFile('/tmp/slow.pdf');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    preview.close();
    release();
    await opening;
    expect(window.document.querySelector('.fp-overlay')).toBeNull();
    expect(window.URL.revokeObjectURL).toHaveBeenCalledWith('blob:https://panel.test/1');
    window.close();
  });

  it('reports a PDF authentication failure without creating a viewer URL', async () => {
    const { window, preview, fetch } = setup();
    const originalFetch = fetch.getMockImplementation();
    fetch.mockImplementation((url, options) => url.includes('/raw')
      ? Promise.resolve({ ok: false, status: 401 }) : originalFetch(url, options));
    await preview.openFile('/tmp/report.pdf');
    expect(window.document.querySelector('.fp-error').textContent).toContain('PDF 加载失败（HTTP 401）');
    expect(window.URL.createObjectURL).not.toHaveBeenCalled();
    preview.close();
    window.close();
  });
});
