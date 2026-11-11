import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { BLOCKS } from '../helpers/blocks.js';

const source = readFileSync('plugins/files/client/js/file-preview.js', 'utf8');
const opened = [];
afterEach(() => opened.splice(0).forEach((window) => {
  window.FilePreview?.close(); window.FilePreview?.closeDocked(); window.close();
}));
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const esc = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const notebook = (text = 'print(1)') => JSON.stringify({ metadata: { language_info: { name: 'python' } }, cells: [
  { cell_type: 'code', execution_count: null, source: [text], outputs: [] },
] });
const patch = (text) => 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+' + text + '\n';
const diagram = '```mermaid\nflowchart TD\nA-->B\n```';
const diagramSvg = '<svg viewBox="0 0 100 40"><text x="10" y="20">graph</text></svg>';

function sheet(rows = 2, columns = 2, text = 'cell', merges = []) {
  return {
    name: 'Sheet', actualRowCount: rows, rowCount: rows, actualColumnCount: columns, columnCount: columns,
    model: { merges }, getColumn: () => ({}),
    getRow: vi.fn(() => ({ getCell: vi.fn(() => ({ text })) })),
  };
}

async function xlsxFetch(url) {
  const parsed = new URL(url, 'https://panel.test/');
  if (parsed.pathname.endsWith('/info')) return { status: 200, json: async () => ({ success: true, data: {
    absPath: parsed.searchParams.get('path'), isText: false, isXlsx: true, size: 8, mtimeMs: 1,
  } }) };
  if (parsed.pathname.endsWith('/raw')) return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
  throw new Error('Unexpected fetch: ' + url);
}

function enableDock(context) {
  context.window.document.body.insertAdjacentHTML('beforeend',
    '<div class="ms-app mode-terminal"><main class="ms-main"><div class="terminal-view"></div></main></div>');
  Object.defineProperty(context.window, 'innerWidth', { value: 1440 });
  context.preview.switchDockContext('local', '@0', '1873:1700000000');
}

/** CDN libraries stay offline; the real script/link load events release each renderer. */
function setup({ sheets = [sheet()], fetchImpl } = {}) {
  const dom = new JSDOM('<div id="box"></div>', { url: 'https://panel.test/' });
  const { window } = dom;
  opened.push(window);
  const fetch = vi.fn(fetchImpl || (async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })));
  const highlight = vi.fn((text) => ({ value: esc(text) }));
  const parse = vi.fn((text) => text);
  window.hljs = { getLanguage: (language) => language !== 'mermaid', highlight, highlightElement: vi.fn() };
  window.mermaid = { initialize: vi.fn(), render: vi.fn(async () => ({ svg: diagramSvg })) };
  window.markdownit = vi.fn((options = {}) => {
    const md = {
      options, inline: { ruler: { before() {}, push() {} } }, core: { ruler: { after() {} } }, parse,
      renderer: { render(text) {
        const fence = /^```(\w+)\n([\s\S]*?)\n```/.exec(text);
        return fence ? '<pre><code class="language-' + fence[1] + '">'
          + (options.highlight?.(fence[2], fence[1]) || esc(fence[2])) + '</code></pre>' : '<p>' + esc(text) + '</p>';
      } },
      render(text) { return md.renderer.render(text); }, use(plugin) { plugin(md); return md; },
    };
    return md;
  });
  const diffHtml = vi.fn((text) => '<pre class="diff2html-result">' + esc(text) + '</pre>');
  window.Diff2Html = { html: diffHtml };
  const workbook = { eachSheet(fn) { sheets.forEach(fn); } };
  const loadWorkbook = vi.fn(async () => workbook);
  window.ExcelJS = { Workbook: class { constructor() { this.xlsx = { load: loadWorkbook }; } } };
  window.Api = { activeServerId: () => 'local', nodeUrl: (_id, path) => path };
  const auth = { headers: () => ({}), wsTokenParam: () => '' };
  new Function('window', 'document', 'fetch', 'Auth', 'Api', BLOCKS + '\nwindow.Blocks = Blocks;\n' + source)(
    window, window.document, fetch, auth, window.Api,
  );
  const loaded = new Set();
  async function finish(promise) {
    for (let round = 0; round < 8; round++) {
      await tick();
      window.document.querySelectorAll('script[src],link[href]').forEach((node) => {
        if (!loaded.has(node)) { loaded.add(node); node.dispatchEvent(new window.Event('load')); }
      });
    }
    return promise;
  }
  const box = window.document.getElementById('box');
  const preview = window.FilePreview;
  const render = (name, content, info = {}) => preview.renderInto(box, {
    name: '/repo/' + name, content, info: { absPath: '/repo/' + name, isText: true, ...info }, versioned: true,
    rawUrl: '/api/git/raw?file=' + name,
  });
  return { window, box, preview, render, finish, fetch, auth, highlight, parse, diffHtml, loadWorkbook };
}

