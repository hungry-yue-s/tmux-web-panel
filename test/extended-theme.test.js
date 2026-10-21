import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const themeSource = readFileSync('public/js/theme.js', 'utf8');
const terminalSource = readFileSync('public/js/terminal.js', 'utf8');
const serversSource = readFileSync('public/js/servers.js', 'utf8');
const msAppSource = readFileSync('public/js/ms-app.js', 'utf8');
const indexSource = readFileSync('public/index.html', 'utf8');

let dom;

function loadTheme(themeId, { native = false, transparency, legacyNative = false, glass, appearance = false } = {}) {
  dom = new JSDOM('<!doctype html><html><body></body></html>', {
    runScripts: 'outside-only',
    url: 'https://tmux-panel.test/',
  });
  if (themeId) dom.window.localStorage.setItem('tmux_theme', themeId);
  if (transparency !== undefined) dom.window.localStorage.setItem('tmux_native_transparency', transparency);
  if (glass !== undefined) dom.window.localStorage.setItem('tmux_native_glass_intensity', glass);
  if (appearance) dom.window.webkit = {
    messageHandlers: { tmuxPanelAppearance: { postMessage: vi.fn() } },
  };
  if (native) dom.window.__tmuxPanelTransparency = true;
  if (legacyNative) dom.window.document.documentElement.classList.add('tmux-native-shell');
  dom.window.eval(themeSource);
  return dom.window.Theme;
}

function renderSettings() {
  dom.window.AppShell = { escape: String, setHeader: vi.fn() };
  dom.window.Store = { getState: () => ({ ui: { showPerformance: true } }) };
  dom.window.eval(serversSource);
  dom.window.document.body.innerHTML = dom.window.ServersPage.renderSettings();
}

function storageChange(key, value) {
  if (key === null) dom.window.localStorage.clear();
  else if (value === null) dom.window.localStorage.removeItem(key);
  else dom.window.localStorage.setItem(key, value);
  dom.window.dispatchEvent(new dom.window.StorageEvent('storage', {
    key,
    newValue: value,
    storageArea: dom.window.localStorage,
  }));
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
    expect(indexSource).toContain('/js/theme.js?v=6');
    expect(indexSource).toContain('/js/file-preview.js?v=44');
  });
});

