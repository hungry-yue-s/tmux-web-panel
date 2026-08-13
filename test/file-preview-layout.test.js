import { describe, it, expect, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';

const source = fs.readFileSync('public/js/file-preview.js', 'utf8');
const styles = fs.readFileSync('public/css/style.css', 'utf8');

function createPreview() {
  const dom = new JSDOM(
    '<!doctype html><body><div id="main-layout"><main id="content"><div class="terminal-view"></div></main></div></body>',
    { url: 'https://panel.test/' }
  );
  Object.defineProperty(dom.window, 'innerWidth', { value: 1440, configurable: true });

  const fetch = vi.fn((url) => {
    const parsed = new URL(String(url), 'https://panel.test/');
    const path = parsed.searchParams.get('path') || '/tmp';
    if (String(url).includes('/api/files/info')) {
      return Promise.resolve({
        status: 200,
        json: () => Promise.resolve({ success: true, data: { isDirectory: true, absPath: path } }),
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
  return { dom, preview: dom.window.FilePreview };
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
    dom.window.localStorage.setItem('tmux_file_preview_side_width', '5000');
    preview.openFile('/tmp/one.md', '%1'); await flush(); dockCurrent(dom);

    const dock = dom.window.document.querySelector('.fp-dock');
    expect(parseInt(dock.style.flexBasis, 10)).toBeLessThanOrEqual(820);
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
    expect(dom.window.localStorage.getItem('tmux_file_preview_side_width')).toBe('500');
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
});