function expectPaged(context, content) {
  const { box } = context;
  expect(box.querySelector('.fp-code-pages')).not.toBeNull();
  const code = box.querySelector('pre > code');
  expect(code.textContent.length).toBeGreaterThan(0);
  expect(code.textContent.length).toBeLessThanOrEqual(4000);
  expect(content.startsWith(code.textContent)).toBe(true);
  expect(box.querySelectorAll('*').length).toBeLessThan(30);
}

describe('shared file preview rendering budgets', () => {
  it.each([
    ['large.md', '```json\n' + 'x'.repeat(70000) + '\n```', { isMarkdown: true }],
    ['large.ipynb', notebook('x'.repeat(70000)), {}],
  ])('pages %s before parsing or highlighting it', async (name, content, info) => {
    const context = setup();
    await context.finish(context.render(name, content, info));
    expectPaged(context, content);
    expect(context.window.markdownit).not.toHaveBeenCalled();
    expect(context.highlight).not.toHaveBeenCalled();
    expect(context.box.querySelector('.blk-nb')).toBeNull();
  });

  it('uses the bounded diff renderer for a large patch even with Diff2Html available', async () => {
    const context = setup();
    await context.finish(context.render('large.patch', patch('x'.repeat(70000))));
    expect(context.diffHtml.mock.calls.length).toBe(0);
    expect(context.box.querySelectorAll('.blk-line')).toHaveLength(2);
    expect(context.box.querySelector('.blk-line-pages')).not.toBeNull();
    expect(context.box.querySelector('.blk-line.is-add .blk-code').textContent.length).toBeLessThanOrEqual(4001);
  });

  it('pages a wide CSV whose cell count exceeds the budget even below the text budget', async () => {
    const content = Array.from({ length: 30 }, () => Array(200).fill('x').join(',')).join('\n');
    const context = setup();
    await context.finish(context.render('wide.csv', content));
    expectPaged(context, content);
    expect(context.box.querySelector('table') === null).toBe(true);
  });

  it('keeps HTML in its sandboxed document preview when its source exceeds the text budget', async () => {
    const context = setup();
    await context.finish(context.render('page.html', '<p>' + 'x'.repeat(70000) + '</p>', { language: 'html' }));
    expect(context.box.querySelector('iframe[sandbox]')).not.toBeNull();
    expect(context.box.querySelector('.fp-code-pages')).toBeNull();
  });
});