// Independent WCAG calculation for opaque colors and an 8% backdrop stress case.
// This does not guarantee contrast at arbitrary user-selected window transparency.
function contrastRatio(foreground, background) {
  const linear = (value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (color) => color.reduce((sum, value, index) =>
    sum + linear(value) * [0.2126, 0.7152, 0.0722][index], 0);
  const [a, b] = [luminance(foreground), luminance(background)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const channels = (color) => [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16));

describe('workbench semantic palettes', () => {
  it('keeps all saved themes and adds Deep Current without changing the default', () => {
    const Theme = loadTheme();
    expect(Theme.getCurrent()).toBe('tokyo-night');
    expect(Theme.getThemeList().map(({ id }) => id)).toEqual(expect.arrayContaining([
      'deep-current', 'tokyo-night', 'catppuccin-mocha', 'dracula', 'nord', 'solarized-dark',
      'solarized-light', 'github-light', 'gruvbox-dark', 'one-dark',
      'catppuccin-mocha-pastel', 'rose-pine-moon', 'tokyo-night-storm',
    ]));
    expect(Theme.getThemeList()).toHaveLength(13);
  });

  it('provides readable text and accent across opaque surfaces and lightly tinted backdrops', () => {
    const Theme = loadTheme();
    for (const { id, colors } of Theme.getThemeList()) {
      Theme.apply(id);
      const root = dom.window.document.documentElement;
      const alpha = 0.92;
      const scheme = ['github-light', 'solarized-light'].includes(id) ? 'light' : 'dark';
      expect(root.style.colorScheme, id).toBe(scheme);
      for (const surface of ['bg', 'sidebar', 'panel', 'hover']) {
        const hex = colors['--workspace-' + surface];
        expect(hex, id + ': ' + surface).toMatch(/^#[0-9a-f]{6}$/i);
        expect(root.style.getPropertyValue('--workspace-' + surface)).toBe(hex);
        const opaque = channels(hex);
        // Stress the surface with 8% black/white, independently of native sliders.
        const backdrops = [opaque, ...[0, 255].map((value) =>
          opaque.map((channel) => channel * alpha + value * (1 - alpha)))];
        for (const background of backdrops) {
          for (const name of ['text', 'muted', 'accent']) {
            const contrast = contrastRatio(channels(colors['--workspace-' + name]), background);
            expect(contrast, id + '/' + surface + '/' + name).toBeGreaterThanOrEqual(4.5);
          }
          expect(contrastRatio(channels(colors['--workspace-line-strong']), background),
            id + '/' + surface + '/control boundary').toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  it('keeps terminal ANSI semantic colors independent from workbench contrast corrections', () => {
    const Theme = loadTheme();
    for (const [id, foreground, blue, red] of [
      ['tokyo-night', '#c0caf5', '#7aa2f7', '#f7768e'],
      ['catppuccin-mocha', '#cdd6f4', '#89b4fa', '#f38ba8'],
      ['dracula', '#f8f8f2', '#bd93f9', '#ff5555'],
      ['nord', '#d8dee9', '#81a1c1', '#bf616a'],
      ['solarized-dark', '#839496', '#268bd2', '#dc322f'],
      ['solarized-light', '#657b83', '#268bd2', '#dc322f'],
      ['github-light', '#1f2328', '#0969da', '#cf222e'],
      ['gruvbox-dark', '#ebdbb2', '#458588', '#cc241d'],
      ['one-dark', '#abb2bf', '#61afef', '#e06c75'],
      ['catppuccin-mocha-pastel', '#cdd6f4', '#89b4fa', '#f38ba8'],
      ['rose-pine-moon', '#e0def4', '#9ccfd8', '#eb6f92'],
      ['tokyo-night-storm', '#c0caf5', '#7aa2f7', '#f7768e'],
    ]) {
      expect(Theme.getTerminalTheme(id), id).toMatchObject({ foreground, blue, red });
    }
    const palette = Theme.getTerminalTheme('deep-current');
    expect(palette.blue).toBe('#7aa2f7');
    expect(palette.cursor).toBe('#edbd8b');
    palette.blue = '#000000';
    expect(Theme.getTerminalTheme('deep-current').blue).toBe('#7aa2f7');
  });
});

describe('native glass intensity', () => {
  it('only exposes the control on clients with the native appearance bridge', () => {
    const Theme = loadTheme(null, { native: true, glass: '35' });
    renderSettings();
    Theme.setGlassIntensity(0);
    expect(Theme.supportsGlassIntensity()).toBe(false);
    expect(dom.window.document.getElementById('native-glass-intensity')).toBeNull();
    expect(dom.window.localStorage.getItem('tmux_native_glass_intensity')).toBe('35');
  });

  it('preserves the current material by default and bounds values before sending them to native', () => {
    const Theme = loadTheme(null, { native: true, appearance: true });
    const send = dom.window.webkit.messageHandlers.tmuxPanelAppearance.postMessage;
    expect(Theme.getGlassIntensity()).toBe(100);
    expect(send).toHaveBeenLastCalledWith({ glassIntensity: 100 });
    for (const [value, expected] of [[0, 0], [34.7, 35], [150, 100], [-10, 0], ['bad', 100]]) {
      Theme.setGlassIntensity(value);
      expect(Theme.getGlassIntensity()).toBe(expected);
      expect(send).toHaveBeenLastCalledWith({ glassIntensity: expected });
      expect(dom.window.localStorage.getItem('tmux_native_glass_intensity')).toBe(String(expected));
    }
  });

  it('restores, applies and synchronizes an independent accessible glass slider', () => {
    const Theme = loadTheme(null, { native: true, appearance: true, glass: '65', transparency: '40' });
    renderSettings();
    dom.window.eval(msAppSource);
    dom.window.MsApp._bindEvents();
    const slider = dom.window.document.getElementById('native-glass-intensity');
    const output = dom.window.document.getElementById('native-glass-intensity-value');
    const send = dom.window.webkit.messageHandlers.tmuxPanelAppearance.postMessage;
    expect(slider.labels[0].textContent).toBe('毛玻璃强度');
    expect([slider.type, slider.min, slider.max, slider.value]).toEqual(['range', '0', '100', '65']);
    expect(send).toHaveBeenLastCalledWith({ glassIntensity: 65 });

    slider.value = '25';
    slider.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(output.textContent).toBe('25%');
    expect(send).toHaveBeenLastCalledWith({ glassIntensity: 25 });
    expect(Theme.getTransparency()).toBe(40);

    storageChange('tmux_native_glass_intensity', '80');
    expect(slider.value).toBe('80');
    expect(output.textContent).toBe('80%');
    expect(send).toHaveBeenLastCalledWith({ glassIntensity: 80 });
    Theme.apply('github-light');
    expect(Theme.getGlassIntensity()).toBe(80);
    storageChange('tmux_native_glass_intensity', null);
    expect(slider.value).toBe('100');
    expect(send).toHaveBeenLastCalledWith({ glassIntensity: 100 });
  });
});

describe('native window transparency', () => {
  it.each([false, true])('keeps unsupported clients opaque with saved preferences (legacy native: %s)', (legacyNative) => {
    const Theme = loadTheme('rose-pine-moon', { transparency: '35', legacyNative });
    const root = dom.window.document.documentElement;
    renderSettings();

    Theme.setTransparency(50);
    expect(dom.window.localStorage.getItem('tmux_native_transparency')).toBe('35');
    storageChange('tmux_native_transparency', '40');

    expect(Theme.supportsTransparency()).toBe(false);
    expect(Theme.getTransparency()).toBe(0);
    expect(Theme.getTerminalTheme().background).toBe('#232136');
    expect(root.hasAttribute('data-native-transparency')).toBe(false);
    expect(dom.window.document.getElementById('native-transparency')).toBeNull();
    expect(dom.window.localStorage.getItem('tmux_native_transparency')).toBe('40');
  });

  it('defaults to opaque and persists only a bounded integer percentage', () => {
    const Theme = loadTheme(null, { native: true });
    const changed = vi.fn();
    dom.window.document.addEventListener('tmux-transparency-change', changed);

    expect(Theme.supportsTransparency()).toBe(true);
    expect(Theme.getTransparency()).toBe(0);
    for (const [input, expected] of [[27.6, 28], [90, 50], [-10, 0], ['invalid', 0]]) {
      Theme.setTransparency(input);
      expect(Theme.getTransparency()).toBe(expected);
      expect(dom.window.localStorage.getItem('tmux_native_transparency')).toBe(String(expected));
      expect(dom.window.document.documentElement.hasAttribute('data-native-transparency')).toBe(expected > 0);
    }
    expect(changed).toHaveBeenCalledTimes(4);
  });

  it('restores transparency and keeps palette colors intact across theme changes', () => {
    const Theme = loadTheme('rose-pine-moon', { native: true, transparency: '25' });
    const root = dom.window.document.documentElement;

    expect(Theme.getTransparency()).toBe(25);
    expect(root.style.getPropertyValue('--native-window-background')).toBe('rgba(35, 33, 54, 0.75)');
    expect(Theme.getTerminalTheme().background).toBe('rgba(0, 0, 0, 0)');

    Theme.apply('github-light');
    const transparentPalette = Theme.getTerminalTheme();
    expect(Theme.getTransparency()).toBe(25);
    expect(root.style.getPropertyValue('--native-window-background')).toBe('rgba(255, 255, 255, 0.75)');
    expect(root.style.getPropertyValue('--bg-primary')).toBe('#ffffff');

    Theme.setTransparency(0);
    expect(Theme.getTerminalTheme()).toEqual({ ...transparentPalette, background: '#ffffff' });
    expect(root.hasAttribute('data-native-transparency')).toBe(false);
  });

  it('updates mounted terminals when preferences change locally or in another window', () => {
    const Theme = loadTheme(null, { native: true });
    dom.window.eval(terminalSource);
    const term = { options: { theme: Theme.getTerminalTheme() } };
    dom.window.terminalState.term = term;

    Theme.setTransparency(30);
    expect(term.options.theme.background).toBe('rgba(0, 0, 0, 0)');

    storageChange('tmux_theme', 'rose-pine-moon');
    expect(dom.window.document.documentElement.getAttribute('data-theme')).toBe('rose-pine-moon');
    expect(term.options.theme.foreground).toBe('#e0def4');
    expect(term.options.theme.background).toBe('rgba(0, 0, 0, 0)');

    storageChange('tmux_native_transparency', '15');
    expect(Theme.getTransparency()).toBe(15);
    expect(dom.window.document.documentElement.style.getPropertyValue('--native-window-background'))
      .toBe('rgba(35, 33, 54, 0.85)');

    storageChange('tmux_native_transparency', null);
    expect(term.options.theme.background).toBe('#232136');

    storageChange(null, null);
    expect(Theme.getTransparency()).toBe(0);
    expect(term.options.theme.background).toBe('#1a1b26');
  });

  it('renders an accessible native slider and applies delegated input immediately', () => {
    const Theme = loadTheme(null, { native: true, transparency: '20' });
    renderSettings();
    dom.window.eval(msAppSource);
    dom.window.MsApp._bindEvents();
    const slider = dom.window.document.getElementById('native-transparency');
    const output = dom.window.document.getElementById('native-transparency-value');

    expect(slider.type).toBe('range');
    expect([slider.min, slider.max, slider.step, slider.value]).toEqual(['0', '50', '1', '20']);
    expect(slider.labels[0].textContent).toBe('背景透明度');
    expect(output.textContent).toBe('20%');

    storageChange('tmux_native_transparency', '40');
    expect(slider.value).toBe('40');
    expect(output.textContent).toBe('40%');

    slider.value = '35';
    slider.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    expect(Theme.getTransparency()).toBe(35);
    expect(output.textContent).toBe('35%');
    expect(dom.window.localStorage.getItem('tmux_native_transparency')).toBe('35');
    expect(dom.window.document.documentElement.hasAttribute('data-native-transparency')).toBe(true);
  });
});
