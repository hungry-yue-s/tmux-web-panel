import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const MS_APP = readFileSync('public/js/ms-app.js', 'utf8');
const INDEX = readFileSync('public/index.html', 'utf8');

function loadMsApp() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost/',
    runScripts: 'outside-only',
  });
  dom.window.eval(MS_APP);
  return dom.window.MsApp;
}

describe('MsApp port parsing', () => {
  const MsApp = loadMsApp();

  it('defaults only an empty value to 22', () => {
    expect(MsApp._parsePort('')).toEqual({ port: 22 });
    expect(MsApp._parsePort('   ')).toEqual({ port: 22 });
    expect(MsApp._parsePort(null)).toEqual({ port: 22 });
    expect(MsApp._parsePort(undefined)).toEqual({ port: 22 });
  });

  it('reports a non-numeric port instead of silently using 22', () => {
    // Silently connecting to 22 would target a port the user never asked for.
    for (const bad of ['abc', '22abc', 'ssh', '2 2', '2.5', '-22', '+22', '0x16']) {
      const result = MsApp._parsePort(bad);
      expect(result.port).toBeUndefined();
      expect(result.error).toBeTruthy();
    }
  });

  it('rejects an out-of-range port', () => {
    expect(MsApp._parsePort('0').error).toBeTruthy();
    expect(MsApp._parsePort('65536').error).toBeTruthy();
    expect(MsApp._parsePort('99999').error).toBeTruthy();
  });

  it('accepts a valid port', () => {
    expect(MsApp._parsePort('22')).toEqual({ port: 22 });
    expect(MsApp._parsePort('2222')).toEqual({ port: 2222 });
    expect(MsApp._parsePort(' 65535 ')).toEqual({ port: 65535 });
    expect(MsApp._parsePort('1')).toEqual({ port: 1 });
  });
});

describe('MsApp failure reporting', () => {
  it('never swallows a route render failure', () => {
    // A blank page with no console trace was impossible to diagnose.
    expect(MS_APP).not.toMatch(/catch\(\(\) => \{\}\)/);
    expect(MS_APP).toContain('_reportRouteFailure');
    expect(MS_APP).toContain("console.error('[MsApp] route render failed:'");
  });

  it('reports a startup failure from the boot script', () => {
    expect(INDEX).toContain("console.error('[MsApp] startup failed:'");
  });
});

describe('MsApp themed dialogs', () => {
  it('uses the existing themed prompt for Session creation', async () => {
    const ctx = loadStatusShell();
    let options = null;
    ctx.win.showPrompt = async (next) => { options = next; return null; };
    ctx.win.prompt = () => { throw new Error('native prompt must not open'); };

    await ctx.MsApp._createSession('local');

    expect(options.title).toBe('在 本机 新建 Session');
    expect(options.confirmText).toBe('创建');
  });

  it('uses the existing themed danger confirmation for Window closing', async () => {
    const ctx = loadStatusShell();
    let options = null;
    ctx.win.showConfirm = async (next) => { options = next; return false; };
    ctx.win.confirm = () => { throw new Error('native confirm must not open'); };

    await ctx.MsApp._closeWindow('local', '@0');

    expect(options.title).toBe('关闭 Window');
    expect(options.danger).toBe(true);
  });
});

describe('MsApp route correction', () => {
  it('does not render twice when the route actually changes', () => {
    // Router.go fires hashchange, which renders; rendering here as well would
    // mount the terminal a second time.
    const fn = MS_APP.slice(
      MS_APP.indexOf('_correctRouteAfterClose(serverId, closed) {'),
      MS_APP.indexOf('openAddServer() {'),
    );
    expect(fn.length).toBeGreaterThan(0);
    expect(fn).toContain('Router.isSame(route, target)');
    const goIndex = fn.indexOf('Router.go(target');
    const manualAfterGo = fn.slice(goIndex).includes('_onRoute(');
    expect(manualAfterGo).toBe(false);
  });
});