describe('decoded Notebook rendering budgets', () => {
  const codeCell = (source = [], outputs = []) => ({ cell_type: 'code', source, outputs });
  const fragments = Array(60).fill('x'.repeat(1000));
  const outputFragments = Array(6).fill('x'.repeat(1000));
  const stream = { output_type: 'stream', text: ['x'] };
  const rich = { output_type: 'display_data', data: { 'text/html': ['<p>small</p>'] } };
  const cases = [
    ['joined code source', () => [codeCell(fragments)]],
    ['joined Markdown source', () => [{ cell_type: 'markdown', source: fragments }]],
    ['joined stream text', () => [codeCell([], [{ output_type: 'stream', text: outputFragments }])]],
    ['joined plain output', () => [codeCell([], [{ output_type: 'display_data', data: { 'text/plain': outputFragments } }])]],
    ['joined HTML output', () => [codeCell([], [{ output_type: 'display_data', data: { 'text/html': outputFragments } }])]],
    ['joined SVG output', () => [codeCell([], [{ output_type: 'display_data', data: { 'image/svg+xml': outputFragments } }])]],
    ['decoded traceback lines', () => [codeCell([], [{ output_type: 'error', traceback: Array(5).fill('x\n'.repeat(250)) }])]],
    ['cell count', () => Array.from({ length: 201 }, () => codeCell())],
    ['total output count', () => [codeCell([], Array(60).fill(stream)), codeCell([], Array(60).fill(stream))]],
    ['rich output count', () => [codeCell([], Array(21).fill(rich))]],
  ];

  it.each(cases)('pages raw JSON when its %s exceeds the decoded budget', async (name, cells) => {
    // Keep the JSON below every shared raw-text threshold so only the decoded guard can catch it.
    const content = name === 'cell count'
      ? '{\n"cells":[\n' + cells().map((cell) => JSON.stringify(cell)).join(',\n') + '\n]\n}'
      : JSON.stringify({ cells: cells() }, null, 2);
    const lines = content.split('\n');
    expect(content.length).toBeLessThan(65536);
    expect(lines.length).toBeLessThanOrEqual(1000);
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(4000);
    const context = setup();
    await context.finish(context.render('decoded.ipynb', content));
    expectPaged(context, content);
    expect(context.box.querySelector('.blk-cell, .blk-out, iframe')).toBeNull();
    expect(context.highlight.mock.calls.length).toBe(0);
  });

  it('applies the total decoded text budget before invoking Notebook libraries', async () => {
    const context = setup();
    const renderText = () => { context.box.textContent = 'plain text fallback'; return true; };
    const text = ('x'.repeat(3500) + '\n').repeat(10);
    const renderer = context.window.Blocks.rendererFor('/repo/total.ipynb');
    await context.finish(renderer(context.box, JSON.stringify({ cells: [codeCell([text]), codeCell([text])] }),
      { absPath: '/repo/total.ipynb' }, { readOnly: true, renderText }));
    expect(context.box.textContent).toBe('plain text fallback');
    expect(context.window.markdownit.mock.calls.length).toBe(0);
    expect(context.highlight.mock.calls.length).toBe(0);
  });

  it('shows bounded guidance when a standalone renderer has no text fallback callback', async () => {
    const context = setup();
    const renderer = context.window.Blocks.rendererFor('/repo/decoded.ipynb');
    await context.finish(renderer(context.box, JSON.stringify({ cells: [codeCell(fragments)] }),
      { absPath: '/repo/decoded.ipynb' }, { readOnly: true }));
    expect(context.box.querySelectorAll('.blk-cell, .blk-out, iframe')).toHaveLength(0);
    expect(context.box.textContent.length).toBeGreaterThan(0);
    expect(context.box.textContent.length).toBeLessThan(200);
    expect(context.highlight.mock.calls.length).toBe(0);
  });
});

