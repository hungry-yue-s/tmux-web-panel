import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const scripts = ['router', 'store', 'app-shell', 'theme', 'servers']
  .map((name) => readFileSync('public/js/' + name + '.js', 'utf8'));
let dom;
afterEach(() => dom?.window.close());

function setup() {
  dom = new JSDOM('<header id="ms-topbar"><span id="ms-crumb"></span><h1 id="ms-page-title"></h1><div id="ms-top-actions"></div></header><main id="view"></main>', {
    url: 'https://servers-page.test/', runScripts: 'outside-only',
  });
  scripts.forEach((source) => dom.window.eval(source));
  const win = dom.window;
  win.PerfPanel = { renderSkeleton: () => '<section>本机性能</section>' };
  win.Store.setServers([
    { id: 'local', name: '本机', kind: 'local', immutable: true },
    { id: 'remote', name: '开发机', kind: 'remote', address: { host: 'dev.test', port: 2222, user: 'dev' }, ssh: {} },
  ]);
  return { win, doc: win.document, Store: win.Store, Page: win.ServersPage };
}

function render(ctx, id, health, section = 'connection') {
  ctx.Store.setHealth(id, health);
  ctx.Store.setWorkspace(id, { provider: 'tmux', serverId: id, sessions: [] });
  ctx.doc.getElementById('view').innerHTML = ctx.Page.renderServer({ name: 'server', params: { serverId: id, section } });
  return ctx.doc.getElementById('view');
}

const checkedAt = '2026-10-21T10:00:00.000Z';

