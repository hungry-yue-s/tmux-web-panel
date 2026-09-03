(function (global) {
  var POLL_MS = 10000;

  function promptDialog(options) {
    if (typeof global.showPrompt === 'function') return global.showPrompt(options);
    return Promise.resolve(global.prompt(options.title || '', options.value || ''));
  }

  function confirmDialog(options) {
    if (typeof global.showConfirm === 'function') return global.showConfirm(options);
    return Promise.resolve(global.confirm([options.title, options.message].filter(Boolean).join('\n')));
  }

  var MsApp = {
    _pollTimer: null,
    _resizing: false,
    _perfPanelMounted: false,

    /**
     * A failed render used to leave a blank page with no trace. Always leave
     * evidence: the console for the developer, a toast for the user.
     */
    _reportRouteFailure(err) {
      const message = err && err.message ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error('[MsApp] route render failed:', err);
      if (global.AppShell && typeof global.AppShell.toast === 'function') {
        global.AppShell.toast('页面加载失败：' + message);
      }
    },

    async start() {
      global.Store.loadUiPrefs();
      global.AppShell.applyUiPrefs();
      this._bindEvents();

      global.Router.subscribe((route) => {
        global.Store.setRoute(route);
        this._onRoute(route).catch((err) => this._reportRouteFailure(err));
      });

      global.Store.subscribe(() => {
        global.AppShell.render();
      });

      await this.refreshServers();
      global.Router.start();
      this._startPolling();
    },

    /** Server list plus each server's last known health. */
    async refreshServers() {
      try {
        const data = await global.Api.get('/api/servers');
        const servers = (data && data.servers) || [];
        global.Store.setServers(servers);
        for (const server of servers) {
          if (server.status) global.Store.setHealth(server.id, server.status);
        }
      } catch (err) {
        global.AppShell.toast('无法读取服务器列表：' + (err && err.message ? err.message : '未知错误'));
      }
    },

    /**
     * Loads a server's workspace. The request token makes a slow response for
     * one server unable to land on another server's page.
     */
    async refreshWorkspace(serverId) {
      const token = global.Store.beginRequest('workspace', serverId);
      try {
        const workspace = await global.Api.get(global.Api.workspacePath(serverId));
        if (!global.Store.isCurrentRequest('workspace', serverId, token)) return null;
        global.Store.setWorkspace(serverId, workspace);
        return workspace;
      } catch (err) {
        if (!global.Store.isCurrentRequest('workspace', serverId, token)) return null;
        // Keep the previous tree: a failed refresh must not blank the sidebar.
        global.Store.setWorkspace(serverId, null);
        if (err && err.code !== 'ABORTED') {
          global.Store.setHealth(serverId, {
            ...global.AppShell.health(serverId),
            state: err.code === 'SERVER_DISABLED' ? 'disabled' : global.AppShell.health(serverId).state,
            error: { code: err.code, message: err.message, action: err.action },
          });
        }
        return null;
      }
    },

    async refreshMetrics(serverId) {
      const token = global.Store.beginRequest('metrics', serverId);
      try {
        const current = await global.Api.get(global.Api.serverPath(serverId, '/metrics/current'));
        if (!global.Store.isCurrentRequest('metrics', serverId, token)) return;
        const history = await global.Api.get(global.Api.serverPath(serverId, '/metrics/history?window=300'));
        if (!global.Store.isCurrentRequest('metrics', serverId, token)) return;
        global.Store.setMetrics(serverId, { ...current, historyPoints: (history && history.points) || [] });
      } catch (_err) {
        // The current snapshot already encodes failure; nothing to add here.
      }
    },

    /**
     * Points the file preview dock at one window, or clears it.
     *
     * The dock reads the panel host's own filesystem, so leaving a stale one up
     * after switching machines would show local files under a remote server.
     */
    _setDockContext(serverId, sessionName, windowIndex) {
      if (!global.FilePreview || typeof global.FilePreview.switchDockContext !== 'function') return;
      global.FilePreview.switchDockContext(serverId, sessionName, windowIndex);
    },

    async _onRoute(route) {
      this._hideSidebarContextMenu();
      const view = global.document.getElementById('ms-view');
      if (!view) return;
      if (route.name !== 'terminal') {
        this._setDockContext(null, null, null);
      }
      // PerfPanel owns interval timers; leaving its route must stop them.
      this._teardownPerfPanel();
      const serverId = (route.params && route.params.serverId) || 'local';

      if (route.name === 'servers') {
        // Status mode is always a selected server, never a list to click through.
        const target = global.AppShell.statusServerId(route);
        if (route.params && route.params.intent === 'new') this.openAddServer();
        global.Router.go(
          { name: 'server', params: { serverId: target, section: 'performance' } },
          { replace: true },
        );
        return;
      }

      if (route.name === 'settings') {
        view.classList.remove('terminal-mode');
        view.innerHTML = global.ServersPage.renderSettings();
        return;
      }

      if (route.name === 'server') {
        const routedServer = global.AppShell.server(serverId);
        if ((route.params || {}).section === 'codex' && (!routedServer || routedServer.kind !== 'local')) {
          global.Router.go(
            { name: 'server', params: { serverId, section: 'performance' } },
            { replace: true },
          );
          return;
        }
        global.Store.setUi({ lastStatusServerId: serverId });
        view.classList.remove('terminal-mode');
        view.innerHTML = global.ServersPage.renderServer(route);
        this._mountPerfPanel(route);
        await this.refreshWorkspace(serverId);
        // The rail shows CPU and memory for every server, not just this one.
        await Promise.all(global.AppShell.servers().map((s) => this.refreshMetrics(s.id)));
        // The route may have moved on while those two were in flight.
        if (!global.Router.isSame(global.Router.current(), route)) return;
        this._teardownPerfPanel();
        view.innerHTML = global.ServersPage.renderServer(route);
        this._mountPerfPanel(route);
        return;
      }

      await this._renderTerminal(route, serverId, view);
    },

    /** Returns the PerfPanel mode owned by this local status route. */
    _localPerfMode(route) {
      if (!route || route.name !== 'server') return null;
      const section = (route.params || {}).section;
      if (section !== 'performance' && section !== 'codex') return null;
      const server = global.AppShell.server((route.params || {}).serverId);
      return server && server.kind === 'local' ? section : null;
    },

    _mountPerfPanel(route) {
      const mode = this._localPerfMode(route);
      if (!mode) return;
      if (!global.PerfPanel || typeof global.PerfPanel.start !== 'function') return;
      if (!global.document.getElementById('perf-panel')) return;
      global.PerfPanel.start(mode);
      this._perfPanelMounted = true;
    },

    _teardownPerfPanel() {
      if (!this._perfPanelMounted) return;
      this._perfPanelMounted = false;
      if (global.PerfPanel && typeof global.PerfPanel.stop === 'function') global.PerfPanel.stop();
    },

    async _renderTerminal(route, serverId, view) {
      const workspace = global.AppShell.workspace(serverId) || await this.refreshWorkspace(serverId);
      const params = route.params || {};

      if (!workspace || workspace.provider === 'unavailable') {
        this._setDockContext(null, null, null);
        view.classList.remove('terminal-mode');
        view.innerHTML = this._unavailableWorkspace(serverId);
        global.AppShell.setHeader(
          global.AppShell.server(serverId) ? global.AppShell.server(serverId).name : serverId,
          '终端工作台',
          '',
        );
        return;
      }

      // A bare #/terminal/:serverId resolves to the most recent window, or the
      // first one. This is a page-level default, not a global entry point.
      if (!params.windowId) {
        const target = global.AppShell.resolveDefaultTarget(serverId);
        if (target) {
          global.Router.go(target, { replace: true });
          return;
        }
        this._setDockContext(null, null, null);
        view.classList.remove('terminal-mode');
        view.innerHTML = this._emptyWorkspace(serverId, workspace);
        global.AppShell.setHeader(
          global.AppShell.server(serverId) ? global.AppShell.server(serverId).name : serverId,
          '终端工作台',
          '',
        );
        return;
      }

      global.AppShell.setTerminalHeader(serverId, workspace, params);
      global.AppShell.noteRecent({
        serverId,
        sessionId: params.sessionId,
        windowId: params.windowId,
        paneId: params.paneId,
        at: Date.now(),
      });

      view.classList.add('terminal-mode');
      view.innerHTML = '<section class="section terminal-stage" id="ms-terminal-host"></section>';
      this._mountTerminal(serverId, workspace, params);
    },

    /**
     * Bridges the new route to the existing terminal renderer, which still
     * addresses panes by session name and window index.
     */
    _mountTerminal(serverId, workspace, params) {
      const host = global.document.getElementById('ms-terminal-host');
      if (!host) return;
      const session = global.AppShell._findSession(workspace, params.sessionId);
      const win = global.AppShell._findWindow(session, params.windowId);

      if (!session || !win) {
        this._setDockContext(null, null, null);
        host.innerHTML = '<div class="ms-card empty"><h3>目标窗口不存在</h3>'
          + '<p>它可能已被关闭。工作区已刷新。</p></div>';
        this.refreshWorkspace(serverId);
        return;
      }

      if (typeof global.renderTerminal !== 'function' || !global.state) {
        this._setDockContext(null, null, null);
        host.innerHTML = '<div class="ms-card empty"><h3>终端组件未加载</h3></div>';
        return;
      }

      // Every API call and the socket address resolve through this target, so a
      // remote window can never act on the panel's own machine.
      global.TerminalTarget.set({
        serverId,
        provider: workspace.provider,
        sessionId: session.id,
        windowId: win.id,
      });

      global.state.currentSession = session.name;
      global.state.currentWindow = String(win.index);
      global.state.currentPane = params.paneId || (win.panes && win.panes[0] ? win.panes[0].id : null);
      global.state.panes = win.panes || [];
      global.state.currentTab = 'terminal';
      if (global.NotificationPanel && global.NotificationPanel._markReadByWindow) {
        global.NotificationPanel._markReadByWindow(session.name, win.index);
      }
      // renderTerminal calls embedTerminalChrome itself, on every render.
      global.renderTerminal(host);
      this._setDockContext(serverId, session.name, win.index);
    },

    /**
     * The renderer builds its own header with a back button. The shell already
     * owns the Window Bar, so the renderer's own header is stripped for parts
     * and then removed.
     *
     * This is invoked from renderTerminal itself, not from the call site: the
     * renderer is also re-entered by pane switch, split, close and the viewport
     * handler, and each of those rebuilt a full legacy header with a back button
     * and a duplicate toolbar.
     */
    /** The visible bar for this viewport; the other one is display:none. */
    _chromeTarget() {
      const sheetTools = global.document.getElementById('ms-mobile-workspace-tools');
      const mobile = sheetTools || global.document.getElementById('ms-mobile-tools');
      const desktop = global.document.getElementById('ms-top-actions');
      if (global.innerWidth < 768 && mobile) return { target: mobile, other: desktop };
      return { target: desktop, other: mobile };
    },

    embedTerminalChrome(view) {
      const root = view || global.document.querySelector('#ms-terminal-host .terminal-view');
      if (!root) return;
      const header = root.querySelector('.terminal-header');
      const { target: actions, other } = this._chromeTarget();
      if (!header || !actions) return;

      const workspace = global.AppShell.workspace(global.AppShell.activeServerId()) || {};
      const remote = workspace.transport === 'ssh';
      const isSsh = workspace.provider === 'ssh';

      // The shell's sidebar and Window Bar replace both of these.
      const back = header.querySelector('.terminal-back-btn');
      if (back) back.remove();
      const title = header.querySelector('.terminal-header-title');
      if (title) title.remove();

      const toolbar = header.querySelector('.terminal-header-actions');
      if (toolbar) {
        // Only tmux can read its own paste buffer, and pop-out addresses a
        // local pane; the SSH provider does support panes and labels.
        if (remote || isSsh) {
          for (const selector of ['.terminal-open-buf-btn', '.terminal-popout-btn']) {
            const node = toolbar.querySelector(selector);
            if (node) node.remove();
          }
        }
        if (isSsh) {
          // tmux-native split rendering has no meaning without tmux.
          const modeToggle = toolbar.querySelector('.terminal-mode-toggle');
          if (modeToggle) modeToggle.remove();
        }
      }

      actions.innerHTML = '';
      // Crossing the breakpoint re-renders; without this the previous viewport's
      // bar would keep a stale copy of the toolbar.
      if (other && other !== actions) other.innerHTML = '';

      if (isSsh) {
        const badge = global.document.createElement('span');
        badge.className = 'provider-badge';
        badge.textContent = 'SSH';
        badge.title = '由面板服务托管 · 面板重启后会话结束';
        actions.appendChild(badge);
      }

      // Move the live nodes so their bound listeners keep working. The renderer
      // keeps its own reference to the pills node, so relocating it is safe.
      const pills = header.querySelector('.terminal-header-pills');
      if (pills) {
        pills.classList.add('ms-hoisted-pills');
        actions.appendChild(pills);
      }
      if (toolbar) actions.appendChild(toolbar);

      // Nothing left worth showing: remove it so only one bar exists.
      header.remove();
    },

    /**
     * Refresh invoked from the terminal toolbar. Refetches this server's
     * workspace, corrects the route if the window is gone, and re-renders in
     * place — the legacy render() would jump back to the hidden old shell.
     */
    async refreshCurrentTerminal() {
      const route = global.Router.current();
      const serverId = (route.params && route.params.serverId) || 'local';
      const workspace = await this.refreshWorkspace(serverId);
      if (!workspace) {
        await this._onRoute(route);
        return;
      }

      const params = route.params || {};
      const session = global.AppShell._findSession(workspace, params.sessionId);
      const win = global.AppShell._findWindow(session, params.windowId);
      if (!session || !win) {
        // The target vanished; fall back to this server's default target.
        const target = global.AppShell.resolveDefaultTarget(serverId);
        if (target) global.Router.go(target, { replace: true });
        else await this._onRoute(route);
        return;
      }

      global.AppShell.render();
      global.AppShell.setTerminalHeader(serverId, workspace, params);
      const host = global.document.getElementById('ms-terminal-host');
      if (host) {
        global.state.panes = win.panes || [];
        global.renderTerminal(host);
      }
    },

    _unavailableWorkspace(serverId) {
      const server = global.AppShell.server(serverId);
      const health = global.AppShell.health(serverId);
      const stateTone = global.AppShell.tone(health.state);
      const repair = health.state === 'auth_required' || health.state === 'host_key_error'
        ? '<button class="ms-btn primary" data-route="'
          + global.AppShell.escape(global.Router.serialize({
            name: 'server',
            params: { serverId, section: 'connection' },
          }))
          + '">修复连接</button>'
        : '<button class="ms-btn primary" data-action="probe">重新检测</button>';

      return '<div class="workspace-onboarding"><div class="workspace-onboarding-card">'
        + '<div class="workspace-onboarding-icon">' + global.AppShell.icon('terminal') + '</div>'
        + '<div class="workspace-kicker">工作区不可用</div>'
        + '<h2>' + global.AppShell.escape(stateTone.label) + '</h2>'
        + '<p>系统只负责检测并选择远端 tmux 或 SSH Session。当前连接条件不满足，'
        + '因此不会创建虚假的 Session、Window 或 Pane。</p>'
        + '<div class="workspace-facts">'
        + '<div class="workspace-fact"><span>服务器</span><strong>'
        + global.AppShell.escape(server ? server.name : serverId) + '</strong></div>'
        + '<div class="workspace-fact"><span>SSH</span><strong>'
        + global.AppShell.escape(stateTone.label) + '</strong></div>'
        + '<div class="workspace-fact"><span>工作区</span><strong>未创建</strong></div></div>'
        + '<div class="workspace-onboarding-actions">' + repair
        + '<button class="ms-btn" data-route="'
        + global.AppShell.escape(global.Router.serialize({ name: 'server', params: { serverId, section: 'performance' } }))
        + '">服务器详情</button></div></div></div>';
    },

    _emptyWorkspace(serverId, workspace) {
      const isSsh = workspace.provider === 'ssh';
      return '<div class="workspace-onboarding"><div class="workspace-onboarding-card">'
        + '<div class="workspace-onboarding-icon">' + global.AppShell.icon('terminal') + '</div>'
        + '<div class="workspace-kicker">' + (isSsh ? 'SSH 工作区' : 'tmux 工作区') + '</div>'
        + '<h2>还没有 Session</h2>'
        + '<p>' + (isSsh
          ? '该服务器未检测到 tmux，面板会为你托管 SSH Session。面板重启后这些会话会结束。'
          : '远端 tmux 可用。新建 Session 后即可进入终端。')
        + '</p>'
        + '<div class="workspace-onboarding-actions">'
        + '<button class="ms-btn primary" data-action="new-session">新建 Session</button></div>'
        + '<p class="workspace-footnote">面板不会在远端安装或启动 tmux。</p></div></div>';
    },

    _startPolling() {
      this._stopPolling();
      this._pollTimer = global.setInterval(() => {
        const route = global.Router.current();
        this.refreshServers();
        if (global.AppShell.mode(route) === 'status') {
          // Every rail row shows live CPU and memory.
          global.AppShell.servers().forEach((server) => this.refreshMetrics(server.id));
          return;
        }
        this.refreshMetrics(global.AppShell.activeServerId());
      }, POLL_MS);
    },

    _stopPolling() {
      if (this._pollTimer) global.clearInterval(this._pollTimer);
      this._pollTimer = null;
    },

    _ensureSidebarContextMenu() {
      let menu = global.document.getElementById('ms-sidebar-context-menu');
      if (menu) return menu;
      menu = global.document.createElement('div');
      menu.id = 'ms-sidebar-context-menu';
      menu.className = 'context-menu ms-sidebar-context-menu';
      menu.setAttribute('role', 'menu');
      menu.hidden = true;
      global.document.body.appendChild(menu);
      return menu;
    },

    _hideSidebarContextMenu({ restoreFocus = false } = {}) {
      const menu = global.document.getElementById('ms-sidebar-context-menu');
      if (!menu || menu.hidden) return;
      menu.hidden = true;
      menu.replaceChildren();
      if (restoreFocus && this._sidebarContextOrigin && this._sidebarContextOrigin.isConnected) {
        const target = this._sidebarContextOrigin.querySelector('.tree-item');
        if (target) target.focus();
      }
      this._sidebarContextOrigin = null;
    },

    _positionSidebarContextMenu(menu, row, event) {
      const gutter = 8;
      const rowRect = row.getBoundingClientRect();
      let left = Number(event.clientX) || rowRect.left + 16;
      let top = Number(event.clientY) || rowRect.bottom;
      menu.style.left = '0px';
      menu.style.top = '0px';
      menu.style.visibility = 'hidden';
      menu.hidden = false;
      const rect = menu.getBoundingClientRect();
      left = Math.max(gutter, Math.min(left, global.innerWidth - rect.width - gutter));
      top = Math.max(gutter, Math.min(top, global.innerHeight - rect.height - gutter));
      menu.style.left = Math.round(left) + 'px';
      menu.style.top = Math.round(top) + 'px';
      menu.style.visibility = '';
    },

    _showSidebarContextMenu(row, event) {
      this._hideSidebarContextMenu();
      global.AppShell.hideServerPicker();
      const serverId = row.dataset.serverId;
      const workspace = global.AppShell.workspace(serverId);
      const actions = (workspace && workspace.actions) || {};
      const entity = row.dataset.sidebarEntity;
      const entries = entity === 'session'
        ? [
          actions.createWindow && ['new-window', '新建 Window', false],
          actions.renameSession && ['rename-session', '重命名', false],
          actions.closeSession && ['close-session', '关闭', true],
        ]
        : [
          actions.renameWindow && ['rename-window', '重命名', false],
          actions.closeWindow && ['close-window', '关闭', true],
        ];
      const available = entries.filter(Boolean);
      if (available.length === 0) return;

      const menu = this._ensureSidebarContextMenu();
      menu.setAttribute('aria-label', (entity === 'session' ? 'Session' : 'Window') + ' 操作');
      menu.innerHTML = available.map((entry) => {
        const action = entry[0];
        const icon = action === 'new-window' ? '+' : (action.indexOf('rename-') === 0 ? '✎' : '×');
        return '<button type="button" role="menuitem" class="context-menu-item'
          + (entry[2] ? ' context-menu-item-danger' : '') + '" data-action="' + action + '"'
          + ' data-server-id="' + global.AppShell.escape(serverId) + '"'
          + ' data-provider="' + global.AppShell.escape(row.dataset.provider || '') + '"'
          + ' data-session="' + global.AppShell.escape(row.dataset.session || '') + '"'
          + ' data-window="' + global.AppShell.escape(row.dataset.window || '') + '"'
          + ' data-entity-name="' + global.AppShell.escape(row.dataset.entityName || '') + '">'
          + '<span class="context-menu-icon" aria-hidden="true">' + icon + '</span>'
          + entry[1] + '</button>';
      }).join('');
      this._sidebarContextOrigin = row;
      this._positionSidebarContextMenu(menu, row, event);
      const first = menu.querySelector('[role="menuitem"]');
      if (first) first.focus();
    },

    /** Single delegated listener for the whole shell. */
    _bindEvents() {
      global.document.addEventListener('click', (event) => {
        this._hideSidebarContextMenu();
        const routeTarget = event.target.closest('[data-route]');
        if (routeTarget) {
          if (routeTarget.closest('#ms-mobile-workspace-sheet')) {
            global.AppShell.closeMobileWorkspaceSheet({ restoreFocus: false });
          }
          global.AppShell.hideServerPicker();
          global.location.hash = routeTarget.dataset.route;
          return;
        }

        const toggleTarget = event.target.closest('[data-session-toggle]');
        if (toggleTarget) {
          global.Store.toggleSessionExpanded(
            global.AppShell.activeServerId(),
            toggleTarget.dataset.sessionToggle,
          );
          return;
        }

        const settingsTarget = event.target.closest('[data-settings-section]');
        if (settingsTarget) {
          global.ServersPage.settingsSection = settingsTarget.dataset.settingsSection;
          global.AppShell.render();
          this._onRoute(global.Router.current()).catch((err) => this._reportRouteFailure(err));
          return;
        }

        const actionTarget = event.target.closest('[data-action]');
        if (!actionTarget) {
          if (!event.target.closest('#ms-server-popover')) global.AppShell.hideServerPicker();
          return;
        }
        this._handleAction(actionTarget.dataset.action, actionTarget, event).catch((err) => {
          global.AppShell.toast(err && err.message ? err.message : '操作失败');
        });
      });

      global.document.addEventListener('contextmenu', (event) => {
        const sidebar = event.target.closest('.ms-sidebar');
        if (!sidebar) return;
        event.preventDefault();
        const row = event.target.closest('[data-sidebar-entity]');
        if (!row) {
          this._hideSidebarContextMenu();
          return;
        }
        this._showSidebarContextMenu(row, event);
      });

      global.document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        const menu = global.document.getElementById('ms-sidebar-context-menu');
        if (!menu || menu.hidden) return;
        event.preventDefault();
        this._hideSidebarContextMenu({ restoreFocus: true });
      });
      global.document.addEventListener('scroll', () => this._hideSidebarContextMenu(), true);
      global.addEventListener('resize', () => {
        this._hideSidebarContextMenu();
        if (global.innerWidth >= 768) global.AppShell.closeMobileWorkspaceSheet({ restoreFocus: false });
      });

      this._bindResizer();
    },

    _bindResizer() {
      const resizer = global.document.querySelector('.sidebar-resizer');
      if (!resizer) return;
      resizer.addEventListener('pointerdown', (event) => {
        if (global.innerWidth < 768) return;
        this._resizing = true;
        global.AppShell.setSidebarCollapsed(false);
        global.document.querySelector('.ms-app').classList.add('resizing-sidebar');
        resizer.setPointerCapture(event.pointerId);
        global.AppShell.setSidebarWidth(event.clientX);
      });
      resizer.addEventListener('pointermove', (event) => {
        if (this._resizing) global.AppShell.setSidebarWidth(event.clientX);
      });
      resizer.addEventListener('pointerup', (event) => {
        this._resizing = false;
        global.document.querySelector('.ms-app').classList.remove('resizing-sidebar');
        try {
          resizer.releasePointerCapture(event.pointerId);
        } catch (_e) { /* pointer already released */ }
      });
      resizer.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home') return;
        event.preventDefault();
        global.AppShell.setSidebarCollapsed(false);
        const current = global.Store.getState().ui.sidebarWidth;
        const next = event.key === 'Home'
          ? global.Store.SIDEBAR_DEFAULT_WIDTH
          : current + (event.key === 'ArrowLeft' ? -12 : 12);
        global.AppShell.setSidebarWidth(next);
      });
    },

    async _handleAction(action, node) {
      const serverId = node.dataset.serverId || global.AppShell.activeServerId();
      const entityContext = {
        provider: node.dataset.provider || null,
        name: node.dataset.entityName || null,
      };

      if (action === 'server-switcher' || action === 'mobile-server') {
        global.AppShell.showServerPicker(node);
        return;
      }
      if (action === 'mobile-workspace') {
        global.AppShell.toggleMobileWorkspaceSheet();
        return;
      }
      if (action === 'mobile-workspace-close') {
        global.AppShell.closeMobileWorkspaceSheet();
        return;
      }
      if (action === 'sidebar-toggle') {
        const app = global.document.querySelector('.ms-app');
        global.AppShell.setSidebarCollapsed(!app.classList.contains('sidebar-collapsed'));
        return;
      }
      if (action === 'notifications') {
        if (global.NotificationPanel) global.NotificationPanel.render();
        return;
      }
      if (action === 'probe') {
        global.AppShell.toast('正在检测 TCP、SSH、认证、指标和 tmux 能力…');
        await global.Api.post(global.Api.serverPath(serverId, '/probe'));
        await this.refreshServers();
        await this.refreshWorkspace(serverId);
        await this._onRoute(global.Router.current());
        return;
      }
      if (action === 'add-server') {
        this.openAddServer();
        return;
      }
      if (action === 'set-theme') {
        if (global.Theme && node.dataset.theme) global.Theme.apply(node.dataset.theme);
        await this._onRoute(global.Router.current());
        return;
      }
      if (action === 'logout') {
        if (global.Auth) global.Auth.logout();
        return;
      }
      if (action === 'edit-server') {
        this.openEditServer(serverId);
        return;
      }
      if (action === 'submit-edit-server') {
        await this._submitEditServer(serverId);
        return;
      }
      if (action === 'rename-session') {
        await this._renameSession(serverId, node.dataset.session, entityContext);
        return;
      }
      if (action === 'close-session') {
        await this._closeSession(serverId, node.dataset.session, entityContext);
        return;
      }
      if (action === 'rename-window') {
        await this._renameWindow(serverId, node.dataset.window, entityContext);
        return;
      }
      if (action === 'close-window') {
        await this._closeWindow(serverId, node.dataset.window, entityContext);
        return;
      }
      if (action === 'close-modal') {
        this.closeModal();
        return;
      }
      if (action === 'submit-server') {
        await this._submitServer();
        return;
      }
      if (action === 'new-session') {
        await this._createSession(serverId);
        return;
      }
      if (action === 'new-window') {
        await this._createWindow(serverId, node.dataset.session, entityContext);
        return;
      }
      if (action === 'adopt-provider') {
        await global.Api.post(global.Api.serverPath(serverId, '/workspace/adopt-provider'));
        await this.refreshWorkspace(serverId);
        await this._onRoute(global.Router.current());
        return;
      }
      if (action === 'scan-host-key') {
        await this._scanHostKey(serverId);
        return;
      }
      if (action === 'trust-host-key') {
        await this._trustHostKey(serverId, node.dataset.fingerprint);
        return;
      }
      if (action === 'delete-server') {
        await this._deleteServer(serverId);
      }
    },

    _providerHeader(serverId, expectedProvider) {
      const workspace = global.AppShell.workspace(serverId);
      const provider = expectedProvider || (workspace && workspace.provider);
      return provider ? { 'X-Workspace-Provider': provider } : {};
    },

    async _createSession(serverId) {
      const server = global.AppShell.server(serverId) || {};
      const name = await promptDialog({
        title: '在 ' + (server.name || serverId) + ' 新建 Session',
        placeholder: 'Session 名称',
        confirmText: '创建',
      });
      if (!name) return;
      await global.Api.request('POST', global.Api.serverPath(serverId, '/sessions'), { name }, {
        headers: this._providerHeader(serverId),
      });
      await this.refreshWorkspace(serverId);
      await this._onRoute(global.Router.current());
    },

    async _createWindow(serverId, sessionId, context = {}) {
      if (!sessionId) return;
      const name = await promptDialog({
        title: '新建 Window',
        placeholder: 'Window 名称（可留空）',
        confirmText: '创建',
      });
      if (name === null) return;
      const path = global.Api.serverPath(serverId, '/sessions/' + encodeURIComponent(sessionId) + '/windows');
      await global.Api.request('POST', path, name ? { name } : {}, {
        headers: this._providerHeader(serverId, context.provider),
      });
      await this.refreshWorkspace(serverId);
      await this._onRoute(global.Router.current());
    },

    async _scanHostKey(serverId) {
      const result = await global.Api.post(global.Api.serverPath(serverId, '/host-key/scan'));
      const keys = (result && result.keys) || [];
      if (keys.length === 0) {
        global.AppShell.toast('未获取到主机密钥');
        return;
      }
      this.openModal('确认主机指纹',
        '<p>请通过可信渠道核对指纹后再信任。面板不会自动信任或覆盖主机密钥。</p>'
        + '<div class="ms-card detail-list">'
        + keys.map((key) => '<div class="detail-row"><span>' + global.AppShell.escape(key.algorithm) + '</span>'
          + '<strong class="mono">' + global.AppShell.escape(key.fingerprint) + '</strong></div>').join('')
        + '</div>',
        keys.map((key) => '<button class="ms-btn primary" data-action="trust-host-key" data-fingerprint="'
          + global.AppShell.escape(key.fingerprint) + '">信任 ' + global.AppShell.escape(key.algorithm)
          + ' 并检测</button>').join(''));
    },

    async _trustHostKey(serverId, fingerprint) {
      await global.Api.post(global.Api.serverPath(serverId, '/host-key/trust'), { fingerprint });
      this.closeModal();
      global.AppShell.toast('已信任主机密钥，正在重新检测');
      await this.refreshServers();
      await this._onRoute(global.Router.current());
    },

    async _deleteServer(serverId) {
      const server = global.AppShell.server(serverId);
      if (!server || server.immutable) return;
      if (!await confirmDialog({
        title: '删除服务器',
        message: '删除服务器“' + server.name + '”？注册信息会被移除。',
        confirmText: '删除',
        danger: true,
      })) return;
      try {
        await global.Api.del(global.Api.serverPath(serverId));
      } catch (err) {
        if (err && err.code === 'SERVER_IN_USE') {
          const count = (err.details && err.details.activePanes) || '若干';
          if (!await confirmDialog({
            title: '结束活动 Shell 并删除',
            message: '该服务器仍有 ' + count + ' 个活动 SSH Pane，删除会结束这些 Shell。',
            confirmText: '继续删除',
            danger: true,
          })) return;
          await global.Api.del(global.Api.serverPath(serverId) + '?force=1');
        } else {
          throw err;
        }
      }
      global.Store.removeServer(serverId);
      await this.refreshServers();
      global.Router.go({ name: 'servers', params: {} });
    },

    /**
     * Parses a port field. Empty means "use the default"; anything that is not a
     * valid port is an error, because silently treating "abc" as 22 would
     * connect somewhere the user did not ask for.
     */
    _parsePort(raw) {
      const text = String(raw === undefined || raw === null ? '' : raw).trim();
      if (text === '') return { port: 22 };
      if (!/^\d+$/.test(text)) return { error: 'SSH Port 必须是数字' };
      const port = Number(text);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return { error: 'SSH Port 必须在 1-65535 之间' };
      }
      return { port };
    },

    openEditServer(serverId) {
      const server = global.AppShell.server(serverId);
      if (!server) return;
      if (server.immutable) {
        // Only the display alias of the built-in local record is editable.
        this.openModal('编辑本机',
          '<p>本机记录由程序合成，连接信息不可修改，只能改显示名称。</p>'
          + '<div class="form-grid"><div class="field full"><label for="ms-edit-name">显示名称</label>'
          + '<input id="ms-edit-name" value="' + global.AppShell.escape(server.name) + '"></div></div>',
          '<button class="ms-btn primary" data-action="submit-edit-server">保存</button>');
        return;
      }

      const address = server.address || {};
      const ssh = server.ssh || {};
      this.openModal('编辑服务器',
        '<p>只保存连接引用。密码与私钥内容不会被保存。</p>'
        + '<div class="form-grid">'
        + '<div class="field full"><label for="ms-edit-name">显示名称</label>'
        + '<input id="ms-edit-name" value="' + global.AppShell.escape(server.name) + '"></div>'
        + '<div class="field"><label for="ms-edit-host">Host</label>'
        + '<input id="ms-edit-host" value="' + global.AppShell.escape(address.host || '') + '"></div>'
        + '<div class="field"><label for="ms-edit-port">SSH Port</label>'
        + '<input id="ms-edit-port" value="' + global.AppShell.escape(address.port || 22) + '"></div>'
        + '<div class="field full"><label for="ms-edit-user">Username</label>'
        + '<input id="ms-edit-user" value="' + global.AppShell.escape(address.user || '') + '"></div>'
        + '<div class="field full"><label for="ms-edit-identity">私钥路径（可选，仅保存路径）</label>'
        + '<input id="ms-edit-identity" placeholder="'
        + (ssh.usesIdentityFile ? '已配置，留空保持不变' : '~/.ssh/id_ed25519') + '"></div>'
        + '</div>',
        '<button class="ms-btn primary" data-action="submit-edit-server">保存并检测</button>');
    },

    async _submitEditServer(serverId) {
      const server = global.AppShell.server(serverId);
      if (!server) return;
      const value = (id) => {
        const node = global.document.getElementById(id);
        return node ? node.value.trim() : '';
      };

      const name = value('ms-edit-name');
      if (!name) {
        global.AppShell.toast('显示名称不能为空');
        return;
      }

      if (server.immutable) {
        await global.Api.patch(global.Api.serverPath(serverId), { name });
        this.closeModal();
        await this.refreshServers();
        return;
      }

      const host = value('ms-edit-host');
      const user = value('ms-edit-user');
      const parsedPort = this._parsePort(value('ms-edit-port'));
      const identityFile = value('ms-edit-identity');
      if (!host) {
        global.AppShell.toast('Host 不能为空');
        return;
      }
      if (parsedPort.error) {
        global.AppShell.toast(parsedPort.error);
        return;
      }
      const port = parsedPort.port;

      const address = server.address || {};
      const connectionChanged = host !== (address.host || '')
        || port !== Number(address.port || 22)
        || user !== (address.user || '')
        || Boolean(identityFile);

      const body = { name };
      if (connectionChanged) {
        body.address = { host, port, user: user || undefined };
        if (identityFile) body.ssh = { identityFile };
      }

      try {
        await global.Api.patch(global.Api.serverPath(serverId), body);
      } catch (err) {
        if (err && err.code === 'SERVER_IN_USE') {
          const count = (err.details && err.details.activePanes) || '若干';
          const proceed = await confirmDialog({
            title: '修改服务器连接',
            message: '该服务器仍有 ' + count + ' 个活动 SSH Pane。修改连接会结束这些 Shell。',
            confirmText: '继续修改',
            danger: true,
          });
          if (!proceed) return;
          await global.Api.patch(global.Api.serverPath(serverId) + '?force=1', body);
        } else {
          const field = err && err.details && err.details.field ? '（' + err.details.field + '）' : '';
          global.AppShell.toast('保存失败' + field + '：' + (err.message || ''));
          return;
        }
      }

      this.closeModal();
      global.AppShell.toast('已保存，正在重新检测…');
      await this.refreshServers();
      await this.refreshWorkspace(serverId);
      await this._onRoute(global.Router.current());
    },

    async _renameSession(serverId, sessionId, context = {}) {
      if (!sessionId) return;
      const workspace = global.AppShell.workspace(serverId);
      const session = global.AppShell._findSession(workspace, sessionId);
      const name = await promptDialog({
        title: '重命名 Session',
        placeholder: '新名称',
        value: context.name || (session ? session.name : ''),
        confirmText: '保存',
      });
      if (!name) return;
      await global.Api.request(
        'PATCH',
        global.Api.serverPath(serverId, '/sessions/' + encodeURIComponent(sessionId)),
        { name },
        { headers: this._providerHeader(serverId, context.provider) },
      );
      await this.refreshWorkspace(serverId);
      await this._onRoute(global.Router.current());
    },

    async _closeSession(serverId, sessionId, context = {}) {
      if (!sessionId) return;
      const workspace = global.AppShell.workspace(serverId);
      const session = global.AppShell._findSession(workspace, sessionId);
      const label = context.name || (session ? session.name : sessionId);
      if (!await confirmDialog({
        title: '关闭 Session',
        message: '关闭 Session“' + label + '”？其中所有 Window 都会结束。',
        confirmText: '关闭',
        danger: true,
      })) return;

      await global.Api.request(
        'DELETE',
        global.Api.serverPath(serverId, '/sessions/' + encodeURIComponent(sessionId)),
        undefined,
        { headers: this._providerHeader(serverId, context.provider) },
      );
      await this.refreshWorkspace(serverId);
      this._correctRouteAfterClose(serverId, { sessionId });
    },

    async _renameWindow(serverId, windowId, context = {}) {
      if (!windowId) return;
      const route = global.Router.current();
      const workspace = global.AppShell.workspace(serverId);
      const session = global.AppShell._findSession(workspace, route.params && route.params.sessionId);
      const win = global.AppShell._findWindow(session, windowId);
      const name = await promptDialog({
        title: '重命名 Window',
        placeholder: '新名称',
        value: context.name || (win ? win.name : ''),
        confirmText: '保存',
      });
      if (!name) return;
      await global.Api.request(
        'PATCH',
        global.Api.serverPath(serverId, '/windows/' + encodeURIComponent(windowId)),
        { name },
        { headers: this._providerHeader(serverId, context.provider) },
      );
      await this.refreshWorkspace(serverId);
      await this._onRoute(global.Router.current());
    },

    async _closeWindow(serverId, windowId, context = {}) {
      if (!windowId) return;
      const label = context.name || '这个 Window';
      if (!await confirmDialog({
        title: '关闭 Window',
        message: '关闭“' + label + '”？其中的 Pane 都会结束。',
        confirmText: '关闭',
        danger: true,
      })) return;
      await global.Api.request(
        'DELETE',
        global.Api.serverPath(serverId, '/windows/' + encodeURIComponent(windowId)),
        undefined,
        { headers: this._providerHeader(serverId, context.provider) },
      );
      await this.refreshWorkspace(serverId);
      this._correctRouteAfterClose(serverId, { windowId });
    },

    /**
     * After a close, the route may point at something that no longer exists.
     * Move to this server's default target rather than rendering a dead window.
     */
    _correctRouteAfterClose(serverId, closed) {
      const route = global.Router.current();
      const params = route.params || {};
      const affected = (closed.sessionId && params.sessionId === closed.sessionId)
        || (closed.windowId && params.windowId === closed.windowId);
      if (!affected) {
        this._onRoute(route).catch((err) => this._reportRouteFailure(err));
        return;
      }
      const target = global.AppShell.resolveDefaultTarget(serverId)
        || { name: 'terminal', params: { serverId } };
      // Router.go fires hashchange, which renders. Rendering here too would
      // mount the terminal twice.
      if (global.Router.isSame(route, target)) {
        this._onRoute(route).catch((err) => this._reportRouteFailure(err));
        return;
      }
      global.Router.go(target, { replace: true });
    },

    openAddServer() {
      this.openModal('添加服务器',
        '<p>只保存连接引用。密码与私钥内容不会被保存，认证走 SSH Agent 或 ~/.ssh/config。</p>'
        + '<div class="form-grid">'
        + '<div class="field full"><label for="ms-name">显示名称</label><input id="ms-name" value=""></div>'
        + '<div class="field"><label for="ms-host">Host</label><input id="ms-host" placeholder="10.0.0.21"></div>'
        + '<div class="field"><label for="ms-port">SSH Port</label><input id="ms-port" value="22"></div>'
        + '<div class="field full"><label for="ms-user">Username</label><input id="ms-user" value=""></div>'
        + '<div class="field full"><label for="ms-identity">私钥路径（可选，仅保存路径）</label>'
        + '<input id="ms-identity" placeholder="~/.ssh/id_ed25519"></div>'
        + '</div>',
        '<button class="ms-btn primary" data-action="submit-server">保存并检测</button>');
    },

    async _submitServer() {
      const value = (id) => {
        const node = global.document.getElementById(id);
        return node ? node.value.trim() : '';
      };
      const host = value('ms-host');
      if (!host) {
        global.AppShell.toast('Host 不能为空');
        return;
      }
      const parsedPort = this._parsePort(value('ms-port'));
      if (parsedPort.error) {
        global.AppShell.toast(parsedPort.error);
        return;
      }
      const port = parsedPort.port;
      const body = {
        name: value('ms-name') || host,
        address: { host, port, user: value('ms-user') || undefined },
        ssh: value('ms-identity') ? { identityFile: value('ms-identity') } : {},
      };
      try {
        const created = await global.Api.post('/api/servers', body);
        this.closeModal();
        global.AppShell.toast('已保存，正在检测连接…');
        await this.refreshServers();
        global.Router.go({ name: 'server', params: { serverId: created.id, section: 'connection' } });
      } catch (err) {
        const field = err && err.details && err.details.field ? '（' + err.details.field + '）' : '';
        global.AppShell.toast('保存失败' + field + '：' + (err.message || ''));
      }
    },

    openModal(title, bodyHtml, actionsHtml) {
      const backdrop = global.document.getElementById('ms-modal');
      if (!backdrop) return;
      backdrop.innerHTML = '<div class="ms-modal" role="dialog" aria-modal="true">'
        + '<h3>' + global.AppShell.escape(title) + '</h3>' + bodyHtml
        + '<div class="ms-modal-actions"><button class="ms-btn ghost" data-action="close-modal">取消</button>'
        + (actionsHtml || '') + '</div></div>';
      backdrop.hidden = false;
    },

    closeModal() {
      const backdrop = global.document.getElementById('ms-modal');
      if (!backdrop) return;
      backdrop.hidden = true;
      backdrop.innerHTML = '';
    },
  };

  global.MsApp = MsApp;
})(typeof window !== 'undefined' ? window : globalThis);
