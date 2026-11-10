// Workbench-specific shell integration. The shell and tools only see the
// terminal-view contract; they never need the native client's implementation.
export function registerWorkbenchShell(global, api) {
  const slots = global.PanelSlots;
  if (!slots) return () => {};
  let mountKey = null, mountedHost = null, lastContext = null;
  const routeNow = () => global.Store?.getState().route || global.Router?.current();
  const matches = (route, context) => route?.name === 'workbench'
    && context?.onTerminal && context.serverId === route.params?.serverId && context.viewId === route.params?.viewId;
  const escape = value => global.AppShell.escape(value == null ? '' : String(value));
  const available = serverId => slots.hasPlugin('control-terminal', serverId)
    && !!global.AppShell?.health(serverId)?.capabilities?.nativeWindow?.available;
  function currentContext() {
    const route = routeNow(), params = route?.params || {}, current = api.currentContext?.();
    if (matches(route, current)) return { ...current };
    return { onTerminal: true, serverId: params.serverId || 'local', viewId: params.viewId,
      paneId: null, key: ['workbench', params.serverId, params.viewId, 'pending'].join('\u0000') };
  }
  function sync(context) {
    if (!matches(routeNow(), context)) return;
    const workspace = global.AppShell?.workspace(context.serverId);
    const session = workspace?.sessions?.find(item => item.id === context.sessionId);
    const win = session?.windows?.find(item => item.id === context.windowId);
    const known = workspace?.instanceId === context.instanceId && win?.panes?.some(item => item.id === context.paneId);
    const switched = lastContext && (lastContext.sessionId !== context.sessionId || lastContext.windowId !== context.windowId);
    lastContext = context;
    // Native prefix actions don't pass through workspace mutations. Read only
    // for a new/changed window or unknown pane, never for ordinary keystrokes.
    if (context.paneId && (!known || switched)) global.MsApp?.refreshWorkspace(context.serverId, { shared: true });
    global.TerminalTarget?.set({ ...context, provider: 'tmux' });
    if (global.state) global.state.currentPane = context.paneId || null;
    global.AppShell?.render();
  }
  async function openWindow({ serverId, node, row, isCurrent }) {
    const workspace = global.AppShell.workspace(serverId)
      || await global.MsApp.refreshWorkspace(serverId, { shared: true });
    if (!isCurrent()) return;
    const sessionId = node.dataset.session || row?.dataset.session;
    const session = global.AppShell._findSession(workspace, sessionId);
    if (!session || !workspace.instanceId) throw new Error('请等待会话读取完成');
    const windowId = node.dataset.window || row?.dataset.window;
    const win = (session.windows || []).find(item => item.id === windowId)
      || (!windowId && ((session.windows || []).find(item => item.active) || session.windows?.[0]));
    if (windowId && !win) throw new Error('此窗口已不存在，请刷新会话列表');
    const existing = api.list?.(serverId).find(item => item.instanceId === workspace.instanceId
      && item.sessionId === sessionId && item.windowId === win?.id);
    const created = existing || await api.create({ serverId, sessionId, instanceId: workspace.instanceId,
      ...(win ? { windowId: win.id } : {}), title: win?.name || session.name });
    if (isCurrent()) api.open(created.id);
  }
  const entry = {
    id: 'workbench', currentContext,
    async focusedContext() {
      if (!api.focusedContext) throw new Error('原生终端尚未确认当前窗格');
      const fresh = await api.focusedContext();
      const current = currentContext();
      if (!fresh?.paneId || !matches(routeNow(), fresh) || fresh.key !== current.key) {
        throw new Error('原生终端焦点已变化或尚未确认');
      }
      return { ...fresh };
    },
    async mount({ route, serverId, view, isCurrent }) {
      const viewId = route.params.viewId, key = serverId + '\u0000' + viewId;
      if (mountKey === key && mountedHost?.isConnected && view.contains(mountedHost)) return;
      api.unmount(); mountKey = null;
      global.TerminalTarget.set({ serverId, viewId, provider: 'tmux' });
      if (global.state) global.state.currentTab = 'terminal';
      view.classList.add('terminal-mode');
      view.innerHTML = '<section class="section terminal-stage" id="ms-workbench-host"></section>';
      const host = view.firstElementChild, saved = api.get(viewId);
      if (!saved || saved.serverId !== serverId) {
        global.FilePreview?.switchDockContext(null, null);
        host.textContent = '此原生工作台不存在。旧版布局数据仍保留，请从现有窗口打开工作台。';
        return;
      }
      if (!global.AppShell.workspace(serverId)) global.MsApp.refreshWorkspace(serverId, { shared: true });
      global.AppShell.setHeader(global.AppShell.server(serverId)?.name || serverId, saved.title || '工作台', '');
      // Reserve restored dock width before xterm measures its first grid.
      global.FilePreview?.switchDockContext(serverId, saved.windowId, saved.instanceId);
      mountKey = key; mountedHost = host;
      await api.render(serverId, viewId, { container: host });
      if (isCurrent()) sync(api.currentContext());
    },
    unmount() { mountKey = null; mountedHost = null; lastContext = null; api.unmount(); },
    reconcileWorkspace: (serverId, workspace) => api.reconcileWorkspace?.(serverId, workspace),
    windowAction: serverId => available(serverId) ? 'open-workbench' : null,
    title: route => api.get?.(route.params.viewId)?.title || '工作台',
    actions: { 'new-workbench': openWindow, 'open-workbench': openWindow },
    renderSessionActions(serverId, session) {
      return available(serverId) ? '<button type="button" class="tree-add-button" data-action="new-workbench" data-session="'
        + escape(session.id) + '" title="打开原生工作台" aria-label="在 ' + escape(session.name) + ' 中打开原生工作台">▦</button>' : '';
    },
    renderNavigation(serverId, route, workspace) {
      const views = api.list?.(serverId) || [];
      if (!views.length) return '';
      return '<div class="tree-section-head"><span>工作台</span></div><div class="tree">' + views.map(view => {
        const stale = workspace.complete === true && workspace.instanceId && view.instanceId && workspace.instanceId !== view.instanceId;
        return '<button class="tree-item ' + (stale ? 'wb-view-stale ' : '') + (route?.params?.viewId === view.id ? 'active' : '') + '"'
          + (stale ? ' title="此工作台绑定旧会话，目标已保留，不会自动替换或结束原任务"' : '') + ' data-route="'
          + escape(global.Router.serialize({ name: 'workbench', params: { serverId, viewId: view.id } })) + '">'
          + global.AppShell.icon('overview') + '<span>' + escape(view.title || '工作台') + '</span>'
          + (stale ? '<small class="wb-view-state">旧会话</small>' : '') + '</button>';
      }).join('') + '</div>';
    },
  };
  const unregister = slots.terminalViews.register(entry);
  const focus = event => sync(event.detail), changed = () => global.AppShell?.render();
  global.addEventListener('terminal-context-changed', focus);
  global.addEventListener('workbench-views-changed', changed);
  global.dispatchEvent(new global.CustomEvent('terminal-views-changed'));
  return () => {
    unregister(); entry.unmount();
    global.removeEventListener('terminal-context-changed', focus);
    global.removeEventListener('workbench-views-changed', changed);
    global.dispatchEvent(new global.CustomEvent('terminal-views-changed'));
  };
}