describe('ServersPage real connection facts and actions', () => {
  it('exposes every settings category in the mobile page and folds host operations', () => {
    const ctx = setup();
    ctx.win.MobileUI = { isMobile: () => true };
    ctx.doc.getElementById('view').innerHTML = ctx.Page.renderSettings();
    const nav = ctx.doc.querySelector('.mobile-settings-nav');
    expect([...nav.querySelectorAll('button')].map(button => button.dataset.settingsSection)).toEqual(['appearance', 'management', 'security', 'about']);
    expect(nav.querySelector('[aria-current="page"]').dataset.settingsSection).toBe('appearance');
    const view = render(ctx, 'local', { state: 'online', capabilities: {} }, 'performance');
    const operations = view.querySelector('.mobile-server-operations');
    expect(operations.open).toBe(false);
    expect(operations.querySelector('[data-action="detach-status"]')).not.toBeNull();
    expect(operations.querySelector('[data-action="probe"]')).not.toBeNull();
  });

  it('keeps one action group in the server hero, including empty performance pages', () => {
    const ctx = setup();
    for (const id of ['local', 'remote']) {
      const view = render(ctx, id, { state: 'online', checkedAt, capabilities: {} }, 'performance');
      expect(ctx.doc.getElementById('ms-top-actions').childElementCount).toBe(0);
      expect(view.querySelectorAll('[data-action="probe"]')).toHaveLength(1);
      expect(view.querySelectorAll('button[data-route="#/terminal/' + id + '"]')).toHaveLength(1);
      expect(view.querySelector('.hero-actions [data-action="probe"]')).not.toBeNull();
      expect(view.querySelectorAll('.hero-actions [data-action="detach-status"]')).toHaveLength(1);
      if (id === 'remote') {
        render(ctx, id, { state: 'unknown', capabilities: {} });
        expect(view.querySelectorAll('[data-action="edit-server"]')).toHaveLength(1);
      }
    }
  });

  it.each(['status', 'agents'])('retains the whole server panel without another detach button for standalone=%s', (standalone) => {
    const ctx = setup();
    ctx.win.history.replaceState(null, '', '/?standalone=' + standalone);
    for (const id of ['local', 'remote']) {
      const view = render(ctx, id, { state: 'online', checkedAt, capabilities: {} }, 'performance');
      expect(view.querySelector('.server-hero')).not.toBeNull();
      expect(view.querySelector('.tabs')).not.toBeNull();
      expect(view.querySelectorAll('[data-action="detach-status"]')).toHaveLength(0);
      expect(view.querySelector('[data-route="#/servers/' + id + '/performance"]')).not.toBeNull();
      expect(view.querySelector('[data-route="#/servers/' + id + '/connection"]')).not.toBeNull();
    }
  });

  it('shows measured local platform, tmux and metrics without SSH configuration or invented stages', () => {
    const ctx = setup();
    const view = render(ctx, 'local', { state: 'degraded', checkedAt,
      facts: { platform: 'darwin', arch: 'arm64', hostname: 'workstation' },
      capabilities: { ssh: { available: true, reason: 'local' }, tmux: { available: false, reason: 'command_not_found' }, metrics: { available: true } },
    });
    expect(view.querySelector('.connection-local')).not.toBeNull();
    expect(view.textContent).toContain('本机进程');
    expect(view.textContent).toContain('macOS');
    expect(view.textContent).toContain('arm64');
    expect(view.textContent).toContain('workstation');
    expect(view.textContent).toContain('未安装');
    expect(view.textContent).toContain('指标采集能力');
    expect(view.querySelectorAll('.timeline-row .check')).toHaveLength(1);
    expect(view.textContent).not.toMatch(/SSH Port|SSH 握手|TCP 连接|身份认证|Username/);
  });

  it('keeps unmeasured local capabilities unknown rather than marking them successful or unavailable', () => {
    const ctx = setup();
    const view = render(ctx, 'local', { state: 'unknown', checkedAt: null,
      capabilities: { ssh: { available: false }, tmux: { available: false }, metrics: { available: false } },
    });
    const connection = view.querySelector('.connection-local');
    expect(connection.textContent).toContain('未检测');
    expect(connection.textContent).not.toMatch(/可用|成功|未安装|不可用/);
    expect(connection.querySelector('.check')).toBeNull();
  });

  it.each(['unknown', 'checking', 'offline', 'auth_required', 'host_key_error', 'disabled'])(
    'does not invent successful SSH stages for remote state %s', (state) => {
      const ctx = setup();
      const view = render(ctx, 'remote', { state, checkedAt: state === 'unknown' ? null : checkedAt, capabilities: {} });
      const connection = view.querySelector('.connection-remote');
      expect(connection.textContent).toContain('SSH Port');
      expect(connection.textContent).toContain('2222');
      expect(connection.querySelector('.timeline').textContent).not.toMatch(/SSH 握手|TCP 连接|成功|已验证/);
      expect(connection.querySelector('.check')).toBeNull();
      if (state === 'host_key_error') expect(connection.querySelector('[data-action="scan-host-key"]')).not.toBeNull();
      if (state === 'auth_required') expect(connection.textContent).toContain('身份认证失败');
    },
  );

  it.each(['disabled', 'offline', 'auth_required', 'host_key_error'])(
    'does not render historical capability successes after the connection becomes %s', (state) => {
      const ctx = setup();
      const view = render(ctx, 'remote', { state, checkedAt, capabilities: {
        ssh: { available: true }, tmux: { available: true, version: '3.5a' }, metrics: { available: true },
      } });
      const timeline = view.querySelector('.connection-remote .timeline');
      expect(timeline.querySelector('.check')).toBeNull();
      expect(timeline.textContent).not.toMatch(/可用|已验证/);
      expect(timeline.textContent).toContain(state === 'disabled' ? '已停用' : '未取得结果');
    },
  );

  it('does not turn the retained capabilities green after an online workspace is disabled', async () => {
    const ctx = setup();
    ctx.Store.setHealth('remote', { state: 'online', checkedAt, capabilities: {
      ssh: { available: true }, tmux: { available: true, version: '3.5a' }, metrics: { available: true },
    } });
    ctx.win.eval(readFileSync('public/js/ms-app.js', 'utf8'));
    ctx.win.Api = { workspaceUrl: () => '/stub', get: async () => {
      throw Object.assign(new Error('disabled'), { code: 'SERVER_DISABLED' });
    } };
    await ctx.win.MsApp.refreshWorkspace('remote');
    const health = ctx.win.AppShell.health('remote');
    expect(health.state).toBe('disabled');
    expect(health.capabilities.tmux.available).toBe(true);
    const view = render(ctx, 'remote', health);
    const timeline = view.querySelector('.connection-remote .timeline');
    expect(timeline.querySelector('.check')).toBeNull();
    expect([...timeline.querySelectorAll('small')].map((row) => row.textContent))
      .toEqual(['已停用', '已停用', '已停用', '已停用']);
  });

  it('only marks SSH verified when the health response explicitly reports a checked connection', () => {
    const ctx = setup();
    let view = render(ctx, 'remote', { state: 'online', checkedAt, capabilities: {} });
    expect(view.querySelector('.connection-remote').textContent).not.toContain('已验证');
    expect(view.querySelector('.connection-remote .check')).toBeNull();
    view = render(ctx, 'remote', { state: 'online', checkedAt,
      capabilities: { ssh: { available: true }, tmux: { available: true, version: '3.5a' }, metrics: { available: false } },
    });
    expect(view.querySelector('.connection-remote').textContent).toContain('已验证');
    expect(view.querySelector('.connection-remote').textContent).toContain('3.5a');
    // SSH tunnel, panel service and tmux; metrics stays unchecked.
    expect(view.querySelectorAll('.connection-remote .check')).toHaveLength(3);
  });

  it('leaves a missing SSH port unspecified instead of presenting 22 as an observed fact', () => {
    const ctx = setup();
    ctx.Store.setServers([{ id: 'remote', name: '未配置端口', kind: 'remote', address: { host: 'dev.test' }, ssh: {} }]);
    const view = render(ctx, 'remote', { state: 'unknown', capabilities: {} });
    const row = [...view.querySelectorAll('.detail-row')].find((element) => element.textContent.includes('SSH Port'));
    expect(row.textContent).toContain('未配置');
    expect(row.textContent).not.toContain('22');
  });

  it('previews workbench semantic colors from the real theme registry', () => {
    const ctx = setup();
    ctx.doc.getElementById('view').innerHTML = ctx.Page.renderSettings();
    const card = ctx.doc.querySelector('[data-theme="deep-current"]');
    const colors = ctx.win.Theme.getThemeList().find((theme) => theme.id === 'deep-current').colors;
    const toRGB = (hex) => 'rgb(' + [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16)).join(', ') + ')';
    expect(card.querySelector('.theme-card-bar').style.background).toBe(toRGB(colors['--workspace-sidebar']));
    expect(card.querySelectorAll('.theme-card-bar span')[2].style.background).toBe(toRGB(colors['--workspace-accent']));
    expect(card.querySelector('.theme-card-name').textContent).toBe('Deep Current');
  });
});

