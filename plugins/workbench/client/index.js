import { createViewStore, newId, validateWindowTarget } from './model.js';
import { NativeWindowSession } from './native-window-session.js';
import { openHistory } from './history.js';
import { registerWorkbenchShell } from './shell.js';
export { registerWorkbenchShell };

export const name = 'workbench';
export const inject = ['api'];

// A duplicated tab may inherit sessionStorage. Holding its Web Lock prevents
// both tabs from typing through the same native tmux client; reload keeps it.
function tabIdentity(global) {
  if (global.__workbenchTabIdentity) return global.__workbenchTabIdentity;
  global.__workbenchTabIdentity = (async () => {
    let id;
    try { id = global.sessionStorage.getItem('twp_native_tab'); } catch { /* private webview */ }
    if (!/^[A-Za-z0-9_-]{1,48}$/.test(id || '')) id = newId('t');
    if (global.navigator.locks) {
      for (;;) {
        let claimed;
        const claim = new Promise((resolve) => { claimed = resolve; });
        global.navigator.locks.request('twp_native_' + id, { ifAvailable: true }, (lock) => {
          claimed(!!lock); return lock ? new Promise(() => {}) : undefined;
        }).catch(() => claimed(null));
        const available = await claim;
        if (available !== false) { if (available !== true) id = newId('t'); break; }
        id = newId('t');
      }
    } else id = newId('t'); // Without a lock, a copied sessionStorage id is unsafe.
    try { global.sessionStorage.setItem('twp_native_tab', id); } catch { /* current tab still works */ }
    return id;
  })();
  return global.__workbenchTabIdentity;
}

