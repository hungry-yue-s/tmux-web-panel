import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('terminal font configuration', () => {
  it('uses the bundled Maple Mono build in both terminal entry points', () => {
    const sources = [
      readFileSync(resolve(import.meta.dirname, '../public/js/terminal.js'), 'utf8'),
      readFileSync(resolve(import.meta.dirname, '../public/terminal.html'), 'utf8'),
    ];

    for (const source of sources) {
      expect(source).toContain("'Tmux Panel Mono', 'Maple Mono NF CN'");
      expect(source).toContain("fontFamily: 'monospace'");
      // Only the core slice is awaited, and only briefly.
      expect(source).toContain('TerminalFonts.coreReady(');
      expect(source).toContain('TerminalFonts.ensure(');
    }
  });

  it('ships the bundled faces as unicode-range slices and preloads only the small core', () => {
    const publicDir = resolve(import.meta.dirname, '../public');
    const fontCss = readFileSync(resolve(publicDir, 'css/terminal-fonts.css'), 'utf8');
    const data = readFileSync(resolve(publicDir, 'js/terminal-fonts-data.js'), 'utf8');
    const license = readFileSync(resolve(publicDir, 'fonts/OFL-MapleMono.txt'), 'utf8');
    const slices = JSON.parse(data.slice(data.indexOf('{'), data.lastIndexOf('}') + 1));

    for (const page of ['index.html', 'terminal.html']) {
      const html = readFileSync(resolve(publicDir, page), 'utf8');
      for (const weight of ['400', '700']) {
        const core = slices.core[weight];
        expect(html).toContain(`rel="preload" href="/fonts/tpm/${core}"`);
        const file = readFileSync(resolve(publicDir, 'fonts/tpm', core));
        expect(file.subarray(0, 4).toString('ascii')).toBe('wOF2');
        expect(file.length).toBeLessThan(120_000);
        expect(fontCss).toContain(`/fonts/tpm/${core}`);
      }
      // The full multi-megabyte faces are never preloaded again.
      expect(html).not.toContain('TmuxPanelMono-Regular.woff2');
      expect(html).not.toContain('TmuxPanelMono-Bold.woff2');
    }
    expect(fontCss).toMatch(/font-family: 'Tmux Panel Mono'[\s\S]*unicode-range: U\+/);
    for (const slice of slices.slices) {
      for (const name of Object.values(slice.files)) {
        expect(readFileSync(resolve(publicDir, 'fonts/tpm', name)).subarray(0, 4).toString('ascii')).toBe('wOF2');
      }
    }
    // The 3755 common hanzi are spread over the han-a slices, declared last so they win.
    const common = slices.slices.filter((s) => s.id.startsWith('han-a'));
    expect(common.reduce((n, s) => n + [...s.chars].length, 0)).toBe(3755);
    expect(slices.slices.at(-1).id).toMatch(/^han-a/);
    expect(license).toContain('SIL OPEN FONT LICENSE Version 1.1');
  });

  it('restores macOS text rendering only inside the Swift shell', () => {
    const styleSource = readFileSync(
      resolve(import.meta.dirname, '../public/css/style.css'),
      'utf8',
    );
    const webViewSource = readFileSync(
      resolve(import.meta.dirname, '../macos/TmuxPanel/Sources/TmuxPanel/PanelWebView.swift'),
      'utf8',
    );

    expect(webViewSource).toContain("classList.add('tmux-native-shell')");
    expect(styleSource).toMatch(/html\.tmux-native-shell body\s*\{[\s\S]*?-webkit-font-smoothing:\s*auto/);
  });

  it('opens the standalone terminal window at the final size too', () => {
    const page = readFileSync(resolve(import.meta.dirname, '../public/terminal.html'), 'utf8');
    expect(page).not.toContain('firstWrite');
    expect(page).toContain('fontSettled.then(connect)');
    // Without these the server attaches at 80x24 and a resize then replaces the client.
    expect(page).toMatch(/'\?cols=' \+ encodeURIComponent\(term\.cols\) \+ '&rows=' \+ encodeURIComponent\(term\.rows\)/);
    const connect = page.slice(page.indexOf('function connect()'), page.indexOf('new WebSocket(wsUrl)'));
    expect(connect).toContain('fitAddon.fit()');
  });

  it('rebuilds the WebGL glyph atlas after the bundled font finishes loading', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../public/js/terminal.js'), 'utf8');
    const fontReady = source.indexOf('var rendererReady = _coreFontWait().then');

    expect(fontReady).toBeGreaterThan(-1);
    expect(source.indexOf('term.loadAddon(webglAddon)')).toBeGreaterThan(fontReady);
    expect(source.indexOf('term.options.fontFamily = TERMINAL_FONT_FAMILY', fontReady)).toBeGreaterThan(fontReady);
    expect(source.indexOf('term.options.fontFamily = TERMINAL_FONT_FAMILY', fontReady))
      .toBeLessThan(source.indexOf('term.loadAddon(webglAddon)'));
    expect(source.indexOf('term.clearTextureAtlas()', fontReady)).toBeGreaterThan(fontReady);
    expect(source.indexOf('term.refresh(0, term.rows - 1)', fontReady)).toBeGreaterThan(fontReady);
    expect(source.slice(fontReady, source.indexOf('\n  }', fontReady)))
      .toContain('terminalState.term !== term');
  });
});