describe('spreadsheet previews', () => {
  it.each([
    ['grid', () => sheet(101, 50)],
    ['text', () => sheet(20, 10, 'x'.repeat(400))],
    ['long cell', () => sheet(1, 1, 'x'.repeat(4001))],
  ])('offers download instead of mounting an oversized %s', async (_name, makeSheet) => {
    const context = setup({ sheets: [makeSheet()] });
    await context.finish(context.render('large.xlsx', null, { isXlsx: true }));
    expect(context.box.querySelector('table') === null).toBe(true);
    expect([...context.box.querySelectorAll('a,button')].some((node) => /下载/.test(node.textContent))).toBe(true);
  });

  it('clips a large merged range to the preview grid', async () => {
    const context = setup({ sheets: [sheet(2, 2, 'one merge', ['A1:GR1000'])] });
    await context.finish(context.render('merged.xlsx', null, { isXlsx: true }));
    const cell = context.box.querySelector('td');
    expect(cell.rowSpan).toBe(2);
    expect(cell.colSpan).toBe(2);
    expect(context.box.querySelectorAll('td')).toHaveLength(1);
  });

  it('renders each sheet only on its first activation', async () => {
    const first = sheet(), second = sheet();
    second.name = 'Second';
    const context = setup({ sheets: [first, second] });
    await context.finish(context.render('tabs.xlsx', null, { isXlsx: true }));
    expect(first.getRow).toHaveBeenCalled();
    expect(second.getRow).not.toHaveBeenCalled();
    const tabs = context.box.querySelectorAll('.fp-xlsx-tab');
    tabs[1].click();
    expect(second.getRow).toHaveBeenCalled();
    const secondTable = context.box.querySelectorAll('.fp-xlsx-pane')[1].querySelector('table');
    tabs[0].click(); tabs[1].click();
    expect(context.box.querySelectorAll('.fp-xlsx-pane')[1].querySelector('table')).toBe(secondTable);
  });

  it('exports unopened sheets without mounting their tables in the live preview', async () => {
    const first = sheet(2, 2, 'first sheet'), second = sheet(2, 2, 'unopened second sheet');
    second.name = 'Second';
    const context = setup({ sheets: [first, second], fetchImpl: xlsxFetch });
    await context.finish(context.preview.openFile('/repo/tabs.xlsx'));
    const liveSecond = context.window.document.querySelectorAll('.fp-body .fp-xlsx-pane')[1];
    expect(liveSecond.querySelector('table')).toBeNull();
    const exported = new JSDOM((await context.preview._test.buildStandaloneDoc()).html, { url: 'https://export.test/' });
    opened.push(exported.window);
    const exportedSecond = exported.window.document.querySelectorAll('.fp-xlsx-pane')[1];
    expect(exportedSecond.textContent).toContain('unopened second sheet');
    expect(exportedSecond.querySelectorAll('td')).toHaveLength(4);
    expect(liveSecond.querySelector('table')).toBeNull();
  });

  it('exports oversized sheet download guidance without live controls, tokens or local paths', async () => {
    const context = setup({ sheets: [sheet(101, 50)], fetchImpl: xlsxFetch });
    context.auth.wsTokenParam = () => 'token=xlsx-private-token';
    const path = '/private/workspace/internal-ledger.xlsx';
    await context.finish(context.preview.openFile(path));
    expect(context.window.document.querySelector('.fp-body .fp-error-download')).not.toBeNull();
    const snapshot = await context.preview._test.buildStandaloneDoc();
    const exported = new JSDOM(snapshot.html, { url: 'https://export.test/' });
    opened.push(exported.window);
    expect(exported.window.document.querySelector('.fp-error-download')).toBeNull();
    expect(exported.window.document.body.textContent).toContain('下载');
    expect(snapshot.html.includes('xlsx-private-token')).toBe(false);
    expect(snapshot.html.includes(path)).toBe(false);
    expect(snapshot.html.includes(encodeURIComponent(path))).toBe(false);
    expect(snapshot.html.includes('/api/files/raw')).toBe(false);
  });

  it('can draw an unopened sheet after the dock is hidden and restored', async () => {
    const first = sheet(2, 2, 'first sheet'), second = sheet(2, 2, 'restored second sheet');
    second.name = 'Second';
    const context = setup({ sheets: [first, second], fetchImpl: xlsxFetch });
    enableDock(context);
    await context.finish(context.preview.openFile('/repo/restored.xlsx'));
    context.window.document.querySelector('.fp-btn-placement').click();
    const secondPane = context.window.document.querySelectorAll('.fp-dock .fp-xlsx-pane')[1];
    expect(secondPane.querySelector('table')).toBeNull();
    context.preview.blockDock.hide();
    expect(context.window.document.querySelector('.fp-dock')).toBeNull();
    context.window.document.querySelector('.fp-dock-restore').click();
    context.window.document.querySelectorAll('.fp-dock .fp-xlsx-tab')[1].click();
    expect(secondPane.textContent).toContain('restored second sheet');
    expect(secondPane.querySelectorAll('td')).toHaveLength(4);
  });
});

