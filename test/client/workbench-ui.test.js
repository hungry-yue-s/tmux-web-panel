import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { createWorkbench } from '../../plugins/workbench/client/index.js';

const remote = { instanceId: '42:123', sessionId: '$1', windowId: '@1', paneId: '%1' };
function fixture() {
  const dom = new JSDOM('<main id="host"></main><nav class="mobile-dock"></nav>', { url: 'https://panel.test' });
  const win = dom.window; const sessions = [];
  win.Api = { nodeUrl: (server, path) => '/n/' + server + path, workspaceUrl: (server, path) => '/n/' + server + '/api/workspace' + path,
    get: vi.fn(async () => ({ available: true, protocol: 1 })), post: vi.fn(async (_url, body) => ({ ...remote, requestId: body.requestId })), del: vi.fn() };
  win.Router = { go: vi.fn() }; win.MobileUI = { isMobile: () => false };
  class Session {
    constructor(global, options) {
      this.options = options; this.target = options.target; this.status = 'live';
      this.context = { ...options.target, paneId: '%1' };
      this.term = { options: { fontSize: 14 }, textarea: global.document.createElement('textarea'), getSelection: () => '' };
      this.term.textarea.className = 'xterm-helper-textarea'; options.container.append(this.term.textarea);
      this.ready = Promise.resolve(); sessions.push(this);
    }
    requestContext() { return Promise.resolve(this.context); }
    fit() {} setVisible() {} send = vi.fn(() => true); paste = vi.fn(() => true);
    focus() { this.term.textarea.focus(); } dispose() { this.disposed = true; } refresh() {} setFontSize() {} copy() {}
    invalidate() { this.status = 'invalid'; this.options.onState({ status: 'invalid' }); }
  }
  const api = createWorkbench(win, { storageScope: 'test', Session });
  return { win, api, sessions, host: win.document.getElementById('host'), close() { api.unmount(); win.close(); } };
}

