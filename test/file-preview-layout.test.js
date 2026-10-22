import { describe, it, expect, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';

const source = fs.readFileSync('public/js/file-preview.js', 'utf8');
const appSource = fs.readFileSync('public/js/app.js', 'utf8');
const msAppSource = fs.readFileSync('public/js/ms-app.js', 'utf8');
const styles = fs.readFileSync('public/css/style.css', 'utf8');
const paletteSource = fs.readFileSync('public/js/command-palette.js', 'utf8');
const workspaceStyles = fs.readFileSync('public/css/workspace.css', 'utf8');

function createPreview({ storage = {}, missingPaths = [], context = ['local', '@0'], auth } = {}) {
  const dom = new JSDOM(
    '<!doctype html><body><div id="main-layout"><main id="content"><div class="terminal-view"></div></main></div></body>',
    { url: 'https://panel.test/' }
  );
  Object.defineProperty(dom.window, 'innerWidth', { value: 1440, configurable: true });
  Object.entries(storage).forEach(([key, value]) => dom.window.localStorage.setItem(key, value));

  const fetch = vi.fn((url) => {
    const parsed = new URL(String(url), 'https://panel.test/');
    const path = parsed.searchParams.get('path') || '/tmp';
    if (String(url).includes('/api/files/info')) {
      if (missingPaths.includes(path)) {
        return Promise.resolve({
          status: 404,
          json: () => Promise.resolve({ success: false, data: null, error: 'File not found' }),
        });
      }
      return Promise.resolve({
        status: 200,
        json: () => Promise.resolve({ success: true, data: { isDirectory: true, absPath: path, mtimeMs: 1, size: 0 } }),
      });
    }
    return Promise.resolve({
      status: 200,
      json: () => Promise.resolve({
        success: true,
        data: { absPath: path, parent: '/', entries: [], truncated: false },
      }),
    });
  });

  new Function('window', 'document', 'fetch', 'Auth', source)(dom.window, dom.window.document, fetch, auth);
  const preview = dom.window.FilePreview;
  if (context) preview.switchDockContext(context[0], context[1]);
  return { dom, preview, fetch };
}

function createLivePreview({ visible = false } = {}) {
  const dom = new JSDOM(
    '<!doctype html><body><div id="main-layout"><main id="content"><div class="terminal-view"></div></main></div></body>',
    { url: 'https://panel.test/' }
  );
  Object.defineProperty(dom.window, 'innerWidth', { value: 1440, configurable: true });
  let hidden = !visible;
  Object.defineProperty(dom.window.document, 'hidden', { get: () => hidden, configurable: true });

  let content = 'name,value\nbefore,1';
  let mtimeMs = 1000;
  let contentFetches = 0;
  let infoError = null;
  let contentFailures = 0;
  let timerId = 0;
  const timers = new Map();
  dom.window.setTimeout = (fn, delay) => {
    const id = ++timerId;
    timers.set(id, { fn, delay });
    return id;
  };
  dom.window.clearTimeout = (id) => timers.delete(id);

  const fetch = vi.fn((url) => {
    const text = String(url);
    if (text.includes('/api/files/info')) {
      if (infoError) {
        return Promise.resolve({
          status: infoError.status || 403,
          json: () => Promise.resolve({ success: false, data: null, error: infoError.message }),
        });
      }
      return Promise.resolve({
        status: 200,
        json: () => Promise.resolve({
          success: true,
          data: {
            absPath: '/tmp/live.csv', size: content.length, mtimeMs,
            isText: true, isImage: false, isPdf: false, isXlsx: false,
            isMarkdown: false, language: null,
          },
        }),
      });
    }
    if (text.includes('/api/files/content')) {
      contentFetches++;
      if (contentFailures > 0) {
        contentFailures--;
        return Promise.resolve({
          status: 500,
          json: () => Promise.resolve({ success: false, data: null, error: 'temporary read failure' }),
        });
      }
      return Promise.resolve({
        status: 200,
        json: () => Promise.resolve({ success: true, data: { content, language: null } }),
      });
    }
    if (text.startsWith('/api/share')) {
      return Promise.resolve({ ok:true, status:200, json:() => Promise.resolve({ success:true,
        data:text.includes('/lan-host') ? { host:'panel.test' } : { shares:[] } }) });
    }
    throw new Error('Unexpected fetch: ' + text);
  });

  new Function('window', 'document', 'fetch', source)(dom.window, dom.window.document, fetch);
  dom.window.FilePreview.switchDockContext('local', '@0');
  return {
    dom,
    preview: dom.window.FilePreview,
    fetch,
    setFile(next, nextMtime) { content = next; mtimeMs = nextMtime; },
    failNextContent() { contentFailures++; },
    setInfoError(message, status = 403) { infoError = { message, status }; },
    setHidden(next) { hidden = next; dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange')); },
    contentFetches: () => contentFetches,
    timers,
  };
}

function createDirectoryPreview() {
  const dom = new JSDOM(
    '<!doctype html><body><div id="main-layout"><main id="content"><div class="terminal-view"></div></main></div></body>',
    { url: 'https://panel.test/' }
  );
  Object.defineProperty(dom.window, 'innerWidth', { value: 1440, configurable: true });

  let rootEntries = [
    { name: 'child', type: 'dir', targetType: null, size: 0, mtime: 1000, isHidden: false },
    { name: 'note.txt', type: 'file', targetType: null, size: 1, mtime: 1000, isHidden: false },
  ];
  let listFetches = 0;
  let heldRoot = null;

  const response = (data) => Promise.resolve({
    status: 200,
    json: () => Promise.resolve({ success: true, data }),
  });
  const fetch = vi.fn((url) => {
    const parsed = new URL(String(url), 'https://panel.test/');
    const path = parsed.searchParams.get('path');
    if (parsed.pathname === '/api/files/info') {
      return response({ isDirectory: true, absPath: path, size: 64, mtimeMs: 1000 });
    }
    if (parsed.pathname === '/api/files/list') {
      listFetches++;
      if (path === '/root' && heldRoot) return heldRoot.promise;
      if (path === '/root/child') {
        return response({
          absPath: path, parent: '/root', truncated: false, totalCount: 1,
          entries: [{ name: 'inside.txt', type: 'file', targetType: null, size: 7, mtime: 2000, isHidden: false }],
        });
      }
      return response({
        absPath: '/root', parent: '/', entries: rootEntries,
        truncated: false, totalCount: rootEntries.length,
      });
    }
    throw new Error('Unexpected fetch: ' + String(url));
  });

  new Function('window', 'document', 'fetch', source)(dom.window, dom.window.document, fetch);
  return {
    dom,
    preview: dom.window.FilePreview,
    listFetches: () => listFetches,
    setNoteSize(size) { rootEntries = rootEntries.map((entry) => entry.name === 'note.txt' ? { ...entry, size, mtime: 3000 } : entry); },
    holdNextRootList() {
      let resolve;
      const promise = new Promise((done) => { resolve = (data) => done(response(data)); });
      heldRoot = { promise, resolve };
      return heldRoot;
    },
    releaseRootList(data) {
      const held = heldRoot;
      heldRoot = null;
      held.resolve(data);
    },
  };
}

function installPalette(dom) {
  const Router = { serialize: JSON.stringify, go: vi.fn() };
  dom.window.CommandPalette = new Function('window', 'document', 'Router', paletteSource + '; return CommandPalette;')(
    dom.window, dom.window.document, Router,
  );
  return { palette: dom.window.CommandPalette, go: Router.go };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function dockCurrent(dom) {
  dom.window.document.querySelector('[aria-label="在右侧分栏打开"]').click();
}

function openMore(dom) {
  const doc = dom.window.document;
  const trigger = doc.querySelector('.fp-overlay:not(.fp-dock) .fp-btn-more') || doc.querySelector('.fp-dock .fp-btn-more');
  trigger.click();
  return trigger;
}

function runPreviewAction(dom, label) {
  openMore(dom);
  const item = dom.window.document.querySelector('.fp-menu [aria-label="' + label + '"]');
  expect(item).not.toBeNull();
  item.click();
  return item;
}

describe('file preview dock tabs', () => {
  it('derives Mermaid colors from the current panel theme', () => {
    const { dom, preview } = createPreview();
    const root = dom.window.document.documentElement;
    root.style.setProperty('--bg-primary', '#ffffff');
    root.style.setProperty('--bg-deep', '#f0f2f5');
    root.style.setProperty('--bg-card', '#f6f8fa');
    root.style.setProperty('--bg-hover', '#eaeef2');
    root.style.setProperty('--border', '#d0d7de');
    root.style.setProperty('--border-subtle', '#e8ebef');
    root.style.setProperty('--text-primary', '#1f2328');
    root.style.setProperty('--text-secondary', '#59636e');
    root.style.setProperty('--accent-blue', '#0969da');

    expect(preview._test.mermaidThemeConfig()).toMatchObject({
      theme: 'base',
      themeVariables: {
        darkMode: false,
        background: '#ffffff',
        primaryColor: '#f6f8fa',
        primaryTextColor: '#1f2328',
        primaryBorderColor: '#0969da',
        clusterBkg: '#f0f2f5',
        clusterBorder: '#d0d7de',
        defaultLinkColor: '#0969da',
        edgeLabelBackground: '#ffffff',
      },
    });
  });

  it('rerenders open Mermaid diagrams when the panel theme changes', async () => {
    const { dom, preview } = createPreview();
    const embed = dom.window.document.createElement('div');
    embed.className = 'mermaid fp-mermaid-embed';
    embed.__fpMermaidSource = 'flowchart TD\nA-->B';
    embed.innerHTML = '<svg viewBox="0 0 400 200"><text>old</text></svg>';
    dom.window.document.body.appendChild(embed);

    dom.window.mermaid = {
      initialize: vi.fn(),
      render: vi.fn(() => Promise.resolve({
        svg: '<svg viewBox="0 0 640 320"><text>new</text></svg>',
      })),
    };
    dom.window.document.dispatchEvent(new dom.window.CustomEvent('tmux-theme-change'));
    await flush();

    expect(dom.window.mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({ theme: 'base' }));
    expect(dom.window.mermaid.render).toHaveBeenCalledWith(
      expect.stringContaining('fp-mmd-theme-'), 'flowchart TD\nA-->B'
    );
    expect(embed.querySelector('text').textContent).toBe('new');
    expect(embed.querySelector('.fp-mermaid-open')).not.toBeNull();
    expect(embed.getAttribute('data-fp-width')).toBe('640');
  });

  it('keeps wide Mermaid diagrams readable and opens the pan and zoom viewer', () => {
    const { dom, preview } = createPreview();
    const embed = dom.window.document.createElement('div');
    embed.className = 'mermaid';
    embed.innerHTML = '<svg viewBox="0 0 2000 600" width="100%" style="max-width: 2000px"></svg>';
    dom.window.document.body.appendChild(embed);

    expect(preview._test.prepareMermaid(embed)).toBe(true);
    const scroll = embed.querySelector('.fp-mermaid-scroll');
    Object.defineProperty(scroll, 'clientWidth', { value: 1000, configurable: true });
    preview._test.installMermaidInteractions(embed);

    const sourceSvg = embed.querySelector('svg');
    expect(sourceSvg.style.width).toBe('1500px');
    expect(sourceSvg.style.maxWidth).toBe('none');
    expect(embed.classList.contains('is-wide')).toBe(true);
    expect(embed.querySelector('[aria-label="放大查看 Mermaid 图表"]')).not.toBeNull();

    embed.querySelector('[aria-label="放大查看 Mermaid 图表"]').click();
    const dialog = dom.window.document.querySelector('.fp-mermaid-dialog');
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.querySelector('.fp-mermaid-percent').textContent).toBe('75%');

    dialog.querySelector('.fp-mermaid-zoom-in').click();
    expect(dialog.querySelector('.fp-mermaid-percent').textContent).toBe('90%');
    dialog.querySelector('.fp-mermaid-actual').click();
    expect(dialog.querySelector('.fp-mermaid-percent').textContent).toBe('100%');

    const viewport = dialog.querySelector('.fp-mermaid-dialog-viewport');
    viewport.dispatchEvent(new dom.window.WheelEvent('wheel', {
      bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100,
    }));
    expect(dialog.querySelector('.fp-mermaid-percent').textContent).toBe('112%');
    viewport.scrollLeft = 300;
    viewport.scrollTop = 100;
    viewport.dispatchEvent(new dom.window.MouseEvent('pointerdown', {
      bubbles: true, button: 0, clientX: 100, clientY: 80,
    }));
    dom.window.dispatchEvent(new dom.window.MouseEvent('pointermove', {
      bubbles: true, clientX: 40, clientY: 30,
    }));
    expect(viewport.scrollLeft).toBe(360);
    expect(viewport.scrollTop).toBe(150);
    dom.window.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true }));

    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true,
    }));
    expect(dom.window.document.querySelector('.fp-mermaid-dialog')).toBeNull();
  });

  it('exports a Mermaid diagram as a high-resolution PNG', async () => {
    const { dom, preview } = createPreview();
    const embed = dom.window.document.createElement('div');
    embed.className = 'mermaid';
    embed.setAttribute('data-fp-export-name', 'mermaid-diagram-2.png');
    embed.innerHTML = '<svg viewBox="0 0 1200 500"></svg>';
    dom.window.document.body.appendChild(embed);

    const drawImage = vi.fn();
    const fillRect = vi.fn();
    const getContext = vi.spyOn(dom.window.HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({ drawImage, fillRect, fillStyle: '' });
    const toBlob = vi.spyOn(dom.window.HTMLCanvasElement.prototype, 'toBlob')
      .mockImplementation(function (callback) {
        callback(new dom.window.Blob(['png'], { type: 'image/png' }));
      });
    dom.window.URL.createObjectURL = vi.fn().mockReturnValue('blob:mermaid-png');
    dom.window.URL.revokeObjectURL = vi.fn();
    dom.window.Image = class {
      set src(value) { this.onload(); }
    };
    let downloaded = '';
    const click = vi.spyOn(dom.window.HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function () { downloaded = this.download; });

    preview._test.prepareMermaid(embed);
    preview._test.installMermaidInteractions(embed);
    embed.querySelector('.fp-mermaid-open').click();
    dom.window.document.querySelector('.fp-mermaid-export').click();
    await flush();

    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 2400, 1000);
    expect(fillRect).toHaveBeenCalledWith(0, 0, 2400, 1000);
    expect(downloaded).toBe('mermaid-diagram-2.png');
    expect(dom.window.URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(dom.window.document.querySelector('.fp-mermaid-export').textContent).toBe('下载');

    getContext.mockRestore();
    toBlob.mockRestore();
    click.mockRestore();
  });

  it('restores Mermaid actions when canvas rendering throws', async () => {
    const { dom, preview } = createPreview();
    const embed = dom.window.document.createElement('div');
    embed.className = 'mermaid';
    embed.innerHTML = '<svg viewBox="0 0 400 200"></svg>';
    dom.window.document.body.appendChild(embed);

    const getContext = vi.spyOn(dom.window.HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({
        drawImage() { throw new Error('canvas failed'); },
        fillRect: vi.fn(),
        fillStyle: '',
      });
    dom.window.Image = class {
      set src(value) { this.onload(); }
    };
    dom.window.alert = vi.fn();

    preview._test.prepareMermaid(embed);
    preview._test.installMermaidInteractions(embed);
    embed.querySelector('.fp-mermaid-open').click();
    const exportButton = dom.window.document.querySelector('.fp-mermaid-export');
    exportButton.click();
    await flush();

    expect(exportButton.disabled).toBe(false);
    expect(exportButton.textContent).toBe('下载');
    expect(dom.window.alert).toHaveBeenCalledWith('下载失败: canvas failed');

    getContext.mockRestore();
  });

  it('copies a Mermaid PNG through the macOS clipboard bridge', async () => {
    const { dom, preview } = createPreview();
    const embed = dom.window.document.createElement('div');
    embed.className = 'mermaid';
    embed.innerHTML = '<svg viewBox="0 0 400 200"></svg>';
    dom.window.document.body.appendChild(embed);

    const postMessage = vi.fn();
    dom.window.webkit = {
      messageHandlers: { tmuxPanelClipboard: { postMessage } },
    };
    const getContext = vi.spyOn(dom.window.HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({ drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: '' });
    const toBlob = vi.spyOn(dom.window.HTMLCanvasElement.prototype, 'toBlob')
      .mockImplementation(function (callback) {
        callback(new dom.window.Blob(['png'], { type: 'image/png' }));
      });
    dom.window.URL.createObjectURL = vi.fn().mockReturnValue('blob:mermaid-svg');
    dom.window.URL.revokeObjectURL = vi.fn();
    dom.window.Image = class {
      set src(value) { this.onload(); }
    };
    dom.window.FileReader = class {
      readAsDataURL() {
        this.result = 'data:image/png;base64,cG5n';
        this.onload();
      }
    };

    preview._test.prepareMermaid(embed);
    preview._test.installMermaidInteractions(embed);
    embed.querySelector('.fp-mermaid-open').click();
    const copyButton = dom.window.document.querySelector('.fp-mermaid-copy');
    copyButton.click();
    await flush();

    expect(postMessage).toHaveBeenCalledWith({ pngBase64: 'cG5n' });
    expect(copyButton.disabled).toBe(false);
    expect(copyButton.textContent).toBe('已复制');

    getContext.mockRestore();
    toBlob.mockRestore();
  });

  it('closes an open Mermaid viewer when its preview is disposed', () => {
    const { dom, preview } = createPreview();
    const root = dom.window.document.createElement('div');
    root.innerHTML = '<div class="mermaid"><svg viewBox="0 0 1200 500"></svg></div>';
    dom.window.document.body.appendChild(root);
    const embed = root.querySelector('.mermaid');

    preview._test.prepareMermaid(embed);
    preview._test.installMermaidInteractions(root);
    embed.querySelector('.fp-mermaid-open').click();
    expect(dom.window.document.querySelector('.fp-mermaid-dialog')).not.toBeNull();

    preview._test.disposeMermaid(root);
    expect(dom.window.document.querySelector('.fp-mermaid-dialog')).toBeNull();
    expect(embed.__fpMermaidBound).toBe(false);
  });

  it('ships the Mermaid interaction runtime with standalone HTML previews', () => {
    const { preview } = createPreview();
    const runtime = preview._test.mermaidStandaloneScript();
    expect(runtime).toContain('fp-mermaid-dialog');
    expect(runtime).toContain('fp-mermaid-export');
    expect(runtime).toContain('fp-mermaid-copy');
    expect(runtime).toContain('ResizeObserver');
    expect(runtime).toContain('Ctrl');

    const standalone = new JSDOM('<!doctype html><body>'
      + '<div class="fp-mermaid-embed" data-fp-width="1600" data-fp-height="500">'
      + '<div class="fp-mermaid-scroll"><div class="fp-mermaid-canvas">'
      + '<svg viewBox="0 0 1600 500"></svg></div></div>'
      + '<button class="fp-mermaid-open">open</button></div></body>');
    const js = runtime.replace(/^<script>/, '').replace(/<\/script>$/, '');
    new Function('window', 'document', js)(standalone.window, standalone.window.document);
    standalone.window.document.querySelector('.fp-mermaid-open').click();
    expect(standalone.window.document.querySelector('.fp-mermaid-dialog')).not.toBeNull();
  });

  it('renders Obsidian heading wikilinks as safe in-document anchors', () => {
    const { preview } = createPreview();
    expect(preview._test.markdownHeadingSlug('1. 设计目标')).toBe('1-设计目标');
    expect(preview._test.markdownHeadingSlug('References')).toBe('references');

    const direct = preview._test.wikilinkHtml('#1. 设计目标', '#1. 设计目标', false);
    expect(direct).toContain('class="fp-wikilink fp-wikilink-heading"');
    expect(direct).toContain('href="#1-设计目标"');
    expect(direct).toContain('data-fp-heading-target="1. 设计目标"');
    expect(direct).toContain('>1. 设计目标</a>');

    const alias = preview._test.wikilinkHtml('#1. 设计目标', '开始阅读', true);
    expect(alias).toContain('>开始阅读</a>');
    expect(preview._test.wikilinkHtml('#目标', '<img src=x onerror=alert(1)>', true))
      .not.toContain('<img');

    const fileLink = preview._test.wikilinkHtml('other.md', '其他文档', true);
    expect(fileLink).toContain('class="fp-wikilink fp-wikilink-file"');
    expect(fileLink).toContain('href="other.md"');
    expect(fileLink).toContain('>其他文档</a>');
    expect(preview._test.wikilinkHtml('notes/bare', 'x', true)).toContain('href="notes/bare.md"');
    expect(preview._test.wikilinkHtml('other.md#sec', 'x', true)).toContain('href="other.md#sec"');
    expect(preview._test.wikilinkHtml('o.md', '<img src=x onerror=alert(1)>', true))
      .not.toContain('<img src=x');
  });

  it('opens Obsidian file wikilinks through the shared link handler', async () => {
    const { dom, preview, fetch } = createPreview();
    const wrap = dom.window.document.createElement('div');
    wrap.className = 'fp-md-wrap';
    wrap.innerHTML = preview._test.wikilinkHtml('sibling.md', '兄弟', true);
    dom.window.document.body.appendChild(wrap);
    preview._test.prepareMarkdownNavigation(wrap, '/notes/current.md', '%1');

    wrap.querySelector('a').click();
    await flush();

    const infoCalls = fetch.mock.calls.map((c) => String(c[0]))
      .filter((u) => u.includes('/api/files/info'));
    expect(infoCalls.some((u) => u.includes(encodeURIComponent('/notes/sibling.md')))).toBe(true);
  });

  it('resolves Markdown links against the current file, not the panel URL', () => {
    const { preview } = createPreview();
    const resolve = preview._test.resolveMarkdownHref;
    const sourcePath = '/Users/me/notes/current.md';

    expect(resolve(sourcePath, '#设计目标')).toEqual({ kind: 'heading', headingRef: '设计目标' });
    expect(resolve(sourcePath, 'next.md')).toEqual({
      kind: 'file', path: '/Users/me/notes/next.md', headingRef: null,
    });
    expect(resolve(sourcePath, '../research/%E4%B8%AA%E4%BA%BA.md?raw=1#%E9%AA%8C%E6%94%B6')).toEqual({
      kind: 'file', path: '/Users/me/research/个人.md', headingRef: '验收',
    });
    expect(resolve(sourcePath, 'current.md#References')).toEqual({ kind: 'heading', headingRef: 'References' });
    expect(resolve(sourcePath, 'https://example.com/doc')).toEqual({ kind: 'web', href: 'https://example.com/doc' });
    expect(resolve(sourcePath, '//example.com/doc')).toEqual({ kind: 'web', href: 'https://example.com/doc' });
    ['javascript:alert(1)', 'data:text/html,x', 'file:///tmp/x', 'blob:https://panel.test/x', 'bad%zz.md']
      .forEach((href) => expect(resolve(sourcePath, href)).toEqual({ kind: 'blocked' }));
  });

  it('opens relative Markdown links in FilePreview and never changes the page URL', async () => {
    const { dom, preview, fetch } = createPreview();
    const wrap = dom.window.document.createElement('div');
    wrap.innerHTML = '<a class="nested" href="../research/%E4%B8%AA%E4%BA%BA.md#%E9%AA%8C%E6%94%B6"><span>打开</span></a>'
      + '<a class="missing" href="#missing">missing</a>';
    dom.window.document.body.appendChild(wrap);
    preview._test.prepareMarkdownNavigation(wrap, '/Users/me/notes/current.md', '%42');
    const before = dom.window.location.href;

    const click = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
    wrap.querySelector('.nested span').dispatchEvent(click);
    await flush();
    expect(click.defaultPrevented).toBe(true);
    const infoURL = String(fetch.mock.calls.find(([url]) => String(url).includes('/api/files/info'))[0]);
    expect(new URL(infoURL, 'https://panel.test').searchParams.get('path')).toBe('/Users/me/research/个人.md');
    expect(new URL(infoURL, 'https://panel.test').searchParams.get('paneId')).toBe('%42');
    expect(dom.window.location.href).toBe(before);

    const missing = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
    wrap.querySelector('.missing').dispatchEvent(missing);
    expect(missing.defaultPrevented).toBe(true);
    expect(dom.window.location.href).toBe(before);
  });

  it('routes external Markdown links out and blocks unsafe schemes', () => {
    const { dom, preview } = createPreview();
    const opened = vi.fn();
    dom.window.open = opened;
    const wrap = dom.window.document.createElement('div');
    wrap.innerHTML = '<a class="web" href="https://example.com/docs">web</a>'
      + '<a class="unsafe" href="javascript:alert(1)">unsafe</a>';
    dom.window.document.body.appendChild(wrap);
    preview._test.prepareMarkdownNavigation(wrap, '/Users/me/notes/current.md', '%1');

    const webClick = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
    wrap.querySelector('.web').dispatchEvent(webClick);
    expect(webClick.defaultPrevented).toBe(true);
    expect(opened).toHaveBeenCalledWith('https://example.com/docs', '_blank', 'noopener');

    const unsafeClick = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
    wrap.querySelector('.unsafe').dispatchEvent(unsafeClick);
    expect(unsafeClick.defaultPrevented).toBe(true);
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it('jumps both Obsidian and standard Markdown anchors to generated heading ids', () => {
    const { dom, preview } = createPreview();
    const wrap = dom.window.document.createElement('div');
    wrap.innerHTML = '<a class="fp-wikilink-heading" href="#1-设计目标" data-fp-heading-target="1. 设计目标">设计目标</a>'
      + '<a href="#references">引用</a>'
      + '<h2>1. 设计目标</h2><h2>1. 设计目标</h2><h2>References</h2>';
    dom.window.document.body.appendChild(wrap);
    const headings = wrap.querySelectorAll('h2');
    const firstScroll = vi.fn();
    const referencesScroll = vi.fn();
    headings[0].scrollIntoView = firstScroll;
    headings[2].scrollIntoView = referencesScroll;

    preview._test.prepareMarkdownNavigation(wrap);
    expect(Array.from(headings).map((heading) => heading.id))
      .toEqual(['1-设计目标', '1-设计目标-1', 'references']);
    expect(Array.from(headings).every((heading) => heading.getAttribute('tabindex') === '-1')).toBe(true);

    wrap.querySelector('.fp-wikilink-heading').click();
    expect(firstScroll).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    wrap.querySelector('a[href="#references"]').click();
    expect(referencesScroll).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
  });

  it('opens files as modals first, then docks the current preview as a tab', async () => {
    const { dom, preview } = createPreview();
    preview.openFile('/tmp/one.md', '%1');
    await flush();

    const modalOverlay = dom.window.document.querySelector('.fp-overlay');
    expect(modalOverlay.classList.contains('fp-side')).toBe(false);
    expect(dom.window.document.querySelector('.fp-dock-tabs')).toBeNull();

    dockCurrent(dom);
    const dock = dom.window.document.querySelector('.fp-dock');
    expect(dock).not.toBeNull();
    expect(dock.parentElement.id).toBe('main-layout');
    expect(dom.window.document.body.classList.contains('fp-side-open')).toBe(true);
    expect(dock.querySelectorAll('.fp-dock-tab-item')).toHaveLength(1);
    expect(dock.querySelector('.fp-dock-tab').textContent).toBe('one.md');
  });

  it('docks into the visible multi-server terminal shell', async () => {
    const dom = new JSDOM(
      '<!doctype html><body><div id="legacy-shell" hidden><div id="main-layout"></div></div>'
      + '<div class="ms-app mode-terminal"><main class="ms-main"><header class="ms-topbar"></header>'
      + '<div class="ms-content terminal-mode"><section class="terminal-stage">'
      + '<div class="terminal-view"></div></section></div></main></div></body>',
      { url: 'https://panel.test/' },
    );
    Object.defineProperty(dom.window, 'innerWidth', { value: 1440, configurable: true });
    const fetch = vi.fn((url) => Promise.resolve({
      status: 200,
      json: () => Promise.resolve(String(url).includes('/api/files/info')
        ? { success: true, data: { isDirectory: true, absPath: '/tmp/one.md', mtimeMs: 1, size: 0 } }
        : { success: true, data: { absPath: '/tmp/one.md', parent: '/', entries: [], truncated: false } }),
    }));
    new Function('window', 'document', 'fetch', source)(dom.window, dom.window.document, fetch);
    dom.window.FilePreview.switchDockContext('local', '@0');
    dom.window.FilePreview.openFile('/tmp/one.md', '%1');
    await flush();
    dockCurrent(dom);

    expect(dom.window.document.querySelector('.fp-dock').parentElement)
      .toBe(dom.window.document.querySelector('.ms-main'));
    expect(dom.window.document.querySelector('#main-layout .fp-dock')).toBeNull();
    expect(styles).toMatch(/\.ms-app\.mode-terminal \.fp-dock\s*\{[\s\S]*?grid-column:\s*2;[\s\S]*?grid-row:\s*1 \/ 3/);
  });

  it('keeps only four toolbar controls and exposes low-frequency operations as named menu actions', async () => {
    const { dom, preview } = createPreview();
    await preview.openFile('/tmp/one.md', '%1');
    const doc = dom.window.document;
    const overlay = doc.querySelector('.fp-overlay');
    expect(Array.from(overlay.querySelectorAll('.fp-actions > button')).map((b) => b.getAttribute('aria-label')))
      .toEqual(['刷新预览', '在右侧分栏打开', '更多文件操作', '关闭预览']);
    ['返回上级目录', '刷新预览', '在右侧分栏打开', '更多文件操作', '关闭预览'].forEach((label) => {
      const button = overlay.querySelector(`[aria-label="${label}"]`);
      expect(button.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
      expect(button.title).not.toBe(''); expect(button.type).toBe('button');
    });
    const trigger = doc.querySelector('.fp-btn-more');
    expect(trigger.textContent).toBe('更多');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    // This fixture is a directory: content-only commands must not be offered.
    openMore(dom);
    expect(Array.from(doc.querySelectorAll('.fp-menu-label')).map((e) => e.textContent)).toEqual(['最大化预览']);
    doc.querySelector('.fp-menu [aria-label="最大化预览"]').click();
    expect(overlay.querySelector('.fp-modal').classList.contains('fp-maximized')).toBe(true);
    expect(doc.activeElement).toBe(trigger);
    runPreviewAction(dom, '恢复预览');
    expect(overlay.querySelector('.fp-modal').classList.contains('fp-maximized')).toBe(false);
    dockCurrent(dom);
    const placement = doc.querySelector('[aria-label="隐藏右侧预览"]');
    expect(placement.getAttribute('aria-pressed')).toBe('true');
    expect(doc.querySelector('.fp-dock .fp-title').textContent).toBe('/tmp/one.md');
    expect(doc.querySelector('.fp-dock-tab').textContent).toBe('one.md');
    preview.closeDocked(); dom.window.close();
  });

  it('keeps the full current directory title and shows only the parent path for docked files', async () => {
    const directory = createPreview();
    await directory.preview.openFile('/root/child', '%1'); dockCurrent(directory.dom);
    expect(directory.dom.window.document.querySelector('.fp-title').textContent).toBe('/root/child');
    directory.preview.closeDocked(); directory.dom.window.close();
    const file = createLivePreview();
    await file.preview.openFile('/tmp/live.csv', '%1');
    expect(file.dom.window.document.querySelector('.fp-title').textContent).toBe('/tmp/live.csv');
    dockCurrent(file.dom);
    expect(file.dom.window.document.querySelector('.fp-title').textContent).toBe('/tmp');
    expect(file.dom.window.document.querySelector('.fp-title').title).toBe('/tmp/live.csv');
    file.preview.closeDocked(); file.dom.window.close();
  });

  it('owns share-dialog focus and Escape without closing the file or generating a share', async () => {
    const live = createLivePreview();
    const { dom, preview, fetch } = live;
    const doc = dom.window.document;
    await preview.openFile('/tmp/live.csv', '%1');
    preview._test.setLanHost('panel.test');
    fetch.mockResolvedValueOnce({ ok:true, status:200, json:() => Promise.resolve({ success:true,
      data:{ shares:[{ id:'existing-demo', filename:'演示.csv', expiresAt:Date.now() + 1000 }] } }) });
    runPreviewAction(dom, '生成内网分享链接'); await flush();
    const share = doc.querySelector('.fp-share-box');
    expect(share.getAttribute('role')).toBe('dialog');
    expect(share.getAttribute('aria-modal')).toBe('true');
    expect(doc.activeElement).toBe(share.querySelector('#fpShareCancel'));
    const copy = share.querySelector('[data-act="copy"]');
    doc.execCommand = vi.fn(() => {
      expect(doc.activeElement.tagName).toBe('TEXTAREA');
      expect(share.contains(doc.activeElement)).toBe(true);
      return true;
    });
    copy.focus(); copy.click();
    expect(doc.execCommand).toHaveBeenCalledWith('copy');
    expect(doc.activeElement).toBe(copy);
    const first = share.querySelector('#fpShareTtl'), last = share.querySelector('[data-act="revoke"]');
    last.focus(); last.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key:'Tab', bubbles:true, cancelable:true }));
    expect(doc.activeElement).toBe(first);
    first.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key:'Tab', shiftKey:true, bubbles:true, cancelable:true }));
    expect(doc.activeElement).toBe(last);
    doc.querySelector('.fp-btn-close').focus();
    expect(doc.activeElement).toBe(share.querySelector('#fpShareCancel'));
    doc.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key:'Escape', bubbles:true, cancelable:true }));
    expect(doc.querySelector('.fp-share-overlay')).toBeNull();
    expect(doc.querySelector('.fp-modal')).not.toBeNull();
    expect(doc.activeElement).toBe(doc.querySelector('.fp-btn-more'));
    preview.close();
    const outside = doc.createElement('button'); doc.body.appendChild(outside); outside.focus();
    expect(doc.activeElement).toBe(outside); // No stale share focus listener.
    expect(fetch.mock.calls.every(([, options]) => !options || !options.method || options.method === 'GET')).toBe(true);
    dom.window.close();
  });

  it('yields share-dialog focus to the palette and disposes it on navigation while retaining dock state', async () => {
    const live = createLivePreview();
    const { dom, preview, fetch } = live;
    const doc = dom.window.document;
    const { palette } = installPalette(dom);
    await preview.openFile('/tmp/live.csv', '%1'); dockCurrent(dom);
    const dock = doc.querySelector('.fp-dock');
    runPreviewAction(dom, '生成内网分享链接'); await flush();
    const cancel = doc.querySelector('#fpShareCancel');
    palette.open(cancel);
    expect(doc.activeElement).toBe(doc.querySelector('.cmd-palette-input'));
    doc.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key:'Escape', bubbles:true, cancelable:true }));
    expect(doc.querySelector('.fp-share-overlay')).not.toBeNull();
    expect(doc.activeElement).toBe(cancel);
    palette.open(cancel);
    const input = doc.querySelector('.cmd-palette-input');
    input.value='设置'; input.dispatchEvent(new dom.window.Event('input', { bubbles:true }));
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key:'Enter', bubbles:true, cancelable:true }));
    expect(doc.querySelector('.fp-share-overlay')).toBeNull();
    expect(doc.querySelector('.fp-dock')).toBe(dock);
    runPreviewAction(dom, '生成内网分享链接'); await flush();
    preview.closeDocked();
    expect(doc.querySelector('.fp-share-overlay')).toBeNull();
    expect(doc.querySelector('.fp-dock')).toBeNull();
    expect(fetch.mock.calls.every(([, options]) => !options || !options.method || options.method === 'GET')).toBe(true);
    dom.window.close();
  });

  it('uses one keyboard-accessible more menu for file operations without nested menu anchors', async () => {
    const { dom, preview } = createLivePreview();
    await preview.openFile('/tmp/live.csv', '%1');
    const doc = dom.window.document;
    const trigger = openMore(dom);
    const menu = doc.querySelector('.fp-menu');
    expect(menu.parentElement).toBe(doc.body);
    expect(menu.getAttribute('aria-label')).toBe('更多文件操作');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(Array.from(menu.querySelectorAll('.fp-menu-label')).map((el) => el.textContent))
      .toEqual(['最大化预览', '在新标签页打开', '带格式复制', '不带格式复制', '生成内网分享链接', '下载原文件', '导出渲染后的 HTML']);
    const press = (key) => doc.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles:true, cancelable:true }));
    expect(doc.activeElement.getAttribute('aria-label')).toBe('最大化预览');
    press('ArrowDown'); expect(doc.activeElement.getAttribute('aria-label')).toBe('在新标签页打开');
    press('End'); expect(doc.activeElement.getAttribute('aria-label')).toBe('导出渲染后的 HTML');
    press('Home'); expect(doc.activeElement.getAttribute('aria-label')).toBe('最大化预览');
    press('Escape');
    expect(doc.querySelector('.fp-menu')).toBeNull();
    expect(doc.querySelector('.fp-overlay')).not.toBeNull();
    expect(doc.activeElement).toBe(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    openMore(dom);
    // Clicking the visible text, rather than the button box, still toggles once.
    trigger.querySelector('span').dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles:true }));
    trigger.querySelector('span').click();
    expect(doc.querySelector('.fp-menu')).toBeNull();
    openMore(dom); press('Tab');
    expect(doc.querySelector('.fp-menu')).toBeNull(); expect(doc.activeElement).toBe(trigger);
    expect(doc.querySelectorAll('.fp-btn-copy,.fp-btn-download')).toHaveLength(0);
    preview.close(); dom.window.close();
  });

  it('copies the full preview text with or without formatting', async () => {
    const live = createLivePreview();
    live.preview.openFile('/tmp/live.csv', '%1');
    await flush();

    const win = live.dom.window;
    const doc = win.document;
    const writeText = vi.fn(() => Promise.resolve());
    const write = vi.fn(() => Promise.resolve());
    Object.defineProperty(win.navigator, 'clipboard', {
      value: { writeText, write }, configurable: true,
    });

    openMore(live.dom);
    const items = doc.querySelectorAll('.fp-menu .fp-menu-item');
    expect(items).toHaveLength(7);

    // No ClipboardItem in this environment: degrade to plain text, never fail.
    doc.querySelector('.fp-menu [aria-label="带格式复制"]').click();
    await flush();
    expect(write).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith('name,value\nbefore,1');
    expect(doc.querySelector('.fp-menu')).toBeNull();

    win.ClipboardItem = class ClipboardItem {
      constructor(flavours) { this.flavours = flavours; }
    };
    runPreviewAction(live.dom, '带格式复制');
    await flush();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    const flavours = write.mock.calls[0][0][0].flavours;
    expect(Object.keys(flavours).sort()).toEqual(['text/html', 'text/plain']);
    expect(await flavours['text/html'].text()).toContain('<table class="fp-xlsx-table"');
    expect(await flavours['text/plain'].text()).toBe('name,value\nbefore,1');
    runPreviewAction(live.dom, '不带格式复制');
    await flush();
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenLastCalledWith('name,value\nbefore,1');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('keeps the dock open while a second file opens in a modal, then adds a tab', async () => {
    const { dom, preview } = createPreview();
    preview.openFile('/tmp/one.md', '%1');
    await flush();
    dockCurrent(dom);

    preview.openFile('/tmp/two.md', '%2');
    await flush();
    expect(dom.window.document.querySelector('.fp-dock')).not.toBeNull();
    const modal = Array.from(dom.window.document.querySelectorAll('.fp-overlay'))
      .find((el) => !el.classList.contains('fp-dock'));
    expect(modal).not.toBeNull();
    expect(modal.classList.contains('fp-side')).toBe(false);

    modal.querySelector('[aria-label="在右侧分栏打开"]').click();
    const dock = dom.window.document.querySelector('.fp-dock');
    expect(dock.querySelectorAll('.fp-dock-tab-item')).toHaveLength(2);
    expect(Array.from(dock.querySelectorAll('.fp-dock-tab')).map((el) => el.textContent))
      .toEqual(['one.md', 'two.md']);
    expect(dock.querySelector('.fp-dock-tab-item.active .fp-dock-tab').textContent).toBe('two.md');
  });

  it('switches and closes tabs without destroying the dock', async () => {
    const { dom, preview } = createPreview();
    preview.openFile('/tmp/one.md', '%1'); await flush(); dockCurrent(dom);
    preview.openFile('/tmp/two.md', '%2'); await flush();
    Array.from(dom.window.document.querySelectorAll('.fp-overlay'))
      .find((el) => !el.classList.contains('fp-dock'))
      .querySelector('[aria-label="在右侧分栏打开"]').click();

    const dock = dom.window.document.querySelector('.fp-dock');
    dock.querySelectorAll('.fp-dock-tab')[0].click();
    expect(dock.querySelector('.fp-dock-tab-item.active .fp-dock-tab').textContent).toBe('one.md');

    dock.querySelector('[aria-label="关闭 one.md"]').click();
    expect(dock.querySelectorAll('.fp-dock-tab-item')).toHaveLength(1);
    expect(dock.querySelector('.fp-dock-tab').textContent).toBe('two.md');
  });

  it('removes the dock after the last tab closes', async () => {
    const { dom, preview } = createPreview();
    preview.openFile('/tmp/one.md', '%1'); await flush(); dockCurrent(dom);

    dom.window.document.querySelector('[aria-label="关闭 one.md"]').click();
    expect(dom.window.document.querySelector('.fp-dock')).toBeNull();
    expect(dom.window.document.querySelector('[aria-label="展开右侧文件预览"]')).toBeNull();
    expect(dom.window.document.body.classList.contains('fp-side-open')).toBe(false);
    expect(dom.window.localStorage.getItem(preview._test.dockStateKey('local', '@0'))).toBeNull();
  });

  it('hides and restores the entire dock while retaining tabs', async () => {
    const { dom, preview } = createPreview();
    preview.openFile('/tmp/one.md', '%1'); await flush(); dockCurrent(dom);

    dom.window.document.querySelector('[aria-label="隐藏右侧预览"]').click();
    expect(dom.window.document.querySelector('.fp-dock')).toBeNull();
    expect(dom.window.document.body.classList.contains('fp-side-open')).toBe(false);
    const restore = dom.window.document.querySelector('[aria-label="展开右侧文件预览"]');
    expect(restore).not.toBeNull();
    expect(restore.textContent).toContain('1');

    restore.click();
    const dock = dom.window.document.querySelector('.fp-dock');
    expect(dock).not.toBeNull();
    expect(dock.querySelectorAll('.fp-dock-tab-item')).toHaveLength(1);
  });

  it('restores persisted tabs, active tab and width after a page reload', async () => {
    const first = createPreview();
    first.preview.openFile('/tmp/one.md', '%1'); await flush(); dockCurrent(first.dom);
    first.preview.openFile('/tmp/two.md', '%2'); await flush();
    Array.from(first.dom.window.document.querySelectorAll('.fp-overlay'))
      .find((el) => !el.classList.contains('fp-dock'))
      .querySelector('[aria-label="在右侧分栏打开"]').click();
    first.dom.window.document.querySelectorAll('.fp-dock-tab')[0].click();

    const key = first.preview._test.dockStateKey('local', '@0');
    const saved = JSON.parse(first.dom.window.localStorage.getItem(key));
    saved.width = 510;
    const serialized = JSON.stringify(saved);
    expect(saved.tabs.map((tab) => tab.path)).toEqual(['/tmp/one.md', '/tmp/two.md']);
    expect(saved.activePath).toBe('/tmp/one.md');
    expect(saved.hidden).toBe(false);

    const reloaded = createPreview({ storage: { [key]: serialized } });
    expect(await reloaded.preview.restoreDocked()).toBe(true);

    const dock = reloaded.dom.window.document.querySelector('.fp-dock');
    expect(dock).not.toBeNull();
    expect(Array.from(dock.querySelectorAll('.fp-dock-tab')).map((el) => el.textContent))
      .toEqual(['one.md', 'two.md']);
    expect(dock.querySelector('.fp-dock-tab-item.active .fp-dock-tab').textContent).toBe('one.md');
    expect(dock.style.width).toBe('510px');
    expect(dock.classList.contains('fp-restoring')).toBe(false);
  });

  it('restores a hidden dock as a collapsed button after reopening the browser', async () => {
    const first = createPreview();
    first.preview.openFile('/tmp/one.md', '%1'); await flush(); dockCurrent(first.dom);
    first.preview.openFile('/tmp/two.md', '%2'); await flush();
    Array.from(first.dom.window.document.querySelectorAll('.fp-overlay'))
      .find((el) => !el.classList.contains('fp-dock'))
      .querySelector('[aria-label="在右侧分栏打开"]').click();
    first.dom.window.document.querySelector('[aria-label="隐藏右侧预览"]').click();

    const key = first.preview._test.dockStateKey('local', '@0');
    const serialized = first.dom.window.localStorage.getItem(key);
    expect(JSON.parse(serialized).hidden).toBe(true);

    const reopened = createPreview({ storage: { [key]: serialized } });
    expect(await reopened.preview.restoreDocked()).toBe(true);
    expect(reopened.dom.window.document.querySelector('.fp-dock')).toBeNull();
    const restore = reopened.dom.window.document.querySelector('[aria-label="展开右侧文件预览"]');
    expect(restore).not.toBeNull();
    expect(restore.textContent).toContain('2');

    restore.click();
    expect(reopened.dom.window.document.querySelector('.fp-dock')).not.toBeNull();
    expect(JSON.parse(reopened.dom.window.localStorage.getItem(key)).hidden).toBe(false);
  });

  it('keeps a replacement tmux window from restoring the dock at its reused index', async () => {
    const reusedIndex = 1;
    const { dom, preview } = createPreview({ context: ['local', '@41'] });
    preview.openFile('/tmp/window-one.md', '%1'); await flush(); dockCurrent(dom);
    const firstKey = preview._test.dockStateKey('local', '@41');
    dom.window.document.querySelector('.fp-dock').style.flexBasis = '410px';
    dom.window.document.querySelector('.fp-dock').style.width = '410px';
    preview._test.persistDockState(410);
    dom.window.document.querySelector('[aria-label="隐藏右侧预览"]').click();

    // tmux can reuse this display index after @41 is closed, but @42 is new.
    expect(reusedIndex).toBe(1);
    expect(await preview.switchDockContext('local', '@42')).toBe(false);
    expect(dom.window.document.querySelector('.fp-dock')).toBeNull();
    expect(JSON.parse(dom.window.localStorage.getItem(firstKey)).tabs[0].path)
      .toBe('/tmp/window-one.md');

    preview.openFile('/tmp/window-two.md', '%2'); await flush(); dockCurrent(dom);
    const secondKey = preview._test.dockStateKey('local', '@42');
    dom.window.document.querySelector('.fp-dock').style.flexBasis = '650px';
    dom.window.document.querySelector('.fp-dock').style.width = '650px';
    preview._test.persistDockState(650);
    expect(secondKey).not.toBe(firstKey);

    expect(await preview.switchDockContext('local', '@41')).toBe(true);
    expect(dom.window.document.querySelector('.fp-dock')).toBeNull();
    dom.window.document.querySelector('[aria-label="展开右侧文件预览"]').click();
    expect(dom.window.document.querySelector('.fp-dock-tab').textContent).toBe('window-one.md');
    expect(dom.window.document.querySelector('.fp-dock').style.width).toBe('410px');

    expect(await preview.switchDockContext('local', '@42')).toBe(true);
    expect(dom.window.document.querySelector('.fp-dock-tab').textContent).toBe('window-two.md');
    expect(dom.window.document.querySelector('.fp-dock').style.width).toBe('650px');

    expect(await preview.switchDockContext(null, null)).toBe(false);
    expect(dom.window.document.querySelector('.fp-dock')).toBeNull();
    expect(await preview.switchDockContext('local', '@42')).toBe(true);
    expect(dom.window.document.querySelector('.fp-dock-tab').textContent).toBe('window-two.md');
  });

  it('does not carry a dock across servers that share an SSH window ID', async () => {
    const { dom, preview } = createPreview({ context: ['local', 'win_1'] });
    preview.openFile('/tmp/local-only.md', '%1'); await flush(); dockCurrent(dom);
    expect(dom.window.document.querySelector('.fp-dock-tab').textContent).toBe('local-only.md');

    expect(await preview.switchDockContext('api-linux', 'win_1')).toBe(false);
    expect(dom.window.document.querySelector('.fp-dock')).toBeNull();
    expect(dom.window.document.querySelector('[aria-label="展开右侧文件预览"]')).toBeNull();
    expect(preview._test.dockStateKey('api-linux', 'win_1'))
      .not.toBe(preview._test.dockStateKey('local', 'win_1'));

    expect(await preview.switchDockContext('local', 'win_1')).toBe(true);
    expect(dom.window.document.querySelector('.fp-dock-tab').textContent).toBe('local-only.md');
  });

  it('migrates the previous global dock snapshot into the first active window', async () => {
    const legacyKey = 'tmux_file_preview_dock_v1';
    const legacy = JSON.stringify({
      version: 1, tabs: [{ path: '/tmp/legacy.md', paneId: '%1' }],
      activePath: '/tmp/legacy.md', hidden: false, width: 470,
    });
    const migrated = createPreview({
      storage: { [legacyKey]: legacy }, context: ['local', '@3'],
    });

    expect(await migrated.preview.restoreDocked()).toBe(true);
    const scopedKey = migrated.preview._test.dockStateKey('local', '@3');
    expect(migrated.dom.window.localStorage.getItem(legacyKey)).toBeNull();
    expect(JSON.parse(migrated.dom.window.localStorage.getItem(scopedKey)).tabs[0].path)
      .toBe('/tmp/legacy.md');
    expect(migrated.dom.window.document.querySelector('.fp-dock').style.width).toBe('470px');
  });

  it('does not restore an index-keyed v2 snapshot into a new stable window', async () => {
    const v2Key = 'tmux_file_preview_dock_v2:' + encodeURIComponent('local\u0000main\u00001');
    const legacyState = JSON.stringify({
      version: 1, tabs: [{ path: '/tmp/old-window.md', paneId: '%1' }],
      activePath: '/tmp/old-window.md', hidden: false, width: 470,
    });
    const replacement = createPreview({ storage: { [v2Key]: legacyState }, context: ['local', '@42'] });

    expect(await replacement.preview.restoreDocked()).toBe(false);
    expect(replacement.dom.window.document.querySelector('.fp-dock')).toBeNull();
    expect(replacement.dom.window.localStorage.getItem(v2Key)).toBe(legacyState);
  });

  it('skips missing files and prunes them from persisted dock state', async () => {
    const key = 'tmux_file_preview_dock_v3:' + encodeURIComponent('local\u0000@0');
    const state = JSON.stringify({
      version: 1,
      tabs: [
        { path: '/tmp/missing.md', paneId: '%1' },
        { path: '/tmp/kept.md', paneId: '%2' },
      ],
      activePath: '/tmp/missing.md', hidden: false, width: 480,
    });
    const restored = createPreview({
      storage: { [key]: state }, missingPaths: ['/tmp/missing.md'],
    });

    expect(await restored.preview.restoreDocked()).toBe(true);
    const dock = restored.dom.window.document.querySelector('.fp-dock');
    expect(dock.querySelectorAll('.fp-dock-tab-item')).toHaveLength(1);
    expect(dock.querySelector('.fp-dock-tab').textContent).toBe('kept.md');
    const pruned = JSON.parse(restored.dom.window.localStorage.getItem(key));
    expect(pruned.tabs.map((tab) => tab.path)).toEqual(['/tmp/kept.md']);
    expect(pruned.activePath).toBe('/tmp/kept.md');
  });

  it('uses stable window IDs in the modern shell without legacy interference', () => {
    expect(appSource).toContain("if (document.querySelector('.ms-app')) return;");
    expect(appSource).toContain("'legacy-local'");
    expect(appSource).toContain('FilePreview.switchDockContext(null, null)');
    expect(msAppSource).toContain('this._setDockContext(serverId, win.id)');
    expect(msAppSource.match(/_setDockContext\(null, null\)/g).length).toBeGreaterThanOrEqual(5);
  });

  it('ignores and removes a corrupted persisted dock snapshot', async () => {
    const key = 'tmux_file_preview_dock_v3:' + encodeURIComponent('local\u0000@0');
    const restored = createPreview({ storage: { [key]: '{broken-json' } });
    expect(await restored.preview.restoreDocked()).toBe(false);
    expect(restored.dom.window.localStorage.getItem(key)).toBeNull();
    expect(restored.dom.window.document.querySelector('.fp-dock')).toBeNull();
  });

  it('activates an existing tab instead of duplicating the same path', async () => {
    const { dom, preview } = createPreview();
    preview.openFile('/tmp/one.md', '%1'); await flush(); dockCurrent(dom);
    preview.openFile('/tmp/one.md', '%1'); await flush();
    Array.from(dom.window.document.querySelectorAll('.fp-overlay'))
      .find((el) => !el.classList.contains('fp-dock'))
      .querySelector('[aria-label="在右侧分栏打开"]').click();
    expect(dom.window.document.querySelectorAll('.fp-dock-tab-item')).toHaveLength(1);
  });

  it('clamps a stale saved width to the current desktop space', async () => {
    const { dom, preview } = createPreview();
    preview.openFile('/tmp/one.md', '%1'); await flush();
    const key = preview._test.dockStateKey('local', '@0');
    dom.window.localStorage.setItem(key, JSON.stringify({
      version: 1, tabs: [{ path: '/tmp/one.md', paneId: '%1' }],
      activePath: '/tmp/one.md', hidden: false, width: 5000,
    }));
    dockCurrent(dom);

    const dock = dom.window.document.querySelector('.fp-dock');
    const cap = Math.floor(dom.window.innerWidth * 0.7);
    expect(parseInt(dock.style.flexBasis, 10)).toBeLessThanOrEqual(cap);
    expect(parseInt(dock.style.flexBasis, 10)).toBeGreaterThanOrEqual(320);
    expect(dock.style.width).toBe(dock.style.flexBasis);
  });

  it('defaults to 360px and allows 70 percent of the workstage after excluding the sidebar', async () => {
    const { dom, preview } = createPreview();
    const doc = dom.window.document;
    // Legacy layout includes its sidebar; the modern shell passes only ms-main.
    const layout = doc.querySelector('#main-layout');
    layout.getBoundingClientRect = () => ({ width: 1200 });
    const sidebar = doc.createElement('aside'); sidebar.id = 'sidebar';
    sidebar.getBoundingClientRect = () => ({ width: 248 }); layout.prepend(sidebar);
    await preview.openFile('/tmp/one.md', '%1'); dockCurrent(dom);
    const dock = doc.querySelector('.fp-dock');
    expect(dock.style.width).toBe('360px');
    const grip = dock.querySelector('[role="separator"]');
    grip.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    expect(dock.style.width).toBe('666px');
    const terminalWidth = 1200 - 248 - parseInt(dock.style.width, 10);
    expect(terminalWidth).toBe(286);
    expect(terminalWidth).toBeGreaterThanOrEqual((1200 - 248) * 0.3);
    preview.closeDocked(); dom.window.close();
  });

  it('clamps restored width against the modern workstage budget and falls back safely when narrowed', async () => {
    const { dom, preview } = createPreview();
    const doc = dom.window.document;
    Object.defineProperty(dom.window, 'innerWidth', { value: 1200, configurable: true });
    const app = doc.createElement('div'); app.className = 'ms-app mode-terminal';
    const main = doc.createElement('main'); main.className = 'ms-main';
    main.appendChild(doc.querySelector('.terminal-view')); app.appendChild(main); doc.body.appendChild(app);
    let workstageWidth = 952;
    main.getBoundingClientRect = () => ({ width: workstageWidth });
    const key = preview._test.dockStateKey('local', '@0');
    dom.window.localStorage.setItem(key, JSON.stringify({
      version: 1, tabs: [{ path: '/tmp/one.md', paneId: '%1' }],
      activePath: '/tmp/one.md', hidden: false, width: 1600,
    }));
    await preview.openFile('/tmp/one.md', '%1'); dockCurrent(dom);
    const dock = doc.querySelector('.fp-dock');
    expect(dock.style.width).toBe('666px');
    expect(workstageWidth - parseInt(dock.style.width, 10)).toBe(286);
    expect(workstageWidth - parseInt(dock.style.width, 10)).toBeGreaterThanOrEqual(workstageWidth * 0.3);
    expect(JSON.parse(dom.window.localStorage.getItem(key)).width).toBe(666);
    // An explicit drag cannot grow the inspector back over the terminal budget.
    dock.getBoundingClientRect = () => ({ width: parseFloat(dock.style.width) });
    const grip = dock.querySelector('.fp-side-resizer');
    grip.dispatchEvent(new dom.window.MouseEvent('pointerdown', { clientX: 800, bubbles: true }));
    dom.window.dispatchEvent(new dom.window.MouseEvent('pointermove', { clientX: 0, bubbles: true }));
    dom.window.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true }));
    expect(dock.style.width).toBe('666px');
    expect(JSON.parse(dom.window.localStorage.getItem(key)).width).toBe(666);
    workstageWidth = 440;
    dom.window.dispatchEvent(new dom.window.Event('resize'));
    expect(doc.querySelector('.fp-dock')).toBeNull();
    expect(doc.querySelector('.fp-dock-restore')).not.toBeNull();
    await preview.openFile('/tmp/two.md', '%1');
    dockCurrent(dom);
    expect(doc.querySelector('.fp-dock')).toBeNull();
    expect(doc.querySelector('.fp-modal')).not.toBeNull();
    preview.close();
    workstageWidth = 952;
    doc.querySelector('.fp-dock-restore').click();
    expect(doc.querySelector('.fp-dock').style.width).toBe('666px');
    expect(doc.querySelectorAll('.fp-dock-tab')).toHaveLength(1);
    preview.closeDocked(); dom.window.close();
  });

  it('opens the palette above the file modal and returns focus on Escape without closing the file', async () => {
    const { dom, preview } = createPreview();
    const doc = dom.window.document;
    const { palette } = installPalette(dom);
    await preview.openFile('/tmp/one.md', '%1');
    const modal = doc.querySelector('.fp-modal');
    const opener = modal.querySelector('.fp-btn-close'); opener.focus();
    palette.open(opener);
    const input = doc.querySelector('.cmd-palette-input');
    const style = doc.createElement('style');
    style.textContent = styles.match(/\.fp-overlay\s*\{[^}]*\}/)[0]
      + workspaceStyles.match(/\.cmd-palette-overlay\s*\{[^}]*z-index[^}]*\}/)[0];
    doc.head.appendChild(style);
    expect(Number(dom.window.getComputedStyle(doc.querySelector('.cmd-palette-overlay')).zIndex))
      .toBeGreaterThan(Number(dom.window.getComputedStyle(modal.parentElement).zIndex));
    opener.focus(); // Only the top overlay may own focus while the palette is open.
    expect(doc.activeElement).toBe(input);
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(doc.activeElement).toBe(doc.querySelector('.cmd-palette-close'));
    doc.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(palette.isOpen()).toBe(false);
    expect(doc.querySelector('.fp-modal')).toBe(modal);
    expect(doc.activeElement).toBe(opener);
    preview.close(); dom.window.close();
  });

  it('lets palette Escape dismiss only the palette above a file action menu or diagram viewer', async () => {
    const { dom, preview } = createPreview();
    const doc = dom.window.document;
    const { palette } = installPalette(dom);
    await preview.openFile('/tmp/one.md', '%1');
    openMore(dom);
    const menu = doc.querySelector('.fp-menu');
    palette.open(doc.activeElement);
    doc.querySelector('.cmd-palette-input').dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true,
    }));
    expect(palette.isOpen()).toBe(false);
    expect(doc.querySelector('.fp-menu')).toBe(menu);
    expect(menu.contains(doc.activeElement)).toBe(true);
    doc.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    const embed = doc.createElement('div');
    embed.className = 'mermaid'; embed.innerHTML = '<svg viewBox="0 0 400 200"></svg>';
    doc.querySelector('.fp-body').appendChild(embed);
    preview._test.prepareMermaid(embed); preview._test.installMermaidInteractions(embed);
    embed.querySelector('.fp-mermaid-open').click();
    const viewer = doc.querySelector('.fp-mermaid-dialog');
    const viewerFocus = doc.activeElement;
    palette.open(viewerFocus);
    doc.querySelector('.cmd-palette-input').dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true,
    }));
    expect(palette.isOpen()).toBe(false);
    expect(doc.querySelector('.fp-mermaid-dialog')).toBe(viewer);
    expect(doc.activeElement).toBe(viewerFocus);
    preview.close(); dom.window.close();
  });

  it('dismisses only a transient modal when the palette selects a route, retaining dock tabs', async () => {
    const { dom, preview } = createPreview();
    const doc = dom.window.document;
    const { palette, go } = installPalette(dom);
    await preview.openFile('/tmp/one.md', '%1'); dockCurrent(dom);
    const dock = doc.querySelector('.fp-dock');
    const body = dock.querySelector('.fp-body'); body.scrollTop = 200;
    await preview.openFile('/tmp/two.md', '%1');
    palette.open(doc.querySelector('.fp-overlay:not(.fp-dock) .fp-btn-close'));
    const input = doc.querySelector('.cmd-palette-input');
    input.value = '设置'; input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(go).toHaveBeenCalledWith({ name: 'settings', params: {} });
    expect(doc.querySelector('.cmd-palette-overlay')).toBeNull();
    expect(doc.querySelector('.fp-overlay:not(.fp-dock)')).toBeNull();
    expect(doc.querySelector('.fp-dock')).toBe(dock);
    expect(doc.querySelector('.fp-body')).toBe(body);
    expect(body.scrollTop).toBe(200);
    expect(dock.querySelectorAll('.fp-dock-tab')).toHaveLength(1);
    // Selecting again while only docked must not close the active tab.
    palette.open(dock.querySelector('.fp-dock-tab'));
    doc.querySelector('.cmd-palette-input').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(doc.querySelector('.fp-dock')).toBe(dock);
    expect(dock.querySelectorAll('.fp-dock-tab')).toHaveLength(1);
    preview.closeDocked(); dom.window.close();
  });

  it('opens directory navigation from a dock in a modal without changing the retained tab', async () => {
    const { dom, preview } = createPreview();
    const doc = dom.window.document;
    await preview.openFile('/tmp/one.md', '%1'); dockCurrent(dom);
    const dock = doc.querySelector('.fp-dock');
    const body = dock.querySelector('.fp-body');
    body.scrollTop = 120;
    dock.querySelector('.fp-dir-parent').click(); await flush();
    const modalOverlay = Array.from(doc.querySelectorAll('.fp-overlay')).find((el) => !el.classList.contains('fp-dock'));
    expect(modalOverlay).not.toBeUndefined();
    expect(dock.querySelector('.fp-body')).toBe(body);
    expect(dock.querySelector('.fp-dock-tab').textContent).toBe('one.md');
    expect(body.scrollTop).toBe(120);
    preview.close();
    expect(doc.querySelector('.fp-dock')).toBe(dock);
    expect(doc.querySelector('.fp-body')).toBe(body);
    preview.closeDocked(); dom.window.close();
  });

  it('resizes with the keyboard and exposes a 70 percent limit without a fixed desktop cap', async () => {
    const { dom, preview } = createPreview();
    Object.defineProperty(dom.window, 'innerWidth', { value: 2560, configurable: true });
    await preview.openFile('/tmp/one.md', '%1'); dockCurrent(dom);
    const doc = dom.window.document;
    const dock = doc.querySelector('.fp-dock');
    const grip = dock.querySelector('[role="separator"]');
    const key = preview._test.dockStateKey('local', '@0');
    const press = (key, shiftKey = false) => grip.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key, shiftKey, bubbles: true, cancelable: true,
    }));
    expect(grip.tabIndex).toBe(0);
    press('End');
    expect(dock.style.width).toBe('1792px');
    expect(grip.getAttribute('aria-valuemax')).toBe('1792');
    expect(dock.style.getPropertyValue('--fp-side-max-width')).toBe('1792px');
    press('ArrowRight', true);
    expect(grip.getAttribute('aria-valuenow')).toBe('1742');
    expect(JSON.parse(dom.window.localStorage.getItem(key)).width).toBe(1742);
    press('Home'); press('ArrowRight');
    expect(dock.style.width).toBe('320px');
    press('ArrowLeft');
    expect(dock.style.width).toBe('340px');
    preview.closeDocked();
    dom.window.close();
  });

  it('restores the modal opener on Escape and traps links and inputs, excluding hidden controls', async () => {
    const { dom, preview } = createPreview();
    const doc = dom.window.document;
    const opener = doc.createElement('button');
    doc.body.appendChild(opener); opener.focus();
    await preview.openFile('/tmp/one.md', '%1');
    const modal = doc.querySelector('.fp-modal');
    expect(modal.getAttribute('aria-modal')).toBe('true');
    modal.querySelector('.fp-btn-back').style.display = 'none';
    const input = doc.createElement('input');
    const disabled = doc.createElement('button'); disabled.disabled = true;
    modal.querySelector('.fp-body').append(input, disabled);
    input.focus();
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(doc.activeElement).toBe(modal.querySelector('.fp-btn-refresh'));
    doc.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    expect(doc.activeElement).toBe(input);
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(doc.querySelector('.fp-overlay')).toBeNull();
    expect(doc.activeElement).toBe(opener);
    dom.window.close();
  });

  it('keeps dock tabs and reading position when Escape hides the dock, and restores keyboard focus', async () => {
    const { dom, preview } = createPreview();
    const doc = dom.window.document;
    await preview.openFile('/tmp/one.md', '%1'); dockCurrent(dom);
    const body = doc.querySelector('.fp-body'); body.scrollTop = 240;
    doc.querySelector('.fp-dock-tab').focus();
    doc.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(doc.querySelector('.fp-dock')).toBeNull();
    const restore = doc.querySelector('.fp-dock-restore');
    expect(doc.activeElement).toBe(restore);
    restore.click();
    expect(doc.querySelector('.fp-body')).toBe(body);
    expect(body.scrollTop).toBe(240);
    expect(doc.activeElement).toBe(doc.querySelector('[role="tab"][aria-selected="true"]'));
    preview.closeDocked(); dom.window.close();
  });

  it('switches dock tabs with arrow keys and closes only the selected tab with Delete', async () => {
    const { dom, preview, fetch } = createPreview();
    const doc = dom.window.document;
    const opener = doc.createElement('button'); doc.body.appendChild(opener); opener.focus();
    await preview.openFile('/tmp/one.md', '%1'); dockCurrent(dom);
    const one = doc.querySelector('.fp-body'); one.scrollTop = 160;
    await preview.openFile('/tmp/two.md', '%1'); dockCurrent(dom);
    const count = fetch.mock.calls.length;
    const press = (key) => doc.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key, bubbles: true, cancelable: true,
    }));
    doc.querySelector('[role="tab"][aria-selected="true"]').focus();
    press('ArrowLeft');
    expect(doc.activeElement.textContent).toBe('one.md');
    expect(doc.querySelector('.fp-body')).toBe(one);
    expect(one.scrollTop).toBe(160);
    expect(doc.querySelector('[role="tabpanel"]').getAttribute('aria-labelledby')).toBe(doc.activeElement.id);
    expect(doc.querySelector('[role="tabpanel"]').hasAttribute('aria-modal')).toBe(false);
    expect(fetch.mock.calls.length).toBe(count);
    press('Delete');
    expect(doc.querySelectorAll('[role="tab"]')).toHaveLength(1);
    expect(doc.activeElement.textContent).toBe('two.md');
    press('Delete');
    expect(doc.querySelector('.fp-dock')).toBeNull();
    expect(doc.activeElement).toBe(opener);
    dom.window.close();
  });

  it('resizes the dock from the left grip and persists the width', async () => {
    const { dom, preview } = createPreview();
    preview.openFile('/tmp/one.md', '%1'); await flush(); dockCurrent(dom);

    const dock = dom.window.document.querySelector('.fp-dock');
    const grip = dock.querySelector('.fp-side-resizer');
    dock.style.flexBasis = '620px';
    dock.style.width = '620px';
    Object.defineProperty(dock, 'getBoundingClientRect', {
      value: () => ({ width: parseFloat(dock.style.width) || 620 }), configurable: true,
    });
    grip.dispatchEvent(new dom.window.MouseEvent('pointerdown', { clientX: 800, bubbles: true }));
    dom.window.dispatchEvent(new dom.window.MouseEvent('pointermove', { clientX: 920, bubbles: true }));
    expect(dock.style.flexBasis).toBe('500px');
    expect(dock.style.width).toBe('500px');
    dom.window.dispatchEvent(new dom.window.MouseEvent('pointerup', { clientX: 920, bubbles: true }));
    const key = preview._test.dockStateKey('local', '@0');
    expect(JSON.parse(dom.window.localStorage.getItem(key)).width).toBe(500);
  });

  it('lets a dock with an inline width fill the viewport when maximized', async () => {
    const { dom, preview } = createPreview();
    const maximizedRule = styles.match(/\.fp-overlay\.fp-side\.fp-side-maximized\s*\{[^}]+\}/);
    expect(maximizedRule).not.toBeNull();
    const style = dom.window.document.createElement('style');
    style.textContent = maximizedRule[0];
    dom.window.document.head.appendChild(style);

    preview.openFile('/tmp/one.md', '%1'); await flush(); dockCurrent(dom);
    const dock = dom.window.document.querySelector('.fp-dock');
    dock.style.width = '500px';
    dock.style.flexBasis = '500px';

    runPreviewAction(dom, '最大化预览');
    expect(dock.classList.contains('fp-side-maximized')).toBe(true);
    expect(dom.window.getComputedStyle(dock).width).toBe('auto');
    runPreviewAction(dom, '恢复预览');
    expect(dock.classList.contains('fp-side-maximized')).toBe(false);
    expect(dom.window.getComputedStyle(dock).width).toBe('500px');
  });

  it('refreshes changed content in place while preserving scroll, maximize and the active dock tab', async () => {
    const live = createLivePreview();
    live.preview.openFile('/tmp/live.csv', '%1');
    await flush();

    const doc = live.dom.window.document;
    dockCurrent(live.dom);
    const dock = doc.querySelector('.fp-dock');
    runPreviewAction(live.dom, '最大化预览');
    const body = dock.querySelector('.fp-body');
    const scroll = body.querySelector('.fp-xlsx-wrap');
    scroll.scrollTop = 73;
    scroll.scrollLeft = 19;

    live.setFile('name,value\nafter,2', 2000);
    dock.querySelector('[aria-label="刷新预览"]').click();
    await flush();

    expect(dock.querySelector('.fp-xlsx-table').textContent).toContain('after');
    expect(scroll.isConnected).toBe(false);
    const refreshedScroll = dock.querySelector('.fp-xlsx-wrap');
    expect(refreshedScroll.scrollTop).toBe(73);
    expect(refreshedScroll.scrollLeft).toBe(19);
    expect(dock.querySelector('.fp-modal').classList.contains('fp-maximized')).toBe(true);
    expect(dock.querySelectorAll('.fp-dock-tab-item.active')).toHaveLength(1);
    expect(dock.querySelector('[aria-label="刷新预览"]').getAttribute('aria-busy')).toBe('false');
  });

  it('checks only the visible preview, skips unchanged content, and pauses when hidden', async () => {
    const live = createLivePreview({ visible: true });
    live.preview.openFile('/tmp/live.csv', '%1');
    await flush();

    expect(live.preview._test.autoRefreshMs).toBe(1500);
    expect(live.preview._test.hasAutoRefreshTimer()).toBe(true);
    expect(Array.from(live.timers.values()).some((timer) => timer.delay === 1500)).toBe(true);
    expect(live.contentFetches()).toBe(1);

    await live.preview._test.refreshCurrent(false);
    expect(live.contentFetches()).toBe(1);

    live.setFile('name,value\nauto,3', 3000);
    await live.preview._test.refreshCurrent(false);
    expect(live.contentFetches()).toBe(2);
    expect(live.dom.window.document.querySelector('.fp-xlsx-table').textContent).toContain('auto');

    live.setHidden(true);
    expect(live.preview._test.hasAutoRefreshTimer()).toBe(false);
    live.setHidden(false);
    expect(live.preview._test.hasAutoRefreshTimer()).toBe(true);

    live.preview.close();
    expect(live.preview._test.hasAutoRefreshTimer()).toBe(false);
  });

  it('retries the same changed signature after a transient render failure', async () => {
    const live = createLivePreview();
    live.preview.openFile('/tmp/live.csv', '%1');
    await flush();

    live.setFile('name,value\nretry,4', 4000);
    live.failNextContent();
    expect(await live.preview._test.refreshCurrent(false)).toBe(false);
    expect(live.dom.window.document.querySelector('.fp-xlsx-table').textContent).toContain('before');

    expect(await live.preview._test.refreshCurrent(false)).toBe(true);
    expect(live.contentFetches()).toBe(3);
    expect(live.dom.window.document.querySelector('.fp-xlsx-table').textContent).toContain('retry');
  });

  it('does not poll the previous file when opening the next preview fails', async () => {
    const live = createLivePreview({ visible: true });
    live.preview.openFile('/tmp/live.csv', '%1');
    await flush();
    expect(live.preview._test.hasAutoRefreshTimer()).toBe(true);

    live.setInfoError('Permission denied');
    live.preview.openFile('/tmp/denied.csv', '%1');
    await flush();

    expect(live.dom.window.document.querySelector('.fp-error').textContent).toContain('Permission denied');
    expect(live.preview._test.hasAutoRefreshTimer()).toBe(false);
    expect(await live.preview._test.refreshCurrent(false)).toBe(false);
  });

  it('refreshes directory rows even when the directory stat is unchanged', async () => {
    const live = createDirectoryPreview();
    live.preview.openFile('/root', '%1');
    await flush();
    expect(live.dom.window.document.querySelector('.fp-dir-size').textContent).toBe('');
    expect(live.dom.window.document.querySelectorAll('.fp-dir-size')[2].textContent).toBe('1 B');

    live.setNoteSize(99);
    expect(await live.preview._test.refreshCurrent(false)).toBe(true);
    expect(live.listFetches()).toBe(2);
    expect(live.dom.window.document.querySelectorAll('.fp-dir-size')[2].textContent).toBe('99 B');
  });

  it('discards an old directory refresh after navigating to a child', async () => {
    const live = createDirectoryPreview();
    live.preview.openFile('/root', '%1');
    await flush();

    live.holdNextRootList();
    const staleRefresh = live.preview._test.refreshCurrent(false);
    await flush();
    live.dom.window.document.querySelector('.fp-dir-isdir').click();
    await flush();
    expect(live.dom.window.document.querySelector('.fp-title').textContent).toBe('/root/child');
    expect(live.dom.window.document.querySelector('.fp-dir-list').textContent).toContain('inside.txt');

    live.releaseRootList({
      absPath: '/root', parent: '/', truncated: false, totalCount: 1,
      entries: [{ name: 'stale.txt', type: 'file', targetType: null, size: 9, mtime: 4000, isHidden: false }],
    });
    expect(await staleRefresh).toBe(false);
    await flush();
    expect(live.dom.window.document.querySelector('.fp-title').textContent).toBe('/root/child');
    expect(live.dom.window.document.querySelector('.fp-dir-list').textContent).toContain('inside.txt');
    expect(live.dom.window.document.querySelector('.fp-dir-list').textContent).not.toContain('stale.txt');
  });
});

