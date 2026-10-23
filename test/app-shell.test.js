import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const ROUTER = readFileSync('public/js/router.js', 'utf8');
const STORE = readFileSync('public/js/store.js', 'utf8');
const SHELL = readFileSync('public/js/app-shell.js', 'utf8');

const SHELL_DOM = `<!DOCTYPE html><html><body>
  <div class="ms-app sidebar-collapsed">
    <aside class="ms-sidebar">
      <div class="sidebar-resizer"></div>
      <button class="sidebar-toggle"></button>
      <div class="server-context" id="ms-server-context"></div>
    </aside>
    <main class="ms-main">
      <header class="mobile-header">
        <button class="mobile-workspace-trigger" data-action="mobile-workspace" aria-expanded="false"><span id="ms-mobile-title"></span><small id="ms-mobile-subtitle"></small></button>
        <div id="ms-mobile-tools"></div>
      </header>
      <header class="ms-topbar" id="ms-topbar">
        <div class="crumb" id="ms-crumb"></div><h1 id="ms-page-title"></h1>
        <div id="ms-top-actions"></div>
      </header>
      <div id="ms-view"></div>
    </main>
  </div>
  <button data-route="#/terminal/local" data-terminal-home></button>
  <button data-route="#/servers"></button>
  <button data-route="#/settings"></button>
  <div id="ms-server-popover" hidden></div>
  <div id="ms-toast"></div>
</body></html>`;

const TMUX_ACTIONS = {
  createSession: true,
  renameSession: true,
  closeSession: true,
  createWindow: true,
  renameWindow: true,
  closeWindow: true,
  splitPane: true,
  closePane: true,
  renamePane: true,
  tmuxLayout: true,
  capturePane: true,
  persistentAfterRestart: true,
};

const SSH_ACTIONS = { ...TMUX_ACTIONS, tmuxLayout: false, capturePane: false, persistentAfterRestart: false };

function loadShell() {
  const dom = new JSDOM(SHELL_DOM, { url: 'http://localhost/', runScripts: 'outside-only' });
  const win = dom.window;
  win.eval(ROUTER);
  win.eval(STORE);
  win.eval(SHELL);
  return { win, Shell: win.AppShell, Store: win.Store, document: win.document };
}

function seedLocalTmux(Store, { sessions } = {}) {
  Store.setServers([{ id: 'local', name: '本机', kind: 'local', immutable: true, address: { host: '127.0.0.1' } }]);
  Store.setHealth('local', {
    state: 'online',
    latencyMs: 3,
    checkedAt: new Date().toISOString(),
    facts: { platform: 'darwin', arch: 'arm64' },
    capabilities: { ssh: { available: true }, tmux: { available: true, version: '3.5a' } },
  });
  Store.setWorkspace('local', {
    serverId: 'local',
    provider: 'tmux',
    transport: 'local',
    persistence: 'tmux',
    pendingProvider: null,
    revision: 1,
    actions: TMUX_ACTIONS,
    sessions: sessions || [
      {
        id: '$0',
        name: 'DataAnt',
        active: true,
        windows: [
          { id: '@0', index: 1, name: '三绿', active: true, panes: [{ id: '%95', command: 'codex' }] },
          { id: '@2', index: 2, name: '风控点总结', active: false, panes: [{ id: '%12', command: 'fish' }] },
        ],
      },
    ],
  });
  Store.setRoute({ name: 'terminal', params: { serverId: 'local', sessionId: '$0', windowId: '@0', paneId: '%95' } });
}

