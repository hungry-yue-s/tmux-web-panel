import { repoPath } from '../../lib/paths.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const engine = readFileSync('plugins/files/client/js/panel-presentation.js', 'utf8');
const themes = readFileSync('plugins/ui/client/js/theme.js', 'utf8');
const example = readFileSync(repoPath('skills/panel-presentation/assets/example.html'), 'utf8');
const html = '<!doctype html><meta name="anymux-presentation" content="1">'
  + '<input value="initial"><details open><summary>Details</summary>Content</details>'
  + '<script>window.runs = (window.runs || 0) + 1;</script>';
const windows = [];
afterEach(() => { windows.splice(0).forEach((win) => win.close()); });

function host({ native = false, transparency = 0, glass = 100 } = {}) {
  const win = new JSDOM('', { url: 'https://panel.test', runScripts: 'outside-only' }).window;
  windows.push(win);
  if (native) {
    win.__anymuxTransparency = true;
    win.webkit = { messageHandlers: { anymuxAppearance: { postMessage: vi.fn() } } };
  }
  win.localStorage.setItem('tmux_native_transparency', String(transparency));
  win.localStorage.setItem('tmux_native_glass_intensity', String(glass));
  win.eval(themes);
  win.eval(engine);
  const frame = win.document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  win.document.body.appendChild(frame);
  return { win, frame, engine: win.PanelPresentation };
}

function child(srcdoc, parent) {
  const win = new JSDOM(srcdoc, { url: 'about:blank', runScripts: 'dangerously',
    beforeParse(window) { Object.defineProperty(window, 'parent', { value: parent }); },
  }).window;
  windows.push(win);
  return win;
}

function deliver(win, parent, data, overrides = {}) {
  win.dispatchEvent(new win.MessageEvent('message', {
    source: parent, origin: 'https://panel.test', data, ...overrides,
  }));
}