describe('FilePreview archive tree', () => {
  it('builds a nested tree and renders collapsible directories', () => {
    const { dom, preview } = createPreview();
    const tree = preview._test.buildArchiveTree([
      { name: 'src/nested/b.js', size: 50, isDir: false },
      { name: 'src/a.js', size: 100, isDir: false },
      { name: 'README.md', size: 10, isDir: false },
    ]);

    const container = dom.window.document.createElement('div');
    preview._test.renderArchiveTree(tree, container, 0);

    const topRows = [...container.children].filter((n) => n.classList.contains('fp-arch-row'));
    expect(topRows.map((r) => r.querySelector('.fp-dir-name').textContent))
      .toEqual(['src', 'README.md']);

    const allRows = container.querySelectorAll('.fp-arch-row');
    expect(allRows).toHaveLength(5);

    const srcRow = topRows[0];
    const srcSub = srcRow.nextElementSibling;
    expect(srcSub.classList.contains('fp-arch-sub')).toBe(true);
    const nestedRow = srcSub.querySelector('.fp-arch-dir');
    expect(nestedRow.querySelector('.fp-dir-name').textContent).toBe('nested');
    expect(parseInt(nestedRow.style.paddingLeft, 10))
      .toBeGreaterThan(parseInt(srcRow.style.paddingLeft, 10));

    srcRow.click();
    expect(srcSub.hidden).toBe(true);
    srcRow.click();
    expect(srcSub.hidden).toBe(false);
  });

  it('formats byte sizes for display', () => {
    const { preview } = createPreview();
    expect(preview._test.formatBytes(500)).toBe('500 B');
    expect(preview._test.formatBytes(2048)).toBe('2.0 KB');
    expect(preview._test.formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('Markdown task lists', () => {
  it('maps task list tokens to their physical source line after frontmatter', () => {
    const { preview } = createPreview();
    const extracted = preview._test.extractFrontmatter('---\ntitle: Tasks\n---\n- [ ] first\n');
    expect(extracted.lineOffset).toBe(3);

    let taskRule;
    preview._test.installMarkdownTasks({
      core: { ruler: { after: (_after, name, rule) => { expect(name).toBe('fp_task_lists'); taskRule = rule; } } },
    });
    const attrs = {};
    const token = {
      type: 'list_item_open', map: [0, 1],
      attrJoin: (name, value) => { attrs[name] = value; },
      attrSet: (name, value) => { attrs[name] = value; },
    };
    taskRule({ env: { fpTaskLines: extracted.body.split(/\r?\n/), fpTaskLineOffset: extracted.lineOffset }, tokens: [token] });

    expect(attrs).toEqual({
      class: 'fp-task-item',
      'data-fp-task-line': '3',
      'data-fp-task-expected': '- [ ] first',
    });
  });

  it('replaces task markers with native checkbox controls without changing task text', () => {
    const { dom, preview } = createPreview();
    const wrap = dom.window.document.createElement('div');
    wrap.innerHTML = '<ul><li class="fp-task-item" data-fp-task-line="3" data-fp-task-expected="- [ ] open"><p>[ ] open</p></li><li class="fp-task-item" data-fp-task-line="4" data-fp-task-expected="- [X] done"><p>[X] done</p></li></ul>';
    dom.window.document.body.appendChild(wrap);

    preview._test.replaceTaskMarkers(wrap);

    const boxes = wrap.querySelectorAll('.fp-task-checkbox');
    expect(boxes).toHaveLength(2);
    expect(boxes[0].checked).toBe(false);
    expect(boxes[1].checked).toBe(true);
    expect(Array.from(wrap.querySelectorAll('li')).map((item) => item.textContent)).toEqual(['open', 'done']);
    expect(styles).toContain('.fp-md-wrap li.fp-task-item { list-style: none; }');
    expect(styles).toContain('.fp-md-wrap li.fp-task-item > ul,');
    expect(styles).toContain('padding-inline-start: 1.8em;');
  });
});

describe('FilePreview failure notifications', () => {
  it('toasts and shows an inline error when the target cannot be opened', async () => {
    const { dom, preview } = createPreview({ missingPaths: ['/tmp/gone.md'] });
    const toast = vi.fn();
    dom.window.AppShell = { toast: toast };

    preview.openFile('/tmp/gone.md', '%1');
    await flush();

    expect(toast).toHaveBeenCalledWith('无法打开：/tmp/gone.md');
    expect(dom.window.document.querySelector('.fp-error')).not.toBeNull();
  });

  it('toasts when a heading jump finds no target', () => {
    const { dom, preview } = createPreview();
    const toast = vi.fn();
    dom.window.AppShell = { toast: toast };
    const wrap = dom.window.document.createElement('div');
    wrap.innerHTML = '<a href="#nope">x</a><h2>Other</h2>';
    dom.window.document.body.appendChild(wrap);
    preview._test.prepareMarkdownNavigation(wrap, '/n/c.md', '%1');

    wrap.querySelector('a').click();

    expect(toast).toHaveBeenCalledWith('未找到标题：nope');
  });

  it('toasts when a link is blocked as unsafe', () => {
    const { dom, preview } = createPreview();
    const toast = vi.fn();
    dom.window.AppShell = { toast: toast };
    const wrap = dom.window.document.createElement('div');
    wrap.innerHTML = '<a href="javascript:alert(1)">x</a>';
    dom.window.document.body.appendChild(wrap);
    preview._test.prepareMarkdownNavigation(wrap, '/n/c.md', '%1');

    wrap.querySelector('a').click();

    expect(toast).toHaveBeenCalledWith('已阻止不安全链接：javascript:alert(1)');
  });
});

describe('video previews', () => {
  it('opens video files without fetching text content and pauses when hidden or closed', async () => {
    const { dom, preview, fetch } = createPreview({
      auth: { headers: () => ({}), wsTokenParam: () => 'token=test-video' },
    });
    fetch.mockImplementation((url) => {
      expect(String(url)).toContain('/api/files/info');
      const path = new URL(String(url), 'https://panel.test').searchParams.get('path');
      return Promise.resolve({ status: 200, json: async () => ({
        success: true, data: { absPath: path, isVideo: true, isText: false, size: 32000000, mtimeMs: 42 },
      }) });
    });
    await preview.openFile('/tmp/视频.mp4', '%1');
    const video = dom.window.document.querySelector('.fp-video-wrap video');
    expect(video.controls).toBe(true);
    expect(video.preload).toBe('metadata');
    expect(video.hasAttribute('playsinline')).toBe(true);
    expect(video.autoplay).toBe(false);
    const url = new URL(video.src);
    expect(url.searchParams.get('path')).toBe('/tmp/视频.mp4');
    expect(url.searchParams.get('token')).toBe('test-video');
    expect(url.searchParams.get('v')).toBe('42');
    video.dispatchEvent(new dom.window.Event('error'));
    expect(video.nextElementSibling.textContent).toContain('下载原文件');
    const pause = vi.spyOn(video, 'pause').mockImplementation(() => {});
    dom.window.document.querySelector('.fp-btn-placement').click();
    dom.window.document.querySelector('.fp-btn-placement').click();
    expect(pause).toHaveBeenCalled();
    dom.window.document.querySelector('.fp-dock-restore').click();
    pause.mockClear();
    preview.close();
    expect(pause).toHaveBeenCalled();
    expect(dom.window.document.querySelector('video')).toBeNull();
  });

  it('resolves Markdown video embeds against the document and keeps remote queries intact', () => {
    const { dom, preview } = createPreview({
      auth: { headers: () => ({}), wsTokenParam: () => 'token=video-test' },
    });
    const wrap = dom.window.document.createElement('div');
    wrap.innerHTML = '<img src="../视频/clip%20one.MP4#t=5,10" alt="演示">'
      + '<img src="/tmp/absolute.webm">'
      + '<img src="https://cdn.test/clip.mov?sig=a&amp;key=b#t=2">'
      + '<img src="//cdn.test/clip.ogv">'
      + '<img src="javascript:evil.mp4" alt="无效视频">'
      + '<img src="cover.png">';
    preview._test.prepareMarkdownMedia(wrap, '/notes/docs/current.md');
    const videos = Array.from(wrap.querySelectorAll('video'));
    expect(videos).toHaveLength(4);
    expect(new URL(videos[0].src).searchParams.get('path')).toBe('/notes/视频/clip one.MP4');
    expect(new URL(videos[0].src).searchParams.get('token')).toBe('video-test');
    expect(new URL(videos[0].src).hash).toBe('#t=5,10');
    expect(videos[0].getAttribute('aria-label')).toBe('演示');
    expect(new URL(videos[1].src).searchParams.get('path')).toBe('/tmp/absolute.webm');
    expect(videos[2].src).toBe('https://cdn.test/clip.mov?sig=a&key=b#t=2');
    expect(videos[3].src).toBe('https://cdn.test/clip.ogv');
    expect(wrap.textContent).toContain('无效视频');
    expect(wrap.querySelectorAll('img')).toHaveLength(1);
    expect(new URL(wrap.querySelector('img').src).searchParams.get('path')).toBe('/notes/docs/cover.png');
  });

  it('renders Obsidian video embeds through the same media path', () => {
    const { dom, preview } = createPreview();
    const rules = {};
    preview._test.obsidianMarkdown({ inline: { ruler: {
      before: (_before, name, rule) => { rules[name] = rule; }, push: () => {},
    } } });
    const token = {};
    const state = { src: '![[clips/演示.mp4|播放演示]]', pos: 0, push: () => token };
    expect(rules.obs_embed(state, false)).toBe(true);
    const wrap = dom.window.document.createElement('div');
    wrap.innerHTML = token.content;
    preview._test.prepareMarkdownMedia(wrap, '/notes/current.md');
    const video = wrap.querySelector('video');
    expect(new URL(video.src).searchParams.get('path')).toBe('/notes/clips/演示.mp4');
    expect(video.getAttribute('aria-label')).toBe('播放演示');
  });

  it('shows inline players for the video links used in the defense document', () => {
    const { dom, preview } = createPreview();
    const wrap = dom.window.document.createElement('div');
    wrap.innerHTML = '<p><a href="演示素材/源视频.mp4">源视频</a>与'
      + '<a href="演示素材/注入后录像.mp4">注入后录像</a>。'
      + '<a href="参考资料/说明.md">参考资料</a></p>';
    preview._test.prepareMarkdownMedia(wrap, '/Users/me/workspace/转正答辩/转正答辩内容稿-30分钟.md');
    const videos = Array.from(wrap.querySelectorAll('video'));
    expect(videos.map((video) => video.getAttribute('aria-label'))).toEqual(['源视频', '注入后录像']);
    expect(videos.map((video) => new URL(video.src).searchParams.get('path'))).toEqual([
      '/Users/me/workspace/转正答辩/演示素材/源视频.mp4',
      '/Users/me/workspace/转正答辩/演示素材/注入后录像.mp4',
    ]);
    expect(wrap.querySelectorAll('a')).toHaveLength(3);
    expect(wrap.querySelector('a').nextElementSibling).toBe(videos[0]);
  });

  it('decodes Chinese and escaped image paths once before requesting the raw file', () => {
    const { dom, preview } = createPreview({
      auth: { headers: () => ({}), wsTokenParam: () => 'token=image-test' },
    });
    const wrap = dom.window.document.createElement('div');
    wrap.innerHTML = '<img src="' + encodeURI('演示素材/网页联调界面.png') + '">'
      + '<img src="' + encodeURI('../图片/空 格 & 截图.png') + '">'
      + '<img src="/tmp/绝对路径.png">'
      + '<img src="https://cdn.test/cover.png?key=a&amp;size=b">'
      + '<img src="data:image/png;base64,cG5n">';
    preview._test.prepareMarkdownMedia(wrap, '/workspace/转正答辩/文稿.md');
    const imgs = Array.from(wrap.querySelectorAll('img'));
    expect(imgs.slice(0, 3).map((img) => new URL(img.src).searchParams.get('path'))).toEqual([
      '/workspace/转正答辩/演示素材/网页联调界面.png',
      '/workspace/图片/空 格 & 截图.png',
      '/tmp/绝对路径.png',
    ]);
    expect(new URL(imgs[0].src).searchParams.get('token')).toBe('image-test');
    expect(imgs[3].src).toBe('https://cdn.test/cover.png?key=a&size=b');
    expect(imgs[4].src).toBe('data:image/png;base64,cG5n');
  });

  it('removes local video stream credentials from standalone snapshots without changing playback', async () => {
    const { dom, preview } = createLivePreview();
    await preview.openFile('/tmp/live.csv', '%1');
    const body = dom.window.document.querySelector('.fp-body');
    body.innerHTML = '<div class="fp-md-wrap">'
      + '<video src="/api/files/raw?path=%2Fprivate%2Fclip.mp4&amp;token=secret" aria-label="演示"></video>'
      + '<video src="https://cdn.test/clip.mp4" controls></video></div>';
    const snapshot = await preview._test.buildStandaloneDoc();
    expect(snapshot.html).not.toContain('token=secret');
    expect(snapshot.html).not.toContain('%2Fprivate');
    expect(snapshot.html).toContain('演示（请在文件预览中播放）');
    expect(snapshot.html).toContain('https://cdn.test/clip.mp4');
    expect(body.querySelector('video').getAttribute('src')).toContain('token=secret');
    vi.spyOn(dom.window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    preview.close();
  });
});

describe('FilePreview share link origin', () => {
  it('prefers the LAN host over the loopback origin', () => {
    const { dom, preview } = createPreview();
    preview._test.setLanHost(null);
    expect(preview._test.shareOrigin()).toBe(dom.window.location.origin);

    preview._test.setLanHost('192.168.1.50');
    const origin = preview._test.shareOrigin();
    expect(origin).toContain('192.168.1.50');
    expect(origin).not.toContain('127.0.0.1');
    preview._test.setLanHost(null);
  });
});

describe('Markdown image HTML tags', () => {
  function parse(markup, silent = false) {
    const { dom, preview } = createPreview();
    const rules = {};
    preview._test.installMarkdownImages({ inline: { ruler: {
      before: (anchor, name, rule) => { rules[name] = rule; },
    } } });
    const tokens = [];
    const state = { src: markup, pos: 0, push: () => {
      const token = {}; tokens.push(token); return token;
    } };
    const matched = rules.fp_image_tag(state, silent);
    const wrap = dom.window.document.createElement('div');
    wrap.innerHTML = tokens.map((token) => token.content).join('');
    return { dom, preview, state, tokens, matched, wrap };
  }

  it('preserves local source, escaped text and explicit image dimensions', () => {
    const ctx = parse('<img src="assets/a.png" alt="A &amp; B > C" title="&quot;image&quot;" width="200" height=48> trailing');
    expect(ctx.matched).toBe(true);
    const image = ctx.wrap.querySelector('img');
    expect(image.getAttribute('src')).toBe('assets/a.png');
    expect(image.alt).toBe('A & B > C');
    expect(image.title).toBe('"image"');
    expect(image.width).toBe(200);
    expect(image.height).toBe(48);
    expect(ctx.state.src.slice(ctx.state.pos)).toBe(' trailing');
    ctx.preview._test.prepareMarkdownMedia(ctx.wrap, '/notes/docs/icons.md');
    expect(new URL(image.src).searchParams.get('path')).toBe('/notes/docs/assets/a.png');
    ctx.dom.window.close();
  });

  it('accepts single quotes and self-closing tags in silent link-label scans', () => {
    const markup = "<IMG src='https://cdn.test/a.png' width='48' />";
    const ctx = parse(markup, true);
    expect(ctx.matched).toBe(true);
    expect(ctx.state.pos).toBe(markup.length);
    expect(ctx.tokens).toHaveLength(0);
    ctx.dom.window.close();
  });

  it('rebuilds only supported attributes and leaves other HTML unrecognized', () => {
    const ctx = parse('<img src="a.png" onerror="alert(1)" onload="bad()" style="position:fixed" srcset="bad 2x" class="bad" width="48">');
    expect(Array.from(ctx.wrap.querySelector('img').attributes, (attr) => attr.name)).toEqual(['src', 'width']);
    ctx.dom.window.close();
    for (const markup of ['<script>alert(1)</script>', '<iframe src="https://test/"></iframe>', '<image src="a.png">', '<img src="unclosed>']) {
      const blocked = parse(markup);
      expect(blocked.matched).toBe(false);
      expect(blocked.tokens).toHaveLength(0);
      blocked.dom.window.close();
    }
  });

  it('rejects unsafe or obfuscated source protocols', () => {
    for (const src of ['javascript:alert(1)', 'jav&#x61;script&#x3a;alert(1)', 'java&#x09;script:alert(1)', 'data:image/svg+xml,evil', 'file:///tmp/a.png', 'blob:https://test/id', 'vbscript:bad', '']) {
      const ctx = parse('<img src="' + src + '" width="48">');
      expect(ctx.matched, src).toBe(false);
      expect(ctx.tokens).toHaveLength(0);
      ctx.dom.window.close();
    }
  });

  it('ignores invalid or excessive dimensions', () => {
    for (const width of ['0', '-1', '4097', '99999999999999999', '48px', '100%', '1.5', '48;position:fixed']) {
      const ctx = parse('<img src="a.png" width="' + width + '" height="48">');
      expect(ctx.matched).toBe(true);
      expect(ctx.wrap.querySelector('img').hasAttribute('width')).toBe(false);
      expect(ctx.wrap.querySelector('img').height).toBe(48);
      ctx.dom.window.close();
    }
  });
});
