import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const APP = readFileSync('public/js/app.js', 'utf8');
const PERF_UTILS = readFileSync('public/js/perf-utils.js', 'utf8');
const PERF_PANEL = readFileSync('public/js/perf-panel.js', 'utf8');
const SERVERS = readFileSync('public/js/servers.js', 'utf8');

/**
 * The legacy shell still ships in the page, hidden. Both shells build the same
 * element ids, and PerfPanel resolves its roots with getElementById, so a
 * legacy render would capture #perf-panel / #perf-view-root and the visible
 * panel would stay on its loading placeholder.
 */
function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error('not found: ' + signature);
  let depth = 0;
  let i = source.indexOf('{', start);
  const open = i;
  for (; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced: ' + signature);
}

describe('legacy shell does not render behind the multi-server shell', () => {
  it('render() bails out when .ms-app is present', () => {
    const fn = extractFunction(APP, 'function render()');
    const guardAt = fn.indexOf(".querySelector('.ms-app')");
    expect(guardAt).toBeGreaterThan(-1);
    // The guard has to precede every branch that writes into #content.
    expect(guardAt).toBeLessThan(fn.indexOf('switch (state.currentTab)'));
    expect(guardAt).toBeLessThan(fn.indexOf('renderDesktopHome'));
  });

  it('updateSidebar() bails out when .ms-app is present', () => {
    const fn = extractFunction(APP, 'function updateSidebar()');
    const guardAt = fn.indexOf(".querySelector('.ms-app')");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(fn.indexOf('state.sessions.length'));
  });

  it('leaves #content empty so only one perf-panel id set exists', () => {
    const dom = new JSDOM(`<!DOCTYPE html><html><body>
      <div id="legacy-shell" hidden><div id="app"><div id="main-layout">
        <aside id="sidebar"></aside><div id="content"></div>
      </div></div></div>
      <div class="ms-app"><main class="ms-main"><div id="ms-view"></div></main></div>
    </body></html>`, { url: 'http://localhost/', runScripts: 'outside-only' });
    const win = dom.window;
    win.eval(PERF_UTILS);
    win.eval(PERF_PANEL);
    win.eval(SERVERS);

    // Only the state and helpers render() touches before its guard.
    win.eval('var state = { currentTab: "sessions", sessions: [], pinsById: {} };');
    win.eval(extractFunction(APP, 'function render()'));
    win.eval(extractFunction(APP, 'function updateSidebar()'));

    win.eval('render(); updateSidebar();');
    expect(win.document.getElementById('content').innerHTML).toBe('');
    expect(win.document.getElementById('sidebar').innerHTML).toBe('');

    // Now the visible shell mounts the component: exactly one id set.
    win.document.getElementById('ms-view').innerHTML = win.ServersPage._localPerformance();
    expect(win.document.querySelectorAll('#perf-panel')).toHaveLength(1);
    expect(win.document.querySelectorAll('#perf-view-root')).toHaveLength(1);
    expect(win.document.querySelectorAll('#claude-view-root')).toHaveLength(1);
    expect(win.document.querySelectorAll('#codex-view-root')).toHaveLength(1);
    expect(win.document.getElementById('ms-view').contains(win.document.getElementById('perf-panel'))).toBe(true);
  });

  it('still renders the legacy shell when it is the only shell', () => {
    // The guard must key off the new shell, not disable the legacy page outright.
    const dom = new JSDOM(`<!DOCTYPE html><html><body>
      <div id="app"><div id="main-layout"><aside id="sidebar"></aside><div id="content"></div></div></div>
    </body></html>`, { url: 'http://localhost/', runScripts: 'outside-only' });
    const win = dom.window;
    win.eval('var state = { currentTab: "unknown-tab", sessions: [], pinsById: {} };');
    win.eval(extractFunction(APP, 'function render()'));
    const content = win.document.getElementById('content');
    win.eval('render();');
    // No .ms-app, so the guard does not fire and render() proceeds.
    expect(content.classList.contains('view-transition')).toBe(true);
  });
});
