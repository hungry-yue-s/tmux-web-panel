import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const source = name => readFileSync(name, 'utf8');
const windows = [];
function setup() {
  const dom = new JSDOM('<!doctype html><body><div class="ms-app mode-terminal"><main class="ms-main"><div id="ms-view"><div class="wb-stage"></div></div></main></div></body>', { url: 'https://panel.test/', runScripts: 'outside-only' });
  const w = dom.window;
  windows.push(w);
  Object.defineProperty(w, 'innerWidth', { value: 1440 });
  w.Auth = { headers: () => ({ Authorization: 'Bearer test' }) };
  w.Api = { activeServerId: () => 'remote', nodeUrl: (id, path) => id === 'local' ? path : '/n/' + id + path };
  w.fetch = vi.fn(async url => {
    const path = new URL(url, w.location.href).searchParams.get('path');
    return { status: 200, json: async () => ({ success: true, data: String(url).includes('/info')
      ? { isDirectory: true, absPath: path, mtimeMs: 1, size: 0 }
      : { absPath: path, parent: '/', entries: [], truncated: false } }) };
  });
  return w;
}
afterEach(() => { windows.splice(0).forEach(w => w.close()); });

describe('local workbench bridges', () => {
  it('round trips a local view route separately from a tmux window route', () => {
    const w = setup();
    w.eval(source('plugins/ui/client/js/router.js'));
    expect(w.Router.parse('#/workbench/remote/view%20one')).toEqual({ name: 'workbench', params: { serverId: 'remote', viewId: 'view one' } });
    expect(w.Router.serialize({ name: 'workbench', params: { serverId: 'remote', viewId: 'view one' } })).toBe('#/workbench/remote/view%20one');
  });

  it('takes tool targets from verified local focus without querying the legacy tmux focus', async () => {
    const w = setup();
    const focus = { onTerminal: true, serverId: 'remote', viewId: 'v1', paneId: '%7', windowId: '@6', sessionId: '$2', instanceId: '19:20', key: 'v1:leaf1' };
    w.Store = { getState: () => ({ route: { name: 'workbench', params: { serverId: 'remote', viewId: 'v1' } } }) };
    w.Workbench = { currentContext: () => focus, focusedContext: () => focus };
    w._resolveFocusedPaneId = () => { throw new Error('legacy focus must not be consulted'); };
    w.eval(source('plugins/files/client/js/blocks.js'));
    expect(w.Blocks.ui.currentContext()).toMatchObject({ viewId: 'v1', paneId: '%7', serverId: 'remote' });
    expect(w.Blocks.ui.selectedContext().key).toBe('v1:leaf1');
    expect(await w.Blocks.ui.focusedContext()).toMatchObject({ paneId: '%7', serverId: 'remote' });
  });

  it('never falls back to a stale legacy pane while a local view is loading', async () => {
    const w = setup();
    w.Store = { getState: () => ({ route: { name: 'workbench', params: { serverId: 'remote', viewId: 'v1' } } }) };
    w.Workbench = { currentContext: () => null, focusedContext: () => null };
    w.state = { currentPane: '%99' };
    w.TerminalTarget = { serverId: 'remote', sessionId: '$old', windowId: '@old' };
    w.eval(source('plugins/files/client/js/blocks.js'));
    expect(w.Blocks.ui.currentContext()).toMatchObject({ serverId: 'remote', viewId: 'v1', paneId: null });
    expect(w.Blocks.ui.selectedContext()).toMatchObject({ onTerminal: true, paneId: null });
    await expect(w.Blocks.ui.focusedContext()).rejects.toThrow('尚未确认');
  });

  it('keeps a local view dock alive while tmux focus and the complete remote tree change', async () => {
    const w = setup();
    w.eval(source('plugins/files/client/js/file-preview.js'));
    await w.FilePreview.switchViewContext('remote', 'v1');
    await w.FilePreview.openFile('/repo', '%7', { source: { serverId: 'remote', paneId: '%7' } });
    w.FilePreview._test.dockCurrent();
    const panel = w.document.querySelector('.fp-dock');
    expect(panel).not.toBeNull();
    const key = w.FilePreview.blockDock.context();
    w.FilePreview.reconcileWorkspace('remote', { provider: 'tmux', instanceId: '30:40', complete: true, sessions: [] });
    await w.FilePreview.switchViewContext('remote', 'v1');
    expect(w.FilePreview.blockDock.context()).toBe(key);
    expect(w.document.querySelector('.fp-dock')).toBe(panel);
    expect([...Array(w.localStorage.length)].map((_, i) => w.localStorage.key(i)).some(k => k.startsWith('tmux_file_preview_view_dock_v1:'))).toBe(true);
  });

  it('keeps the file source server and pane when another pane gains focus', async () => {
    const w = setup();
    w.eval(source('plugins/files/client/js/file-preview.js'));
    await w.FilePreview.openFile('/repo', '%7', { source: { serverId: 'origin', paneId: '%7' } });
    w.Api.activeServerId = () => 'other';
    await w.FilePreview._test.refreshCurrent(true);
    expect(w.fetch.mock.calls.map(([url]) => String(url)).filter(url => url.includes('/api/files/'))
      .every(url => url.startsWith('/n/origin/'))).toBe(true);
    expect(w.fetch.mock.calls[0][0]).toContain('paneId=%257');
  });

  it('keeps docked directory navigation on its source host after the active server changes', async () => {
    const w = setup();
    w.eval(source('plugins/files/client/js/file-preview.js'));
    await w.FilePreview.switchViewContext('origin', 'v1');
    await w.FilePreview.openFile('/repo', '%7', { source: { serverId: 'origin', paneId: '%7' } });
    w.FilePreview._test.dockCurrent();
    w.Api.activeServerId = () => 'other';
    w.document.querySelector('.fp-dir-parent').click();
    await Promise.resolve();
    expect(String(w.fetch.mock.calls.at(-1)[0])).toMatch(/^\/n\/origin\//);
  });

  it('mounts the workbench route and retains its DOM across a workspace refresh', async () => {
    const w = setup();
    w.eval(source('plugins/ui/client/js/router.js'));
    w.eval(source('plugins/ui/client/js/store.js'));
    w.Store.setRoute({ name: 'workbench', params: { serverId: 'remote', viewId: 'v1' } });
    w.eval(source('plugins/ui/client/js/terminal-target.js'));
    w.eval(source('plugins/ui/client/js/app-shell.js'));
    w.eval(source('plugins/ui/client/js/ms-app.js'));
    const target = { onTerminal: true, serverId: 'remote', viewId: 'v1', paneId: '%7', windowId: '@6', sessionId: '$2', key: 'v1:1' };
    w.Workbench = {
      get: () => ({ id: 'v1', serverId: 'remote', title: '编辑区' }),
      render: async (_server, _view, { container }) => { container.innerHTML = '<textarea aria-label="editor">draft</textarea>'; },
      currentContext: () => target,
      unmount: () => {},
    };
    w.FilePreview = { switchViewContext: () => {}, switchDockContext: () => {} };
    w.cleanupTerminal = () => {};
    w.state = {};
    const route = w.Store.getState().route;
    await w.MsApp._onRoute(route);
    const draft = w.document.querySelector('textarea');
    expect(draft).not.toBeNull();
    draft.value = 'keep this draft';
    await w.MsApp._onRoute(route);
    expect(w.document.querySelector('textarea')).toBe(draft);
    expect(draft.value).toBe('keep this draft');
    expect(w.TerminalTarget.serverId).toBe('remote');
    expect(w.TerminalTarget.viewId).toBe('v1');
  });

  it('offers local views and new layout actions beside the supported server session', () => {
    const w = setup();
    w.eval(source('plugins/ui/client/js/router.js'));
    w.eval(source('plugins/ui/client/js/store.js'));
    w.Store.setHealth('remote', { capabilities: { nativeWindow: { available: true } } });
    w.Store.setWorkspace('remote', { provider: 'tmux', instanceId: '1:2', actions: {}, sessions: [{ id: '$2', name: '开发', windows: [] }] });
    w.Workbench = { list: () => [{ id: 'v1', serverId: 'remote', title: '我的布局' }] };
    w.eval(source('plugins/ui/client/js/app-shell.js'));
    w.document.body.insertAdjacentHTML('beforeend', w.AppShell._renderTree('remote', { name: 'workbench', params: { serverId: 'remote', viewId: 'v1' } }));
    expect(w.document.querySelector('[data-route="#/workbench/remote/v1"]').textContent).toContain('我的布局');
    expect(w.document.querySelector('[data-action="new-workbench"]').dataset.session).toBe('$2');
  });

  it('opens an existing multi-pane window through the default native workbench entry', async () => {
    const w = setup(); w.eval(source('plugins/ui/client/js/router.js')); w.eval(source('plugins/ui/client/js/store.js'));
    const remoteWindow = { id: '@3', name: '编辑', index: 3, active: true, panes: [{ id: '%7' }, { id: '%8' }] };
    w.Store.setHealth('remote', { capabilities: { nativeWindow: { available: true } } });
    w.Store.setWorkspace('remote', { provider: 'tmux', instanceId: '1:2', actions: {}, sessions: [{ id: '$2', name: '开发', windows: [remoteWindow] }] });
    w.Workbench = { list: () => [], create: vi.fn(async () => ({ id: 'native-view' })), open: vi.fn() };
    w.eval(source('plugins/ui/client/js/app-shell.js')); w.eval(source('plugins/ui/client/js/ms-app.js'));
    w.document.body.insertAdjacentHTML('beforeend', w.AppShell._renderWindows('remote', w.AppShell.workspace('remote').sessions[0], {}, false));
    const button = w.document.querySelector('[data-action="open-workbench"]'); expect(button).not.toBeNull();
    await w.MsApp._handleAction('open-workbench', button);
    expect(w.Workbench.create).toHaveBeenCalledWith(expect.objectContaining({ serverId: 'remote', instanceId: '1:2', sessionId: '$2', windowId: '@3' }));
    expect(w.Workbench.open).toHaveBeenCalledWith('native-view');
  });

  it('distinguishes a saved view from a previous tmux lifetime without deleting it', () => {
    const w = setup(); w.eval(source('plugins/ui/client/js/router.js')); w.eval(source('plugins/ui/client/js/store.js'));
    w.Store.setWorkspace('remote', { provider: 'tmux', instanceId: '3:4', complete: true, actions: {}, sessions: [] });
    const views = [{ id: 'old', title: '开发', instanceId: '1:2' }, { id: 'current', title: '开发', instanceId: '3:4' }];
    w.Workbench = { list: () => views }; w.eval(source('plugins/ui/client/js/app-shell.js'));
    w.document.body.insertAdjacentHTML('beforeend', w.AppShell._renderTree('remote', { name: 'workbench', params: { serverId: 'remote', viewId: 'current' } }));
    expect(w.document.querySelector('.wb-view-stale').textContent).toContain('旧会话');
    expect(w.document.querySelectorAll('[data-route^="#/workbench/"]')).toHaveLength(2);
    expect(views).toHaveLength(2);
  });

  it('keeps a view-owned tool draft across remote pane collection', async () => {
    const w = setup();
    w.eval(source('plugins/files/client/js/file-preview.js'));
    await w.FilePreview.switchViewContext('remote', 'v1');
    w.eval(source('plugins/files/client/js/block-host.js'));
    w.BlockHost.register('draft', { title: '草稿', perWindow: true, create() {
      const node = w.document.createElement('textarea');
      node.value = 'keep draft';
      return { el: node };
    } });
    w.BlockHost.open('draft');
    const draft = w.document.querySelector('textarea');
    expect(draft).not.toBeNull();
    w.FilePreview.reconcileWorkspace('remote', { provider: 'tmux', instanceId: '8:9', complete: true, sessions: [] });
    expect(w.document.querySelector('textarea')).toBe(draft);
    expect([...Array(w.localStorage.length)].map((_, i) => w.localStorage.key(i)).some(k => k.startsWith('twp_view_blocks_v1:'))).toBe(true);
  });

  it('finishes creating a layout without navigating over a newer user route', async () => {
    const w = setup();
    w.eval(source('plugins/ui/client/js/router.js'));
    w.eval(source('plugins/ui/client/js/store.js'));
    w.eval(source('plugins/ui/client/js/app-shell.js'));
    w.eval(source('plugins/ui/client/js/ms-app.js'));
    w.Store.setWorkspace('remote', { provider: 'tmux', instanceId: '1:2', sessions: [{ id: '$2', name: '开发', windows: [] }] });
    let resolve;
    w.Workbench = { create: () => new Promise(done => { resolve = done; }), open: id => w.Router.go({ name: 'workbench', params: { serverId: 'remote', viewId: id } }) };
    w.location.hash = '#/terminal/remote';
    const button = w.document.createElement('button');
    button.dataset.serverId = 'remote';
    button.dataset.session = '$2';
    const creating = w.MsApp._handleAction('new-workbench', button);
    w.location.hash = '#/settings';
    w.MsApp._routeGeneration++;
    resolve({ id: 'new-view' });
    await creating;
    expect(w.location.hash).toBe('#/settings');
  });

  it('loads the server workspace in the background when opening a saved local layout', async () => {
    const w = setup();
    w.eval(source('plugins/ui/client/js/router.js'));
    w.eval(source('plugins/ui/client/js/store.js'));
    w.eval(source('plugins/ui/client/js/terminal-target.js'));
    w.eval(source('plugins/ui/client/js/app-shell.js'));
    w.eval(source('plugins/ui/client/js/ms-app.js'));
    const workspace = { provider: 'tmux', instanceId: '1:2', sessions: [], complete: true };
    w.Api.workspaceUrl = id => '/n/' + id + '/api/workspace';
    w.Api.get = async url => { expect(url).toBe('/n/remote/api/workspace'); return workspace; };
    w.Workbench = { get: () => ({ id: 'v1', serverId: 'remote' }), render: async () => {}, unmount() {}, currentContext: () => null };
    await w.MsApp._onRoute({ name: 'workbench', params: { serverId: 'remote', viewId: 'v1' } });
    await Promise.resolve();
    expect(w.AppShell.workspace('remote')).toEqual(workspace);
  });
});
