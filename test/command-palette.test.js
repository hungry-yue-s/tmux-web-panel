import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const source = readFileSync('public/js/command-palette.js', 'utf8');
const router = readFileSync('public/js/router.js', 'utf8');
const store = readFileSync('public/js/store.js', 'utf8');
let dom;
afterEach(() => dom?.window.close());

function setup() {
  dom = new JSDOM('<button id="opener">快速切换</button><button id="outside">外部</button>', {
    url: 'https://palette.test/', runScripts: 'outside-only',
  });
  const win = dom.window;
  win.fetch = vi.fn(() => { throw new Error('Palette must not fetch'); });
  win.api = { get: vi.fn(() => { throw new Error('Palette must not fetch'); }) };
  win.eval(source);
  return { win, doc: win.document, palette: win.CommandPalette };
}

function key(win, element, value, extra = {}) {
  element.dispatchEvent(new win.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...extra }));
}

function search(win, doc, value) {
  const input = doc.querySelector('[role="combobox"]');
  input.value = value;
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  return input;
}

describe('command palette destinations and focus', () => {
  it('provides mobile result hierarchy, a touch cancel action and a keyboard-accessible clear action', () => {
    const { win, doc, palette } = setup();
    win.MobileUI = { isMobile: () => true };
    win.eval(router); win.eval(store);
    win.Store.setServers([{ id: 'local', name: '本机' }]);
    win.Store.setWorkspace('local', { sessions: [{ id: '$0', name: '产品开发', windows: [
      { id: '@1', name: '构建任务', panes: [{ id: '%1', command: 'npm' }] },
    ] }] });
    palette.open(doc.getElementById('opener'));
    expect(doc.querySelector('.cmd-palette-is-mobile')).not.toBeNull();
    expect(doc.querySelector('.cmd-palette-close').textContent).toBe('取消');
    expect(doc.querySelector('.cmd-palette-footer').textContent).not.toContain('Esc');
    const input = search(win, doc, '构建');
    expect(doc.querySelector('.cmd-palette-item-name').textContent).toBe('构建任务');
    expect(doc.querySelector('.cmd-palette-item-meta').textContent).toContain('本机 / 产品开发');
    expect(doc.querySelector('.cmd-palette-item-kind').textContent).toBe('窗口');
    key(win, input, 'Tab');
    expect(doc.activeElement).toBe(doc.querySelector('.cmd-palette-clear'));
    key(win, doc.activeElement, 'Tab');
    expect(doc.activeElement).toBe(doc.querySelector('.cmd-palette-close'));
    doc.querySelector('.cmd-palette-clear').click();
    expect(input.value).toBe('');
    expect(doc.activeElement).toBe(input);
    expect(doc.querySelector('.cmd-palette-clear').hidden).toBe(true);
    doc.querySelector('.cmd-palette-close').click();
    expect(palette.isOpen()).toBe(false);
  });

  it('searches cached cross-server windows, ranks live recents, navigates stable IDs and traps/restores focus', () => {
    const { win, doc, palette } = setup();
    win.eval(router);
    win.eval(store);
    win.Store.setServers([{ id: 'local', name: '本机' }, { id: 'ssh-prod', name: '开发服务器' }]);
    for (const [id, windows] of [
      ['local', [{ id: '@1', index: 0, name: '工作区', panes: [{ id: '%1', command: 'zsh' }] }]],
      ['ssh-prod', [
        { id: '@1', index: 0, name: '接口服务', panes: [{ id: '%1', command: 'node' }, { id: '%2', command: 'npm', active: true }] },
        { id: '@2', index: 1, name: '<部署>', panes: [{ id: '%3', command: '<script>' }] },
      ]],
    ]) win.Store.setWorkspace(id, { serverId: id, sessions: [{ id: '$1', name: '产品开发', windows }] });
    win.Store.setRoute({ name: 'terminal', params: { serverId: 'ssh-prod' } });
    win.AppShell = {
      recentTargets: () => [{ serverId: 'ssh-prod', windowId: '@2' }, { serverId: 'gone', windowId: '@9' }],
      icon: () => '<svg class="ms-icon" viewBox="0 0 24 24"><path d="M1 1h2"/></svg>',
    };
    win.state = { sessions: [{ name: '旧数据', windowDetails: [{ index: 0, name: '不应出现' }] }] };
    const go = vi.spyOn(win.Router, 'go');
    const opener = doc.getElementById('opener');
    opener.focus();
    palette.open(opener);
    const input = doc.querySelector('[role="combobox"]');
    expect(doc.activeElement).toBe(input);
    expect(doc.querySelector('[role="dialog"]').getAttribute('aria-modal')).toBe('true');
    expect(doc.querySelector('[role="option"]').textContent).toContain('<部署>');
    expect(doc.querySelector('script')).toBeNull();
    expect(doc.body.textContent).not.toContain('旧数据');
    expect(doc.body.textContent).not.toContain('gone');
    expect(input.getAttribute('aria-controls')).toBe(doc.querySelector('[role="listbox"]').id);
    const firstId = input.getAttribute('aria-activedescendant');
    key(win, input, 'ArrowDown');
    expect(input.getAttribute('aria-activedescendant')).not.toBe(firstId);
    key(win, input, 'ArrowUp');
    expect(input.getAttribute('aria-activedescendant')).toBe(firstId);
    key(win, input, 'Tab');
    expect(doc.activeElement).toBe(doc.querySelector('.cmd-palette-close'));
    key(win, doc.activeElement, 'Tab');
    expect(doc.activeElement).toBe(input);
    key(win, input, 'Tab', { shiftKey: true });
    expect(doc.activeElement).toBe(doc.querySelector('.cmd-palette-close'));
    doc.getElementById('outside').focus();
    expect(doc.activeElement).toBe(input);
    search(win, doc, '不存在的目的地');
    expect(doc.querySelectorAll('[role="option"]')).toHaveLength(0);
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
    expect(doc.querySelector('[role="status"]').textContent).toContain('没有匹配');
    key(win, input, 'Enter');
    expect(go).not.toHaveBeenCalled();
    search(win, doc, '开发服务器 接口');
    expect(doc.querySelectorAll('[role="option"]')).toHaveLength(1);
    key(win, input, 'Enter', { isComposing: true });
    expect(go).not.toHaveBeenCalled();
    const focus = vi.spyOn(opener, 'focus');
    key(win, input, 'Enter');
    expect(go).toHaveBeenCalledWith({ name: 'terminal', params: {
      serverId: 'ssh-prod', sessionId: '$1', windowId: '@1', paneId: '%2',
    } });
    expect(win.location.hash).toBe('#/terminal/ssh-prod/%241/%401/%252');
    expect(doc.querySelector('[role="dialog"]')).toBeNull();
    expect(focus).not.toHaveBeenCalled();
    palette.open(opener);
    key(win, doc.querySelector('input'), 'Escape');
    expect(doc.activeElement).toBe(opener);
    expect(focus).toHaveBeenCalledOnce();
    palette.open(opener);
    opener.remove();
    palette.close();
    expect(focus).toHaveBeenCalledOnce();
    palette.open();
    search(win, doc, '状态');
    key(win, doc.querySelector('input'), 'Enter');
    expect(go).toHaveBeenLastCalledWith({ name: 'server', params: { serverId: 'ssh-prod', section: 'performance' } });
    expect(win.fetch).not.toHaveBeenCalled();
    expect(win.api.get).not.toHaveBeenCalled();
  });

  it('dismisses transient preview before navigation even when the router stays on the same route', () => {
    const { win, doc, palette } = setup();
    win.eval(router);
    const closeModal = vi.fn(); win.FilePreview = { closeModal };
    const go = vi.spyOn(win.Router, 'go').mockImplementation(() => {});
    palette.open(doc.getElementById('opener'));
    expect(palette.isOpen()).toBe(true);
    key(win, search(win, doc, '设置'), 'Enter');
    expect(closeModal).toHaveBeenCalledOnce();
    expect(go).toHaveBeenCalledOnce();
    expect(closeModal.mock.invocationCallOrder[0]).toBeLessThan(go.mock.invocationCallOrder[0]);
    expect(palette.isOpen()).toBe(false);
  });

  it('keeps the legacy public API and navigates cached pane IDs without a network request', () => {
    const { win, doc, palette } = setup();
    win.state = { sessions: [{ name: '中文会话', windowDetails: [{ index: 2, name: '日志窗口', panes: [{ id: '%8', command: 'tail' }] }] }] };
    win.navigate = vi.fn();
    doc.getElementById('opener').focus();
    palette.open();
    key(win, search(win, doc, '中文 日志'), 'Enter');
    expect(win.navigate).toHaveBeenCalledWith('terminal', { currentSession: '中文会话', currentWindow: 2, currentPane: '%8' });
    expect(win.fetch).not.toHaveBeenCalled();
    expect(win.api.get).not.toHaveBeenCalled();
    palette.open();
    doc.querySelector('.cmd-palette-overlay').click();
    expect(doc.querySelector('.cmd-palette-overlay')).toBeNull();
    palette.close();
  });
});
