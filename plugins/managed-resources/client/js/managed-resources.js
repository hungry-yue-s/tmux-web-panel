// What the project manages on this machine, as two panels of the management
// centre (PanelSlots.managementPanels, plugins/ui/client/js/management-page.js):
// the tmux runtime with where its configuration is set, and the Agent Skills
// with the presentation-page skill. Both read /api/managed-resources.

(function (global) {
  'use strict';
  if (!global.PanelSlots) return;

  const esc = (text) => global.AppShell.escape(text);
  const api = '/api/managed-resources';
  const button = (label, action, extra = '') => '<button class="ms-btn" data-managed="' + action + '" ' + extra + '>' + esc(label) + '</button>';
  const statusNames = { running: '构建中', completed: '构建完成', failed: '构建失败', interrupted: '结果待核对' };
  const skillRows = (skills) => skills.map((skill) => '<div class="managed-skill"><div><strong>' + esc(skill.name) + ' · ' + esc(skill.target) + '</strong><small class="mono">'
    + esc(skill.path) + '</small><small>' + ({ managed: '本项目管理', conflict: '同名路径由其他来源管理', not_installed: '未安装' })[skill.status] + '</small></div>'
    + button(skill.status === 'managed' ? '移除' : '安装', 'skill-' + (skill.status === 'managed' ? 'uninstall' : 'install'), 'data-name="' + esc(skill.name) + '" data-target="' + esc(skill.target) + '"' + (skill.status === 'conflict' ? ' disabled' : '')) + '</div>').join('');

  function buildHtml(build) {
    return build ? '<p>' + esc(statusNames[build.status] || build.status) + (build.exitCode != null ? ' · exit ' + build.exitCode : '')
      + '</p><pre>' + esc(build.output || build.message || '') + '</pre>' : '';
  }

  /** Reads the resources into `host`, or shows why not with a retry; null when it could not. */
  async function load(host, again) {
    host.innerHTML = '<p role="status">正在读取管理状态…</p>';
    try {
      const resources = await global.Api.get(api);
      return host.isConnected ? resources : null;
    } catch (error) {
      if (host.isConnected) host.innerHTML = '<p role="alert">' + esc(error.message) + '</p>' + button('重试', 'refresh');
      host.onclick = again;
      return null;
    }
  }

  /** Runs an action button's request, then shows the panel again; a failure is reported on the page. */
  function actions(host, page, remount, run) {
    host.onclick = async (event) => {
      const target = event.target.closest('[data-managed]');
      if (!target || target.disabled) return;
      const action = target.dataset.managed;
      target.disabled = true;
      try {
        if (action === 'refresh') { await remount(); return; }
        await run(action, target);
        global.AppShell.toast(action === 'build' ? '构建已启动，可在此查看结果' : '操作完成');
        await remount();
      } catch (error) {
        // A filesystem error may interrupt a bulk operation after one install.
        await remount();
        page.feedback(error.message);
        global.AppShell.toast(error.message);
      } finally { target.disabled = false; }
    };
  }

  async function mountTmux(host, page) {
    const remount = () => mountTmux(host, page);
    const resources = await load(host, remount);
    if (!resources) return;
    const runtime = resources.runtime;
    const sessionsRoute = global.Router ? global.Router.serialize({ name: 'server', params: { serverId: 'local', section: 'sessions' } }) : '';
    host.innerHTML = '<div class="section"><div class="section-head"><h3>tmux 运行时</h3>' + button('刷新状态', 'refresh') + '</div>'
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
      + (sessionsRoute ? '<button class="ms-btn" data-route="' + esc(sessionsRoute) + '">打开本机的会话页面</button>' : '') + '</div></div>';

    actions(host, page, remount, (action) => global.Api.post(api + '/tmux/' + action));

    if (runtime.build?.status === 'running') {
      const buildNode = host.querySelector('#managed-build');
      const poll = async () => {
        if (!buildNode.isConnected) return;
        try {
          const latest = await global.Api.get(api);
          if (!buildNode.isConnected) return;
          buildNode.innerHTML = buildHtml(latest.runtime.build);
          if (latest.runtime.build?.status === 'running') global.setTimeout(poll, 2000);
          else {
            host.querySelector('[data-managed="build"]').disabled = false;
            host.querySelector('[data-managed="rollback"]').disabled = false;
          }
        } catch (error) { buildNode.textContent = error.message; }
      };
      global.setTimeout(poll, 2000);
    }
  }

  async function mountSkills(host, page) {
    const remount = () => mountSkills(host, page);
    const resources = await load(host, remount);
    if (!resources) return;
    const presentationSkills = resources.skills.filter((skill) => skill.name === 'panel-presentation');
    const presentationInstalled = presentationSkills.length > 0 && presentationSkills.every((skill) => skill.status === 'managed');
    host.innerHTML = '<div class="section"><div class="section-head"><h3>信息呈现网页</h3></div><div class="ms-card managed-card">'
      + '<p>让 Agent 生成的个人报告、说明和可视化网页跟随面板配色，切换主题时即时更新。</p>'
      + '<p>Skill 只提供主题接入约定，布局、字体、组件和交互由 Agent 自由设计；专门的视觉作品可保留自己的风格。</p>'
      + '<p>选择 Agent 全局安装，或安装到全部受支持的 Agent（当前为 Codex、Claude）。安装位置为面板所在机器，开启新会话后生效。</p>'
      + (presentationSkills.length ? '<div class="managed-actions">' + button(presentationInstalled ? '从全部 Agent 移除' : '为全部 Agent 安装',
        'skill-' + (presentationInstalled ? 'uninstall' : 'install'), 'data-name="panel-presentation" data-target="all"'
        + (presentationSkills.some((skill) => skill.status === 'conflict') ? ' disabled' : '')) + '</div>' + skillRows(presentationSkills) : '')
      + '</div></div>'
      + '<div class="section"><div class="section-head"><h3>Agent Skills</h3></div><div class="ms-card managed-card">'
      + '<p>安装为指向本仓库的链接，项目更新后同步生效。已有的同名个人 skill 不会被覆盖；安装后在 agent 中开启新会话。</p>'
      + skillRows(resources.skills.filter((skill) => skill.name !== 'panel-presentation'))
      + '</div></div>';

    actions(host, page, remount, (action, target) => global.Api.post(api + '/skills/' + target.dataset.name + '/' + target.dataset.target + '/' + action.slice(6)));
  }

  global.PanelSlots.managementPanels.register({ id: 'tmux', order: 10, mount: mountTmux });
  global.PanelSlots.managementPanels.register({ id: 'skills', order: 30, mount: mountSkills });
})(typeof window !== 'undefined' ? window : globalThis);
