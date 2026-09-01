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
      <strong id="ms-mobile-title"></strong><small id="ms-mobile-subtitle"></small>
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

  it('offers session and window lifecycle controls when the provider allows them', () => {
    expect(ctx.document.querySelector('[data-action="new-session"]')).toBeTruthy();
    expect(ctx.document.querySelector('[data-action="rename-session"]').dataset.session).toBe('$0');
    expect(ctx.document.querySelector('[data-action="close-session"]').dataset.session).toBe('$0');
    expect(ctx.document.querySelector('[data-action="new-window"]').dataset.session).toBe('$0');
    expect(ctx.document.querySelector('[data-action="rename-window"]').dataset.window).toBe('@0');
    const closeWindows = [...ctx.document.querySelectorAll('[data-action="close-window"]')];
    expect(closeWindows.map((node) => node.dataset.window)).toEqual(['@0', '@2']);
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
    expect(ctx.document.querySelector('[data-action="rename-window"]')).toBeTruthy();
    expect(ctx.document.querySelector('[data-action="close-window"]')).toBeTruthy();
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
    ctx.Shell.setSidebarCollapsed(false);

    const app = ctx.document.querySelector('.ms-app');
    const toggle = ctx.document.querySelector('.sidebar-toggle');
    expect(app.classList.contains('sidebar-collapsed')).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toBe('‹');

    ctx.Shell.setSidebarCollapsed(true);
    expect(app.classList.contains('sidebar-collapsed')).toBe(true);
    expect(toggle.getAttribute('aria-label')).toBe('展开侧边栏');
  });
});

describe('AppShell window bar', () => {
  it('shows server, session and window with no back button', () => {
    const ctx = loadShell();
    seedLocalTmux(ctx.Store);
    const workspace = ctx.Store.getState().entities.workspaceByServerId.local;

    ctx.Shell.setTerminalHeader('local', workspace, { sessionId: '$0', windowId: '@0' });

    expect(ctx.document.getElementById('ms-topbar').classList.contains('terminal-layout')).toBe(true);
    expect(ctx.document.getElementById('ms-page-title').textContent).toBe('本机 / DataAnt / 1 三绿');
    expect(ctx.document.querySelector('.terminal-back-btn')).toBeNull();
  });

  it('centers the title inside the space left of the toolbar', () => {
    const styles = readFileSync('public/css/style.css', 'utf8');
    const bar = styles.slice(
      styles.indexOf('.ms-topbar.terminal-layout {'),
      styles.indexOf('.ms-topbar.terminal-layout .terminal-tool-button'),
    );

    expect(bar).toContain('display: grid');
    expect(bar).toContain('grid-template-columns: minmax(0, 1fr) auto');
    expect(bar).toMatch(/\.ms-topbar\.terminal-layout \.crumbs\s*\{[^}]*text-align:\s*center/);
    expect(bar).toMatch(/\.ms-topbar\.terminal-layout \.top-actions\s*\{[^}]*margin-left:\s*0/);
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

  it('keeps Codex only for the local row and falls remote rows back to performance', () => {
    ctx.Store.setRoute({ name: 'server', params: { serverId: 'local', section: 'codex' } });
    ctx.Shell.render();
    const routes = [...ctx.document.querySelectorAll('.server-rail-item')].map((n) => n.dataset.route);
    expect(routes).toEqual(['#/servers/local/codex', '#/servers/api-linux/performance']);
    expect(ctx.Shell._titleFor({ name: 'server', params: { section: 'codex' } })).toBe('Codex 用量');
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
    expect(items.map((n) => n.dataset.settingsSection)).toEqual(['appearance', 'security', 'about']);
    expect(items.map((n) => n.textContent)).toEqual(['外观', '连接与安全', 'GitHub']);
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