describe('AppShell sidebar tree', () => {
  let ctx;

  beforeEach(() => {
    ctx = loadShell();
    seedLocalTmux(ctx.Store);
    ctx.Shell.render();
  });

  it('renders the server switcher with the health dot and address', () => {
    const switcher = ctx.document.querySelector('.server-switcher');
    expect(switcher).toBeTruthy();
    expect(switcher.querySelector('.dot').className).toContain('online');
    expect(switcher.textContent).toContain('本机');
    expect(switcher.textContent).toContain('3ms');
  });

  it('shows a TMUX provider badge', () => {
    expect(ctx.document.querySelector('.provider-badge').textContent).toBe('TMUX');
  });

  it('renders sessions as groups with their window list', () => {
    const groups = ctx.document.querySelectorAll('.tree-session-group');
    expect(groups).toHaveLength(1);
    expect(groups[0].classList.contains('active')).toBe(true);
    expect(ctx.document.querySelectorAll('.tree-window-row')).toHaveLength(2);
  });

  it('puts stable server, provider and entity identity on sidebar rows', () => {
    const session = ctx.document.querySelector('.tree-session-row');
    const win = ctx.document.querySelector('.tree-window-row');
    expect(session.dataset).toMatchObject({
      sidebarEntity: 'session', serverId: 'local', provider: 'tmux', session: '$0', entityName: 'DataAnt',
    });
    expect(win.dataset).toMatchObject({
      sidebarEntity: 'window', serverId: 'local', provider: 'tmux', session: '$0', window: '@0', entityName: '三绿',
    });
  });

  it('escapes row attributes while preserving the dataset value', () => {
    seedLocalTmux(ctx.Store, { sessions: [{
      id: '$8', name: 'A&B "team"', active: true,
      windows: [{ id: '@9', index: 1, name: 'docs <draft>', active: true, panes: [] }],
    }] });
    ctx.Store.setRoute({ name: 'terminal', params: { serverId: 'local', sessionId: '$8', windowId: '@9' } });
    ctx.Shell.render();
    expect(ctx.document.querySelector('.tree-session-row').dataset.entityName).toBe('A&B "team"');
    expect(ctx.document.querySelector('.tree-window-row').dataset.entityName).toBe('docs <draft>');
  });

  it('shows full window names with no first-character or ordinal anchor', () => {
    const rows = [...ctx.document.querySelectorAll('.tree-window-row')];
    const labels = rows.map((row) => row.querySelector('.tree-item-name').textContent);

    expect(labels).toEqual(['三绿', '风控点总结']);
    expect(ctx.document.querySelectorAll('.tree-window-list .index')).toHaveLength(0);
    rows.forEach((row) => {
      const text = row.querySelector('.tree-item').textContent;
      expect(text.startsWith('三绿') || text.startsWith('风控点总结')).toBe(true);
    });
    // Neither the bare first character nor the tmux index may stand in for a name.
    expect(labels).not.toContain('三');
    expect(labels).not.toContain('风');
    expect(labels).not.toContain('1');
    expect(labels).not.toContain('2');
  });

  it('keeps window names visible and ellipsised while the sidebar is collapsed', () => {
    // The fixture is already .sidebar-collapsed, but JSDOM applies no stylesheet,
    // so the collapsed rules are asserted against the CSS source.
    const styles = readFileSync('public/css/style.css', 'utf8');

    expect(styles).not.toMatch(/sidebar-collapsed \.tree-window-list \.tree-item-name[\s\S]*?display:\s*none/);
    expect(styles).not.toContain('.tree-window-list .index');
    expect(styles).toMatch(/\.tree-window-list \.tree-item-name\s*\{[^}]*text-overflow:\s*ellipsis/);
    expect(styles).toMatch(/\.tree-window-list \.tree-item-name\s*\{[^}]*white-space:\s*nowrap/);
  });

  it('keeps the full name as the tooltip', () => {
    const first = ctx.document.querySelector('.tree-window-row .tree-item');
    expect(first.getAttribute('title')).toBe('三绿');
    expect(first.querySelector('.tree-item-name').textContent).toBe('三绿');
  });

  it('marks the routed window as current', () => {
    const activeWindows = ctx.document.querySelectorAll('.tree-window-list .tree-item.active');
    expect(activeWindows).toHaveLength(1);
    const active = activeWindows[0];
    expect(active.getAttribute('aria-current')).toBe('page');
    expect(active.getAttribute('title')).toBe('三绿');
  });

  it('routes window entries to encoded stable ids', () => {
    const route = ctx.document.querySelector('.tree-window-row .tree-item').dataset.route;
    expect(route).toBe('#/terminal/local/%240/%400/%2595');
    expect(ctx.win.Router.parse(route).params).toEqual({
      serverId: 'local', sessionId: '$0', windowId: '@0', paneId: '%95',
    });
  });

  it('keeps creation direct and exposes permitted lifecycle actions through row menus', () => {
    expect(ctx.document.querySelector('[data-action="new-session"]')).toBeTruthy();
    expect(ctx.document.querySelector('[data-action="new-window"]').dataset.session).toBe('$0');
    const menus = [...ctx.document.querySelectorAll('[data-action="workspace-entity-menu"]')];
    expect(menus).toHaveLength(3);
    expect(menus.map(button => button.closest('[data-sidebar-entity]').dataset.window || '$0')).toEqual(['$0', '@0', '@2']);
    menus.forEach(button => {
      expect(button.getAttribute('aria-haspopup')).toBe('menu');
      expect(button.getAttribute('aria-controls')).toBe('ms-sidebar-context-menu');
    });
    expect(ctx.document.querySelector('[data-action^="rename-"],[data-action^="close-"]')).toBeNull();
    ctx.Store.setWorkspace('local', { ...ctx.Shell.workspace('local'), actions: { createSession: true } });
    ctx.Shell.render();
    expect(ctx.document.querySelector('[data-action="new-session"]')).toBeTruthy();
    expect(ctx.document.querySelector('[data-action="new-window"],[data-action="workspace-entity-menu"]')).toBeNull();
  });

  it('restores the same sidebar keyboard target on refresh without stealing terminal focus', () => {
    const original = ctx.document.querySelector('[data-window="@2"] .tree-item');
    original.focus();
    ctx.Store.setHealth('local', { state: 'online', latencyMs: 4, capabilities: {} });
    ctx.Shell.render();
    const replacement = ctx.document.querySelector('[data-window="@2"] .tree-item');
    expect(replacement).not.toBe(original);
    expect(original.isConnected).toBe(false);
    expect(ctx.document.activeElement).toBe(replacement);
    const terminalInput = ctx.document.createElement('textarea');
    ctx.document.getElementById('ms-view').append(terminalInput);
    terminalInput.focus();
    ctx.Store.setHealth('local', { state: 'online', latencyMs: 5, capabilities: {} });
    ctx.Shell.render();
    expect(ctx.document.activeElement).toBe(terminalInput);
  });

  it('escapes a hostile session name', () => {
    seedLocalTmux(ctx.Store, {
      sessions: [{ id: '$9', name: '<img src=x onerror=alert(1)>', windows: [] }],
    });
    ctx.Shell.render();

    const context = ctx.document.getElementById('ms-server-context');
    expect(context.querySelector('img')).toBeNull();
    expect(context.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('AppShell ssh workspace', () => {
  let ctx;

  beforeEach(() => {
    ctx = loadShell();
    ctx.Store.setServers([{ id: 'api-linux', name: 'API Linux', kind: 'remote', address: { host: '10.0.0.21' } }]);
    ctx.Store.setHealth('api-linux', {
      state: 'online',
      latencyMs: 26,
      checkedAt: new Date().toISOString(),
      facts: { platform: 'linux', arch: 'x64' },
      capabilities: { ssh: { available: true }, tmux: { available: false, reason: 'command_not_found' } },
    });
    ctx.Store.setWorkspace('api-linux', {
      serverId: 'api-linux',
      provider: 'ssh',
      transport: 'ssh',
      persistence: 'process-memory',
      pendingProvider: null,
      revision: 1,
      actions: SSH_ACTIONS,
      sessions: [{
        id: 'ses_1',
        name: 'main',
        windows: [{ id: 'win_1', index: 0, name: 'shell', panes: [{ id: 'pane_1', command: 'bash' }] }],
      }],
    });
    ctx.Store.setRoute({ name: 'terminal', params: { serverId: 'api-linux', sessionId: 'ses_1', windowId: 'win_1' } });
    ctx.Shell.render();
  });

  it('labels the workspace SSH and explains the weaker persistence', () => {
    const context = ctx.document.getElementById('ms-server-context');
    expect(context.querySelector('.provider-badge').textContent).toBe('SSH');
    expect(context.querySelector('.ssh-lifecycle').textContent).toContain('面板重启后会话结束');
  });

  it('still offers pane and window lifecycle, which the ssh provider supports', () => {
    expect(ctx.document.querySelector('[data-action="new-session"]')).toBeTruthy();
    const row = ctx.document.querySelector('[data-sidebar-entity="window"]');
    expect(row.dataset).toMatchObject({ serverId: 'api-linux', provider: 'ssh', window: 'win_1' });
    expect(row.querySelector('[data-action="workspace-entity-menu"]')).toBeTruthy();
    expect(row.querySelector('[data-action="rename-window"],[data-action="close-window"]')).toBeNull();
  });

  it('routes ssh ids through the encoder', () => {
    const route = ctx.document.querySelector('.tree-window-row .tree-item').dataset.route;
    expect(route).toBe('#/terminal/api-linux/ses_1/win_1/pane_1');
  });
});

describe('AppShell unavailable workspace', () => {
  it('offers a connection repair route for an auth failure, not a retry', () => {
    const ctx = loadShell();
    ctx.Store.setServers([{ id: 'edge', name: 'edge-lab', kind: 'remote', address: { host: '192.168.8.31' } }]);
    ctx.Store.setHealth('edge', {
      state: 'auth_required',
      checkedAt: new Date().toISOString(),
      error: { code: 'SSH_AUTH_REQUIRED', message: 'denied', action: 'edit_connection' },
      capabilities: {},
    });
    ctx.Store.setRoute({ name: 'terminal', params: { serverId: 'edge' } });
    ctx.Shell.render();

    const missing = ctx.document.querySelector('.workspace-missing');
    expect(missing.textContent).toContain('认证失败');
    expect(missing.querySelector('[data-route]').dataset.route).toBe('#/servers/edge/connection');
  });

  it('offers a retry for an offline server', () => {
    const ctx = loadShell();
    ctx.Store.setServers([{ id: 'archive', name: 'archive-node', kind: 'remote', address: { host: '10.24.8.39' } }]);
    ctx.Store.setHealth('archive', { state: 'offline', checkedAt: new Date().toISOString(), capabilities: {} });
    ctx.Store.setRoute({ name: 'terminal', params: { serverId: 'archive' } });
    ctx.Shell.render();

    expect(ctx.document.querySelector('.workspace-missing [data-action="probe"]')).toBeTruthy();
  });
});

describe('AppShell sidebar preferences', () => {
  it('writes the namespaced width variable the stylesheet reads', () => {
    const ctx = loadShell();
    ctx.Shell.setSidebarWidth(300);

    const app = ctx.document.querySelector('.ms-app');
    // The unprefixed name belongs to the legacy sidebar.
    expect(app.style.getPropertyValue('--ms-sidebar-width')).toBe('300px');
    expect(app.style.getPropertyValue('--sidebar-width')).toBe('');
    expect(ctx.Store.getState().ui.sidebarWidth).toBe(300);
  });

  it('clamps the width to the resizer range', () => {
    const ctx = loadShell();
    expect(ctx.Shell.setSidebarWidth(50)).toBe(220);
    expect(ctx.Shell.setSidebarWidth(9999)).toBe(360);
    expect(ctx.Shell.setSidebarWidth(248.6)).toBe(249);
  });

  it('toggles the collapsed class and the toggle affordance', () => {
    const ctx = loadShell();
    const toggle = ctx.document.querySelector('.sidebar-toggle');
    toggle.innerHTML = '<svg aria-hidden="true"><path d="M9 4v16"/></svg>';
    const icon = toggle.firstElementChild;
    ctx.Shell.setSidebarCollapsed(false);

    const app = ctx.document.querySelector('.ms-app');
    expect(app.classList.contains('sidebar-collapsed')).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('收起侧边栏');
    expect(toggle.firstElementChild).toBe(icon);

    ctx.Shell.setSidebarCollapsed(true);
    expect(app.classList.contains('sidebar-collapsed')).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-label')).toBe('展开侧边栏');
    expect(toggle.firstElementChild).toBe(icon);
  });
});

describe('AppShell window bar', () => {
  it('emphasizes the window title while retaining server and session in the breadcrumb', () => {
    const ctx = loadShell();
    seedLocalTmux(ctx.Store);
    const workspace = ctx.Store.getState().entities.workspaceByServerId.local;

    ctx.Shell.setTerminalHeader('local', workspace, { sessionId: '$0', windowId: '@0' });

    expect(ctx.document.getElementById('ms-topbar').classList.contains('terminal-layout')).toBe(true);
    expect(ctx.document.getElementById('ms-page-title').textContent).toBe('三绿');
    expect(ctx.document.getElementById('ms-crumb').textContent).toBe('本机 / DataAnt');
    expect(ctx.document.querySelector('.terminal-back-btn')).toBeNull();
  });

  it('keeps window navigation server-scoped in the single sidebar', () => {
    const ctx = loadShell();
    seedLocalTmux(ctx.Store);
    const local = ctx.Store.getState().entities.workspaceByServerId.local;
    ctx.Store.setServers([{ id: 'local', name: '本机', kind: 'local' }, { id: 'edge', name: '远端', kind: 'remote' }]);
    ctx.Store.setWorkspace('edge', { ...local, serverId: 'edge', sessions: [{
      id: '$0', name: '远端会话', windows: [{ id: '@0', index: 1, name: '远端任务', panes: [{ id: '%95' }] }],
    }] });
    ctx.Store.setRoute({ name: 'terminal', params: { serverId: 'edge', sessionId: '$0', windowId: '@0' } });
    ctx.Shell.render();
    const links = ctx.document.querySelectorAll('#ms-server-context .tree-window-row > .tree-item');
    expect(links).toHaveLength(1);
    expect(links[0].textContent).toContain('远端任务');
    expect(ctx.win.Router.parse(links[0].dataset.route)).toEqual({ name: 'terminal', params: {
      serverId: 'edge', sessionId: '$0', windowId: '@0', paneId: '%95',
    } });
    expect(links[0].classList.contains('active')).toBe(true);
    ctx.win.close();
  });

  it('keeps useful context when a routed window or session disappears', () => {
    const ctx = loadShell();
    seedLocalTmux(ctx.Store);
    const workspace = ctx.Store.getState().entities.workspaceByServerId.local;
    ctx.Shell.setTerminalHeader('local', workspace, { sessionId: '$0', windowId: '@gone' });
    expect(ctx.document.getElementById('ms-page-title').textContent).toBe('DataAnt');
    expect(ctx.document.getElementById('ms-crumb').textContent).toBe('本机 / DataAnt');
    ctx.Shell.setTerminalHeader('local', workspace, { sessionId: '$gone' });
    expect(ctx.document.getElementById('ms-page-title').textContent).toBe('终端工作台');
    expect(ctx.document.getElementById('ms-crumb').textContent).toBe('本机');
  });

  it('drops the terminal layout for a non-terminal page', () => {
    const ctx = loadShell();
    seedLocalTmux(ctx.Store);
    ctx.Shell.setTerminalHeader('local', ctx.Store.getState().entities.workspaceByServerId.local, {});
    ctx.Shell.setHeader('全局', '状态', '');

    expect(ctx.document.getElementById('ms-topbar').classList.contains('terminal-layout')).toBe(false);
    expect(ctx.document.getElementById('ms-page-title').textContent).toBe('状态');
  });
});

describe('AppShell recent targets', () => {
  it('keys recents by server so two hosts never collide', () => {
    const ctx = loadShell();
    ctx.Shell.noteRecent({ serverId: 'local', sessionId: '$0', windowId: '@1', paneId: '%1' });
    ctx.Shell.noteRecent({ serverId: 'api-linux', sessionId: '$0', windowId: '@1', paneId: '%1' });

    const recents = ctx.Shell.recentTargets();
    expect(recents).toHaveLength(2);
    expect(recents.map((r) => r.serverId)).toEqual(['api-linux', 'local']);
  });

  it('resolves a bare server route to its most recent window', () => {
    const ctx = loadShell();
    seedLocalTmux(ctx.Store);
    ctx.Shell.noteRecent({ serverId: 'local', sessionId: '$0', windowId: '@2', paneId: '%12' });

    expect(ctx.Shell.resolveDefaultTarget('local').params).toEqual({
      serverId: 'local', sessionId: '$0', windowId: '@2', paneId: '%12',
    });
  });

  it('falls back to the first window when there is no history', () => {
    const ctx = loadShell();
    seedLocalTmux(ctx.Store);

    expect(ctx.Shell.resolveDefaultTarget('local').params.windowId).toBe('@0');
  });

  it('returns null when the server has no windows at all', () => {
    const ctx = loadShell();
    seedLocalTmux(ctx.Store, { sessions: [] });

    expect(ctx.Shell.resolveDefaultTarget('local')).toBeNull();
  });
});

describe('AppShell server picker', () => {
  it('opens above a low anchor, clamps the actual width and toggles the same trigger', () => {
    const ctx = loadShell();
    seedLocalTmux(ctx.Store);
    const anchor = ctx.document.querySelector('.sidebar-toggle');
    const popover = ctx.document.getElementById('ms-server-popover');
    anchor.getBoundingClientRect = () => ({ left: 950, top: 730, bottom: 760 });
    popover.getBoundingClientRect = () => ({ width: 306, height: 200 });
    ctx.Shell.showServerPicker(anchor);
    expect(popover.hidden).toBe(false);
    expect(popover.style.top).toBe('524px');
    expect(popover.style.left).toBe('706px');
    expect(anchor.getAttribute('aria-expanded')).toBe('true');
    ctx.Shell.showServerPicker(anchor);
    expect(popover.hidden).toBe(true);
    expect(anchor.getAttribute('aria-expanded')).toBe('false');
    anchor.getBoundingClientRect = () => ({ left: -20, top: 30, bottom: 60 });
    ctx.Shell.showServerPicker(anchor);
    expect(popover.style.left).toBe('12px');
    expect(popover.style.top).toBe('66px');
    ctx.Shell.hideServerPicker();
    ctx.win.MobileUI = { isMobile: () => true };
    ctx.Shell.showServerPicker(anchor);
    expect(popover.style.maxHeight).toBe('');
    ctx.win.close();
  });

  it('sends an unreachable server to its connection page instead of a terminal', () => {
    const ctx = loadShell();
    ctx.Store.setServers([
      { id: 'local', name: '本机', kind: 'local' },
      { id: 'archive', name: 'archive-node', kind: 'remote', address: { host: '10.24.8.39' } },
    ]);
    ctx.Store.setHealth('local', { state: 'online', latencyMs: 2, capabilities: {} });
    ctx.Store.setHealth('archive', { state: 'offline', capabilities: {} });

    ctx.Shell.showServerPicker(ctx.document.querySelector('.sidebar-toggle'));

    const options = [...ctx.document.querySelectorAll('#ms-server-popover .server-option')];
    const routes = options.map((option) => option.dataset.route);
    expect(routes).toContain('#/terminal/local');
    expect(routes).toContain('#/servers/archive/connection');
  });
});

function seedTwoServers(Store) {
  Store.setServers([
    { id: 'local', name: '本机', kind: 'local', immutable: true, address: { host: '127.0.0.1' } },
    { id: 'api-linux', name: 'api-linux', kind: 'remote', address: { host: '10.0.0.21', port: 22 } },
  ]);
  Store.setHealth('local', { state: 'online', latencyMs: 2, capabilities: {} });
  Store.setHealth('api-linux', { state: 'degraded', latencyMs: 41, capabilities: {} });
  Store.setMetrics('local', { cpuPercent: 33, memPercent: 88, sampledAt: '2026-08-31T00:00:00Z' });
}

describe('AppShell shell modes', () => {
  it.each(['status', 'agents'])('focuses the entire status page for standalone=%s and restores the shell when leaving', (standalone) => {
    const ctx = loadShell();
    seedTwoServers(ctx.Store);
    ctx.win.history.replaceState(null, '', '/?standalone=' + standalone);
    const status = { name: 'server', params: { serverId: 'local', section: 'performance' } };
    expect(ctx.Shell.isStandaloneStatus(status)).toBe(true);
    ctx.Shell._syncMode(status);
    expect(ctx.document.documentElement.classList.contains('status-standalone')).toBe(true);

    for (const name of ['terminal', 'settings', 'servers']) {
      const route = { name, params: {} };
      expect(ctx.Shell.isStandaloneStatus(route)).toBe(false);
      ctx.Shell._syncMode(route);
      expect(ctx.document.documentElement.classList.contains('status-standalone')).toBe(false);
    }
    ctx.Shell._syncMode(status);
    expect(ctx.document.documentElement.classList.contains('status-standalone')).toBe(true);
    ctx.win.close();
  });

  it('keeps ordinary and unrecognized standalone URLs in the complete shell', () => {
    const ctx = loadShell();
    const route = { name: 'server', params: { serverId: 'local', section: 'agents' } };
    for (const search of ['', '?standalone=terminal']) {
      ctx.win.history.replaceState(null, '', '/' + search);
      expect(ctx.Shell.isStandaloneStatus(route)).toBe(false);
      ctx.Shell._syncMode(route);
      expect(ctx.document.documentElement.classList.contains('status-standalone')).toBe(false);
    }
    ctx.win.close();
  });

  it('maps each route to its mode', () => {
    const { Shell } = loadShell();
    expect(Shell.mode({ name: 'terminal', params: {} })).toBe('terminal');
    expect(Shell.mode({ name: 'servers', params: {} })).toBe('status');
    expect(Shell.mode({ name: 'server', params: { serverId: 'local' } })).toBe('status');
    expect(Shell.mode({ name: 'settings', params: {} })).toBe('settings');
    expect(Shell.mode({})).toBe('terminal');
  });

  it('marks the mode on the shell element so CSS can scope the sidebar width', () => {
    const ctx = loadShell();
    seedTwoServers(ctx.Store);
    const app = ctx.document.querySelector('.ms-app');

    ctx.Store.setRoute({ name: 'server', params: { serverId: 'local', section: 'performance' } });
    ctx.Shell.render();
    expect(app.classList.contains('mode-status')).toBe(true);
    expect(app.classList.contains('mode-terminal')).toBe(false);

    ctx.Store.setRoute({ name: 'settings', params: {} });
    ctx.Shell.render();
    expect(app.classList.contains('mode-settings')).toBe(true);
    expect(app.classList.contains('mode-status')).toBe(false);

    seedLocalTmux(ctx.Store);
    ctx.Shell.render();
    expect(app.classList.contains('mode-terminal')).toBe(true);
    expect(app.classList.contains('mode-status')).toBe(false);
    expect(app.classList.contains('mode-settings')).toBe(false);
  });

  it('scopes the status width to its own property so terminal width is untouched', () => {
    // Visiting 状态 must not overwrite the width the user chose for the tree.
    const styles = readFileSync('public/css/style.css', 'utf8');
    expect(styles).toMatch(/--ms-status-sidebar-width:\s*\d+px/);
    expect(styles).toMatch(/\.ms-app\.mode-status[\s\S]{0,120}--ms-sidebar-effective-width:\s*var\(--ms-status-sidebar-width\)/);
    // The resizer writes --ms-sidebar-width, so it must not be reachable there.
    expect(styles).toContain('.ms-app.mode-status .sidebar-resizer');
    const hideBlock = styles.slice(
      styles.indexOf('.ms-app.mode-status .sidebar-resizer'),
      styles.indexOf('.brand {'),
    );
    expect(hideBlock).toMatch(/display:\s*none/);
  });
});

describe('AppShell status server rail', () => {
  let ctx;

  beforeEach(() => {
    ctx = loadShell();
    seedTwoServers(ctx.Store);
    ctx.Store.setRoute({ name: 'server', params: { serverId: 'api-linux', section: 'performance' } });
    ctx.Shell.render();
  });

  it('replaces the session tree with a server overview list', () => {
    expect(ctx.document.querySelector('.server-rail')).toBeTruthy();
    expect(ctx.document.querySelector('.tree-window-row')).toBeNull();
    expect(ctx.document.querySelector('.server-switcher')).toBeNull();
    expect(ctx.document.querySelectorAll('.server-rail-item')).toHaveLength(2);
  });

  it('shows name, state, address and latency for each server', () => {
    const rows = [...ctx.document.querySelectorAll('.server-rail-item')];
    expect(rows[0].textContent).toContain('本机');
    expect(rows[0].querySelector('.dot').className).toContain('online');
    expect(rows[1].textContent).toContain('api-linux');
    expect(rows[1].textContent).toContain('10.0.0.21');
    expect(rows[1].textContent).toContain('41ms');
    expect(rows[1].querySelector('.dot').className).toContain('warn');
  });

  it('shows a known metric as a percentage and an unknown one as an em dash', () => {
    const rows = [...ctx.document.querySelectorAll('.server-rail-item')];
    expect(rows[0].querySelector('.server-rail-metrics').textContent).toContain('33%');
    expect(rows[0].querySelector('.server-rail-metrics').textContent).toContain('88%');
    // A server with no sample must never read as 0%.
    const remote = rows[1].querySelector('.server-rail-metrics').textContent;
    expect(remote).toContain('—');
    expect(remote).not.toContain('0%');
  });

  it('marks the routed server as selected', () => {
    const selected = ctx.document.querySelectorAll('.server-rail-item.selected');
    expect(selected).toHaveLength(1);
    expect(selected[0].dataset.railServer).toBe('api-linux');
    expect(selected[0].getAttribute('aria-current')).toBe('true');
  });

  it('routes each row to that server detail, keeping the current section', () => {
    ctx.Store.setRoute({ name: 'server', params: { serverId: 'api-linux', section: 'performance' } });
    ctx.Shell.render();
    const routes = [...ctx.document.querySelectorAll('.server-rail-item')].map((n) => n.dataset.route);
    // Switching servers while comparing performance must stay on performance.
    expect(routes).toEqual(['#/servers/local/performance', '#/servers/api-linux/performance']);
  });

  it('keeps the Agent console only for the local row and falls remote rows back to performance', () => {
    ctx.Store.setRoute({ name: 'server', params: { serverId: 'local', section: 'codex' } });
    ctx.Shell.render();
    const routes = [...ctx.document.querySelectorAll('.server-rail-item')].map((n) => n.dataset.route);
    expect(routes).toEqual(['#/servers/local/agents', '#/servers/api-linux/performance']);
    expect(ctx.Shell._titleFor({ name: 'server', params: { section: 'agents' } })).toBe('Agent 控制台');
  });

  it('falls back to the first visible local monitor section in rail links', () => {
    ctx.Store.setUi({ showPerformance: false, showClaude: true, showCodex: false });
    ctx.Store.setRoute({ name: 'server', params: { serverId: 'local', section: 'performance' } });
    ctx.Shell.render();

    expect(ctx.Shell.localStatusSections()).toEqual(['agents']);
    expect(ctx.Shell.defaultStatusSection('local')).toBe('agents');
    expect(ctx.Shell.resolveStatusSection('local', 'performance')).toBe('agents');
    expect(ctx.Shell.resolveStatusSection('api-linux', 'claude')).toBe('performance');
    expect([...ctx.document.querySelectorAll('.server-rail-item')].map((n) => n.dataset.route))
      .toEqual(['#/servers/local/agents', '#/servers/api-linux/performance']);
    expect(ctx.Shell._titleFor({ name: 'server', params: { section: 'agents' } })).toBe('Agent 控制台');
  });

  it('offers an add-server entry', () => {
    expect(ctx.document.querySelector('.server-rail, .tree-section-head')).toBeTruthy();
    expect(ctx.document.querySelector('[data-action="add-server"]')).toBeTruthy();
  });

  it('restores the session tree when going back to the terminal', () => {
    seedLocalTmux(ctx.Store);
    ctx.Shell.render();
    expect(ctx.document.querySelector('.server-rail')).toBeNull();
    expect(ctx.document.querySelector('.server-switcher')).toBeTruthy();
    expect(ctx.document.querySelectorAll('.tree-window-row')).toHaveLength(2);
  });
});

describe('AppShell status server resolution', () => {
  it('prefers the routed server', () => {
    const ctx = loadShell();
    seedTwoServers(ctx.Store);
    expect(ctx.Shell.statusServerId({ name: 'server', params: { serverId: 'api-linux' } })).toBe('api-linux');
  });

  it('falls back to the remembered server when the route has none', () => {
    const ctx = loadShell();
    seedTwoServers(ctx.Store);
    ctx.Store.setUi({ lastStatusServerId: 'api-linux' });
    expect(ctx.Shell.statusServerId({ name: 'servers', params: {} })).toBe('api-linux');
  });

  it('falls back to local when the remembered server no longer exists', () => {
    const ctx = loadShell();
    seedTwoServers(ctx.Store);
    ctx.Store.setUi({ lastStatusServerId: 'deleted-host' });
    expect(ctx.Shell.statusServerId({ name: 'servers', params: {} })).toBe('local');
  });

  it('falls back to local with no preference at all', () => {
    const ctx = loadShell();
    seedTwoServers(ctx.Store);
    expect(ctx.Shell.statusServerId({ name: 'servers', params: {} })).toBe('local');
  });
});

describe('AppShell settings navigation', () => {
  it('renders a settings nav instead of the server tree', () => {
    const ctx = loadShell();
    seedTwoServers(ctx.Store);
    ctx.Store.setRoute({ name: 'settings', params: {} });
    ctx.Shell.render();

    const items = [...ctx.document.querySelectorAll('.settings-nav-item')];
    expect(items.map((n) => n.dataset.settingsSection)).toEqual(['appearance', 'management', 'security', 'about']);
    expect(items.map((n) => n.textContent)).toEqual(['外观', '管理中心', '连接与安全', 'GitHub']);
    expect(ctx.document.querySelector('.server-rail')).toBeNull();
    expect(ctx.document.querySelector('.tree-window-row')).toBeNull();
  });

  it('marks the active settings section', () => {
    const ctx = loadShell();
    ctx.win.ServersPage = { settingsSection: 'about' };
    ctx.Store.setRoute({ name: 'settings', params: {} });
    ctx.Shell.render();
    const selected = ctx.document.querySelectorAll('.settings-nav-item.selected');
    expect(selected).toHaveLength(1);
    expect(selected[0].dataset.settingsSection).toBe('about');
  });
});

describe('AppShell sidebar width applies immediately', () => {
  const styles = readFileSync('public/css/style.css', 'utf8');

  it('does not transition a width that comes from a custom property', () => {
    // A transitioned property whose value is substituted from an unregistered
    // custom property keeps its stale used value when only that property
    // changes: collapsing the sidebar, or entering status mode, kept painting
    // the previous width even though the property already resolved to the new one.
    const shellGrid = styles.slice(
      styles.indexOf('.ms-app {'),
      styles.indexOf('.ms-app.sidebar-collapsed {'),
    );
    expect(shellGrid).toContain('grid-template-columns: var(--ms-sidebar-effective-width)');
    expect(shellGrid).not.toMatch(/transition:[^;]*grid-template-columns/);

    const sidebar = styles.slice(styles.indexOf('.ms-sidebar {'), styles.indexOf('.sidebar-toggle {'));
    expect(sidebar).toContain('width: var(--ms-sidebar-effective-width)');
    expect(sidebar).not.toMatch(/transition:[^;]*\bwidth\b/);
  });

  it('hides the controls that cannot change a mode-scoped width', () => {
    // In status and settings mode the width is fixed by the mode, so a collapse
    // toggle there would only flip a preference with no visible effect.
    const block = styles.slice(
      styles.indexOf('.ms-app.mode-status .sidebar-resizer'),
      styles.indexOf('.brand {'),
    );
    expect(block).toContain('.ms-app.mode-status .sidebar-toggle');
    expect(block).toContain('.ms-app.mode-settings .sidebar-toggle');
    expect(block).toContain('.ms-app.mode-status .sidebar-resizer');
    expect(block).toContain('.ms-app.mode-settings .sidebar-resizer');
    expect(block).toMatch(/display:\s*none/);
  });
});

describe('AppShell mobile workspace sheet', () => {
  it('makes the thumb rail follow the current server and resolves omitted pane IDs', () => {
    const ctx = loadShell();
    seedLocalTmux(ctx.Store);
    ctx.document.querySelector('.ms-main').insertAdjacentHTML('beforeend', '<nav class="mobile-dock"><button data-route="#/terminal/local" data-terminal-home></button><button data-action="mobile-files"></button><button data-route="#/servers"></button></nav>');
    const route = { name: 'terminal', params: { serverId: 'local', sessionId: '$0', windowId: '@0' } };
    ctx.Store.setRoute(route);
    ctx.Shell.render();
    expect(ctx.Shell.mobilePaneId(route)).toBe('%95');
    expect(ctx.document.querySelector('.mobile-dock [data-action="mobile-files"]').disabled).toBe(false);
    expect(ctx.document.querySelector('.mobile-dock [data-terminal-home]').getAttribute('aria-current')).toBe('page');
    ctx.win.TerminalTarget = { serverId: 'local', sessionId: '$0', windowId: '@0' };
    ctx.win.state = { currentSession: 'DataAnt', currentWindow: '1', currentPane: '%live' };
    expect(ctx.Shell.mobilePaneId(route)).toBe('%live');
    ctx.win.TerminalTarget.serverId = 'remote';
    expect(ctx.Shell.mobilePaneId(route)).toBe('%95');
    ctx.Store.setRoute({ name: 'settings', params: {} });
    ctx.Shell.render();
    expect(ctx.document.querySelector('.mobile-dock [data-action="mobile-files"]').disabled).toBe(true);
    ctx.win.close();
  });

  it('contains focus in the sheet and restores the actual bottom trigger', () => {
    const ctx = loadShell();
    seedLocalTmux(ctx.Store);
    ctx.win.MobileUI = { isMobile: () => true };
    const bottom = ctx.document.createElement('button');
    bottom.dataset.action = 'mobile-workspace';
    ctx.document.querySelector('.ms-main').appendChild(bottom);
    bottom.focus();
    ctx.Shell.openMobileWorkspaceSheet();
    expect(ctx.document.querySelector('.ms-app').inert).toBe(true);
    expect(bottom.getAttribute('aria-expanded')).toBe('true');
    const sheet = ctx.document.getElementById('ms-mobile-workspace-sheet');
    const buttons = [...sheet.querySelectorAll('button')];
    buttons.at(-1).focus();
    ctx.document.dispatchEvent(new ctx.win.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(ctx.document.activeElement).toBe(buttons[0]);
    ctx.document.dispatchEvent(new ctx.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(ctx.document.querySelector('.ms-app').inert).toBe(false);
    expect(ctx.document.activeElement).toBe(bottom);
    expect(bottom.getAttribute('aria-expanded')).toBe('false');
    ctx.win.close();
  });

  it('exposes the same creation shortcuts and per-row menus on desktop and mobile', () => {
    const ctx = loadShell();
    Object.defineProperty(ctx.win, 'innerWidth', { value: 375, configurable: true });
    seedLocalTmux(ctx.Store);
    ctx.Shell.render();
    ctx.Shell.openMobileWorkspaceSheet();

    const sheet = ctx.document.getElementById('ms-mobile-workspace-sheet');
    expect(sheet.querySelector('.tree-section-head [data-action="new-session"]')).not.toBeNull();
    expect(sheet.querySelector('[data-action="new-window"]').dataset.session).toBe('$0');
    expect(sheet.querySelectorAll('[data-action="workspace-entity-menu"]')).toHaveLength(3);
    expect(sheet.querySelector('[data-action="close-session"]')).toBeNull();
    expect(sheet.querySelector('[data-action="close-window"]')).toBeNull();
    expect(ctx.document.querySelector('.ms-sidebar [data-action="close-session"]')).toBeNull();
    expect(ctx.document.querySelectorAll('.ms-sidebar .tree-menu-button')).toHaveLength(3);
    ctx.win.close();
  });

  it('offers session creation in an empty workspace and hides unsupported operations', () => {
    const ctx = loadShell();
    Object.defineProperty(ctx.win, 'innerWidth', { value: 375, configurable: true });
    seedLocalTmux(ctx.Store, { sessions: [] });
    ctx.Shell.render();
    ctx.Shell.openMobileWorkspaceSheet();
    const sheet = ctx.document.getElementById('ms-mobile-workspace-sheet');
    expect(sheet.querySelector('[data-action="new-session"]')).not.toBeNull();

    seedLocalTmux(ctx.Store);
    ctx.Store.setWorkspace('local', { ...ctx.Shell.workspace('local'), actions: {} });
    ctx.Shell.render();
    expect(sheet.querySelector('.tree-add-button')).toBeNull();
    expect(sheet.querySelectorAll('.tree-window-row')).toHaveLength(2);
    ctx.win.close();
  });

  it('uses the title trigger to expose active session and window navigation on phones', () => {
    const ctx = loadShell();
    Object.defineProperty(ctx.win, 'innerWidth', { value: 375, configurable: true });
    seedLocalTmux(ctx.Store);
    ctx.Shell.render();

    const trigger = ctx.document.querySelector('.mobile-workspace-trigger');
    expect(trigger.hidden).toBe(false);
    expect(trigger.textContent).toContain('1 三绿');
    expect(ctx.document.getElementById('ms-mobile-subtitle').textContent).toBe('DataAnt');
    expect(trigger.getAttribute('aria-label')).toContain('DataAnt / 1 三绿');

    ctx.Shell.openMobileWorkspaceSheet();
    const sheet = ctx.document.getElementById('ms-mobile-workspace-sheet');
    expect(sheet).not.toBeNull();
    expect(sheet.querySelector('[data-action="mobile-server"]').textContent).toContain('本机');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const active = sheet.querySelector('.tree-window-row .tree-item.active');
    expect(active.dataset.route).toContain('#/terminal/local/%240/%400');

    ctx.Store.setSessionExpanded('local', '$0', false);
    ctx.Shell.render();
    expect(sheet.querySelectorAll('.tree-window-row')).toHaveLength(2);

    ctx.Shell.closeMobileWorkspaceSheet();
    expect(ctx.document.getElementById('ms-mobile-workspace-sheet')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(ctx.document.activeElement).toBe(trigger);
  });

  it('moves live terminal controls between staging and the visible sheet', () => {
    const ctx = loadShell();
    Object.defineProperty(ctx.win, 'innerWidth', { value: 375, configurable: true });
    seedLocalTmux(ctx.Store);
    ctx.Shell.render();
    const tool = ctx.document.createElement('button');
    tool.className = 'terminal-refresh-btn';
    ctx.document.getElementById('ms-mobile-tools').appendChild(tool);

    ctx.Shell.openMobileWorkspaceSheet();
    expect(ctx.document.querySelector('#ms-mobile-workspace-tools .terminal-refresh-btn')).toBe(tool);

    ctx.Shell.closeMobileWorkspaceSheet({ restoreFocus: false });
    expect(ctx.document.querySelector('#ms-mobile-tools .terminal-refresh-btn')).toBe(tool);
  });

  it('keeps navigation available on settings without terminal controls', () => {
    const ctx = loadShell();
    Object.defineProperty(ctx.win, 'innerWidth', { value: 375, configurable: true });
    seedLocalTmux(ctx.Store);
    ctx.Shell.render();
    ctx.Shell.openMobileWorkspaceSheet();

    ctx.Store.setRoute({ name: 'settings', params: {} });
    ctx.Shell.render();

    const sheet = ctx.document.getElementById('ms-mobile-workspace-sheet');
    expect(sheet).not.toBeNull();
    expect(sheet.classList.contains('has-terminal')).toBe(false);
    expect(sheet.querySelectorAll('.mobile-menu-nav button')).toHaveLength(4);
    expect(sheet.querySelector('[data-route="#/settings"]')).not.toBeNull();
    expect(ctx.document.querySelector('.mobile-workspace-trigger').hidden).toBe(false);
    ctx.Shell.closeMobileWorkspaceSheet();
    ctx.Shell.openMobileWorkspaceSheet();
    expect(ctx.document.querySelector('.mobile-menu-nav [data-terminal-home]').dataset.route).toBe('#/terminal/local');
  });
});


describe('native titlebar drag regions', () => {
  it('reports interactive holes and updates them after a toolbar change', async () => {
    const dom = new JSDOM('<header class="workspace-chrome"><span>工作台</span><button>通知</button><summary>更多</summary></header>',
      { url: 'http://localhost/', runScripts: 'outside-only' });
    const win = dom.window;
    const header = win.document.querySelector('header');
    const button = header.querySelector('button');
    const summary = header.querySelector('summary');
    header.getBoundingClientRect = () => ({ height: 44, top: 0 });
    button.getBoundingClientRect = () => ({ left: 900, top: 8, width: 28, height: 28 });
    summary.getBoundingClientRect = () => ({ left: 940, top: 8, width: 28, height: 28 });
    const messages = [];
    win.webkit = { messageHandlers: { tmuxPanelAction: { postMessage: (message) => messages.push(message) } } };
    win.requestAnimationFrame = (callback) => { callback(); return 1; };
    win.eval(SHELL);
    expect(messages[0]).toMatchObject({ action: 'titlebarDragRegions', height: 44, viewportWidth: 1024,
      exclusions: [{ x: 900, y: 8, width: 28, height: 28 }, { x: 940, y: 8, width: 28, height: 28 }] });
    button.getBoundingClientRect = () => ({ left: 860, top: 8, width: 28, height: 28 });
    button.setAttribute('aria-pressed', 'true');
    await Promise.resolve();
    expect(messages.at(-1).exclusions[0].x).toBe(860);
    expect(messages.at(-1).exclusions).toHaveLength(2);
    const overlay = win.document.createElement('div'); overlay.className = 'fp-overlay';
    win.document.body.append(overlay);
    await Promise.resolve();
    expect(messages.at(-1)).toMatchObject({ height: 0, exclusions: [] });
    overlay.remove(); await Promise.resolve();
    expect(messages.at(-1).height).toBe(44);
    const notification = win.document.createElement('div'); notification.className = 'notification-panel';
    win.document.body.append(notification); await Promise.resolve();
    expect(messages.at(-1).height).toBe(0);
    notification.remove(); await Promise.resolve();
    const picker = win.document.createElement('div'); picker.id = 'ms-server-popover'; picker.hidden = true;
    win.document.body.append(picker); await Promise.resolve();
    expect(messages.at(-1).height).toBe(44);
    picker.hidden = false; await Promise.resolve();
    expect(messages.at(-1).height).toBe(0);
    picker.hidden = true; await Promise.resolve();
    expect(messages.at(-1).height).toBe(44);
    header.getBoundingClientRect = () => ({ height: 0, top: 0 });
    header.hidden = true; await Promise.resolve();
    expect(messages.at(-1)).toMatchObject({ height: 0, exclusions: [] });
    dom.window.close();
  });
});