describe('panel presentation protocol', () => {
  it('reuses native glass only in the dock, keeps modal and export backgrounds solid, and never fades text', () => {
    const { win, frame, engine } = host({ native: true, transparency: 35, glass: 65 });
    engine.mount(frame, html);
    const modal = child(frame.srcdoc, win);
    expect(modal.PanelPresentation.getTheme().appearance.material).toBe('solid');
    const dock = win.document.createElement('div');
    dock.className = 'fp-dock';
    win.document.body.appendChild(dock);
    dock.appendChild(frame);
    engine.mount(frame, html);
    const reader = child(frame.srcdoc, win);
    const root = reader.document.documentElement;
    expect(reader.PanelPresentation.getTheme().appearance).toEqual({ material: 'native-glass', transparency: 35, glassIntensity: 65 });
    expect(root.style.getPropertyValue('--pp-page-bg')).toBe('transparent');
    expect(root.style.getPropertyValue('--pp-bg')).toBe(engine.getTheme().tokens['--pp-bg']);
    expect(root.style.getPropertyValue('--pp-glass-surface')).toMatch(/^rgba\(.+, 0.16\)$/);
    expect(root.style.opacity).toBe('');
    expect(root.style.backdropFilter).toBe('');
    const note = reader.document.querySelector('input');
    note.value = 'still here';
    const original = frame.srcdoc;
    win.Theme.setGlassIntensity(20);
    deliver(reader, win, engine.getTheme(frame));
    expect(reader.PanelPresentation.getTheme().appearance.glassIntensity).toBe(20);
    win.Theme.setTransparency(0);
    deliver(reader, win, engine.getTheme(frame));
    expect(root.style.getPropertyValue('--pp-page-bg')).toBe(engine.getTheme().tokens['--pp-bg']);
    expect(reader.PanelPresentation.getTheme().appearance.material).toBe('solid');
    expect(note.value).toBe('still here');
    expect(frame.srcdoc).toBe(original);
    win.Theme.setTransparency(50);
    const exported = child(engine.snapshot(frame), win);
    expect(exported.PanelPresentation.getTheme().appearance).toEqual({ material: 'solid', transparency: 0, glassIntensity: 0 });
    expect(exported.document.documentElement.style.getPropertyValue('--pp-page-bg')).toBe(engine.getTheme().tokens['--pp-bg']);
  });

  it('keeps ordinary browser docks opaque even with stored native preferences', () => {
    const { win, frame, engine } = host({ transparency: 50, glass: 40 });
    const dock = win.document.createElement('div');
    dock.className = 'fp-dock';
    win.document.body.appendChild(dock);
    dock.appendChild(frame);
    engine.mount(frame, html);
    const reader = child(frame.srcdoc, win);
    expect(reader.PanelPresentation.getTheme().appearance).toEqual({ material: 'solid', transparency: 0, glassIntensity: 0 });
    expect(reader.document.documentElement.style.getPropertyValue('--pp-page-bg')).not.toBe('transparent');
  });

  it('leaves ordinary HTML, unsupported versions and unrelated metadata untouched', () => {
    const { frame, engine } = host();
    for (const content of ['<h1>Own design</h1>', html.replace('content="1"', 'content="2"'),
      '<script>var text = \'<meta name="anymux-presentation" content="1">\';</script>']) {
      engine.mount(frame, content);
      expect(frame.srcdoc).toBe(content);
      expect(frame.hasAttribute('data-panel-presentation')).toBe(false);
    }
  });

  it('provides the exact active palette before page scripts, for every supported theme', () => {
    const { win, frame, engine } = host();
    for (const theme of win.Theme.getThemeList()) {
      win.Theme.apply(theme.id);
      engine.mount(frame, html);
      const reader = child(frame.srcdoc, win);
      expect(reader.PanelPresentation.getTheme().themeId).toBe(theme.id);
      expect(reader.document.documentElement.style.getPropertyValue('--pp-bg')).toBe(theme.colors['--workspace-bg']);
      expect(reader.document.documentElement.style.getPropertyValue('--pp-fg')).toBe(theme.colors['--workspace-text']);
      expect(reader.document.documentElement.style.colorScheme).toBe(theme.colorScheme);
      expect(reader.runs).toBe(1);
    }
  });

  it('updates variables and chart notifications without replacing the document or losing state', () => {
    const { win, frame, engine } = host();
    engine.mount(frame, html);
    const originalSrcdoc = frame.srcdoc;
    const reader = child(originalSrcdoc, win);
    const input = reader.document.querySelector('input');
    input.value = 'my note';
    const listener = vi.fn();
    reader.document.addEventListener('panel-theme-change', listener);
    win.Theme.apply('github-light');
    deliver(reader, win, engine.getTheme());
    expect(reader.document.querySelector('input')).toBe(input);
    expect(input.value).toBe('my note');
    expect(reader.document.querySelector('details').open).toBe(true);
    expect(reader.runs).toBe(1);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0].detail.themeId).toBe('github-light');
    expect(frame.srcdoc).toBe(originalSrcdoc);
    expect(reader.document.documentElement.style.getPropertyValue('--pp-bg')).toBe('#ffffff');
  });

  it('rejects messages from other windows, origins, versions and invalid CSS values', () => {
    const { win, frame, engine } = host();
    engine.mount(frame, html);
    const reader = child(frame.srcdoc, win);
    const initial = reader.PanelPresentation.getTheme();
    win.Theme.apply('github-light');
    const next = engine.getTheme();
    deliver(reader, win, next, { source: reader });
    deliver(reader, win, next, { origin: 'https://other.test' });
    deliver(reader, win, { ...next, version: 2 });
    deliver(reader, win, { ...next, tokens: { ...next.tokens, '--pp-bg': 'url(https://other.test)' } });
    for (const appearance of [
      { material: 'url(https://other.test)', transparency: 25, glassIntensity: 20 },
      { material: 'native-glass', transparency: 0, glassIntensity: 20 },
      { material: 'native-glass', transparency: 51, glassIntensity: 20 },
      { material: 'native-glass', transparency: NaN, glassIntensity: 20 },
      { material: 'native-glass', transparency: 25, glassIntensity: 101 },
    ]) deliver(reader, win, { ...next, appearance });
    deliver(reader, win, null);
    expect(reader.PanelPresentation.getTheme()).toBe(initial);
    deliver(reader, win, next);
    expect(reader.PanelPresentation.getTheme().themeId).toBe('github-light');
    const { appearance: _appearance, ...legacy } = next;
    deliver(reader, win, legacy);
    expect(reader.PanelPresentation.getTheme().appearance.material).toBe('solid');
  });

  it('sends the latest palette after load and snapshots the current theme without modifying the source', () => {
    const { win, frame, engine } = host();
    engine.mount(frame, html);
    const post = vi.spyOn(frame.contentWindow, 'postMessage');
    win.Theme.apply('oyster'); // changed while the document was loading
    frame.dispatchEvent(new win.Event('load'));
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ themeId: 'oyster', version: 1 }), '*');
    const exported = child(engine.snapshot(frame), win);
    expect(exported.PanelPresentation.getTheme().themeId).toBe('oyster');
    expect(frame.__panelPresentationSource).toBe(html);
    expect(Object.keys(engine.getTheme()).sort()).toEqual(['appearance', 'colorScheme', 'themeId', 'tokens', 'type', 'version']);
    expect(Object.values(engine.getTheme().tokens).every((value) => /^#[\da-f]{6}$/i.test(value))).toBe(true);
  });

  it('keeps the example readable outside the panel and draws its canvas again on theme notifications', () => {
    const fills = vi.fn();
    const win = new JSDOM(example, { runScripts: 'dangerously', beforeParse(window) {
      window.HTMLCanvasElement.prototype.getContext = () => ({ clearRect() {}, fillRect: fills });
    } }).window;
    windows.push(win);
    expect(win.document.querySelector('input')).not.toBeNull();
    expect(fills).toHaveBeenCalledTimes(3);
    win.document.dispatchEvent(new win.CustomEvent('panel-theme-change'));
    expect(fills).toHaveBeenCalledTimes(6);
  });
});
