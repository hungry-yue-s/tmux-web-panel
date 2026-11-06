import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { loadSlots } from '../helpers/slots.js';

const APP = readFileSync('plugins/ui/client/js/app.js', 'utf8');
const PERF_UTILS = readFileSync('plugins/metrics/client/js/perf-utils.js', 'utf8');
const PERF_PANEL = readFileSync('plugins/metrics/client/js/perf-panel.js', 'utf8');
const SERVERS = readFileSync('plugins/ui/client/js/servers.js', 'utf8');

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
  it('has no legacy views left: render() and updateSidebar() never write into the page', () => {
    const dom = new JSDOM(`<!DOCTYPE html><html><body>
      <div id="app"><div id="main-layout"><aside id="sidebar"></aside><div id="content"></div></div></div>
    </body></html>`, { url: 'http://localhost/', runScripts: 'outside-only' });
    const win = dom.window;
    win.eval('var state = { currentTab: "sessions", sessions: [{ name: "a", windows: 1 }], pinsById: {} };');
    win.eval(extractFunction(APP, 'function render()'));
    win.eval(extractFunction(APP, 'function updateSidebar()'));
    win.eval('render(); updateSidebar();');
    expect(win.document.getElementById('content').innerHTML).toBe('');
    expect(win.document.getElementById('sidebar').innerHTML).toBe('');
    for (const name of ['renderDesktopHome', '_rebuildSidebar', '_loadSidebarWindows', 'toggleSessionDropdown']) {
      expect(APP).not.toContain('function ' + name + '(');
    }
  });

  it('leaves #content empty so only one perf-panel id set exists', () => {
    const dom = new JSDOM(`<!DOCTYPE html><html><body>
      <div id="legacy-shell" hidden><div id="app"><div id="main-layout">
        <aside id="sidebar"></aside><div id="content"></div>
      </div></div></div>
      <div class="ms-app"><main class="ms-main"><div id="ms-view"></div></main></div>
    </body></html>`, { url: 'http://localhost/', runScripts: 'outside-only' });
    const win = dom.window;
    loadSlots(win);
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
    win.document.getElementById('ms-view').innerHTML = win.PanelSlots.serverSections.get('performance').render();
    expect(win.document.querySelectorAll('#perf-panel')).toHaveLength(1);
    expect(win.document.querySelectorAll('#perf-view-root')).toHaveLength(1);
    expect(win.document.querySelectorAll('#claude-view-root')).toHaveLength(0);
    expect(win.document.querySelectorAll('#codex-view-root')).toHaveLength(0);
    expect(win.document.getElementById('ms-view').contains(win.document.getElementById('perf-panel'))).toBe(true);

    win.document.getElementById('ms-view').innerHTML = win.PerfPanel.renderSkeleton('claude');
    expect(win.document.querySelectorAll('#perf-panel')).toHaveLength(1);
    expect(win.document.querySelectorAll('#perf-view-root')).toHaveLength(0);
    expect(win.document.querySelectorAll('#claude-view-root')).toHaveLength(1);
    expect(win.document.querySelectorAll('#codex-view-root')).toHaveLength(0);

    win.document.getElementById('ms-view').innerHTML = win.PerfPanel.renderSkeleton('codex');
    expect(win.document.querySelectorAll('#perf-panel')).toHaveLength(1);
    expect(win.document.querySelectorAll('#perf-view-root')).toHaveLength(0);
    expect(win.document.querySelectorAll('#claude-view-root')).toHaveLength(0);
    expect(win.document.querySelectorAll('#codex-view-root')).toHaveLength(1);
  });

});
