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
    const config = resources.tmuxConfig;
    root.innerHTML = '<div class="intro"><h2>管理中心</h2><p>管理面板所在机器的 tmux、配置、插件和 Agent Skills。</p></div>'
      + '<div class="section"><div class="section-head"><h3>tmux 运行时</h3>' + button('刷新状态', 'refresh') + '</div>'
      + '<div class="ms-card managed-card"><strong>' + esc(runtime.version || '尚未安装项目 tmux') + '</strong>'
      + '<p class="mono">' + esc(runtime.path) + '</p><p>从项目固定的 tmux 源码构建；保留上一版本供回退。更新不会重启正在运行的会话。</p>'
      + '<div class="managed-actions">' + button(runtime.available ? '重新构建 / 更新' : '构建并安装', 'build', runtime.build?.status === 'running' ? 'disabled' : '')
      + button('回退上一版本', 'rollback', runtime.build?.status === 'running' ? 'disabled' : '') + '</div>'
      + '<div id="managed-build" aria-live="polite">' + buildHtml(runtime.build) + '</div></div></div>'
      + '<div class="section"><div class="section-head"><h3>tmux 配置</h3><span>' + (config.linked ? '已接入 ~/.tmux.conf' : '尚未接入') + '</span></div>'
      + '<div class="ms-card managed-card"><label for="managed-config">项目管理的配置片段</label>'
      + '<p class="mono">' + esc(config.path) + '</p><textarea id="managed-config" spellcheck="false" rows="9">' + esc(config.content) + '</textarea>'
      + '<p>保存会创建备份。接入只添加一个标记区块，保留其他个人配置；应用会影响当前 tmux。</p>'
      + '<div class="managed-actions">' + button('保存配置', 'save-config') + button(config.linked ? '取消自动加载' : '接入自动加载', config.linked ? 'unlink-config' : 'link-config')
      + button('应用已保存配置', 'apply-config') + '</div><p class="muted">备份目录：' + esc(config.backupDirectory) + '</p></div></div>'
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
        if (action !== 'save-config' && root.querySelector('#managed-config').value !== config.content) {
          throw new Error('配置有未保存的修改，请先保存再执行其他管理操作。');
        }
        let result;
        if (action === 'save-config') {
          result = await global.Api.request('PUT', api + '/tmux/config', { content: root.querySelector('#managed-config').value, expectedContent: config.content });
          config.content = root.querySelector('#managed-config').value;
        } else if (action.endsWith('-config')) {
          result = await global.Api.post(api + '/tmux/config/' + action.split('-')[0]);
        } else if (action === 'build' || action === 'rollback') {
          result = await global.Api.post(api + '/tmux/' + action);
        } else if (action.startsWith('plugin-')) {
          result = await global.Api.post('/api/plugins/' + target.dataset.id + '/' + action.slice(7));
        } else if (action.startsWith('skill-')) {
          result = await global.Api.post(api + '/skills/' + target.dataset.name + '/' + target.dataset.target + '/' + action.slice(6));
        }
        global.AppShell.toast(result?.backup ? '已保存，备份：' + result.backup : action === 'build' ? '构建已启动，可在此查看结果' : '操作完成');
        if (action !== 'save-config') await mount(root);
        else feedback.textContent = '已保存，尚未应用。备份：' + (result.backup || '首次保存');
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
