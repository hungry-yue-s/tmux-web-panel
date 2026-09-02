import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const themeSource = readFileSync('public/js/theme.js', 'utf8');
const appSource = readFileSync('public/js/app.js', 'utf8');
const terminalSource = readFileSync('public/js/terminal.js', 'utf8');
const styles = readFileSync('public/css/style.css', 'utf8');
const indexSource = readFileSync('public/index.html', 'utf8');

let dom;

function loadTheme(themeId) {
  dom = new JSDOM('<!doctype html><html><body></body></html>', {
    runScripts: 'outside-only',
    url: 'https://tmux-panel.test/',
  });
  if (themeId) dom.window.localStorage.setItem('tmux_theme', themeId);
  dom.window.eval(themeSource);
  return dom.window.Theme;
}

afterEach(() => {
  if (dom) dom.window.close();
  dom = null;
});

describe('extended terminal themes', () => {
  it('registers all three additional opaque palettes', () => {
    const Theme = loadTheme();
    const addedThemes = Theme.getThemeList().slice(-3);

    expect(addedThemes.map((theme) => theme.id)).toEqual([
      'catppuccin-mocha-pastel',
      'rose-pine-moon',
      'tokyo-night-storm',
    ]);
    expect(addedThemes.map((theme) => theme.name)).toEqual([
      'Catppuccin Mocha Pastel',
      'Rosé Pine Moon',
      'Tokyo Night Storm',
    ]);
  });

  it('applies an opaque palette to both UI and terminal', () => {
    const Theme = loadTheme('rose-pine-moon');

    expect(Theme.getCurrent()).toBe('rose-pine-moon');
    expect(Theme.getTerminalTheme().background).toBe('#232136');
    expect(dom.window.document.documentElement.getAttribute('data-theme')).toBe('rose-pine-moon');
    expect(dom.window.document.documentElement.style.getPropertyValue('--bg-primary')).toBe('#232136');
  });

  it('announces theme changes so rendered previews can rebuild embedded colors', () => {
    const Theme = loadTheme();
    const listener = vi.fn();
    dom.window.document.addEventListener('tmux-theme-change', listener);

    Theme.apply('github-light');

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0].detail.themeId).toBe('github-light');
  });

  it('bumps browser caches for the theme-aware Mermaid scripts', () => {
    expect(indexSource).toContain('/js/theme.js?v=4');
    expect(indexSource).toContain('/js/file-preview.js?v=40');
  });

  it('does not expose the removed transparency UI or xterm option', () => {
    loadTheme();

    expect(appSource).not.toContain('glass-transparency');
    expect(terminalSource).not.toContain('allowTransparency');
    expect(styles).not.toContain('data-glass');
    expect(themeSource).not.toContain('setGlassTransparency');
  });
});
