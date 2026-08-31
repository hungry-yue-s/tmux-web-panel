(function (global) {
  var ICONS = {
    terminal: '<svg class="ms-icon" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/></svg>',
    gauge: '<svg class="ms-icon" viewBox="0 0 24 24"><path d="M20 13a8 8 0 1 0-16 0"/><path d="m12 13 4-4"/><path d="M5 19h14"/></svg>',
    settings: '<svg class="ms-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .4 1.9l-2.9 2.9a1.7 1.7 0 0 0-1.9-.4 1.7 1.7 0 0 0-1 1.6h-4a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.4l-2.9-2.9a1.7 1.7 0 0 0 .4-1.9A1.7 1.7 0 0 0 3 14v-4a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.4-1.9l2.9-2.9a1.7 1.7 0 0 0 1.9.4A1.7 1.7 0 0 0 10 3h4a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.4l2.9 2.9a1.7 1.7 0 0 0-.4 1.9 1.7 1.7 0 0 0 1.6 1v4a1.7 1.7 0 0 0-1.6 1Z"/></svg>',
    bell: '<svg class="ms-icon" viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg>',
    server: '<svg class="ms-icon" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01M17 7h1M17 17h1"/></svg>',
    overview: '<svg class="ms-icon" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
    plus: '<svg class="ms-icon" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    refresh: '<svg class="ms-icon" viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>',
    chevron: '<svg class="ms-icon" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>',
  };

  /** Health state -> the dot class and the words next to it. */
  var STATE_TONE = {
    online: { dot: 'online', tone: 'green', label: '在线' },
    degraded: { dot: 'warn', tone: 'yellow', label: '需关注' },
    checking: { dot: 'checking', tone: 'muted', label: '检测中' },
    unknown: { dot: 'checking', tone: 'muted', label: '未检测' },
    offline: { dot: 'offline', tone: 'red', label: '离线' },
    auth_required: { dot: 'auth', tone: 'red', label: '认证失败' },
    host_key_error: { dot: 'auth', tone: 'red', label: '指纹变化' },
    disabled: { dot: 'offline', tone: 'muted', label: '已停用' },
  };

  function icon(name) { return ICONS[name] || ''; }

  function esc(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function tone(state) {
    return STATE_TONE[state] || STATE_TONE.unknown;
  }

  /** Unknown, unsupported and failed all render as an em dash, never as 0. */
  function metricCell(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) {
      return '<span class="muted">—</span>';
    }
    var pct = Math.round(Number(value));
    var color = pct >= 85 ? 'var(--accent-red)' : pct >= 70 ? 'var(--accent-yellow)' : 'var(--accent-blue)';
    return '<div><span class="metric">' + pct + '%</span><div class="metric-bar">'
      + '<i style="width:' + pct + '%;background:' + color + '"></i></div></div>';
  }

  function badge(toneName, text) {
    return '<span class="ms-badge ' + toneName + '">' + esc(text) + '</span>';
  }

  function providerBadge(workspace) {
    if (!workspace) return '';
    if (workspace.provider === 'tmux') return '<span class="provider-badge">TMUX</span>';
    if (workspace.provider === 'ssh') return '<span class="provider-badge">SSH</span>';
    return '';
  }

  function el(id) { return global.document.getElementById(id); }

  var AppShell = {
    _started: false,
    _statusUnsub: null,

    icon: icon,
    escape: esc,
    tone: tone,
    metricCell: metricCell,

    /** Server list ordered with the built-in local record first. */
    servers: function () {
      var byId = global.Store.getState().entities.serversById;
      return Object.keys(byId).map(function (id) { return byId[id]; }).sort(function (a, b) {
        if (a.id === 'local') return -1;
        if (b.id === 'local') return 1;
        return String(a.name || a.id).localeCompare(String(b.name || b.id));
      });
    },

    server: function (serverId) {
      return global.Store.getState().entities.serversById[serverId] || null;
    },

    health: function (serverId) {
      var server = this.server(serverId);
      var stored = global.Store.getState().entities.healthByServerId[serverId];
      return stored || (server && server.status) || { state: 'unknown' };
    },

    workspace: function (serverId) {
      return global.Store.getState().entities.workspaceByServerId[serverId] || null;
    },

    /** The server the current route is about, falling back to local. */
    activeServerId: function () {
      var route = global.Store.getState().route || {};
      var params = route.params || {};
      return params.serverId || 'local';
    },

    /** The shell mode drives which sidebar is rendered and how wide it is. */
    mode: function (route) {
      var name = route && route.name ? route.name : 'terminal';
      if (name === 'servers' || name === 'server') return 'status';
      if (name === 'settings') return 'settings';
      return 'terminal';
    },

    /**
     * Status mode always has a selected server: the routed one, else the last
     * one looked at, else the built-in local record.
     */
    statusServerId: function (route) {
      var params = (route && route.params) || {};
      if (params.serverId) return params.serverId;
      var remembered = global.Store.getState().ui.lastStatusServerId;
      if (remembered && this.server(remembered)) return remembered;
      return 'local';
    },

    render: function () {
      var route = global.Store.getState().route || {};
      this._syncMode(route);
      this._renderSidebar(route);
      this._renderMobile(route);
      this._syncNav(route);
    },

    _syncMode: function (route) {
      var app = global.document.querySelector('.ms-app');
      if (!app) return;
      var mode = this.mode(route);
      app.classList.toggle('mode-terminal', mode === 'terminal');
      app.classList.toggle('mode-status', mode === 'status');
      app.classList.toggle('mode-settings', mode === 'settings');
    },

    _renderSidebar: function (route) {
      var context = el('ms-server-context');
      if (!context) return;
      var mode = this.mode(route);
      if (mode === 'status') {
        context.innerHTML = this._renderServerRail(route);
        return;
      }
      if (mode === 'settings') {
        context.innerHTML = this._renderSettingsNav();
        return;
      }

      var serverId = this.activeServerId();
      var server = this.server(serverId);
      var health = this.health(serverId);
      var stateTone = tone(health.state);

      var switcher = '<button class="server-switcher" data-action="server-switcher">'
        + '<span class="dot ' + stateTone.dot + '"></span>'
        + '<span><strong>' + esc(server ? server.name : serverId) + '</strong>'
        + '<small>当前服务器 · ' + esc(this._addressOf(server)) + ' · '
        + esc(this._latencyOf(health)) + '</small></span>'
        + '<span>⌄</span></button>';

      context.innerHTML = switcher + '<div class="subnav">' + this._renderTree(serverId, route) + '</div>';
    },

    /**
     * Status mode sidebar: the server overview list itself, so choosing a server
     * only swaps the detail pane instead of routing through a separate list page.
     */
    _renderServerRail: function (route) {
      var self = this;
      var selectedId = this.statusServerId(route);
      var section = (route && route.params && route.params.section) || 'overview';
      var metricsById = global.Store.getState().entities.metricsByServerId;

      var rows = this.servers().map(function (server) {
        var health = self.health(server.id);
        var stateTone = tone(health.state);
        var metrics = metricsById[server.id] || {};
        // Keep the section when switching servers: a user comparing performance
        // should not be thrown back to the overview tab.
        var target = { name: 'server', params: { serverId: server.id, section: section } };
        return '<button class="server-rail-item' + (server.id === selectedId ? ' selected' : '') + '"'
          + ' data-route="' + esc(global.Router.serialize(target)) + '"'
          + ' data-rail-server="' + esc(server.id) + '"'
          + ' title="' + esc(server.name) + '"'
          + (server.id === selectedId ? ' aria-current="true"' : '') + '>'
          + '<span class="server-rail-head"><span class="dot ' + stateTone.dot + '"></span>'
          + '<strong>' + esc(server.name) + '</strong>'
          + '<small>' + esc(stateTone.label) + '</small></span>'
          + '<span class="server-rail-address">' + esc(self._addressOf(server))
          + ' · ' + esc(self._latencyOf(health)) + '</span>'
          + '<span class="server-rail-metrics">'
          + self._railMetric('CPU', metrics.cpuPercent)
          + self._railMetric('内存', metrics.memPercent)
          + '</span></button>';
      }).join('');

      return '<div class="tree-section-head"><span>服务器</span>'
        + '<button class="tree-add-button" data-action="add-server" title="添加服务器"'
        + ' aria-label="添加服务器">+</button></div>'
        + '<div class="server-rail">' + rows + '</div>';
    },

    /** Unknown stays an em dash here too; a 0% bar would read as real data. */
    _railMetric: function (label, value) {
      var known = value !== null && value !== undefined && Number.isFinite(Number(value));
      var pct = known ? Math.round(Number(value)) : null;
      var color = !known ? 'var(--text-muted)'
        : pct >= 85 ? 'var(--accent-red)'
          : pct >= 70 ? 'var(--accent-yellow)' : 'var(--accent-blue)';
      return '<span class="server-rail-metric"><small>' + esc(label) + '</small>'
        + '<span class="metric">' + (known ? pct + '%' : '—') + '</span>'
        + '<span class="metric-bar"><i style="width:' + (known ? pct : 0)
        + '%;background:' + color + '"></i></span></span>';
    },

    SETTINGS_SECTIONS: [
      ['appearance', '外观'],
      ['security', '连接与安全'],
      ['about', 'GitHub'],
    ],

    _renderSettingsNav: function () {
      var active = global.ServersPage ? global.ServersPage.settingsSection : 'appearance';
      return '<div class="tree-section-head"><span>设置</span></div>'
        + '<div class="settings-nav">' + this.SETTINGS_SECTIONS.map(function (entry) {
          return '<button class="settings-nav-item' + (entry[0] === active ? ' selected' : '') + '"'
            + ' data-settings-section="' + entry[0] + '">' + esc(entry[1]) + '</button>';
        }).join('') + '</div>';
    },

    _addressOf: function (server) {
      if (!server) return '—';
      if (server.kind === 'local') return '本机';
      var address = server.address || {};
      if (!address.host) return (server.ssh && server.ssh.configHost) || '—';
      return address.host;
    },

    _latencyOf: function (health) {
      if (!health || health.latencyMs === null || health.latencyMs === undefined) return '—';
      return health.latencyMs + 'ms';
    },

    /**
     * Session bubbles with their windows nested inside, matching the demo. The
     * tree is the terminal entry point, so it stays visible on every page.
     */
    _renderTree: function (serverId, route) {
      var workspace = this.workspace(serverId);
      var health = this.health(serverId);

      if (!workspace) {
        if (health.state === 'offline' || health.state === 'auth_required' || health.state === 'host_key_error') {
          return this._renderUnavailableTree(serverId, health);
        }
        return '<div class="tree-section-head"><span>Workspace</span></div>'
          + '<div class="workspace-missing"><strong>正在检测</strong><p>正在确认该服务器的 tmux 与 SSH 能力。</p></div>';
      }

      if (workspace.provider === 'unavailable') return this._renderUnavailableTree(serverId, health);

      var sessions = workspace.sessions || [];
      var actions = workspace.actions || {};
      var head = '<div class="tree-section-head"><span>Sessions</span>'
        + providerBadge(workspace)
        + (actions.createSession
          ? '<button class="tree-add-button" data-action="new-session" title="在当前服务器新建 Session"'
            + ' aria-label="新建 Session">+</button>'
          : '')
        + '</div>';

      if (sessions.length === 0) {
        return head + '<div class="workspace-missing"><strong>还没有 Session</strong>'
          + '<p>' + (workspace.provider === 'ssh'
            ? '由面板服务托管 SSH 连接，面板重启后会话结束。'
            : '远端 tmux 可用，新建 Session 后即可进入。')
          + '</p></div>';
      }

      var self = this;
      var params = (route && route.params) || {};
      var tree = sessions.map(function (session) {
        var expanded = global.Store.isSessionExpanded(serverId, session.id) || params.sessionId === session.id;
        var isActive = params.sessionId === session.id;
        return '<div class="tree-session-group ' + (isActive ? 'active' : '') + '">'
          + '<div class="tree-session-row ' + (isActive ? 'active' : '') + '">'
          + '<button class="tree-item" data-session-toggle="' + esc(session.id) + '"'
          + ' data-rail-label="' + esc(String(session.name || '?').charAt(0)) + '"'
          + ' title="' + esc(session.name) + '"'
          + ' aria-expanded="' + (expanded ? 'true' : 'false') + '">'
          + '<span>' + (expanded ? '▾' : '▸') + '</span>'
          + '<span>' + esc(session.name) + '</span>'
          + '<span class="cmd">' + (session.windows || []).length + ' windows</span>'
          + '</button>'
          + (actions.renameSession
            ? '<button class="tree-add-button" data-action="rename-session" data-session="' + esc(session.id) + '"'
              + ' title="重命名 ' + esc(session.name) + '" aria-label="重命名 Session">✎</button>'
            : '')
          + (actions.closeSession
            ? '<button class="tree-add-button" data-action="close-session" data-session="' + esc(session.id) + '"'
              + ' title="关闭 ' + esc(session.name) + '" aria-label="关闭 Session">×</button>'
            : '')
          + (actions.createWindow
            ? '<button class="tree-add-button" data-action="new-window" data-session="' + esc(session.id) + '"'
              + ' title="在 ' + esc(session.name) + ' 中新建 Window" aria-label="新建 Window">+</button>'
            : '')
          + '</div>'
          + (expanded ? self._renderWindows(serverId, session, params) : '')
          + '</div>';
      }).join('');

      var lifecycle = workspace.provider === 'ssh'
        ? '<div class="ssh-lifecycle">面板服务托管 · 面板重启后会话结束</div>'
        : '';

      return head + '<div class="tree">' + tree + '</div>' + lifecycle;
    },

    _renderWindows: function (serverId, session, params) {
      var windows = session.windows || [];
      if (windows.length === 0) return '';
      var workspace = this.workspace(serverId);
      var actions = (workspace && workspace.actions) || {};
      return '<div class="tree-window-list">' + windows.map(function (win) {
        var active = params.windowId === win.id;
        var pane = (win.panes || [])[0];
        var target = {
          name: 'terminal',
          params: {
            serverId: serverId,
            sessionId: session.id,
            windowId: win.id,
            paneId: pane ? pane.id : undefined,
          },
        };
        var command = pane ? (pane.command || pane.name || '') : '';
        return '<div class="tree-window-row">'
          + '<button class="tree-item ' + (active ? 'active' : '') + '"'
          + ' data-route="' + esc(global.Router.serialize(target)) + '"'
          + ' title="' + esc(win.name) + '"'
          + (active ? ' aria-current="page"' : '')
          + '><span class="tree-item-name">' + esc(win.name) + '</span>'
          + '<span class="cmd">' + esc(command) + '</span></button>'
          + (actions.renameWindow
            ? '<button class="tree-add-button" data-action="rename-window" data-window="' + esc(win.id) + '"'
              + ' title="重命名 ' + esc(win.name) + '" aria-label="重命名 Window">✎</button>'
            : '')
          + (actions.closeWindow
            ? '<button class="tree-add-button" data-action="close-window" data-window="' + esc(win.id) + '"'
              + ' title="关闭 ' + esc(win.name) + '" aria-label="关闭 Window">×</button>'
            : '')
          + '</div>';
      }).join('') + '</div>';
    },

    _renderUnavailableTree: function (serverId, health) {
      var stateTone = tone(health.state);
      var repair = health.state === 'auth_required' || health.state === 'host_key_error'
        ? '<button class="ms-btn primary" data-route="'
          + esc(global.Router.serialize({ name: 'server', params: { serverId: serverId, section: 'connection' } }))
          + '">修复连接</button>'
        : '<button class="ms-btn primary" data-action="probe">' + icon('refresh') + '重新检测</button>';
      return '<div class="tree-section-head"><span>Workspace</span></div>'
        + '<div class="workspace-missing"><strong>' + esc(stateTone.label) + '</strong>'
        + '<p>当前无法建立 tmux 或 SSH Session。</p>'
        + '<div class="workspace-missing-actions">' + repair + '</div></div>';
    },

    _renderMobile: function (route) {
      var title = el('ms-mobile-title');
      var subtitle = el('ms-mobile-subtitle');
      if (!title || !subtitle) return;
      var serverId = this.activeServerId();
      var server = this.server(serverId);
      title.textContent = this._titleFor(route);
      subtitle.textContent = server ? server.name : serverId;
      var home = global.document.querySelector('[data-terminal-home]');
      if (home) {
        home.dataset.route = global.Router.serialize({ name: 'terminal', params: { serverId: serverId } });
      }
    },

    _titleFor: function (route) {
      if (!route || !route.name) return '终端工作台';
      if (route.name === 'servers') return '状态';
      if (route.name === 'settings') return '设置';
      if (route.name === 'server') {
        return ({ overview: '服务器概览', performance: '性能', connection: '连接' })[route.params.section]
          || '服务器概览';
      }
      return '终端工作台';
    },

    /** Marks the active top-level entry, matching the demo's rules. */
    _syncNav: function (route) {
      var name = route && route.name ? route.name : 'terminal';
      var nodes = global.document.querySelectorAll('.sidebar-footer [data-route], .bottom-nav [data-route]');
      for (var i = 0; i < nodes.length; i += 1) {
        var target = nodes[i].dataset.route || '';
        var isActive = false;
        if (name === 'terminal') isActive = target.indexOf('#/terminal/') === 0;
        else if (name === 'servers' || name === 'server') isActive = target === '#/servers';
        else isActive = target === '#/' + name;
        nodes[i].classList.toggle('active', isActive);
      }
    },

    /** Sets the compact Window Bar used on the terminal route. */
    setTerminalHeader: function (serverId, workspace, params) {
      var topbar = el('ms-topbar');
      var crumb = el('ms-crumb');
      var pageTitle = el('ms-page-title');
      if (!topbar || !crumb || !pageTitle) return;
      topbar.classList.add('terminal-layout');

      var server = this.server(serverId);
      var parts = [server ? server.name : serverId];
      var session = this._findSession(workspace, params.sessionId);
      var win = this._findWindow(session, params.windowId);
      if (session) parts.push(session.name);
      if (win) parts.push(win.index + ' ' + win.name);

      crumb.textContent = server ? server.name : serverId;
      pageTitle.textContent = parts.join(' / ');
    },

    setHeader: function (crumbText, title, actionsHtml) {
      var topbar = el('ms-topbar');
      var crumb = el('ms-crumb');
      var pageTitle = el('ms-page-title');
      var actions = el('ms-top-actions');
      if (!topbar || !crumb || !pageTitle) return;
      topbar.classList.remove('terminal-layout');
      crumb.textContent = crumbText;
      pageTitle.textContent = title;
      if (actions) actions.innerHTML = actionsHtml || '';
    },

    setTopActions: function (html) {
      var actions = el('ms-top-actions');
      if (actions) actions.innerHTML = html || '';
    },

    _findSession: function (workspace, sessionId) {
      if (!workspace || !sessionId) return null;
      var sessions = workspace.sessions || [];
      for (var i = 0; i < sessions.length; i += 1) {
        if (sessions[i].id === sessionId) return sessions[i];
      }
      return null;
    },

    _findWindow: function (session, windowId) {
      if (!session || !windowId) return null;
      var windows = session.windows || [];
      for (var i = 0; i < windows.length; i += 1) {
        if (windows[i].id === windowId) return windows[i];
      }
      return null;
    },

    /**
     * Resolves a bare `#/terminal/:serverId` to a concrete window: the most
     * recently visited one for that server, else the first available.
     */
    resolveDefaultTarget: function (serverId) {
      var workspace = this.workspace(serverId);
      if (!workspace) return null;
      var recent = this._recentFor(serverId);
      var sessions = workspace.sessions || [];
      var i;
      var j;
      if (recent) {
        for (i = 0; i < sessions.length; i += 1) {
          if (sessions[i].id !== recent.sessionId) continue;
          for (j = 0; j < (sessions[i].windows || []).length; j += 1) {
            if (sessions[i].windows[j].id === recent.windowId) {
              return this._targetFrom(serverId, sessions[i], sessions[i].windows[j]);
            }
          }
        }
      }
      for (i = 0; i < sessions.length; i += 1) {
        var windows = sessions[i].windows || [];
        if (windows.length > 0) return this._targetFrom(serverId, sessions[i], windows[0]);
      }
      return null;
    },

    _targetFrom: function (serverId, session, win) {
      var pane = (win.panes || [])[0];
      return {
        name: 'terminal',
        params: {
          serverId: serverId,
          sessionId: session.id,
          windowId: win.id,
          paneId: pane ? pane.id : undefined,
        },
      };
    },

    RECENT_KEY: 'tmux_recent_targets',

    _recentAll: function () {
      try {
        return JSON.parse(global.localStorage.getItem(this.RECENT_KEY)) || [];
      } catch (_e) {
        return [];
      }
    },

    _recentFor: function (serverId) {
      var all = this._recentAll();
      for (var i = 0; i < all.length; i += 1) {
        if (all[i].serverId === serverId) return all[i];
      }
      return null;
    },

    /** Recent entries are keyed by server so two hosts cannot collide. */
    noteRecent: function (target) {
      if (!target || !target.serverId || !target.windowId) return;
      var all = this._recentAll().filter(function (entry) {
        return !(entry.serverId === target.serverId && entry.windowId === target.windowId);
      });
      all.unshift({
        serverId: target.serverId,
        sessionId: target.sessionId || null,
        windowId: target.windowId,
        paneId: target.paneId || null,
        name: target.name || null,
        at: target.at || 0,
      });
      if (all.length > 12) all = all.slice(0, 12);
      try {
        global.localStorage.setItem(this.RECENT_KEY, JSON.stringify(all));
      } catch (_e) { /* storage full or blocked */ }
    },

    recentTargets: function () {
      return this._recentAll();
    },

    toast: function (message) {
      var node = el('ms-toast');
      if (!node) return;
      node.textContent = message;
      node.classList.add('show');
      global.clearTimeout(this._toastTimer);
      this._toastTimer = global.setTimeout(function () { node.classList.remove('show'); }, 2400);
    },

    /** Server picker popover, anchored under whatever opened it. */
    showServerPicker: function (anchor) {
      var popover = el('ms-server-popover');
      if (!popover) return;
      var self = this;
      popover.innerHTML = '<div class="ms-popover-title">选择服务器</div>'
        + this.servers().map(function (server) {
          var health = self.health(server.id);
          var stateTone = tone(health.state);
          var workspace = self.workspace(server.id);
          var provider = workspace ? workspace.provider : null;
          var summary = provider === 'tmux' ? 'tmux 工作区'
            : provider === 'ssh' ? 'SSH Session'
              : stateTone.label;
          var route = health.state === 'offline' || health.state === 'auth_required' || health.state === 'host_key_error'
            ? { name: 'server', params: { serverId: server.id, section: 'connection' } }
            : { name: 'terminal', params: { serverId: server.id } };
          return '<button class="server-option" data-route="' + esc(global.Router.serialize(route)) + '">'
            + '<span class="dot ' + stateTone.dot + '"></span>'
            + '<span><strong>' + esc(server.name) + '</strong>'
            + '<small>' + esc(self._addressOf(server)) + ' · ' + esc(summary) + '</small></span>'
            + '<span class="latency">' + esc(self._latencyOf(health)) + '</span></button>';
        }).join('')
        + '<div style="padding:7px 8px 2px"><button class="ms-btn" style="width:100%" data-route="#/servers">状态</button></div>';

      var rect = anchor.getBoundingClientRect();
      popover.style.left = Math.min(rect.left, global.innerWidth - 318) + 'px';
      popover.style.top = (rect.bottom + 6) + 'px';
      popover.hidden = false;
    },

    hideServerPicker: function () {
      var popover = el('ms-server-popover');
      if (popover) popover.hidden = true;
    },

    setSidebarCollapsed: function (collapsed) {
      var app = global.document.querySelector('.ms-app');
      if (!app) return;
      app.classList.toggle('sidebar-collapsed', Boolean(collapsed));
      global.Store.setUi({ sidebarCollapsed: Boolean(collapsed) });
      var toggle = global.document.querySelector('.sidebar-toggle');
      if (toggle) {
        var label = collapsed ? '展开侧边栏' : '收起侧边栏';
        toggle.textContent = collapsed ? '›' : '‹';
        toggle.setAttribute('aria-expanded', String(!collapsed));
        toggle.setAttribute('aria-label', label);
        toggle.title = label;
      }
    },

    setSidebarWidth: function (width) {
      var app = global.document.querySelector('.ms-app');
      if (!app) return;
      var clamped = Math.max(global.Store.SIDEBAR_MIN_WIDTH, Math.min(global.Store.SIDEBAR_MAX_WIDTH, Math.round(width)));
      // The shell stylesheet reads --ms-sidebar-width; the unprefixed name
      // belongs to the legacy sidebar and setting it here would do nothing.
      app.style.setProperty('--ms-sidebar-width', clamped + 'px');
      global.Store.setUi({ sidebarWidth: clamped });
      var resizer = global.document.querySelector('.sidebar-resizer');
      if (resizer) resizer.setAttribute('aria-valuenow', String(clamped));
      return clamped;
    },

    applyUiPrefs: function () {
      var ui = global.Store.getState().ui;
      this.setSidebarWidth(ui.sidebarWidth);
      this.setSidebarCollapsed(ui.sidebarCollapsed);
    },
  };

  global.AppShell = AppShell;
})(typeof window !== 'undefined' ? window : globalThis);
