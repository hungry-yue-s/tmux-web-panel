import { describe, it, expect, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';

const source = fs.readFileSync('public/js/file-preview.js', 'utf8');
const appSource = fs.readFileSync('public/js/app.js', 'utf8');
const msAppSource = fs.readFileSync('public/js/ms-app.js', 'utf8');
const styles = fs.readFileSync('public/css/style.css', 'utf8');

function createPreview({ storage = {}, missingPaths = [], context = ['local', 'test-session', 0] } = {}) {
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

  new Function('window', 'document', 'fetch', source)(dom.window, dom.window.document, fetch);
  const preview = dom.window.FilePreview;
  if (context) preview.switchDockContext(context[0], context[1], context[2]);
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
    throw new Error('Unexpected fetch: ' + text);
  });

  new Function('window', 'document', 'fetch', source)(dom.window, dom.window.document, fetch);
  dom.window.FilePreview.switchDockContext('local', 'test-session', 0);
  return {
    dom,
    preview: dom.window.FilePreview,
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

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function dockCurrent(dom) {
  dom.window.document.querySelector('[aria-label="在右侧分栏打开"]').click();
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
    dom.window.FilePreview.switchDockContext('local', 'test-session', 0);
    dom.window.FilePreview.openFile('/tmp/one.md', '%1');
    await flush();
    dockCurrent(dom);

    expect(dom.window.document.querySelector('.fp-dock').parentElement)
      .toBe(dom.window.document.querySelector('.ms-main'));
    expect(dom.window.document.querySelector('#main-layout .fp-dock')).toBeNull();
    expect(styles).toMatch(/\.ms-app\.mode-terminal \.fp-dock\s*\{[\s\S]*?grid-column:\s*2;[\s\S]*?grid-row:\s*1 \/ 3/);
  });

  it('uses consistent SVG controls with accessible toggle states', async () => {
    const { dom, preview } = createPreview();
    preview.openFile('/tmp/one.md', '%1'); await flush();

    const overlay = dom.window.document.querySelector('.fp-overlay');
    ['Back to parent directory', 'Refresh preview', '在右侧分栏打开', 'Maximize', 'Open in new tab',
      '导出渲染后的 HTML', '生成内网分享链接', 'Download', 'Close'].forEach((label) => {
      const button = overlay.querySelector(`[aria-label="${label}"]`);
      expect(button).not.toBeNull();
      expect(button.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
      expect(button.title).not.toBe('');
      expect(button.type).toBe('button');
    });

    const maximize = overlay.querySelector('[aria-label="Maximize"]');
    maximize.click();
    expect(maximize.classList.contains('is-active')).toBe(true);
    expect(maximize.getAttribute('aria-pressed')).toBe('true');
    expect(maximize.querySelector('svg')).not.toBeNull();
    maximize.click();
    expect(maximize.classList.contains('is-active')).toBe(false);

    dockCurrent(dom);
    const placement = dom.window.document.querySelector('[aria-label="隐藏右侧预览"]');
    expect(placement.classList.contains('is-active')).toBe(true);
    expect(placement.getAttribute('aria-pressed')).toBe('true');
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
    expect(dom.window.localStorage.getItem(preview._test.dockStateKey('local', 'test-session', 0))).toBeNull();
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

    const key = first.preview._test.dockStateKey('local', 'test-session', 0);
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

    const key = first.preview._test.dockStateKey('local', 'test-session', 0);
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

  it('keeps dock tabs isolated while switching between tmux windows', async () => {
    const { dom, preview } = createPreview({ context: ['local', 'main', 1] });
    preview.openFile('/tmp/window-one.md', '%1'); await flush(); dockCurrent(dom);
    const firstKey = preview._test.dockStateKey('local', 'main', 1);
    dom.window.document.querySelector('.fp-dock').style.flexBasis = '410px';
    dom.window.document.querySelector('.fp-dock').style.width = '410px';
    preview._test.persistDockState(410);
    dom.window.document.querySelector('[aria-label="隐藏右侧预览"]').click();

    expect(await preview.switchDockContext('local', 'main', 2)).toBe(false);
    expect(dom.window.document.querySelector('.fp-dock')).toBeNull();
    expect(JSON.parse(dom.window.localStorage.getItem(firstKey)).tabs[0].path)
      .toBe('/tmp/window-one.md');

    preview.openFile('/tmp/window-two.md', '%2'); await flush(); dockCurrent(dom);
    const secondKey = preview._test.dockStateKey('local', 'main', 2);
    dom.window.document.querySelector('.fp-dock').style.flexBasis = '650px';
    dom.window.document.querySelector('.fp-dock').style.width = '650px';
    preview._test.persistDockState(650);
    expect(secondKey).not.toBe(firstKey);

    expect(await preview.switchDockContext('local', 'main', 1)).toBe(true);
    expect(dom.window.document.querySelector('.fp-dock')).toBeNull();
    dom.window.document.querySelector('[aria-label="展开右侧文件预览"]').click();
    expect(dom.window.document.querySelector('.fp-dock-tab').textContent).toBe('window-one.md');
    expect(dom.window.document.querySelector('.fp-dock').style.width).toBe('410px');

    expect(await preview.switchDockContext('local', 'main', 2)).toBe(true);
    expect(dom.window.document.querySelector('.fp-dock-tab').textContent).toBe('window-two.md');
    expect(dom.window.document.querySelector('.fp-dock').style.width).toBe('650px');

    expect(await preview.switchDockContext(null, null, null)).toBe(false);
    expect(dom.window.document.querySelector('.fp-dock')).toBeNull();
    expect(await preview.switchDockContext('local', 'main', 2)).toBe(true);
    expect(dom.window.document.querySelector('.fp-dock-tab').textContent).toBe('window-two.md');
  });

  it('does not carry a dock across machines that share a session name and window index', async () => {
    const { dom, preview } = createPreview({ context: ['local', 'main', 1] });
    preview.openFile('/tmp/local-only.md', '%1'); await flush(); dockCurrent(dom);
    expect(dom.window.document.querySelector('.fp-dock-tab').textContent).toBe('local-only.md');

    // Same session name, same window index, different machine. Keyed without a
    // serverId this looked unchanged and the local dock simply stayed up.
    expect(await preview.switchDockContext('api-linux', 'main', 1)).toBe(false);
    expect(dom.window.document.querySelector('.fp-dock')).toBeNull();
    expect(dom.window.document.querySelector('[aria-label="展开右侧文件预览"]')).toBeNull();
    expect(preview._test.dockStateKey('api-linux', 'main', 1))
      .not.toBe(preview._test.dockStateKey('local', 'main', 1));

    // The local dock is untouched and comes back on return.
    expect(await preview.switchDockContext('local', 'main', 1)).toBe(true);
    expect(dom.window.document.querySelector('.fp-dock-tab').textContent).toBe('local-only.md');
  });

  it('migrates the previous global dock snapshot into the first active window', async () => {
    const legacyKey = 'tmux_file_preview_dock_v1';
    const legacy = JSON.stringify({
      version: 1, tabs: [{ path: '/tmp/legacy.md', paneId: '%1' }],
      activePath: '/tmp/legacy.md', hidden: false, width: 470,
    });
    const migrated = createPreview({
      storage: { [legacyKey]: legacy }, context: ['local', 'main', 3],
    });

    expect(await migrated.preview.restoreDocked()).toBe(true);
    const scopedKey = migrated.preview._test.dockStateKey('local', 'main', 3);
    expect(migrated.dom.window.localStorage.getItem(legacyKey)).toBeNull();
    expect(JSON.parse(migrated.dom.window.localStorage.getItem(scopedKey)).tabs[0].path)
      .toBe('/tmp/legacy.md');
    expect(migrated.dom.window.document.querySelector('.fp-dock').style.width).toBe('470px');
  });

  it('skips missing files and prunes them from persisted dock state', async () => {
    const key = 'tmux_file_preview_dock_v2:' + encodeURIComponent('local\u0000test-session\u00000');
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

  it('switches the dock context with the active machine and tmux window', () => {
    expect(appSource).toContain("FilePreview.switchDockContext('local', state.currentSession, state.currentWindow)");
    expect(appSource).toContain('FilePreview.switchDockContext(null, null, null)');
    expect(msAppSource).toContain('this._setDockContext(serverId, session.name, win.index)');
    // Every terminal path that does not mount a terminal must drop the dock, or
    // the previous machine's preview stays on screen.
    expect(msAppSource.match(/_setDockContext\(null, null, null\)/g).length).toBeGreaterThanOrEqual(5);
  });

  it('ignores and removes a corrupted persisted dock snapshot', async () => {
    const key = 'tmux_file_preview_dock_v2:' + encodeURIComponent('local\u0000test-session\u00000');
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
    const key = preview._test.dockStateKey('local', 'test-session', 0);
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
    const key = preview._test.dockStateKey('local', 'test-session', 0);
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
    dock.style.width = '620px';
    dock.style.flexBasis = '620px';

    dock.querySelector('[aria-label="Maximize"]').click();
    expect(dock.classList.contains('fp-side-maximized')).toBe(true);
    expect(dom.window.getComputedStyle(dock).width).toBe('auto');
    expect(dock.querySelector('[aria-label="Restore"]')).not.toBeNull();

    dock.querySelector('[aria-label="Restore"]').click();
    expect(dock.classList.contains('fp-side-maximized')).toBe(false);
    expect(dom.window.getComputedStyle(dock).width).toBe('620px');
  });

  it('refreshes changed content in place while preserving scroll, maximize and the active dock tab', async () => {
    const live = createLivePreview();
    live.preview.openFile('/tmp/live.csv', '%1');
    await flush();

    const doc = live.dom.window.document;
    dockCurrent(live.dom);
    const dock = doc.querySelector('.fp-dock');
    dock.querySelector('[aria-label="Maximize"]').click();
    const body = dock.querySelector('.fp-body');
    const scroll = body.querySelector('.fp-xlsx-wrap');
    scroll.scrollTop = 73;
    scroll.scrollLeft = 19;

    live.setFile('name,value\nafter,2', 2000);
    dock.querySelector('[aria-label="Refresh preview"]').click();
    await flush();

    expect(dock.querySelector('.fp-xlsx-table').textContent).toContain('after');
    expect(scroll.isConnected).toBe(false);
    const refreshedScroll = dock.querySelector('.fp-xlsx-wrap');
    expect(refreshedScroll.scrollTop).toBe(73);
    expect(refreshedScroll.scrollLeft).toBe(19);
    expect(dock.querySelector('.fp-modal').classList.contains('fp-maximized')).toBe(true);
    expect(dock.querySelectorAll('.fp-dock-tab-item.active')).toHaveLength(1);
    expect(dock.querySelector('[aria-label="Refresh preview"]').getAttribute('aria-busy')).toBe('false');
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
