// Panel plugins, as a panel of the management centre (PanelSlots.managementPanels,
// plugins/ui/client/js/management-page.js): install, enable, update and remove
// the reviewed packages (/api/plugins), and how an agent connects to their tools.

(function (global) {
  'use strict';
  if (!global.PanelSlots) return;

  const esc = (text) => global.AppShell.escape(text);
  const button = (label, action, extra = '') => '<button class="ms-btn" data-managed="' + action + '" ' + extra + '>' + esc(label) + '</button>';

  function pluginCard(plugin) {
    return '<div class="ms-card managed-card"><h3>' + esc(plugin.name) + ' <small>v' + esc(plugin.installedVersion || plugin.version) + '</small></h3>'
      + '<p>' + esc(plugin.description) + '</p><p>' + (plugin.enabled ? '已启用' : plugin.installed ? '已停用' : '未安装') + '</p><div class="managed-actions">'
      + (plugin.installed ? button(plugin.enabled ? '停用' : '启用', 'plugin-' + (plugin.enabled ? 'disable' : 'enable'), 'data-id="' + esc(plugin.id) + '"')
        + button('卸载', 'plugin-uninstall', 'data-id="' + esc(plugin.id) + '"') : button('安装并启用', 'plugin-install', 'data-id="' + esc(plugin.id) + '"'))
      + (plugin.enabled ? button('Agent 接入配置', 'connection', 'data-id="' + esc(plugin.id) + '"') : '')
      + (plugin.installed ? button('更新插件', 'plugin-update', 'data-id="' + esc(plugin.id) + '"') : '')
      + '</div><div data-connection="' + esc(plugin.id) + '"></div></div>';
  }

  async function mount(host, page) {
    const remount = () => mount(host, page);
    host.innerHTML = '<p role="status">正在读取管理状态…</p>';
    let plugins;
    try {
      plugins = await global.Api.get('/api/plugins');
    } catch (error) {
      if (host.isConnected) host.innerHTML = '<p role="alert">' + esc(error.message) + '</p>' + button('重试', 'refresh');
      host.onclick = remount;
      return;
    }
    if (!host.isConnected) return;
    host.innerHTML = '<div class="section"><div class="section-head"><h3>插件</h3></div>'
      + plugins.plugins.map(pluginCard).join('') + '</div>';

    host.onclick = async (event) => {
      const target = event.target.closest('[data-managed]');
      if (!target || target.disabled) return;
      const action = target.dataset.managed;
      target.disabled = true;
      try {
        if (action === 'refresh') { await remount(); return; }
        if (action === 'connection') {
          const data = await global.Api.get('/api/plugins/' + target.dataset.id + '/connection');
          const container = host.querySelector('[data-connection="' + target.dataset.id + '"]');
          container.innerHTML = '<p>MCP 地址（Streamable HTTP）：</p><pre>' + esc(data.url) + '</pre><pre>' + esc(JSON.stringify(data.config, null, 2))
            + '</pre><p>启用面板认证时，需在 agent 客户端配置面板 Bearer token。此处不导出凭据。HTTPS 自签证书需在客户端建立信任。</p>'
            + button('下载 SKILL.md', 'download-skill', 'data-id="' + esc(target.dataset.id) + '"');
          container.dataset.skill = data.skill;
          return;
        }
        if (action === 'download-skill') {
          const container = host.querySelector('[data-connection="' + target.dataset.id + '"]');
          const url = URL.createObjectURL(new Blob([container.dataset.skill], { type: 'text/markdown' }));
          const link = global.document.createElement('a');
          link.href = url; link.download = 'SKILL.md'; link.click(); URL.revokeObjectURL(url);
          return;
        }
        await global.Api.post('/api/plugins/' + target.dataset.id + '/' + action.slice(7));
        global.AppShell.toast('操作完成');
        await remount();
      } catch (error) {
        await remount();
        page.feedback(error.message);
        global.AppShell.toast(error.message);
      } finally { target.disabled = false; }
    };
  }

  global.PanelSlots.managementPanels.register({ id: 'plugins', order: 20, mount: mount });
})(typeof window !== 'undefined' ? window : globalThis);