describe('Mermaid preview lifetime', () => {
  it('finishes drawing after font readiness while its dock is hidden and restored', async () => {
    let fontsReady;
    const context = setup({ fetchImpl: async (url) => ({ status: 200, json: async () => ({ success: true, data:
      url.includes('/info?') ? { absPath: '/repo/graph.md', isText: true, isMarkdown: true, size: diagram.length, mtimeMs: 1 }
        : { content: diagram, language: 'markdown' },
    }) }) });
    Object.defineProperty(context.window.document, 'fonts', { value: {
      ready: new Promise((resolve) => { fontsReady = resolve; }),
    } });
    enableDock(context);
    await context.finish(context.preview.openFile('/repo/graph.md'));
    expect(context.window.document.querySelector('code.language-mermaid')).not.toBeNull();
    context.window.document.querySelector('.fp-btn-placement').click();
    context.preview.blockDock.hide();
    context.window.document.querySelector('.fp-dock-restore').click();
    fontsReady();
    await tick();
    expect(context.window.document.querySelector('.fp-dock .fp-mermaid-canvas svg')).not.toBeNull();
    context.window.document.querySelector('.fp-mermaid-open').click();
    expect(context.window.document.querySelector('.fp-mermaid-dialog')).not.toBeNull();
  });

  it('ignores a diagram result after the actual preview is disposed', async () => {
    let release;
    const context = setup();
    context.window.mermaid.render.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    await context.finish(context.render('graph.md', diagram, { isMarkdown: true }));
    const wrap = context.box.querySelector('.fp-md-wrap');
    expect(wrap.querySelector('.mermaid')).not.toBeNull();
    context.preview.disposeRendered(context.box);
    release({ svg: diagramSvg });
    await tick();
    expect(wrap.querySelector('svg')).toBeNull();
    expect(wrap.querySelector('.fp-mermaid-open')).toBeNull();
  });
});

describe('cancelled asynchronous file previews', () => {
  it.each([
    ['Markdown', 'small.md', '```json\n{}\n```', { isMarkdown: true }],
    ['Notebook', 'small.ipynb', notebook(), {}],
    ['patch', 'small.patch', patch('new'), {}],
  ])('does no late %s rendering after its box is replaced', async (_kind, name, content, info) => {
    const context = setup();
    const first = context.render(name, content, info);
    await tick();
    await context.render('new.png', null, { isImage: true });
    await expect(context.finish(first)).resolves.toBe(false);
    expect(context.window.markdownit).not.toHaveBeenCalled();
    expect(context.highlight).not.toHaveBeenCalled();
    expect(context.diffHtml).not.toHaveBeenCalled();
    expect(context.box.querySelector('img')).not.toBeNull();
  });

  it('invalidates a pending content read when the preview is disposed', async () => {
    let release;
    const context = setup();
    const pending = context.preview.renderInto(context.box, { name: '/repo/read.js', info: { isText: true },
      loadContent: () => new Promise((resolve) => { release = resolve; }),
    });
    await tick();
    context.preview.disposeRendered(context.box);
    release({ content: 'const n = 1;', language: 'javascript' });
    await expect(context.finish(pending)).resolves.toBe(false);
    expect(context.highlight).not.toHaveBeenCalled();
    expect(context.box.querySelector('code')).toBeNull();
  });

  it('does not parse an XLSX response that arrives after disposal', async () => {
    let release;
    const context = setup({ fetchImpl: () => new Promise((resolve) => { release = resolve; }) });
    const pending = context.render('late.xlsx', null, { isXlsx: true });
    await tick();
    context.preview.disposeRendered(context.box);
    release({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
    await expect(context.finish(pending)).resolves.toBe(false);
    expect(context.loadWorkbook).not.toHaveBeenCalled();
    expect(context.box.querySelector('table')).toBeNull();
  });

  it('shows a read-only Notebook without a run action for the file on disk', async () => {
    const context = setup();
    await context.finish(context.render('old.ipynb', notebook()));
    expect(context.box.querySelector('.blk-cell code').textContent).toBe('print(1)');
    expect([...context.box.querySelectorAll('button')].some((node) => /运行/.test(node.textContent))).toBe(false);
  });

  it('keeps the run action for an ordinary Notebook preview', async () => {
    const context = setup();
    const renderer = context.window.Blocks.rendererFor('/repo/current.ipynb');
    await context.finish(renderer(context.box, notebook(), { absPath: '/repo/current.ipynb' }, { readOnly: false }));
    expect(context.box.querySelector('.blk-cell code').textContent).toBe('print(1)');
    expect([...context.box.querySelectorAll('button')].some((node) => /运行/.test(node.textContent))).toBe(true);
  });
});
