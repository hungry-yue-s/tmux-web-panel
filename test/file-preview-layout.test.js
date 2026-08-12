import { describe, it, expect, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';

const source = fs.readFileSync('public/js/file-preview.js', 'utf8');

function createPreview(savedPlacement) {
  const dom = new JSDOM(
    '<!doctype html><body><div id="main-layout"><main id="content"><div class="terminal-view"></div></main></div></body>',
    { url: 'https://panel.test/' }
  );
  Object.defineProperty(dom.window, 'innerWidth', { value: 1440, configurable: true });
  if (savedPlacement) dom.window.localStorage.setItem('tmux_file_preview_placement', savedPlacement);

  const fetch = vi.fn((url) => {
    if (String(url).includes('/api/files/info')) {
      return Promise.resolve({
        status: 200,
        json: () => Promise.resolve({ success: true, data: { isDirectory: true, absPath: '/tmp' } }),
      });
    }
    return Promise.resolve({
      status: 200,
      json: () => Promise.resolve({
        success: true,
        data: { absPath: '/tmp', parent: '/', entries: [], truncated: false },
      }),
    });
  });

  new Function('window', 'document', 'fetch', source)(dom.window, dom.window.document, fetch);
  return { dom, preview: dom.window.FilePreview };
}

describe('file preview desktop placement', () => {
  it('offers a top action that docks the preview to the right and restores the modal', async () => {
    const { dom, preview } = createPreview();
    preview.openFile('.', '%1');

    const button = dom.window.document.querySelector('[aria-label="在右侧分栏打开"]');
    expect(button).not.toBeNull();
    expect(button.closest('.fp-header')).not.toBeNull();

    const exportButton = dom.window.document.querySelector('[aria-label="导出渲染后的 HTML"]');
    const shareButton = dom.window.document.querySelector('[aria-label="生成内网分享链接"]');
    expect(exportButton.querySelector('svg[stroke="currentColor"]')).not.toBeNull();
    expect(shareButton.querySelector('svg[stroke="currentColor"]')).not.toBeNull();
    expect(exportButton.textContent).not.toContain('\u{1F4BE}');
    expect(shareButton.textContent).not.toContain('\u{1F517}');

    button.click();
    const overlay = dom.window.document.querySelector('.fp-overlay');
    expect(overlay.classList.contains('fp-side')).toBe(true);
    expect(overlay.parentElement.id).toBe('main-layout');
    expect(dom.window.document.body.classList.contains('fp-side-open')).toBe(true);
    expect(button.getAttribute('aria-label')).toBe('恢复弹窗预览');

    const maximize = dom.window.document.querySelector('[aria-label="Maximize"]');
    expect(maximize).not.toBeNull();
    maximize.click();
    expect(overlay.classList.contains('fp-side-maximized')).toBe(true);
    expect(overlay.querySelector('.fp-modal').classList.contains('fp-maximized')).toBe(true);
    expect(maximize.getAttribute('aria-label')).toBe('Restore');

    maximize.click();
    expect(overlay.classList.contains('fp-side-maximized')).toBe(false);
    expect(overlay.querySelector('.fp-modal').classList.contains('fp-maximized')).toBe(false);

    button.click();
    expect(overlay.classList.contains('fp-side')).toBe(false);
    expect(overlay.parentElement).toBe(dom.window.document.body);
    expect(dom.window.document.body.classList.contains('fp-side-open')).toBe(false);
  });

  it('defaults every newly opened preview to a modal', () => {
    const { dom, preview } = createPreview('side');
    preview.openFile('.', '%1');

    let overlay = dom.window.document.querySelector('.fp-overlay');
    expect(overlay.classList.contains('fp-side')).toBe(false);
    expect(overlay.parentElement).toBe(dom.window.document.body);

    dom.window.document.querySelector('[aria-label="在右侧分栏打开"]').click();
    expect(overlay.classList.contains('fp-side')).toBe(true);

    preview.close();
    expect(dom.window.document.querySelector('.fp-overlay')).toBeNull();
    expect(dom.window.document.body.classList.contains('fp-side-open')).toBe(false);

    preview.openFile('.', '%1');
    overlay = dom.window.document.querySelector('.fp-overlay');
    expect(overlay.classList.contains('fp-side')).toBe(false);
    expect(overlay.parentElement).toBe(dom.window.document.body);
  });

  it('clamps a stale saved width to the current desktop space', () => {
    const { dom, preview } = createPreview();
    dom.window.localStorage.setItem('tmux_file_preview_side_width', '5000');
    preview.openFile('.', '%1');
    dom.window.document.querySelector('[aria-label="在右侧分栏打开"]').click();

    const overlay = dom.window.document.querySelector('.fp-overlay');
    expect(parseInt(overlay.style.flexBasis, 10)).toBeLessThan(1000);
    expect(parseInt(overlay.style.flexBasis, 10)).toBeGreaterThanOrEqual(320);
  });
});