describe('single Window Bar', () => {
  const TERMINAL_SRC = readFileSync('public/js/terminal.js', 'utf8');

  it('embeds from inside renderTerminal, so every re-render path is covered', () => {
    // Pane switch, split, close and the viewport handler all re-enter
    // renderTerminal without going through MsApp. Adopting only at the mount
    // call site let a full legacy header — back button and all — come back.
    expect(TERMINAL_SRC).toContain('window.MsApp.embedTerminalChrome(view)');
    const renderStart = TERMINAL_SRC.indexOf('function renderTerminal(container)');
    const hookAt = TERMINAL_SRC.indexOf('window.MsApp.embedTerminalChrome(view)');
    expect(hookAt).toBeGreaterThan(renderStart);
    // The hook must run before renderTerminal's own asynchronous pane fetch.
    const fetchInRender = TERMINAL_SRC.indexOf('TerminalTarget.listPanes(state.currentSession', hookAt);
    expect(fetchInRender).toBeGreaterThan(hookAt);
  });

  it('no longer adopts the header from the call site', () => {
    expect(MS_APP).not.toContain('_adoptTerminalHeader');
  });

  it('captures the pills node synchronously so it can be relocated', () => {
    // Re-querying the view after the move would silently find nothing.
    expect(TERMINAL_SRC).toContain("var headerPillsEl = view.querySelector('.terminal-header-pills')");
    expect(TERMINAL_SRC).toContain('renderPanePills(headerPillsEl, panes, state.currentPane, switchPane)');
    expect(TERMINAL_SRC).not.toContain("var headerPills = view.querySelector('.terminal-header-pills')");
  });

  /** Renders the real header markup, then runs the real embed hook over it. */
  function embedFixture({ provider = 'tmux', transport = 'local', width = 1440 } = {}) {
    const dom = new JSDOM(`<!DOCTYPE html><html><body>
      <header class="mobile-header"><div class="mobile-tools" id="ms-mobile-tools"></div></header>
      <header class="ms-topbar" id="ms-topbar"><div id="ms-top-actions"></div></header>
      <div id="ms-terminal-host"><div class="terminal-view">
        <div class="terminal-header">
          <button class="terminal-back-btn">back</button>
          <div class="terminal-header-pills"><button class="pane-pill">1</button></div>
          <span class="terminal-header-title">DataAnt : 1</span>
          <div class="terminal-header-actions">
            <button class="terminal-refresh-btn"></button>
            <div class="terminal-mode-toggle"></div>
            <button class="terminal-split-btn"></button>
            <button class="terminal-label-btn"></button>
            <button class="terminal-open-buf-btn"></button>
            <button class="terminal-popout-btn"></button>
          </div>
        </div>
        <div class="terminal-container"></div>
      </div></div>
    </body></html>`, { url: 'http://localhost/', runScripts: 'outside-only' });

    const win = dom.window;
    Object.defineProperty(win, 'innerWidth', { value: width, configurable: true });
    win.AppShell = {
      activeServerId: () => 'srv',
      workspace: () => ({ provider, transport }),
    };
    win.eval(MS_APP);
    win.MsApp.embedTerminalChrome(win.document.querySelector('.terminal-view'));
    return win;
  }

  it('leaves exactly one bar with no back button and no duplicate toolbar', () => {
    const doc = embedFixture().document;

    expect(doc.querySelector('.terminal-header')).toBeNull();
    expect(doc.querySelector('.terminal-back-btn')).toBeNull();
    expect(doc.querySelector('.terminal-header-title')).toBeNull();
    expect(doc.querySelectorAll('.terminal-header-actions')).toHaveLength(1);
    expect(doc.querySelector('#ms-top-actions .terminal-header-actions')).toBeTruthy();
  });

  it('keeps pane switching available inside the one bar', () => {
    const doc = embedFixture().document;

    const pills = doc.querySelector('#ms-top-actions .terminal-header-pills');
    expect(pills).toBeTruthy();
    expect(pills.classList.contains('ms-hoisted-pills')).toBe(true);
    // The live pill node moved, so its bound listener still works.
    expect(pills.querySelector('.pane-pill')).toBeTruthy();
  });

  it('leaves nothing above the terminal container in the view', () => {
    const doc = embedFixture().document;
    const view = doc.querySelector('.terminal-view');
    expect(view.firstElementChild.className).toContain('terminal-container');
  });

  it('does not duplicate anything when the hook runs again', () => {
    const win = embedFixture();
    // A second pass over an already-embedded view must be a no-op.
    win.MsApp.embedTerminalChrome(win.document.querySelector('.terminal-view'));

    expect(win.document.querySelectorAll('#ms-top-actions .terminal-header-actions')).toHaveLength(1);
    expect(win.document.querySelectorAll('#ms-top-actions .terminal-header-pills')).toHaveLength(1);
  });

  it('withholds only local-only actions on a remote tmux server', () => {
    const actions = embedFixture({ provider: 'tmux', transport: 'ssh' })
      .document.querySelector('#ms-top-actions');

    expect(actions.querySelector('.terminal-open-buf-btn')).toBeNull();
    expect(actions.querySelector('.terminal-popout-btn')).toBeNull();
    // Remote tmux still supports native split and labels.
    expect(actions.querySelector('.terminal-mode-toggle')).toBeTruthy();
    expect(actions.querySelector('.terminal-split-btn')).toBeTruthy();
    expect(actions.querySelector('.terminal-label-btn')).toBeTruthy();
  });

  it('keeps split and label on an ssh workspace but drops the tmux mode toggle', () => {
    const actions = embedFixture({ provider: 'ssh', transport: 'ssh' })
      .document.querySelector('#ms-top-actions');

    expect(actions.querySelector('.terminal-mode-toggle')).toBeNull();
    expect(actions.querySelector('.terminal-split-btn')).toBeTruthy();
    expect(actions.querySelector('.terminal-label-btn')).toBeTruthy();
    expect(actions.querySelector('.provider-badge').textContent).toBe('SSH');
  });

  it('hoists into the mobile header on a phone, where the desktop bar is hidden', () => {
    // .ms-topbar is display:none below 760px, so putting the toolbar there
    // would make pane switching and every tool unreachable on mobile.
    const doc = embedFixture({ width: 360 }).document;

    expect(doc.querySelector('#ms-mobile-tools .terminal-header-actions')).toBeTruthy();
    expect(doc.querySelector('#ms-mobile-tools .terminal-header-pills')).toBeTruthy();
    expect(doc.querySelector('#ms-top-actions').children).toHaveLength(0);
  });

  it('hoists into the desktop window bar above the breakpoint', () => {
    const doc = embedFixture({ width: 768 }).document;

    expect(doc.querySelector('#ms-top-actions .terminal-header-actions')).toBeTruthy();
    expect(doc.querySelector('#ms-mobile-tools').children).toHaveLength(0);
  });

  it('leaves no stale copy in the other bar after crossing the breakpoint', () => {
    const win = embedFixture({ width: 1440 });
    expect(win.document.querySelector('#ms-top-actions').children.length).toBeGreaterThan(0);

    // Simulate a resize past the breakpoint, which re-renders the terminal.
    Object.defineProperty(win, 'innerWidth', { value: 360, configurable: true });
    const view = win.document.querySelector('.terminal-view');
    view.insertAdjacentHTML('afterbegin', `<div class="terminal-header">
      <button class="terminal-back-btn"></button>
      <div class="terminal-header-pills"></div>
      <div class="terminal-header-actions"><button class="terminal-refresh-btn"></button></div>
    </div>`);
    win.MsApp.embedTerminalChrome(view);

    expect(win.document.querySelector('#ms-mobile-tools .terminal-header-actions')).toBeTruthy();
    expect(win.document.querySelector('#ms-top-actions').children).toHaveLength(0);
    expect(win.document.querySelectorAll('.terminal-header-actions')).toHaveLength(1);
  });
});

