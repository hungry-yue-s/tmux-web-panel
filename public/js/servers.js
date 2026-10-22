(function (global) {
  var Shell = null;

  function shell() {
    Shell = Shell || global.AppShell;
    return Shell;
  }

  function esc(value) { return shell().escape(value); }

  function actionButton(label, action, primary, iconName) {
    return '<button class="ms-btn ' + (primary ? 'primary' : '') + '" data-action="' + action + '">'
      + (iconName ? shell().icon(iconName) : '') + esc(label) + '</button>';
  }

  function routeButton(label, route, primary, iconName) {
    return '<button class="ms-btn ' + (primary ? 'primary' : '') + '" data-route="'
      + esc(global.Router.serialize(route)) + '">'
      + (iconName ? shell().icon(iconName) : '') + esc(label) + '</button>';
  }

  function kpi(label, value, toneName, note) {
    return '<div class="ms-card kpi"><div class="kpi-top"><span>' + esc(label) + '</span>'
      + '<span class="dot ' + (toneName === 'red' ? 'offline' : toneName === 'yellow' ? 'warn' : 'online') + '"></span></div>'
      + '<div class="kpi-value ' + toneName + '">' + esc(value) + '</div>'
      + '<div class="kpi-note">' + esc(note) + '</div></div>';
  }

  function detail(label, value) {
    return '<div class="detail-row"><span>' + esc(label) + '</span><strong class="mono">' + esc(value) + '</strong></div>';
  }

  function timeline(label, value, ok) {
    return '<div class="timeline-row"><span class="' + (ok ? 'check' : 'skip') + '">' + (ok ? '✓' : '△') + '</span>'
      + '<strong>' + esc(label) + '</strong><small>' + esc(value) + '</small></div>';
  }

  function capabilityStatus(capability, health, isTmux) {
    if (health.state === 'disabled') return { text: '已停用', ok: false };
    if (health.state === 'checking') return { text: '检测中', ok: false };
    if (!health.checkedAt || health.state === 'unknown') return { text: '未检测', ok: false };
    if (health.state !== 'online' && health.state !== 'degraded') return { text: '未取得结果', ok: false };
    if (capability && capability.available === true) {
      return { text: '可用' + (isTmux && capability.version ? ' · ' + capability.version : ''), ok: true };
    }
    if (!capability || capability.available !== false) return { text: '未取得结果', ok: false };
    var reason = capability && capability.reason;
    var reasons = { command_not_found: '未安装', unsupported_platform: '该平台不支持',
      version_unparseable: '版本无法识别', command_failed: '检测失败' };
    if (reason) return { text: reasons[reason] || '不可用', ok: false };
    return { text: '不可用', ok: false };
  }

  /** Percent for display: unknown stays an em dash rather than becoming 0. */
  function pct(value) {
    return value === null || value === undefined || !Number.isFinite(Number(value))
      ? '—'
      : Math.round(Number(value)) + '%';
  }

  function relativeTime(iso) {
    if (!iso) return '从未';
    var then = Date.parse(iso);
    if (!Number.isFinite(then)) return '—';
    var seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (seconds < 10) return '刚刚';
    if (seconds < 60) return seconds + ' 秒前';
    if (seconds < 3600) return Math.floor(seconds / 60) + ' 分钟前';
    if (seconds < 86400) return Math.floor(seconds / 3600) + ' 小时前';
    return Math.floor(seconds / 86400) + ' 天前';
  }

  var ServersPage = {
    settingsSection: 'appearance',

    /** Server workspace: identity strip plus capability-driven tabs. */
    renderServer: function (route) {
      var serverId = route.params.serverId;
      var section = route.params.section || 'performance';
      var server = shell().server(serverId);
      if (!server) {
        return '<div class="ms-card empty"><h3>服务器不存在</h3>'
          + '<p>它可能已被删除。</p>' + routeButton('返回状态列表', { name: 'servers', params: {} }, true) + '</div>';
      }

      var health = shell().health(serverId);
      var workspace = shell().workspace(serverId);
      var openWorkspace = workspace && workspace.provider !== 'unavailable'
        ? routeButton('打开工作区', { name: 'terminal', params: { serverId: serverId } }, true, 'terminal')
        : '';

      shell().setHeader(
        '服务器 / ' + server.name,
        ({ performance: '性能', agents: 'Agent 控制台', claude: 'Agent 控制台', codex: 'Agent 控制台', connection: '连接' })[section] || '性能',
        '',
      );

      var base = this._hero(server, health, openWorkspace, route) + this._tabs(server, section);
      if (section === 'connection') return base + this._connection(server, health, workspace);
      if (section === 'agents' && server.kind === 'local') return base + this._localAgents();
      return base + (server.kind === 'local'
        ? this._localPerformance()
        : this._performance(serverId, health));
    },

    /**
     * The local machine has the full performance component. Each status route
     * requests only the roots and pollers it owns; the legacy app keeps the
     * no-argument all-in-one mode.
     */
    _localPerformance: function () {
      if (!global.PerfPanel || typeof global.PerfPanel.renderSkeleton !== 'function') {
        return '<div class="ms-card empty"><h3>性能组件未加载</h3>'
          + '<p>PerfPanel 脚本缺失，无法显示本机性能。</p></div>';
      }
      return '<div class="section local-perf-host">' + global.PerfPanel.renderSkeleton('performance') + '</div>';
    },

    _localClaude: function () {
      if (!global.PerfPanel || typeof global.PerfPanel.renderSkeleton !== 'function') {
        return '<div class="ms-card empty"><h3>Claude 用量组件未加载</h3></div>';
      }
      return '<div class="section local-perf-host">' + global.PerfPanel.renderSkeleton('claude') + '</div>';
    },

    _localCodex: function () {
      if (!global.PerfPanel || typeof global.PerfPanel.renderSkeleton !== 'function') {
        return '<div class="ms-card empty"><h3>Codex 用量组件未加载</h3></div>';
      }
      return '<div class="section local-perf-host">' + global.PerfPanel.renderSkeleton('codex') + '</div>';
    },

    _localAgents: function () {
      if (!global.AgentHub || typeof global.AgentHub.renderSkeleton !== 'function') {
        return '<div class="ms-card empty"><h3>Agent 控制台组件未加载</h3></div>';
      }
      return '<div class="section local-agent-host">' + global.AgentHub.renderSkeleton() + '</div>';
    },

    _hero: function (server, health, openWorkspace, route) {
      var stateTone = shell().tone(health.state);
      var facts = health.facts || {};
      var mobile = global.MobileUI && global.MobileUI.isMobile();
      var operations = (shell().isStandaloneStatus(route) ? '' : actionButton('独立展示', 'detach-status', false, ''))
        + actionButton('立即检测', 'probe', false, 'refresh')
        + (server.immutable ? '' : actionButton('编辑', 'edit-server', false, ''));
      return '<div class="ms-card server-hero"><div class="server-icon">' + shell().icon('server') + '</div>'
        + '<div class="server-hero-copy"><h2>' + esc(server.name) + ' '
        + '<span class="ms-badge ' + stateTone.tone + '"><span class="dot ' + stateTone.dot + '"></span>'
        + esc(stateTone.label) + '</span></h2>'
        + '<p>' + esc(shell()._addressOf(server)) + ' · '
        + esc([facts.platform, facts.arch].filter(Boolean).join(' ') || '—') + ' · '
        + esc(shell()._latencyOf(health)) + ' · 更新于 ' + esc(relativeTime(health.checkedAt)) + '</p></div>'
        + '<div class="hero-actions">' + openWorkspace
        + '<details class="mobile-server-operations"' + (mobile ? '' : ' open') + '><summary>服务器操作</summary><div>' + operations + '</div></details>'
        + '</div></div>';
    },

    _tabs: function (server, section) {
      var labels = { performance: '性能', agents: 'Agent 控制台', claude: 'Claude 用量', codex: 'Codex 用量', connection: '连接' };
      var entries = server.kind === 'local'
        ? shell().localStatusSections().map(function (name) { return [name, labels[name]]; })
        : [['performance', labels.performance]];
      entries.push(['connection', labels.connection]);
      return '<div class="tabs">' + entries.map(function (entry) {
        var route = { name: 'server', params: { serverId: server.id, section: entry[0] } };
        return '<button class="tab ' + (section === entry[0] ? 'active' : '') + '"'
          + ' data-route="' + esc(global.Router.serialize(route)) + '">' + esc(entry[1]) + '</button>';
      }).join('') + '</div>';
    },

    _performance: function (serverId, health) {
      var metrics = global.Store.getState().entities.metricsByServerId[serverId] || {};
      if (!metrics.sampledAt) {
        var unsupported = metrics.availability && metrics.availability.cpu === 'unsupported';
        return '<div class="ms-card empty"><div class="empty-icon">' + shell().icon('gauge') + '</div>'
          + '<h3>' + (unsupported ? '该平台暂不支持性能采集' : '暂时没有性能数据') + '</h3>'
          + '<p>' + (unsupported
            ? '面板只为 Linux 与 macOS 提供只读探针，未知值不会用 0 代替。'
            : '最后一次采集未成功。恢复连接后会继续采样，当前不会用 0 代替未知值。')
          + '</p>'
          + (metrics.last
            ? '<p class="muted">最后一次成功样本：CPU ' + esc(pct(metrics.last.cpuPercent))
              + ' · ' + esc(relativeTime(metrics.last.sampledAt)) + '</p>'
            : '')
          + '</div>';
      }

      return '<div class="grid kpi-grid">'
        + kpi('CPU', pct(metrics.cpuPercent), Number(metrics.cpuPercent) >= 70 ? 'yellow' : 'blue', '整机口径')
        + kpi('内存', pct(metrics.memPercent), Number(metrics.memPercent) >= 85 ? 'red' : 'purple',
          metrics.memMetric || '整机口径')
        + kpi('磁盘', pct(metrics.diskPercent), Number(metrics.diskPercent) >= 80 ? 'yellow' : 'green', '根卷')
        + kpi('负载', metrics.load1 === null || metrics.load1 === undefined ? '—' : String(metrics.load1), 'green',
          'load 1 分钟')
        + kpi('延迟', shell()._latencyOf(health), 'blue', 'SSH 往返')
        + '</div>'
        + '<div class="section"><div class="section-head"><h3>采样历史</h3>'
        + '<span>内存态，面板重启后重新开始</span></div>'
        + '<div class="ms-card chart-card"><div class="chart-title"><strong>CPU 趋势</strong>'
        + '<span>' + esc(relativeTime(metrics.sampledAt)) + '</span></div>'
        + this._sparkline(serverId) + '</div></div>';
    },

    _sparkline: function (serverId) {
      var history = global.Store.getState().entities.metricsByServerId[serverId];
      var points = (history && history.historyPoints) || [];
      if (points.length < 2) {
        return '<p class="muted" style="margin-top:14px">正在积累采样点…</p>';
      }
      var width = 700;
      var height = 180;
      var step = width / (points.length - 1);
      var path = points.map(function (point, index) {
        var value = Number.isFinite(Number(point.cpuPercent)) ? Number(point.cpuPercent) : 0;
        var y = height - (value / 100) * height;
        return (index === 0 ? 'M' : 'L') + Math.round(index * step) + ' ' + Math.round(y);
      }).join('');
      return '<svg class="chart" viewBox="0 0 700 190" preserveAspectRatio="none">'
        + '<path class="chart-grid" d="M0 25H700M0 75H700M0 125H700M0 175H700"/>'
        + '<path class="chart-line" d="' + path + '"/></svg>';
    },

    _localConnection: function (health) {
      var facts = health.facts || {}, capabilities = health.capabilities || {};
      var platforms = { darwin: 'macOS', linux: 'Linux', windows: 'Windows' };
      var tmux = capabilityStatus(capabilities.tmux, health, true);
      var metrics = capabilityStatus(capabilities.metrics, health, false);
      return '<div class="grid two-col connection-local"><section>'
        + '<div class="section-head"><h3>本机信息</h3></div><div class="ms-card detail-list">'
        + detail('连接方式', '本机进程')
        + detail('平台', platforms[facts.platform] || facts.platform || '未检测')
        + detail('架构', facts.arch || '未检测')
        + detail('主机名', facts.hostname || '未检测')
        + '</div><p class="muted">直接读取本机运行状态。</p></section><section>'
        + '<div class="section-head"><h3>最近检测结果</h3><span>' + esc(relativeTime(health.checkedAt)) + '</span></div>'
        + '<div class="ms-card timeline">'
        + timeline('tmux', tmux.text, tmux.ok)
        + timeline('指标采集能力', metrics.text, metrics.ok)
        + '</div></section></div>';
    },

    _connection: function (server, health, workspace) {
      if (server.kind === 'local') return this._localConnection(health);
      var address = server.address || {};
      var ssh = server.ssh || {};
      var capabilities = health.capabilities || {};
      var keyProblem = health.state === 'host_key_error';
      var verified = Boolean(health.checkedAt && (health.state === 'online' || health.state === 'degraded')
        && capabilities.ssh && capabilities.ssh.available === true);
      var connection = verified ? '已验证' : ({ offline: '连接失败', auth_required: '身份认证失败',
        host_key_error: '主机指纹需要确认', checking: '检测中', disabled: '已停用' })[health.state] || '未检测';
      var tmux = capabilityStatus(capabilities.tmux, health, true);
      var metrics = capabilityStatus(capabilities.metrics, health, false);

      return '<div class="grid two-col connection-remote"><section>'
        + '<div class="section-head"><h3>连接配置</h3></div>'
        + '<div class="ms-card detail-list">'
        + detail('Host', address.host || ssh.configHost || '—')
        + detail('SSH Port', address.port || (ssh.configHost ? '来自 ssh config' : '未配置'))
        + detail('Username', address.user || (ssh.configHost ? '来自 ssh config' : '—'))
        + detail('认证配置', ssh.usesIdentityFile ? '指定私钥文件' : 'SSH Agent / ssh config')
        + detail('最近成功', relativeTime(health.lastOnlineAt))
        + '</div>'
        + (keyProblem
          ? '<div class="section"><div class="ms-card capability">'
            + '<div class="capability-head"><strong>主机指纹需要确认</strong>'
            + '<span class="ms-badge red">阻断</span></div>'
            + '<p>面板不会自动信任或覆盖主机密钥。请通过可信渠道核对指纹后再确认。</p>'
            + actionButton('获取指纹', 'scan-host-key', true, '') + '</div></div>'
          : '')
        + (workspace && workspace.pendingProvider === 'tmux'
          ? '<div class="section"><div class="ms-card capability">'
            + '<div class="capability-head"><strong>tmux 已可用</strong>'
            + '<span class="ms-badge yellow">待切换</span></div>'
            + '<p>当前 SSH Session 仍在运行，关闭后自动切换到 tmux；也可以立即切换并结束这些 Session。</p>'
            + actionButton('立即切换到 tmux', 'adopt-provider', false, '') + '</div></div>'
          : '')
        + (server.immutable ? '' : '<div class="section">'
          + actionButton('删除服务器', 'delete-server', false, '') + '</div>')
        + '</section><section>'
        + '<div class="section-head"><h3>最近一次检测</h3><span>' + esc(relativeTime(health.checkedAt)) + '</span></div>'
        + '<div class="ms-card timeline">'
        + timeline('SSH 连接', connection, verified)
        + timeline('指标采集能力', metrics.text, metrics.ok)
        + timeline('tmux', tmux.text, tmux.ok)
        + '</div>'
        + '<p class="muted" style="margin-top:10px">面板不会在远端安装、升级或启动 tmux。</p>'
        + '</section></div>';
    },

    renderSettings: function () {
      shell().setHeader('全局', '设置', '');
      var section = this.settingsSection || 'appearance';
      var navigation = '<nav class="mobile-settings-nav" aria-label="设置分类">' + shell().SETTINGS_SECTIONS.map(function (entry) {
        return '<button type="button" data-settings-section="' + entry[0] + '"'
          + (entry[0] === section ? ' aria-current="page"' : '') + '>' + esc(entry[1]) + '</button>';
      }).join('') + '</nav>';
      var content = section === 'management' ? '<div id="managed-resources"></div>'
        : section === 'security' ? this._settingsSecurity()
          : section === 'about' ? this._settingsAbout() : this._settingsAppearance();
      return navigation + content;
    },

    _settingsAppearance: function () {
      return '<div class="intro"><h2>外观</h2><p>主题会立即应用到面板与终端。</p></div>'
        + '<div class="section"><div class="section-head"><h3>主题</h3>'
        + '<span>当前：' + esc(global.Theme ? global.Theme.getName() : '—') + '</span></div>'
        + this._themeGrid() + '</div>'
        + this._transparencySettings()
        + this._monitorPageSettings();
    },

    _transparencySettings: function () {
      if (!global.Theme || !global.Theme.supportsTransparency || !global.Theme.supportsTransparency()) return '';
      var amount = global.Theme.getTransparency();
      return '<div class="section native-transparency-settings"><div class="section-head">'
        + '<h3><label for="native-transparency">背景透明度</label></h3>'
        + '<output id="native-transparency-value" for="native-transparency">' + amount + '%</output></div>'
        + '<input id="native-transparency" type="range" min="0" max="50" step="1" value="' + amount + '"'
        + ' aria-describedby="native-transparency-help">'
        + '<p id="native-transparency-help" class="muted">0% 为不透明；调高可透出桌面毛玻璃效果，文字保持清晰。仅在 macOS 客户端生效。</p></div>'
        + (global.Theme.supportsGlassIntensity && global.Theme.supportsGlassIntensity()
          ? '<div class="section native-transparency-settings"><div class="section-head">'
            + '<h3><label for="native-glass-intensity">毛玻璃强度</label></h3>'
            + '<output id="native-glass-intensity-value" for="native-glass-intensity">' + global.Theme.getGlassIntensity() + '%</output></div>'
            + '<input id="native-glass-intensity" type="range" min="0" max="100" step="1" value="' + global.Theme.getGlassIntensity() + '"'
            + ' aria-describedby="native-glass-intensity-help">'
            + '<p id="native-glass-intensity-help" class="muted">0% 关闭毛玻璃，100% 为最强效果；背景透明度大于 0% 时可见。</p></div>'
          : '');
    },

    _monitorPageSettings: function () {
      var ui = global.Store.getState().ui;
      var entries = [
        ['showPerformance', '性能', '机器与窗口资源'],
        ['showClaude', 'Claude 数据源', '在 Agent 控制台显示 Claude 配额与趋势'],
        ['showCodex', 'Codex / Qoder 数据源', '在 Agent 控制台显示账号、供应商与 CLI 活动'],
      ];
      var enabledCount = entries.filter(function (entry) { return ui[entry[0]]; }).length;
      return '<div class="section"><div class="section-head"><h3>监控页面</h3>'
        + '<span>至少保留一个</span></div><div class="ms-card monitor-page-settings">'
        + entries.map(function (entry) {
          var enabled = ui[entry[0]];
          var locked = enabled && enabledCount === 1;
          return '<label class="monitor-page-toggle' + (locked ? ' locked' : '') + '">'
            + '<span><strong>' + esc(entry[1]) + '</strong><small>' + esc(entry[2]) + '</small></span>'
            + '<input type="checkbox" data-action="toggle-monitor-page" data-ui-key="' + entry[0] + '"'
            + (enabled ? ' checked' : '') + (locked ? ' disabled' : '') + '>'
            + '<span class="monitor-page-toggle-track" aria-hidden="true"></span></label>';
        }).join('') + '</div></div>';
    },

    /** Reuses Theme's own registry so the panel never keeps a second copy. */
    _themeGrid: function () {
      if (!global.Theme || typeof global.Theme.getThemeList !== 'function') {
        return '<div class="ms-card empty"><h3>主题组件未加载</h3></div>';
      }
      var current = global.Theme.getCurrent();
      return '<div class="theme-grid">' + global.Theme.getThemeList().map(function (theme) {
        var colors = theme.colors || {};
        var isActive = theme.id === current;
        var bg = colors['--workspace-bg'] || colors['--bg-primary'];
        var bgCard = colors['--workspace-sidebar'] || colors['--bg-card'];
        var text = colors['--workspace-text'] || colors['--text-primary'];
        var accent = colors['--workspace-accent'] || colors['--accent-blue'];
        var terminal = theme.terminal || {};
        return '<button class="theme-card' + (isActive ? ' active' : '') + '"'
          + ' data-action="set-theme" data-theme="' + esc(theme.id) + '"'
          + (isActive ? ' aria-current="true"' : '')
          + ' style="background:' + esc(bg) + ';border-color:' + esc(isActive ? accent : bgCard) + '">'
          + '<span class="theme-card-preview">'
          + '<span class="theme-card-bar" style="background:' + esc(bgCard) + '">'
          + '<span style="background:' + esc(colors['--accent-red']) + '"></span>'
          + '<span style="background:' + esc(colors['--accent-green']) + '"></span>'
          + '<span style="background:' + esc(accent) + '"></span></span>'
          + '<span class="theme-card-body" style="background:' + esc(bg) + '">'
          + '<span class="theme-card-line" style="background:' + esc(text) + ';opacity:.6;width:70%"></span>'
          + '<span class="theme-card-line" style="background:' + esc(accent) + ';opacity:.7;width:50%"></span>'
          + '<span class="theme-card-line" style="background:' + esc(colors['--accent-purple'])
          + ';opacity:.5;width:60%"></span>'
          + '<span class="theme-card-swatches" aria-hidden="true">'
          + ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'].map(function (color) {
            return '<i style="background:' + esc(terminal[color] || accent) + '"></i>';
          }).join('') + '</span></span></span>'
          + '<span class="theme-card-name" style="color:' + esc(text) + '">' + esc(theme.name) + '</span>'
          + (theme.description ? '<span class="theme-card-description" style="color:'
            + esc(colors['--workspace-muted'] || text) + '">' + esc(theme.description) + '</span>' : '')
          + '</button>';
      }).join('') + '</div>';
    },

    _settingsSecurity: function () {
      return '<div class="intro"><h2>连接与安全</h2>'
        + '<p>面板只保存连接引用，密码与私钥内容不会落盘。</p></div>'
        + '<div class="grid two-col"><div class="ms-card detail-list">'
        + detail('认证引用', 'SSH Agent 与 ~/.ssh/config')
        + detail('主机密钥', '需显式确认，变化后阻断连接')
        + detail('远端安装', '不安装、不升级、不启动远端 tmux')
        + '</div><div class="ms-card detail-list">'
        + detail('私钥', '仅保存路径引用')
        + detail('探针', '只读，非交互')
        + detail('SSH 选项', 'BatchMode，StrictHostKeyChecking')
        + '</div></div>';
    },

    _settingsAbout: function () {
      var signOut = global.Auth && global.Auth.getToken()
        ? '<div class="section"><div class="section-head"><h3>账户</h3>'
          + '<span>登录已启用</span></div><div class="ms-card detail-list">'
          + '<div class="workspace-missing-actions">'
          + actionButton('退出登录', 'logout', false, '') + '</div></div></div>'
        : '';
      return '<div class="intro"><h2>GitHub</h2><p>项目源码与版本信息。</p></div>'
        + '<div class="ms-card detail-list">'
        + detail('名称', 'Tmux Web Panel')
        + detail('版本', 'v1.0.0')
        + detail('说明', '面向移动端友好的 tmux 会话管理界面')
        + '</div>'
        + '<div class="section"><a class="ms-btn" href="https://github.com/hungry-yue-s/tmux-web-panel"'
        + ' target="_blank" rel="noopener">查看 GitHub 仓库 →</a></div>'
        + signOut;
    },
  };

  global.ServersPage = ServersPage;
})(typeof window !== 'undefined' ? window : globalThis);
