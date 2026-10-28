(function (global) {
  const esc = (text) => global.AppShell.escape(text);
  const api = '/api/managed-resources';
  const button = (label, action, extra = '') => '<button class="ms-btn" data-managed="' + action + '" ' + extra + '>' + esc(label) + '</button>';
  const statusNames = { running: '构建中', completed: '构建完成', failed: '构建失败', interrupted: '结果待核对' };

  async function mount(root) {
    if (!root) return;
    root.innerHTML = '<p role="status">正在读取管理状态…</p>';
    let resources;
    let plugins;
    try {
      [resources, plugins] = await Promise.all([global.Api.get(api), global.Api.get('/api/plugins')]);
    } catch (error) {
      if (root.isConnected) root.innerHTML = '<p role="alert">' + esc(error.message) + '</p>' + button('重试', 'refresh');
      root.onclick = () => mount(root);
      return;
    }
    if (!root.isConnected) return;
    const runtime = resources.runtime;
    const sessionsRoute = global.Router ? global.Router.serialize({ name: 'server', params: { serverId: 'local', section: 'sessions' } }) : '';
    root.innerHTML = '<div class="intro"><h2>管理中心</h2><p>管理面板所在机器的 tmux、配置、插件和 Agent Skills。</p></div>'
      + '<div class="section"><div class="section-head"><h3>tmux 运行时</h3>' + button('刷新状态', 'refresh') + '</div>'
      + '<div class="ms-card managed-card"><strong>' + esc(runtime.version || '尚未安装项目 tmux') + '</strong>'
      + '<p class="mono">' + esc(runtime.path) + '</p><p>' + (runtime.packaged
        ? '此 tmux 随桌面客户端提供，无需本机编译。请通过客户端更新运行时，现有个人 tmux 不会被替换。'
        : '从项目固定的 tmux 源码构建；保留上一版本供回退。更新不会重启正在运行的会话。') + '</p>'
      + '<div class="managed-actions">' + (runtime.buildSupported === false ? '' : button(runtime.available ? '重新构建 / 更新' : '构建并安装', 'build', runtime.build?.status === 'running' ? 'disabled' : ''))
      + (runtime.rollbackSupported === false ? '' : button('回退上一版本', 'rollback', runtime.build?.status === 'running' ? 'disabled' : '')) + '</div>'
      + '<div id="managed-build" aria-live="polite">' + buildHtml(runtime.build) + '</div></div></div>'
      + '<div class="section"><div class="section-head"><h3>tmux 配置</h3></div>'
      + '<div class="ms-card managed-card"><p>会话保护（自动保存、重启后恢复）、找回会话，以及面板需要的 tmux 设置，'
      + '都在每台服务器的“会话”页面里设置，远程服务器也一样。</p>'
      + (sessionsRoute ? '<button class="ms-btn" data-route="' + esc(sessionsRoute) + '">打开本机的会话页面</button>' : '') + '</div></div>'
      + '<div class="section"><div class="section-head"><h3>插件</h3></div>'
      + plugins.plugins.map((plugin) => '<div class="ms-card managed-card"><h3>' + esc(plugin.name) + ' <small>v' + esc(plugin.installedVersion || plugin.version) + '</small></h3>'
        + '<p>' + esc(plugin.description) + '</p><p>' + (plugin.enabled ? '已启用' : plugin.installed ? '已停用' : '未安装') + '</p><div class="managed-actions">'
        + (plugin.installed ? button(plugin.enabled ? '停用' : '启用', 'plugin-' + (plugin.enabled ? 'disable' : 'enable'), 'data-id="' + esc(plugin.id) + '"')
          + button('卸载', 'plugin-uninstall', 'data-id="' + esc(plugin.id) + '"') : button('安装并启用', 'plugin-install', 'data-id="' + esc(plugin.id) + '"'))
        + (plugin.enabled ? button('Agent 接入配置', 'connection', 'data-id="' + esc(plugin.id) + '"') : '')
        + (plugin.installed ? button('更新插件', 'plugin-update', 'data-id="' + esc(plugin.id) + '"') : '')
        + '</div><div data-connection="' + esc(plugin.id) + '"></div></div>').join('') + '</div>'
      + '<div class="section"><div class="section-head"><h3>Agent Skills</h3></div><div class="ms-card managed-card">'
      + '<p>安装为指向本仓库的链接，项目更新后同步生效。已有的同名个人 skill 不会被覆盖；安装后在 agent 中开启新会话。</p>'
      + resources.skills.map((skill) => '<div class="managed-skill"><div><strong>' + esc(skill.name) + ' · ' + esc(skill.target) + '</strong><small class="mono">'
        + esc(skill.path) + '</small><small>' + ({ managed: '本项目管理', conflict: '同名路径由其他来源管理', not_installed: '未安装' })[skill.status] + '</small></div>'
        + button(skill.status === 'managed' ? '移除' : '安装', 'skill-' + (skill.status === 'managed' ? 'uninstall' : 'install'), 'data-name="' + esc(skill.name) + '" data-target="' + esc(skill.target) + '"' + (skill.status === 'conflict' ? ' disabled' : '')) + '</div>').join('')
      + '</div></div><p id="managed-feedback" role="status" aria-live="polite"></p>';

    root.onclick = async (event) => {
      const target = event.target.closest('[data-managed]');
      if (!target || target.disabled) return;
      const action = target.dataset.managed;
      const feedback = root.querySelector('#managed-feedback');
      target.disabled = true;
      try {
        if (action === 'refresh') { await mount(root); return; }
        if (action === 'connection') {
          const data = await global.Api.get('/api/plugins/' + target.dataset.id + '/connection');
          const container = root.querySelector('[data-connection="' + target.dataset.id + '"]');
          container.innerHTML = '<p>MCP 地址（Streamable HTTP）：</p><pre>' + esc(data.url) + '</pre><pre>' + esc(JSON.stringify(data.config, null, 2))
            + '</pre><p>启用面板认证时，需在 agent 客户端配置面板 Bearer token。此处不导出凭据。HTTPS 自签证书需在客户端建立信任。</p>'
            + button('下载 SKILL.md', 'download-skill', 'data-id="' + esc(target.dataset.id) + '"');
          container.dataset.skill = data.skill;
          return;
        }
        if (action === 'download-skill') {
          const container = root.querySelector('[data-connection="' + target.dataset.id + '"]');
          const url = URL.createObjectURL(new Blob([container.dataset.skill], { type: 'text/markdown' }));
          const link = global.document.createElement('a');
          link.href = url; link.download = 'SKILL.md'; link.click(); URL.revokeObjectURL(url);
          return;
        }
        let result;
        if (action === 'build' || action === 'rollback') {
          result = await global.Api.post(api + '/tmux/' + action);
        } else if (action.startsWith('plugin-')) {
          result = await global.Api.post('/api/plugins/' + target.dataset.id + '/' + action.slice(7));
        } else if (action.startsWith('skill-')) {
          result = await global.Api.post(api + '/skills/' + target.dataset.name + '/' + target.dataset.target + '/' + action.slice(6));
        }
        global.AppShell.toast(action === 'build' ? '构建已启动，可在此查看结果' : '操作完成');
        await mount(root);
      } catch (error) {
        feedback.textContent = error.message;
        global.AppShell.toast(error.message);
      } finally { target.disabled = false; }
    };

    if (runtime.build?.status === 'running') {
      const buildNode = root.querySelector('#managed-build');
      const poll = async () => {
        if (!buildNode.isConnected) return;
        try {
          const latest = await global.Api.get(api);
          if (!buildNode.isConnected) return;
          buildNode.innerHTML = buildHtml(latest.runtime.build);
          if (latest.runtime.build?.status === 'running') global.setTimeout(poll, 2000);
          else {
            root.querySelector('[data-managed="build"]').disabled = false;
            root.querySelector('[data-managed="rollback"]').disabled = false;
          }
        } catch (error) { buildNode.textContent = error.message; }
      };
      global.setTimeout(poll, 2000);
    }
  }

  function buildHtml(build) {
    return build ? '<p>' + esc(statusNames[build.status] || build.status) + (build.exitCode != null ? ' · exit ' + build.exitCode : '')
      + '</p><pre>' + esc(build.output || build.message || '') + '</pre>' : '';
  }
  global.ManagementPage = { mount };
})(typeof window !== 'undefined' ? window : globalThis);