describe('ServersPage basic mode', () => {
  const basicHealth = {
    state: 'online',
    checkedAt,
    capabilities: { ssh: { available: true }, tmux: { available: true, version: '3.4' }, files: { available: false, reason: 'node_not_installed' } },
    workspace: { provider: 'tmux', transport: 'ssh', persistence: 'tmux' },
    node: { installed: false, posix: true, platform: 'linux' },
  };

  it('offers to install the panel instead of the machine pages', () => {
    const ctx = setup();
    for (const section of ['performance', 'agents']) {
      const view = render(ctx, 'remote', basicHealth, section);
      const card = view.querySelector('.install-node-card');
      expect(card).toBeTruthy();
      expect(card.textContent).toContain('远端 tmux 会话');
      expect(card.querySelector('[data-action="install-node"]').textContent).toContain('安装面板服务');
      expect(view.textContent).not.toContain('本机性能');
    }
  });

  it('says hosted shells end with the client when there is no remote tmux', () => {
    const ctx = setup();
    const view = render(ctx, 'remote', { ...basicHealth, workspace: { provider: 'ssh', transport: 'ssh', persistence: 'process-memory' } }, 'performance');
    expect(view.querySelector('.install-node-card').textContent).toContain('客户端退出后结束');
  });

  it('shows the install offer and the panel state on the connection page', () => {
    const ctx = setup();
    const view = render(ctx, 'remote', basicHealth, 'connection');
    expect(view.querySelector('.install-node-card')).toBeTruthy();
    expect(view.textContent).toContain('未安装（基础模式）');
  });

  it('renders a running installation with its step and log tail, and no button', () => {
    const ctx = setup();
    ctx.win.MsApp = { installJob: () => ({ state: 'running', step: 'npm ci', log: ['>> unpack panel', '>> npm ci', 'added 120 packages'] }) };
    const card = render(ctx, 'remote', basicHealth, 'performance').querySelector('.install-node-card');
    expect(card.querySelector('.install-progress').textContent).toContain('npm ci');
    expect(card.querySelector('.install-log').textContent).toContain('added 120 packages');
    expect(card.querySelector('[data-action="install-node"]')).toBeNull();
  });

  it('asks to continue with a sudo password, or to retry after a failure', () => {
    const ctx = setup();
    ctx.win.MsApp = { installJob: () => ({ state: 'needs_password', log: [] }) };
    expect(render(ctx, 'remote', basicHealth, 'performance').querySelector('[data-action="install-node"]').textContent)
      .toContain('sudo 密码');
    ctx.win.MsApp = { installJob: () => ({ state: 'failed', error: { message: 'npm ci failed' }, log: [] }) };
    const card = render(ctx, 'remote', basicHealth, 'performance').querySelector('.install-node-card');
    expect(card.textContent).toContain('npm ci failed');
    expect(card.querySelector('[data-action="install-node"]').textContent).toContain('重试');
  });

  it('keeps the full pages for a server whose panel answers', () => {
    const ctx = setup();
    const view = render(ctx, 'remote', { ...basicHealth, node: { installed: true } }, 'performance');
    expect(view.querySelector('.install-node-card')).toBeNull();
    expect(view.textContent).toContain('本机性能');
  });
});
