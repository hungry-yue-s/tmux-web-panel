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
    expect(indexSource).toContain('/css/style.css?v=13');
    expect(indexSource).toContain('/js/app-fullscreen.js?v=1');
    expect(indexSource).toContain('/js/app.js?v=11');
  });
});