export function createWorkbench(global, options = {}) {
  const doc = global.document;
  let storage; try { storage = global.localStorage; } catch { /* memory-only */ }
  const store = createViewStore(storage, options.storageScope || 'local');
  const Session = options.Session || NativeWindowSession;
  const tab = tabIdentity(global), pending = new Map();
  let mounted = null, generation = 0;
  const mobile = () => global.MobileUI?.isMobile() ?? global.innerWidth < 768;
  const emit = (name, detail) => global.dispatchEvent(new global.CustomEvent(name, { detail }));
  const changed = () => emit('workbench-views-changed', {});
  const nodeUrl = (serverId, path) => global.Api.nodeUrl(serverId, path);
  const hasPlugin = (id, serverId) => global.PanelSlots?.hasPlugin(id, serverId) ?? true;
  const viewNow = () => mounted && store.get(mounted.viewId);
  function element(tag, className, text) {
    const node = doc.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node;
  }
  function button(text, title, run, className = '') {
    const node = element('button', 'wb-button ' + className, text); node.type = 'button'; node.title = title; node.setAttribute('aria-label', title);
    node.addEventListener('click', () => { try { Promise.resolve(run()).catch(notify); } catch (error) { notify(error); } }); return node;
  }
  function glyph(name) {
    const known = global.Blocks?.icon(name); if (known) return known;
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">'
      + (name === 'more' ? '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>' : '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>') + '</svg>';
  }
  function notify(error) {
    const message = typeof error === 'string' ? error : error.message;
    if (mounted) { mounted.notice.textContent = message; mounted.notice.hidden = false; }
    global._showToast?.(message, 3500);
  }
  function context() {
    const view = viewNow(), session = mounted?.session;
    const target = session?.status === 'live' ? session.context : null;
    return Object.freeze({ onTerminal: !!mounted, serverId: view?.serverId || null, viewId: view?.id || null,
      instanceId: view?.instanceId || null, sessionId: target?.sessionId || view?.sessionId || null,
      windowId: target?.windowId || view?.windowId || null, paneId: target?.paneId || null, clientId: target?.clientId || null,
      target, key: [generation, view?.id, target?.instanceId, target?.clientId, target?.sessionId, target?.windowId, target?.paneId, session?.status].join('\u0000'),
      source: target ? Object.freeze({ serverId: target.serverId, paneId: target.paneId }) : null });
  }
  const announceFocus = () => { emit('terminal-context-changed', context()); emit('workbench-focus-changed', context()); };
  async function supported(serverId) {
    if (!hasPlugin('control-terminal', serverId)) throw new Error('此服务器未启用原生终端插件');
    const capability = await global.Api.get(nodeUrl(serverId, '/api/workbench/native-capability'));
    if (!capability?.available || capability.protocol !== 1) throw new Error('请更新 Node 和正在运行的 tmux。仅替换 tmux 程序不会更新已有服务，请在下一次安全重启 tmux 后启用；当前可使用兼容终端。');
    return true;
  }
  async function ensureWindow(viewId) {
    if (pending.has(viewId)) return pending.get(viewId);
    const view = store.get(viewId); if (!view || view.windowId) return view;
    const request = global.Api.post(nodeUrl(view.serverId, '/api/workbench/windows'), {
      instanceId: view.instanceId, sessionId: view.sessionId, requestId: view.requestId, ...view.create,
    }).then((response) => {
      if (response?.requestId && response.requestId !== view.requestId) throw new Error('创建窗口的响应不匹配');
      if (!store.get(viewId)) return null; // A late create remains a normal remote window.
      const saved = store.bind(viewId, { ...response, serverId: view.serverId }); changed(); return saved;
    }).finally(() => pending.delete(viewId));
    pending.set(viewId, request); return request;
  }
  function placeToolbar(owner) {
    const topbar = doc.getElementById('ms-topbar');
    if (topbar) { if (!topbar.classList.contains('terminal-layout')) owner.addedTerminalLayout = true; topbar.classList.add('terminal-layout'); }
    const target = mobile() ? doc.querySelector('.mobile-header') : doc.getElementById('ms-top-actions');
    owner.actions.classList.toggle('wb-actions-mobile', mobile());
    (target || owner.toolbar).append(owner.actions); owner.toolbar.hidden = !!target;
    owner.root.classList.toggle('wb-mobile', mobile()); owner.tools.hidden = !mobile();
    if (!mobile()) owner.closeDrawer();
  }
  function installTools(owner) {
    const tools = element('div', 'mobile-terminal-controls wb-mobile-tools');
    const upload = element('input'); upload.type = 'file'; upload.hidden = true;
    const drawer = element('div', 'fab-drawer-mount'); drawer.id = 'workbench-key-drawer'; drawer.inert = true;
    let drawerApi;
    let drawerOpen = false;
    const send = (data) => {
      if (mounted !== owner) return;
      if (data === '__upload__') {
        if (!hasPlugin('upload', owner.serverId)) { notify('此服务器未启用上传插件'); return; }
        upload.value = ''; upload.click();
      }
      else if (!owner.session?.send(data)) notify('终端尚未连接，按键未发送');
    };
    const toggleDrawer = (open) => {
      if (mounted && mounted !== owner) return;
      drawerOpen = open;
      if (open && owner.menu) owner.menu.open = false;
      if (open) doc.activeElement?.blur?.();
      if (open && !hasPlugin('keypad', owner.serverId)) return;
      if (open && !drawerApi && global.FabDrawer) {
        global.FabMigrate?.runOnce();
        drawerApi = global.FabDrawer.mount(drawer, { sendKey: send, onKeyboard: focusKeyboard, onClose: () => toggleDrawer(false) });
      }
      if (open && drawerApi) {
        const target = mounted?.session?.context;
        const workspace = target && global.AppShell?.workspace(target.serverId);
        const pane = workspace?.sessions?.find((item) => item.id === target.sessionId)?.windows?.find((item) => item.id === target.windowId)?.panes?.find((item) => item.id === target.paneId);
        const scene = pane?.command && global.FabScene ? global.FabScene.matchScene(pane.command, global.FabScene.loadScenes()) : 'terminal';
        drawerApi.setScene(scene);
      }
      drawer.classList.toggle('open', open); drawer.inert = !open;
      drawer.setAttribute('aria-hidden', String(!open));
      trigger.setAttribute('aria-expanded', String(open));
      owner.root.classList.toggle('drawer-pushed', open);
      doc.documentElement.classList.toggle('mobile-tools-open', open);
      doc.querySelectorAll('.mobile-dock').forEach((node) => { node.inert = open; });
      global.clearTimeout(owner.fitTimer);
      owner.fitTimer = global.setTimeout(() => { if (mounted === owner) owner.session?.fit(); }, 270);
    };
    function focusKeyboard() {
      if (mounted !== owner) return;
      toggleDrawer(false);
      // Direct synchronous call in the trusted click, required by iOS Safari.
      owner.session?.focus();
    }
    const trigger = element('button', 'fab-tool', '工具'); trigger.type = 'button';
    trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-controls', drawer.id); trigger.setAttribute('aria-label', '打开终端工具');
    trigger.addEventListener('click', () => toggleDrawer(true));
    const keys = element('div', 'mobile-terminal-quick-keys');
    for (const [id, label, seq] of [['esc', 'Esc', '\x1b'], ['tab', 'Tab', '\t'], ['ctrl', 'Ctrl+C', '\x03']]) {
      const key = element('button', '', label); key.type = 'button'; key.dataset.wbKey = id; key.addEventListener('click', () => send(seq)); keys.append(key);
    }
    const keyboard = element('button', 'mobile-terminal-keyboard', '输入'); keyboard.type = 'button'; keyboard.setAttribute('aria-label', '打开键盘输入'); keyboard.addEventListener('click', focusKeyboard);
    tools.append(...(hasPlugin('keypad', owner.serverId) ? [trigger] : []), keys, keyboard);
    owner.root.append(tools, upload, drawer);
    const sentinel = (event) => { if (drawerOpen && event.target.classList?.contains('xterm-helper-textarea')) toggleDrawer(false); };
    doc.addEventListener('focusin', sentinel);
    upload.addEventListener('change', async () => {
      const source = context().source;
      if (!upload.files?.[0] || !source || !hasPlugin('upload', source.serverId)) return;
      const form = new global.FormData(); form.append('file', upload.files[0]);
      try {
        const response = await global.fetch(nodeUrl(source.serverId, '/api/upload'), { method: 'POST', headers: global.Auth?.headers?.() || {}, body: form });
        if (!response.ok) throw new Error('上传失败');
        const result = await response.json();
        const path = result.data?.path;
        if (path) { global._copyToClipboard?.(path); notify('路径已复制：' + path); }
      } catch (error) { notify(error); }
    });
    owner.tools = tools; owner.closeDrawer = () => toggleDrawer(false);
    owner.toolsCleanup = () => { toggleDrawer(false); doc.removeEventListener('focusin', sentinel); drawerApi?.destroy(); };
  }

  function mountSession(owner, view, tabId) {
    if (!view?.windowId || mounted !== owner || owner.session) return;
    const target = validateWindowTarget({ ...view, clientId: view.clientId + '-' + tabId });
    owner.session = new Session(global, { container: owner.terminal, target, fontSize: view.fontSize,
      onFontSize: (fontSize) => { if (store.get(view.id)) store.update(view.id, (saved) => { saved.fontSize = fontSize; }); },
      onContext: (confirmed) => {
        if (mounted !== owner || !store.get(view.id)) return;
        const saved = store.get(view.id);
        if (saved.sessionId !== confirmed.sessionId || saved.windowId !== confirmed.windowId) { store.follow(view.id, confirmed); changed(); }
        announceFocus();
      },
      onState: ({ status, message }) => {
        if (mounted !== owner) return;
        owner.root.dataset.status = status; owner.message.hidden = status === 'live';
        owner.message.textContent = message || ({ connecting: '正在连接原生终端…', disconnected: '连接已断开，正在重连…', invalid: '无法连接此窗口', exited: '原生终端已结束' }[status] || '');
        announceFocus();
      },
    });
    owner.session.ready.then(() => {
      if (mounted !== owner) return;
      announceFocus(); if (!mobile() && (doc.activeElement === doc.body || owner.root.contains(doc.activeElement))) owner.session.focus();
    }).catch((error) => { if (mounted === owner) notify(error); });
  }

  const api = {
    list: (serverId) => store.list(serverId), get: (id) => store.get(id), supported,
    currentContext: context,
    async focusedContext() {
      const owner = mounted, selected = context();
      if (!owner?.session || !selected.source) throw new Error('原生终端尚未确认当前窗格');
      await owner.session.requestContext();
      if (mounted !== owner) throw new Error('工作台已切换，请重试');
      const fresh = context(); if (!fresh.source) throw new Error('原生终端未能确认当前窗格');
      return Object.freeze({ ...fresh, focusRequestKey: selected.key });
    },
    focusedSession: () => mounted?.session || null,
    open(id) { const view = store.get(id); if (!view) throw new Error('工作台不存在'); global.Router.go({ name: 'workbench', params: { serverId: view.serverId, viewId: id } }); },
    async create(input) {
      input = { ...input, ...(input.target || {}) }; await supported(input.serverId);
      const view = store.create(input); changed();
      if (!view.windowId) await ensureWindow(view.id).catch(notify);
      return store.get(view.id);
    },
    async render(serverId, viewId, { container } = {}) {
      if (!container) throw new Error('缺少工作台容器');
      if (mounted?.viewId === viewId && mounted.host === container && mounted.root.isConnected) { mounted.session?.fit(); return; }
      api.unmount(); const view = store.get(viewId);
      if (!view || view.serverId !== serverId) {
        container.replaceChildren(element('div', 'wb-empty', '此浏览器没有保存这个原生工作台。旧版原型布局数据仍保留；请从会话中的现有窗口打开工作台。')); return;
      }
      const owner = { serverId, viewId, host: container, histories: new Map(), session: null, root: element('section', 'wb-stage terminal-view'), closeDrawer() {} };
      mounted = owner; const version = generation;
      owner.root.dataset.viewId = viewId; owner.root.setAttribute('aria-label', view.title);
      owner.toolbar = element('header', 'wb-toolbar'); owner.actions = element('div', 'wb-toolbar-actions');
      owner.actions.setAttribute('role', 'toolbar'); owner.actions.setAttribute('aria-label', '原生终端操作');
      const more = element('details', 'wb-workbench-menu'); const summary = element('summary', 'wb-icon-button');
      summary.innerHTML = glyph('more'); summary.setAttribute('aria-label', '更多终端操作');
      const menu = element('div', 'wb-command-menu');
      const command = (label, run) => button(label, label, () => { more.open = false; return run(); }, 'wb-menu-item');
      menu.append(command('左右分割', () => api.split('horizontal')), command('上下分割', () => api.split('vertical')),
        command('重新连接', () => owner.session?.refresh()), command('粘贴', async () => {
          const selected = context(); const text = await global.navigator.clipboard.readText();
          if (context().key !== selected.key) throw new Error('原生焦点已变化，请重新粘贴');
          if (!owner.session?.paste(text)) throw new Error('终端尚未连接，内容未发送');
        }), command('滚动历史', () => api.openHistory()),
        command('减小字号', () => owner.session?.setFontSize(owner.session.term.options.fontSize - 1)),
        command('增大字号', () => owner.session?.setFontSize(owner.session.term.options.fontSize + 1)),
        command('重命名工作台', () => api.renameView(viewId)),
        command('关闭本地工作台', () => { api.closeView(viewId); global.Router.go({ name: 'terminal', params: { serverId } }); }));
      more.append(summary, menu); owner.menu = more; owner.actions.append(more); owner.toolbar.append(owner.actions);
      owner.dismissMenu = (event) => { if (!more.contains(event.target) || event.key === 'Escape') more.open = false; };
      doc.addEventListener('pointerdown', owner.dismissMenu, true); doc.addEventListener('keydown', owner.dismissMenu);
      owner.notice = element('p', 'wb-notice'); owner.notice.hidden = true; owner.notice.setAttribute('role', 'status');
      owner.terminal = element('div', 'wb-window-terminal');
      owner.message = element('div', 'wb-window-message', '正在准备原生终端…'); owner.message.setAttribute('role', 'status');
      owner.root.append(owner.toolbar, owner.notice, owner.terminal, owner.message); installTools(owner);
      container.replaceChildren(owner.root); doc.body.classList.add('terminal-active'); placeToolbar(owner);
      owner.resize = () => { if (mounted === owner) { placeToolbar(owner); owner.session?.fit(); } };
      owner.visibility = () => owner.session?.setVisible(!doc.hidden);
      global.addEventListener('resize', owner.resize); doc.addEventListener('visibilitychange', owner.visibility);
      try {
        const [, tabId] = await Promise.all([supported(serverId), tab]);
        if (mounted !== owner || generation !== version) return;
        const bound = view.windowId ? view : await ensureWindow(viewId);
        if (mounted !== owner || generation !== version) return;
        if (!store.persistent) notify('浏览器未允许保存，本次工作台仅在此页面保留。');
        mountSession(owner, bound, tabId);
      } catch (error) {
        if (mounted !== owner || generation !== version) return;
        notify(error); owner.message.hidden = true;
        owner.root.append(button('重新尝试', '重新尝试连接同一个窗口', () => { api.unmount(); return api.render(serverId, viewId, { container }); }),
          button('打开兼容终端', '打开服务器原有终端', () => global.Router.go({ name: 'terminal', params: { serverId, sessionId: view.sessionId, windowId: view.windowId } })));
      }
    },
    unmount() {
      generation++; const owner = mounted; mounted = null; if (!owner) return;
      owner.toolsCleanup?.(); for (const reader of owner.histories.values()) reader.close();
      global.clearTimeout(owner.fitTimer); global.removeEventListener('resize', owner.resize); doc.removeEventListener('visibilitychange', owner.visibility);
      doc.removeEventListener('pointerdown', owner.dismissMenu, true); doc.removeEventListener('keydown', owner.dismissMenu);
      if (owner.addedTerminalLayout) doc.getElementById('ms-topbar')?.classList.remove('terminal-layout');
      owner.session?.dispose(); owner.actions.remove(); owner.root.remove(); doc.body.classList.remove('terminal-active'); announceFocus();
    },
    async split(direction = 'horizontal') {
      if (!['horizontal', 'vertical'].includes(direction)) throw new Error('无效分割方向');
      const selected = await api.focusedContext();
      if (context().key !== selected.key) throw new Error('原生终端焦点已变化，请重新分窗');
      const path = '/windows/' + encodeURIComponent(selected.windowId) + '/panes';
      const url = global.Api.workspaceUrl ? global.Api.workspaceUrl(selected.serverId, path) : nodeUrl(selected.serverId, '/api/workspace' + path);
      return global.Api.post(url, { paneId: selected.paneId, direction });
    },
    async renameView(id, title) {
      const view = store.get(id); if (!view) return;
      if (title === undefined) title = global.showPrompt ? await global.showPrompt({ title: '重命名工作台', value: view.title }) : global.prompt('工作台名称', view.title);
      if (title == null) return; if (typeof title !== 'string' || !title.trim() || title.length > 120) throw new Error('名称需为 1–120 个字符');
      store.update(id, (saved) => { saved.title = title.trim(); }); changed();
    },
    async openHistory() {
      const selected = await api.focusedContext();
      if (!mounted || context().key !== selected.key) throw new Error('原生终端焦点已变化，请重新打开历史');
      const owner = mounted, id = selected.paneId;
      if (owner.histories.has(id)) { owner.histories.get(id).dialog.focus(); return owner.histories.get(id); }
      owner.closeDrawer(); const reader = openHistory(global, selected.target, { title: store.get(owner.viewId).title, onClose: () => owner.histories.delete(id) });
      owner.histories.set(id, reader); return reader;
    },
    closeView(id) { if (mounted?.viewId === id) api.unmount(); store.close(id); changed(); emit('workbench-view-closed', { viewId: id }); },
    reconcileWorkspace(serverId, workspace) {
      if (mounted?.serverId !== serverId || workspace?.complete !== true) return;
      const view = viewNow();
      if (workspace.instanceId !== view?.instanceId) mounted.session?.invalidate('tmux 实例已变化，原工作台身份已保留。请从当前窗口新建工作台。');
      // Native context/exit is authoritative. A delayed workspace tree must not
      // override a prefix-driven window switch or destroy a still-live client.
    },
  };
  return api;
}
export function apply(ctx, config = {}) {
  const api = createWorkbench(globalThis, config); ctx.provide('workbench', api);
  ctx.effect(() => {
    const previous = globalThis.Workbench; globalThis.Workbench = api; globalThis.dispatchEvent(new CustomEvent('workbench-ready'));
    const unregister = registerWorkbenchShell(globalThis, api);
    return () => { unregister(); if (globalThis.Workbench === api) globalThis.Workbench = previous; };
  });
}
