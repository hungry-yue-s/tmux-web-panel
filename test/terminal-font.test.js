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
      expect(source).toContain("fontFamily: \"'Tmux Panel Mono', 'Maple Mono NF CN'");
    }
  });

  it('ships and preloads complete WOFF2 regular and bold faces', () => {
    const publicDir = resolve(import.meta.dirname, '../public');
    const styleSource = readFileSync(resolve(publicDir, 'css/style.css'), 'utf8');
    const indexSource = readFileSync(resolve(publicDir, 'index.html'), 'utf8');
    const regular = readFileSync(resolve(publicDir, 'fonts/TmuxPanelMono-Regular.woff2'));
    const bold = readFileSync(resolve(publicDir, 'fonts/TmuxPanelMono-Bold.woff2'));
    const license = readFileSync(resolve(publicDir, 'fonts/OFL-MapleMono.txt'), 'utf8');

    expect(regular.subarray(0, 4).toString('ascii')).toBe('wOF2');
    expect(bold.subarray(0, 4).toString('ascii')).toBe('wOF2');
    expect(regular.length).toBeGreaterThan(1_000_000);
    expect(bold.length).toBeGreaterThan(1_000_000);
    expect(styleSource).toMatch(/font-family:\s*'Tmux Panel Mono'[\s\S]*?TmuxPanelMono-Regular\.woff2/);
    expect(styleSource).toMatch(/font-family:\s*'Tmux Panel Mono'[\s\S]*?TmuxPanelMono-Bold\.woff2/);
    expect(indexSource).toContain('rel="preload" href="/fonts/TmuxPanelMono-Regular.woff2?v=1"');
    expect(indexSource).toContain('rel="preload" href="/fonts/TmuxPanelMono-Bold.woff2?v=1"');
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
});
