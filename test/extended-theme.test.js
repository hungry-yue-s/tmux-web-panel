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
  it('registers four distinct new palettes and their preview metadata', () => {
    const Theme = loadTheme();
    for (const id of ['prism', 'graphite', 'forest-ink', 'oyster']) {
      const theme = Theme.getThemeList().find((entry) => entry.id === id);
      expect(theme.description).toBeTruthy();
      expect(theme.terminal.background).toBe(theme.colors['--workspace-bg']);
      expect(theme.colorScheme).toBe(id === 'oyster' ? 'light' : 'dark');
    }
  });

  it('applies a new palette to both UI and terminal', () => {
    const Theme = loadTheme('prism');
    expect(Theme.getCurrent()).toBe('prism');
    expect(Theme.getTerminalTheme().background).toBe('#191923');
    expect(dom.window.document.documentElement.getAttribute('data-theme')).toBe('prism');
    expect(dom.window.document.documentElement.style.getPropertyValue('--bg-primary')).toBe('#191923');
  });

  it.each([
    ['tokyo-night-storm', 'tokyo-night'], ['catppuccin-mocha', 'prism'],
    ['catppuccin-mocha-pastel', 'prism'], ['rose-pine-moon', 'prism'],
    ['dracula', 'prism'], ['one-dark', 'graphite'], ['solarized-dark', 'deep-current'],
  ])('migrates retired %s to %s for saved and explicit choices', (oldId, newId) => {
    const Theme = loadTheme(oldId, { native: true, transparency: '25', glass: '65', appearance: true });
    expect(Theme.getCurrent()).toBe(newId);
    expect(dom.window.localStorage.getItem('tmux_theme')).toBe(newId);
    expect(Theme.getThemeList().some((theme) => theme.id === oldId)).toBe(false);
    expect(Theme.getTerminalTheme(oldId)).toEqual(Theme.getTerminalTheme(newId));
    expect(Theme.getName(oldId)).toBe(Theme.getName(newId));
    expect([Theme.getTransparency(), Theme.getGlassIntensity()]).toEqual([25, 65]);
    Theme.apply('github-light');
    storageChange('tmux_theme', oldId);
    expect(Theme.getCurrent()).toBe(newId);
    expect(dom.window.document.documentElement.getAttribute('data-theme')).toBe(newId);
    expect(dom.window.localStorage.getItem('tmux_theme')).toBe(newId);
  });

  it.each(['unknown-theme', '__proto__', 'toString'])('safely falls back for invalid saved theme %s', (id) => {
    const Theme = loadTheme(id);
    expect(Theme.getCurrent()).toBe('tokyo-night');
    Theme.apply(id);
    expect(Theme.getCurrent()).toBe('tokyo-night');
    expect(Theme.getTerminalTheme(id)).toEqual(Theme.getTerminalTheme('tokyo-night'));
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
    expect(indexSource).toContain('/js/theme.js?v=7');
    expect(indexSource).toContain('/js/terminal.js?v=22');
    expect(indexSource).toContain('/css/style.css?v=51');
    expect(indexSource).toContain('/js/file-preview.js?v=45');
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
  it('curates ten choices while retaining the existing default', () => {
    const Theme = loadTheme();
    expect(Theme.getCurrent()).toBe('tokyo-night');
    expect(Theme.getThemeList().map(({ id }) => id)).toEqual([
      'prism', 'graphite', 'deep-current', 'forest-ink', 'tokyo-night', 'nord',
      'gruvbox-dark', 'oyster', 'solarized-light', 'github-light',
    ]);
  });

  it('provides readable text and accent across opaque surfaces and lightly tinted backdrops', () => {
    const Theme = loadTheme();
    for (const { id, colors } of Theme.getThemeList()) {
      Theme.apply(id);
      const root = dom.window.document.documentElement;
      const alpha = 0.92;
      const scheme = ['github-light', 'solarized-light', 'oyster'].includes(id) ? 'light' : 'dark';
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

  it('preserves classic ANSI slots used by TUI backgrounds and reverse video', () => {
    const Theme = loadTheme();
    for (const [id, unchanged] of [
      ['tokyo-night', { foreground: '#c0caf5', blue: '#7aa2f7', red: '#f7768e' }],
      ['nord', { foreground: '#d8dee9', blue: '#81a1c1', green: '#a3be8c' }],
      ['github-light', { foreground: '#1f2328', blue: '#0969da', red: '#cf222e' }],
      ['gruvbox-dark', { foreground: '#ebdbb2', green: '#98971a', yellow: '#d79921' }],
    ]) {
      expect(Theme.getTerminalTheme(id), id).toMatchObject(unchanged);
    }
    expect(Theme.getTerminalTheme('tokyo-night').brightBlack).toBe('#414868');
    expect(Theme.getTerminalTheme('nord').red).toBe('#bf616a');
    expect(Theme.getTerminalTheme('gruvbox-dark').blue).toBe('#458588');
    expect(Theme.getTerminalTheme('solarized-light').brightWhite).toBe('#fdf6e3');
    const palette = Theme.getTerminalTheme('deep-current');
    expect(palette.blue).toBe('#7aa2f7');
    expect(palette.cursor).toBe('#edbd8b');
    palette.blue = '#000000';
    expect(Theme.getTerminalTheme('deep-current').blue).toBe('#7aa2f7');
  });

  it('corrects default text and selection contrast while keeping new ANSI palettes readable', () => {
    const Theme = loadTheme();
    const ansi = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
      'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];
    for (const { id } of Theme.getThemeList()) {
      const palette = Theme.getTerminalTheme(id);
      for (const key of ['foreground', 'cursor', ...(['prism', 'graphite', 'forest-ink', 'oyster'].includes(id) ? ansi : [])]) {
        expect(palette[key], id + '/' + key).toMatch(/^#[0-9a-f]{6}$/i);
        expect(contrastRatio(channels(palette[key]), channels(palette.background)), id + '/' + key)
          .toBeGreaterThanOrEqual(4.5);
      }
      expect(contrastRatio(channels(palette.selectionForeground), channels(palette.selectionBackground)), id + '/selection')
        .toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps semantic action text readable in all palettes', () => {
    const Theme = loadTheme();
    for (const { id, colors } of Theme.getThemeList()) {
      for (const color of ['--accent-blue', '--accent-green', '--accent-red', '--accent-yellow', '--accent-purple']) {
        expect(contrastRatio(channels(colors[color]), channels(colors['--bg-primary'])), id + '/' + color)
          .toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('keeps bright text legible on classic ANSI gray backgrounds', () => {
    const Theme = loadTheme();
    for (const id of ['tokyo-night', 'nord', 'solarized-light']) {
      const palette = Theme.getTerminalTheme(id);
      expect(contrastRatio(channels(palette.brightWhite), channels(palette.brightBlack)), id + '/SGR 97;100')
        .toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each([false, true])('enables per-cell contrast in terminal mode nozoom=%s', (nozoom) => {
    loadTheme();
    dom.window.state = { currentPane: '%test', currentServer: 'local' };
    dom.window.eval(terminalSource);
    dom.window.Terminal = function (options) { this.options = options; };
    const term = dom.window.createTerminalInstance(120, 40, nozoom);
    expect(term.options.minimumContrastRatio).toBe(4.5);
    expect(term.options.theme.brightBlack).toBe('#414868');
    expect(term.options.macOptionClickForcesSelection).toBe(!nozoom);
  });

  it('keeps picker previews opaque and isolated from native transparency and caller mutations', () => {
    const Theme = loadTheme('prism', { native: true, transparency: '40' });
    const preview = Theme.getThemeList().find(({ id }) => id === 'prism');
    expect(Theme.getTerminalTheme().background).toBe('rgba(0, 0, 0, 0)');
    expect(preview.terminal.background).toBe('#191923');
    preview.terminal.blue = '#000000';
    expect(Theme.getTerminalTheme().blue).toBe('#a6a5f8');
    renderSettings();
    const card = dom.window.document.querySelector('.theme-card[data-theme="prism"]');
    expect(card.querySelector('.theme-card-description').textContent).toContain('烟紫');
    expect(card.querySelectorAll('.theme-card-swatches i')).toHaveLength(6);
    expect(card.querySelectorAll('.theme-card-swatches i')[3].style.background).toBe('rgb(166, 165, 248)');
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
    const Theme = loadTheme('prism', { transparency: '35', legacyNative });
    const root = dom.window.document.documentElement;
    renderSettings();

    Theme.setTransparency(50);
    expect(dom.window.localStorage.getItem('tmux_native_transparency')).toBe('35');
    storageChange('tmux_native_transparency', '40');

    expect(Theme.supportsTransparency()).toBe(false);
    expect(Theme.getTransparency()).toBe(0);
    expect(Theme.getTerminalTheme().background).toBe('#191923');
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
    const Theme = loadTheme('prism', { native: true, transparency: '25' });
    const root = dom.window.document.documentElement;

    expect(Theme.getTransparency()).toBe(25);
    expect(root.style.getPropertyValue('--native-window-background')).toBe('rgba(25, 25, 35, 0.75)');
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

    storageChange('tmux_theme', 'prism');
    expect(dom.window.document.documentElement.getAttribute('data-theme')).toBe('prism');
    expect(term.options.theme.foreground).toBe('#e8e5f2');
    expect(term.options.theme.background).toBe('rgba(0, 0, 0, 0)');

    storageChange('tmux_native_transparency', '15');
    expect(Theme.getTransparency()).toBe(15);
    expect(dom.window.document.documentElement.style.getPropertyValue('--native-window-background'))
      .toBe('rgba(25, 25, 35, 0.85)');

    storageChange('tmux_native_transparency', null);
    expect(term.options.theme.background).toBe('#191923');

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