describe('native workbench UI', () => {
  it('opens any existing window without creating/moving panes and restores the same client on remount', async () => {
    const f = fixture();
    const view = await f.api.create({ serverId: 'dev', ...remote, title: '任务' });
    expect(f.win.Api.post).not.toHaveBeenCalled();
    await f.api.render('dev', view.id, { container: f.host });
    expect(f.host.querySelectorAll('.wb-window-terminal')).toHaveLength(1);
    expect(f.host.querySelector('.wb-pane-header,.wb-separator,.wb-pane-tabs')).toBeNull();
    expect(f.api.currentContext().paneId).toBe('%1');
    const first = f.sessions[0]; const terminal = f.host.querySelector('.wb-window-terminal');
    await f.api.render('dev', view.id, { container: f.host });
    expect(f.sessions).toHaveLength(1); expect(f.host.querySelector('.wb-window-terminal')).toBe(terminal);
    f.api.unmount(); expect(first.disposed).toBe(true);
    await f.api.render('dev', view.id, { container: f.host });
    expect(f.sessions[1].target.clientId).toBe(first.target.clientId);
    f.api.closeView(view.id); expect(f.win.Api.del).not.toHaveBeenCalled(); f.close();
  });
  it('takes tool context only from confirmed native focus and keeps same metadata updates stable', async () => {
    const f = fixture(); const view = await f.api.create({ serverId: 'dev', ...remote });
    await f.api.render('dev', view.id, { container: f.host });
    const old = f.api.currentContext();
    f.sessions[0].options.onState({ status: 'live' }); expect(f.api.currentContext().key).toBe(old.key);
    f.sessions[0].context = { ...f.sessions[0].target, paneId: '%2' };
    f.sessions[0].options.onContext(f.sessions[0].context);
    expect(f.api.currentContext().paneId).toBe('%2'); expect(f.api.currentContext().key).not.toBe(old.key);
    expect(old.source.paneId).toBe('%1');
    f.sessions[0].status = 'connecting'; f.sessions[0].options.onState({ status: 'connecting' });
    expect(f.api.currentContext().paneId).toBeNull(); f.close();
  });
  it('splits the actual remote pane and leaves layout/status rendering to tmux', async () => {
    const f = fixture(); const view = await f.api.create({ serverId: 'dev', ...remote });
    await f.api.render('dev', view.id, { container: f.host }); await f.api.split('vertical');
    expect(f.win.Api.post).toHaveBeenLastCalledWith('/n/dev/api/workspace/windows/%401/panes', { paneId: '%1', direction: 'vertical' });
    expect(f.sessions).toHaveLength(1); expect(f.api.get(view.id).windowId).toBe('@1'); f.close();
  });
  it('creates only one window using a persisted idempotency key and does not retry after restore', async () => {
    const f = fixture(); f.win.Api.post.mockRejectedValueOnce(new Error('network lost'));
    const view = await f.api.create({ serverId: 'dev', instanceId: remote.instanceId, sessionId: remote.sessionId });
    expect(view.windowId).toBeNull(); await f.api.render('dev', view.id, { container: f.host });
    expect(f.win.Api.post.mock.calls[0][1].requestId).toBe(f.win.Api.post.mock.calls[1][1].requestId);
    f.api.unmount(); await f.api.render('dev', view.id, { container: f.host });
    expect(f.win.Api.post).toHaveBeenCalledTimes(2); f.close();
  });
  it('keeps native input drawer and iOS keyboard focus exclusive', async () => {
    const f = fixture(); f.win.MobileUI.isMobile = () => true; let drawer;
    f.win.FabDrawer = { mount: (_node, options) => { drawer = options; return { setScene() {}, destroy() {} }; } };
    const view = await f.api.create({ serverId: 'dev', ...remote }); await f.api.render('dev', view.id, { container: f.host });
    f.host.querySelector('.fab-tool').click(); drawer.sendKey('\x02');
    expect(f.sessions[0].send).toHaveBeenCalledWith('\x02');
    expect(f.host.querySelector('.fab-drawer-mount').classList.contains('open')).toBe(true);
    f.host.querySelector('.mobile-terminal-keyboard').click();
    expect(f.win.document.activeElement).toBe(f.sessions[0].term.textarea);
    expect(f.host.querySelector('.fab-drawer-mount').classList.contains('open')).toBe(false); f.close();
  });
  it('does not mount after navigation or rebind a missing instance', async () => {
    const f = fixture(); const view = await f.api.create({ serverId: 'dev', ...remote }); let finish;
    f.win.Api.get.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const render = f.api.render('dev', view.id, { container: f.host }); f.api.unmount(); finish({ available: true, protocol: 1 }); await render;
    expect(f.sessions).toHaveLength(0); await f.api.render('dev', view.id, { container: f.host });
    f.api.reconcileWorkspace('dev', { complete: false, instanceId: 'new', sessions: [] }); expect(f.sessions[0].status).toBe('live');
    f.api.reconcileWorkspace('dev', { complete: true, instanceId: 'new', sessions: [] }); expect(f.sessions[0].status).toBe('invalid');
    expect(f.api.get(view.id).windowId).toBe('@1'); expect(f.win.Api.post).not.toHaveBeenCalled(); f.close();
  });  it('does not let a disposed mobile drawer send keys or focus a newer view', async () => {
    const f = fixture(); f.win.MobileUI.isMobile = () => true; const drawers = [];
    f.win.FabDrawer = { mount: (_node, options) => { drawers.push(options); return { setScene() {}, destroy() {} }; } };
    const first = await f.api.create({ serverId: 'dev', ...remote }); await f.api.render('dev', first.id, { container: f.host });
    f.host.querySelector('.fab-tool').click();
    const second = await f.api.create({ serverId: 'dev', ...remote }); await f.api.render('dev', second.id, { container: f.host });
    drawers[0].sendKey('stale input'); drawers[0].onKeyboard();
    expect(f.sessions[1].send).not.toHaveBeenCalled();
    expect(f.win.document.activeElement).not.toBe(f.sessions[1].term.textarea); f.close();
  });
  it('freshly verifies the native source and discards a reply after its view was left', async () => {
    const f = fixture(); const view = await f.api.create({ serverId: 'dev', ...remote }); await f.api.render('dev', view.id, { container: f.host });
    const initial = f.api.currentContext();
    f.sessions[0].requestContext = async () => { f.sessions[0].context = { ...f.sessions[0].context, paneId: '%8' }; f.sessions[0].options.onContext(f.sessions[0].context); return f.sessions[0].context; };
    const fresh = await f.api.focusedContext(); expect(fresh.paneId).toBe('%8'); expect(fresh.focusRequestKey).toBe(initial.key);
    let finish; f.sessions[0].requestContext = () => new Promise((resolve) => { finish = resolve; });
    const pending = f.api.focusedContext(); const rejected = expect(pending).rejects.toThrow('工作台');
    f.api.unmount(); finish({ paneId: '%8' }); await rejected; f.close();
  });
  it('shares the existing desktop and mobile header without a second terminal toolbar or remount', async () => {
    const f = fixture();
    f.win.document.body.insertAdjacentHTML('afterbegin', '<header id="ms-topbar"><div id="ms-top-actions"></div></header><header class="mobile-header" id="ms-native-mobile-header"><div id="ms-mobile-tools" aria-hidden="true"></div></header>');
    const view = await f.api.create({ serverId: 'dev', ...remote }); await f.api.render('dev', view.id, { container: f.host });
    const actions = f.win.document.querySelector('.wb-toolbar-actions'); expect(actions.parentNode.id).toBe('ms-top-actions');
    f.win.MobileUI.isMobile = () => true; f.win.dispatchEvent(new f.win.Event('resize'));
    expect(actions.parentNode.id).toBe('ms-native-mobile-header'); expect(f.host.querySelector('.wb-toolbar').hidden).toBe(true);
    expect(f.sessions).toHaveLength(1); f.api.unmount(); expect(actions.isConnected).toBe(false); f.close();
  });

});