describe('index.html cache busting', () => {
  const versionOf = (path) => {
    const match = new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\?v=(\\d+)`).exec(INDEX);
    return match ? Number(match[1]) : null;
  };

  it('carries a version on every file changed in this work', () => {
    // A stale bundle in the user's browser silently reintroduces old behavior.
    for (const path of [
      '/css/style.css',
      '/js/terminal.js',
      '/js/panes.js',
      '/js/terminal-target.js',
      '/js/app-shell.js',
      '/js/servers.js',
      '/js/ms-app.js',
      '/js/router.js',
      '/js/store.js',
      '/js/api.js',
    ]) {
      expect(versionOf(path), path).toBeGreaterThanOrEqual(2);
    }
  });

  it('bumped the two long-lived files past their previous versions', () => {
    expect(versionOf('/css/style.css')).toBeGreaterThan(17);
    expect(versionOf('/js/terminal.js')).toBeGreaterThan(11);
    expect(versionOf('/js/panes.js')).toBeGreaterThan(2);
  });

  it('loads the terminal adapter before the modules that use it', () => {
    const order = ['/js/terminal-target.js', '/js/panes.js', '/js/terminal.js'];
    const positions = order.map((path) => INDEX.indexOf(path));
    expect(positions[0]).toBeGreaterThan(-1);
    expect(positions[0]).toBeLessThan(positions[1]);
    expect(positions[0]).toBeLessThan(positions[2]);
  });

  it('keeps the legacy shell present but hidden', () => {
    expect(INDEX).toContain('<div id="legacy-shell" hidden>');
    expect(INDEX).toContain('id="content"');
    expect(INDEX).toContain('class="ms-app sidebar-collapsed"');
  });

  it('has one window bar and a footer nav with terminal, status and settings', () => {
    expect((INDEX.match(/id="ms-topbar"/g) || [])).toHaveLength(1);
    expect(INDEX).toContain('data-route="#/terminal/local" data-terminal-home');
    expect(INDEX).toContain('data-route="#/servers"');
    expect(INDEX).toContain('data-route="#/settings"');
  });
});

const SERVERS_SRC = readFileSync('public/js/servers.js', 'utf8');
const SHELL_SRC = readFileSync('public/js/app-shell.js', 'utf8');
const ROUTER_SRC = readFileSync('public/js/router.js', 'utf8');
const STORE_SRC = readFileSync('public/js/store.js', 'utf8');

const STATUS_DOM = `<!DOCTYPE html><html><body>
  <div class="ms-app">
    <aside class="ms-sidebar">
      <div class="sidebar-resizer"></div>
      <button class="sidebar-toggle"></button>
      <div class="server-context" id="ms-server-context"></div>
    </aside>
    <main class="ms-main">
      <strong id="ms-mobile-title"></strong><small id="ms-mobile-subtitle"></small>
      <header class="ms-topbar" id="ms-topbar">
        <div class="crumb" id="ms-crumb"></div><h1 id="ms-page-title"></h1>
        <div id="ms-top-actions"></div>
      </header>
      <div class="ms-content" id="ms-view"></div>
    </main>
  </div>
  <div id="ms-server-popover" hidden></div>
  <div id="ms-modal" hidden></div>
  <div id="ms-toast"></div>
</body></html>`;

/** Full shell with stubbed network, so route handling can be driven directly. */
function loadStatusShell({ perfPanel = null, theme = null, auth = null } = {}) {
  const dom = new JSDOM(STATUS_DOM, { url: 'http://localhost/', runScripts: 'outside-only' });
  const win = dom.window;
  win.eval(ROUTER_SRC);
  win.eval(STORE_SRC);
  win.eval(SHELL_SRC);
  win.eval(SERVERS_SRC);
  win.eval(MS_APP);

  if (perfPanel) win.PerfPanel = perfPanel;
  if (theme) win.Theme = theme;
  if (auth) win.Auth = auth;

  win.Api = {
    serverPath: (id, suffix) => '/api/servers/' + id + (suffix || ''),
    workspacePath: (id) => '/api/servers/' + id + '/workspace',
    get: async () => ({}),
    post: async () => ({}),
  };

  win.Store.setServers([
    { id: 'local', name: '本机', kind: 'local', immutable: true, address: { host: '127.0.0.1' } },
    { id: 'api-linux', name: 'api-linux', kind: 'remote', address: { host: '10.0.0.21', port: 22 } },
  ]);
  win.Store.setHealth('local', { state: 'online', latencyMs: 2, capabilities: {} });
  win.Store.setHealth('api-linux', { state: 'online', latencyMs: 30, capabilities: {} });

  return { win, MsApp: win.MsApp, Store: win.Store, Router: win.Router, document: win.document };
}

function seedRemoteSidebarWorkspace(Store) {
  Store.setWorkspace('api-linux', {
    serverId: 'api-linux', provider: 'ssh', transport: 'ssh', persistence: 'process-memory',
    actions: { createWindow: true, renameSession: true, closeSession: true, renameWindow: true, closeWindow: true },
    sessions: [],
  });
}

function fakePerfPanel() {
  const calls = { started: [], stopped: 0, rendered: [] };
  return {
    calls,
    renderSkeleton: (mode) => {
      calls.rendered.push(mode);
      const sections = [];
      if (mode !== 'codex') {
        sections.push('<div class="section"><div class="section-head"><h3>机器性能</h3></div><div id="perf-view-root"></div></div>');
        sections.push('<div class="section"><div class="section-head"><h3>Claude 用量</h3></div><div id="claude-view-root"></div></div>');
      }
      if (mode !== 'performance') {
        sections.push('<div class="section"><div class="section-head"><h3>Codex 用量</h3></div><div id="codex-view-root"></div></div>');
      }
      return '<div id="perf-panel" class="pp-card">' + sections.join('') + '</div>';
    },
    start: (mode) => { calls.started.push(mode); },
    stop: () => { calls.stopped += 1; },
  };
}

describe('MsApp status mode routing', () => {
  it('removes the terminal preview dock before rendering status', async () => {
    const ctx = loadStatusShell();
    const calls = [];
    ctx.win.FilePreview = {
      switchDockContext: (serverId, session, windowIndex) => calls.push([serverId, session, windowIndex]),
    };

    await ctx.MsApp._onRoute({ name: 'server', params: { serverId: 'api-linux', section: 'performance' } });

    expect(calls).toEqual([[null, null, null]]);
    expect(ctx.document.getElementById('ms-view').querySelector('.server-hero')).toBeTruthy();
  });

  it('replaces the bare servers route with a server detail, with no list in between', async () => {
    const ctx = loadStatusShell();
    const goes = [];
    ctx.win.Router.go = (route, opts) => goes.push({ route, opts });

    await ctx.MsApp._onRoute({ name: 'servers', params: {} });

    expect(goes).toHaveLength(1);
    expect(goes[0].route).toEqual({ name: 'server', params: { serverId: 'local', section: 'performance' } });
    // replace, so the list route never becomes a history entry to go back to.
    expect(goes[0].opts).toEqual({ replace: true });
    expect(ctx.document.getElementById('ms-view').innerHTML).toBe('');
  });

  it('resolves the bare servers route to the remembered server', async () => {
    const ctx = loadStatusShell();
    ctx.Store.setUi({ lastStatusServerId: 'api-linux' });
    const goes = [];
    ctx.win.Router.go = (route) => goes.push(route);

    await ctx.MsApp._onRoute({ name: 'servers', params: {} });
    expect(goes[0].params.serverId).toBe('api-linux');
  });

  it('no longer has a server list page at all', () => {
    expect(SERVERS_SRC).not.toContain('renderList');
    expect(MS_APP).not.toContain('renderList');
    // Its filter and search controls went with it.
    expect(MS_APP).not.toContain('ms-server-search');
    expect(MS_APP).not.toContain('data-filter');
  });

  it('shows Codex between performance and connection only for the local server', async () => {
    const perf = fakePerfPanel();
    const ctx = loadStatusShell({ perfPanel: perf });

    await ctx.MsApp._onRoute({ name: 'server', params: { serverId: 'local', section: 'performance' } });
    expect([...ctx.document.querySelectorAll('.tabs .tab')].map((n) => n.textContent))
      .toEqual(['性能', 'Codex 用量', '连接']);

    await ctx.MsApp._onRoute({ name: 'server', params: { serverId: 'api-linux', section: 'performance' } });
    expect([...ctx.document.querySelectorAll('.tabs .tab')].map((n) => n.textContent))
      .toEqual(['性能', '连接']);
  });

  it('remembers the selected server when a detail route renders', async () => {
    const ctx = loadStatusShell();
    await ctx.MsApp._onRoute({ name: 'server', params: { serverId: 'api-linux', section: 'performance' } });
    expect(ctx.Store.getState().ui.lastStatusServerId).toBe('api-linux');
  });

  it('renders the detail pane for the routed server', async () => {
    const ctx = loadStatusShell();
    await ctx.MsApp._onRoute({ name: 'server', params: { serverId: 'api-linux', section: 'performance' } });
    const view = ctx.document.getElementById('ms-view');
    expect(view.classList.contains('terminal-mode')).toBe(false);
    expect(view.querySelector('.server-hero').textContent).toContain('api-linux');
    expect(view.querySelector('.tabs')).toBeTruthy();
  });
});

describe('MsApp sidebar context menu', () => {
  function row(ctx, entity) {
    const el = ctx.document.createElement('div');
    el.className = entity === 'session' ? 'tree-session-row' : 'tree-window-row';
    Object.assign(el.dataset, {
      sidebarEntity: entity,
      serverId: 'api-linux',
      provider: 'ssh',
      session: '$7',
      window: entity === 'window' ? '@9' : '',
      entityName: entity === 'session' ? 'Remote work' : 'Build logs',
    });
    const button = ctx.document.createElement('button');
    button.className = 'tree-item';
    button.innerHTML = '<span class="nested-label">target</span>';
    el.appendChild(button);
    ctx.document.querySelector('.ms-sidebar').appendChild(el);
    return el;
  }

  it('offers new window, rename and close for Session rows and rename/close for Window rows', () => {
    const ctx = loadStatusShell();
    seedRemoteSidebarWorkspace(ctx.Store);

    const session = row(ctx, 'session');
    ctx.MsApp._showSidebarContextMenu(session, { clientX: 20, clientY: 30 });
    let menu = ctx.document.getElementById('ms-sidebar-context-menu');
    expect([...menu.querySelectorAll('[data-action]')].map((n) => n.dataset.action))
      .toEqual(['new-window', 'rename-session', 'close-session']);
    expect(menu.textContent).not.toMatch(/Pin|Move|置顶|移动/);

    const win = row(ctx, 'window');
    ctx.MsApp._showSidebarContextMenu(win, { clientX: 20, clientY: 30 });
    menu = ctx.document.getElementById('ms-sidebar-context-menu');
    expect([...menu.querySelectorAll('[data-action]')].map((n) => n.dataset.action))
      .toEqual(['rename-window', 'close-window']);
    expect(menu.getAttribute('role')).toBe('menu');
    expect(ctx.document.activeElement.getAttribute('role')).toBe('menuitem');
  });

  it('intercepts nested right-clicks, dismisses on Escape, and restores focus', () => {
    const ctx = loadStatusShell();
    seedRemoteSidebarWorkspace(ctx.Store);
    ctx.MsApp._bindEvents();
    const session = row(ctx, 'session');
    const nested = session.querySelector('.nested-label');
    const event = new ctx.win.MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: 10000, clientY: 10000,
    });

    nested.dispatchEvent(event);
    const menu = ctx.document.getElementById('ms-sidebar-context-menu');
    expect(event.defaultPrevented).toBe(true);
    expect(menu.hidden).toBe(false);
    expect(parseInt(menu.style.left, 10)).toBeLessThanOrEqual(ctx.win.innerWidth - 8);
    expect(parseInt(menu.style.top, 10)).toBeLessThanOrEqual(ctx.win.innerHeight - 8);

    ctx.document.dispatchEvent(new ctx.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(menu.hidden).toBe(true);
    expect(ctx.document.activeElement).toBe(session.querySelector('.tree-item'));
  });

  it('passes captured remote server, provider, id and name into existing actions', async () => {
    const ctx = loadStatusShell();
    const calls = [];
    ctx.MsApp._renameWindow = async (...args) => calls.push(args);
    const action = ctx.document.createElement('button');
    Object.assign(action.dataset, {
      action: 'rename-window', serverId: 'api-linux', provider: 'ssh',
      window: '@9', entityName: 'Build logs',
    });

    await ctx.MsApp._handleAction('rename-window', action);
    expect(calls).toEqual([['api-linux', '@9', { provider: 'ssh', name: 'Build logs' }]]);
    expect(ctx.MsApp._providerHeader('api-linux', 'ssh')).toEqual({ 'X-Workspace-Provider': 'ssh' });
  });
});

describe('MsApp PerfPanel lifecycle', () => {
  it('uses machine plus Claude mode for the local performance section', async () => {
    const perf = fakePerfPanel();
    const ctx = loadStatusShell({ perfPanel: perf });

    await ctx.MsApp._onRoute({ name: 'server', params: { serverId: 'local', section: 'performance' } });

    const view = ctx.document.getElementById('ms-view');
    expect(view.querySelector('#perf-panel')).toBeTruthy();
    expect(view.textContent).toContain('机器性能');
    expect(view.textContent).toContain('Claude 用量');
    expect(view.querySelector('#codex-view-root')).toBeNull();
    expect(perf.calls.started).toContain('performance');
  });

  it('uses the Codex-only mode for the local Codex section', async () => {
    const perf = fakePerfPanel();
    const ctx = loadStatusShell({ perfPanel: perf });

    await ctx.MsApp._onRoute({ name: 'server', params: { serverId: 'local', section: 'codex' } });

    const view = ctx.document.getElementById('ms-view');
    expect(view.textContent).toContain('Codex 用量');
    expect(view.textContent).not.toContain('机器性能');
    expect(view.querySelector('#codex-view-root')).toBeTruthy();
    expect(view.querySelector('#perf-view-root')).toBeNull();
    expect(perf.calls.started).toContain('codex');
  });

  it('stops PerfPanel polling when leaving the route', async () => {
    const perf = fakePerfPanel();
    const ctx = loadStatusShell({ perfPanel: perf });

    await ctx.MsApp._onRoute({ name: 'server', params: { serverId: 'local', section: 'performance' } });
    const startedWhileMounted = perf.calls.started.length;
    await ctx.MsApp._onRoute({ name: 'settings', params: {} });

    expect(startedWhileMounted).toBeGreaterThan(0);
    expect(perf.calls.stopped).toBeGreaterThan(0);
    expect(ctx.MsApp._perfPanelMounted).toBe(false);
  });

  it('keeps server-level metrics for a remote host instead of the local panel', async () => {
    const perf = fakePerfPanel();
    const ctx = loadStatusShell({ perfPanel: perf });

    await ctx.MsApp._onRoute({ name: 'server', params: { serverId: 'api-linux', section: 'performance' } });

    // PerfPanel polls the panel's own machine; it must not represent a remote host.
    expect(ctx.document.querySelector('#perf-panel')).toBeNull();
    expect(perf.calls.started).toHaveLength(0);
  });

  it('redirects a remote Codex route to that server performance page', async () => {
    const perf = fakePerfPanel();
    const ctx = loadStatusShell({ perfPanel: perf });
    const goes = [];
    ctx.win.Router.go = (route, opts) => goes.push({ route, opts });

    await ctx.MsApp._onRoute({ name: 'server', params: { serverId: 'api-linux', section: 'codex' } });

    expect(goes).toEqual([{
      route: { name: 'server', params: { serverId: 'api-linux', section: 'performance' } },
      opts: { replace: true },
    }]);
    expect(perf.calls.started).toHaveLength(0);
    expect(ctx.document.getElementById('ms-view').innerHTML).toBe('');
  });

  it('does not claim to be mounted when PerfPanel is missing', async () => {
    const ctx = loadStatusShell();
    await ctx.MsApp._onRoute({ name: 'server', params: { serverId: 'local', section: 'performance' } });
    expect(ctx.MsApp._perfPanelMounted).toBeFalsy();
    expect(ctx.document.getElementById('ms-view').textContent).toContain('性能组件未加载');
  });
});

describe('MsApp settings interactions', () => {
  function fakeTheme(current) {
    const applied = [];
    return {
      applied,
      getCurrent: () => current,
      getName: () => current,
      apply: (id) => { applied.push(id); },
      getThemeList: () => [
        { id: 'tokyo', name: 'Tokyo Night', colors: {
          '--bg-primary': '#1a1b26', '--bg-card': '#24283b', '--text-primary': '#c0caf5',
          '--accent-blue': '#7aa2f7', '--accent-green': '#9ece6a', '--accent-red': '#f7768e',
          '--accent-purple': '#bb9af7' } },
        { id: 'light', name: 'Light', colors: {
          '--bg-primary': '#ffffff', '--bg-card': '#f2f2f2', '--text-primary': '#111111',
          '--accent-blue': '#2563eb', '--accent-green': '#16a34a', '--accent-red': '#dc2626',
          '--accent-purple': '#7c3aed' } },
      ],
    };
  }

  it('renders interactive theme cards from the existing Theme module', async () => {
    const theme = fakeTheme('tokyo');
    const ctx = loadStatusShell({ theme });
    await ctx.MsApp._onRoute({ name: 'settings', params: {} });

    const cards = [...ctx.document.querySelectorAll('.theme-card')];
    expect(cards).toHaveLength(2);
    expect(cards.map((c) => c.dataset.theme)).toEqual(['tokyo', 'light']);
    expect(cards.every((c) => c.dataset.action === 'set-theme')).toBe(true);
    expect(cards[0].classList.contains('active')).toBe(true);
    expect(cards[1].classList.contains('active')).toBe(false);
    expect(ctx.document.getElementById('ms-view').textContent).not.toContain('终端模式下可拖拽调整');
    expect(ctx.document.getElementById('ms-view').textContent).not.toContain('宽度');
  });

  it('applies a theme through Theme rather than reimplementing it', async () => {
    const theme = fakeTheme('tokyo');
    const ctx = loadStatusShell({ theme });
    await ctx.MsApp._onRoute({ name: 'settings', params: {} });

    const light = ctx.document.querySelector('[data-theme="light"]');
    await ctx.MsApp._handleAction('set-theme', light);
    expect(theme.applied).toEqual(['light']);
  });

  it('shows about and version details', async () => {
    const ctx = loadStatusShell({ theme: fakeTheme('tokyo') });
    ctx.win.ServersPage.settingsSection = 'about';
    await ctx.MsApp._onRoute({ name: 'settings', params: {} });

    const text = ctx.document.getElementById('ms-view').textContent;
    const repository = ctx.document.querySelector('a[href="https://github.com/hungry-yue-s/tmux-web-panel"]');
    expect(text).toContain('Tmux Web Panel');
    expect(text).toContain('v1.0.0');
    expect(repository).toBeTruthy();
    expect(repository.textContent).toContain('GitHub');
  });

  it('offers Sign Out only when a login token exists', async () => {
    const ctx = loadStatusShell({ theme: fakeTheme('tokyo'), auth: { getToken: () => null } });
    ctx.win.ServersPage.settingsSection = 'about';
    await ctx.MsApp._onRoute({ name: 'settings', params: {} });
    expect(ctx.document.querySelector('[data-action="logout"]')).toBeNull();

    const signedIn = loadStatusShell({
      theme: fakeTheme('tokyo'),
      auth: { getToken: () => 'token-abc', logout: () => {} },
    });
    signedIn.win.ServersPage.settingsSection = 'about';
    await signedIn.MsApp._onRoute({ name: 'settings', params: {} });
    expect(signedIn.document.querySelector('[data-action="logout"]')).toBeTruthy();
  });

  it('delegates sign out to the existing Auth module', async () => {
    let calls = 0;
    const ctx = loadStatusShell({
      theme: fakeTheme('tokyo'),
      auth: { getToken: () => 'token-abc', logout: () => { calls += 1; } },
    });
    await ctx.MsApp._handleAction('logout', ctx.document.body);
    expect(calls).toBe(1);
  });

  it('keeps the SSH and host-key policy visible', async () => {
    const ctx = loadStatusShell({ theme: fakeTheme('tokyo') });
    ctx.win.ServersPage.settingsSection = 'security';
    await ctx.MsApp._onRoute({ name: 'settings', params: {} });

    const text = ctx.document.getElementById('ms-view').textContent;
    expect(text).toContain('SSH Agent');
    expect(text).toContain('主机密钥');
    expect(text).toContain('不安装、不升级、不启动远端 tmux');
  });
});
