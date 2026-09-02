import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const styles = readFileSync('public/css/style.css', 'utf8');
const appSource = readFileSync('public/js/app.js', 'utf8');
const indexSource = readFileSync('public/index.html', 'utf8');

describe('global UI system', () => {
  it('defines theme-derived surface, radius, control and focus tokens', () => {
    ['--ui-radius-sm', '--ui-radius-md', '--ui-control-sm', '--ui-surface',
      '--ui-border-soft', '--ui-shadow-md'].forEach((token) => {
      expect(styles).toContain(token);
    });
    expect(styles).toContain('button:focus-visible');
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('uses reusable SVG icons for sidebar actions and collapse states', () => {
    expect(appSource).toContain('function _appIcon(name)');
    expect(appSource).toContain('class="app-icon"');
    expect(appSource).toContain("_appIcon('notifications')");
    expect(appSource).toContain("_appIcon('fullscreen')");
    expect(appSource).toContain("_sidebarCollapseContent(collapsed)");
    expect(indexSource.match(/class="app-icon"/g)).toHaveLength(4);
    expect(indexSource).toContain('id="btn-app-fullscreen"');
  });

  it('keeps desktop and mobile navigation layouts explicitly covered', () => {
    expect(styles).toMatch(/#sidebar\.collapsed[\s\S]*?width:\s*52px/);
    expect(styles).toContain('@media (max-width: 767px)');
    expect(styles).toMatch(/#topbar[\s\S]*?min-height:\s*52px/);
    expect(indexSource).toContain('/css/style.css?v=34');
    expect(indexSource).toContain('/js/app-fullscreen.js?v=2');
    expect(indexSource).toContain('/js/app.js?v=13');
  });

  it('lets long status pages scroll without unlocking the terminal viewport', () => {
    expect(styles).toMatch(/\.ms-app\.mode-status \.ms-main,[\s\S]*?\.ms-app\.mode-settings \.ms-main\s*\{[\s\S]*?height:\s*100vh;[\s\S]*?overflow-y:\s*auto/);
    expect(styles).toMatch(/@media \(max-width:\s*760px\)[\s\S]*?\.ms-app\.mode-status \.ms-main,[\s\S]*?height:\s*calc\(100dvh - 64px\);[\s\S]*?overflow-y:\s*auto/);
    expect(styles).toMatch(/\.ms-app\.mode-terminal \.ms-main\s*\{[\s\S]*?height:\s*100vh;[\s\S]*?overflow:\s*hidden/);
    expect(styles).toMatch(/\.ms-content\.terminal-mode\s*\{[\s\S]*?overflow:\s*hidden/);
  });

  it('keeps the new-shell terminal inside the exact remaining content height', () => {
    expect(styles).toMatch(/\.ms-content\.terminal-mode \.terminal-view\s*\{[\s\S]*?height:\s*100%;[\s\S]*?max-height:\s*100%/);
    expect(styles).toMatch(/\.ms-app\.mode-terminal \.ms-main\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) auto/);
    expect(styles).toMatch(/\.ms-app\.mode-terminal \.ms-content\.terminal-mode\s*\{[\s\S]*?grid-column:\s*1;[\s\S]*?grid-row:\s*2;[\s\S]*?height:\s*auto/);
  });
});
