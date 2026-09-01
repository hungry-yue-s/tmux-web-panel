import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const PERF_UTILS = readFileSync('public/js/perf-utils.js', 'utf8');
const PERF_PANEL = readFileSync('public/js/perf-panel.js', 'utf8');
const INDEX = readFileSync('public/index.html', 'utf8');

/**
 * Loads the real component instead of a stub. The multi-server shell reaches it
 * as window.PerfPanel, and a test double for that global cannot prove the real
 * file publishes it.
 */
function loadRealPerfPanel() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost/',
    runScripts: 'outside-only',
  });
  const win = dom.window;
  win.eval(PERF_UTILS);
  win.eval(PERF_PANEL);
  return win;
}

describe('PerfPanel real load', () => {
  it('publishes itself on window so the shell can resolve it', () => {
    const win = loadRealPerfPanel();
    expect(typeof win.PerfPanel).toBe('object');
    expect(win.PerfPanel).not.toBeNull();
  });

  it('exposes the lifecycle the shell calls', () => {
    const win = loadRealPerfPanel();
    expect(typeof win.PerfPanel.renderSkeleton).toBe('function');
    expect(typeof win.PerfPanel.start).toBe('function');
    expect(typeof win.PerfPanel.stop).toBe('function');
  });

  it('depends on PerfUtils being loaded first', () => {
    expect(PERF_PANEL).toContain('window.PerfUtils');
    const utilsAt = INDEX.indexOf('/js/perf-utils.js');
    const panelAt = INDEX.indexOf('/js/perf-panel.js');
    expect(utilsAt).toBeGreaterThan(-1);
    expect(panelAt).toBeGreaterThan(utilsAt);
  });

  it('renders a skeleton carrying machine, Claude and Codex views', () => {
    const win = loadRealPerfPanel();
    const html = win.PerfPanel.renderSkeleton();
    expect(html).toContain('id="perf-panel"');
    expect(html).toContain('机器性能');
    expect(html).toContain('Claude 用量');
    expect(html).toContain('Codex 用量');
    // The drill-down and history views mount into these roots.
    expect(html).toContain('id="perf-view-root"');
    expect(html).toContain('id="claude-view-root"');
    expect(html).toContain('id="codex-view-root"');
  });

  it('stop() is safe before start()', () => {
    const win = loadRealPerfPanel();
    expect(() => win.PerfPanel.stop()).not.toThrow();
  });

  it('is served with a cache-busting version', () => {
    expect(INDEX).toMatch(/\/js\/perf-panel\.js\?v=\d+/);
  });
});
