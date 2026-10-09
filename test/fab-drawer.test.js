import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const sceneSource = readFileSync('public/js/fab-scene.js', 'utf8');
const heatSource = readFileSync('public/js/fab-heat.js', 'utf8');
const drawerSource = readFileSync('public/js/fab-drawer.js', 'utf8');
const terminalSource = readFileSync('public/js/terminal.js', 'utf8');
let dom;

function boot() {
  dom = new JSDOM('<div class="terminal-view" id="host"></div>', {
    url: 'http://localhost/', runScripts: 'outside-only',
  });
  const win = dom.window;
  win.innerWidth = 375;
  // Existing users have already run discovery and heat seeding.
  win.localStorage.setItem('fab-discover-v1', '1');
  win.localStorage.setItem('fab-builtin-seeded-v1', '1');
  win.eval(sceneSource);
  win.eval(heatSource);
  win.eval(drawerSource);
  return win;
}

function button(win, label, selector = '.fab-drawer-btn') {
  const found = Array.from(win.document.querySelectorAll(selector))
    .find(el => el.firstChild.textContent === label);
  expect(found, label).toBeDefined();
  return found;
}

afterEach(() => dom?.window.close());

describe('Codex mobile drawer', () => {
  it('selects the active pane in the multi-server shell and sends real input frames', () => {
    const win = boot();
    const send = vi.fn();
    win.state = { currentPane: '%1', panes: [{ id: '%1', command: 'codex' }, { id: '%2', command: 'nvim' }] };
    win.terminalState = { ws: { readyState: 1, send } };
    // Pane ids can overlap across servers: current pane data must take priority.
    win._paneSceneMap = { '%1': 'claude' };
    win._syncTerminalSize = vi.fn();
    const fabCode = terminalSource.slice(terminalSource.indexOf('function _sendTermData'), terminalSource.indexOf('// === Terminal State ==='));
    win.eval(fabCode);
    const host = win.document.getElementById('host');
    win._createFabPanel(host);
    const open = () => host.querySelector('.fab-tool').dispatchEvent(new win.Event('touchend'));
    open();
    expect(win._fabDrawerInstance.getState().currentScene).toBe('codex');

    for (const [label, data] of [['Tab 排队', '\t'], ['C-r 历史', '\x12'], ['C-o 复制', '\x0f'], ['C-g 编辑', '\x07']]) {
      button(win, label).click();
      expect(send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'input', data }));
    }
    expect(win.document.querySelector('.fab-drawer-mount.open')).not.toBeNull();

    button(win, 'Shift+←').click();
    expect(send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'input', data: '\x1b[1;2D' }));
    expect(host.textContent).not.toContain('Shift+→');
    button(win, '按键', '.fab-drawer-tab').click();
    button(win, 'Shift+←').click();
    expect(send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'input', data: '\x1b[1;2D' }));
    expect(host.textContent).not.toContain('Shift+→');

    host.querySelector('.fab-drawer-close').click();
    win.state.currentPane = '%2';
    open();
    expect(win._fabDrawerInstance.getState().currentScene).toBe('vim');
    host.querySelector('.fab-drawer-close').click();
    win.state.currentPane = '%1';
    win.state.panes[0].command = 'zsh';
    open();
    expect(win._fabDrawerInstance.getState().currentScene).toBe('terminal');
  });

  it('submits slash commands and inserts prefixes without submitting', () => {
    const win = boot();
    const send = vi.fn();
    const api = win.FabDrawer.mount(win.document.getElementById('host'), { sendKey: send });
    api.setScene('codex');
    button(win, 'Slash', '.fab-drawer-tab').click();
    button(win, '/model').click();
    expect(send).toHaveBeenLastCalledWith('/model\r');
    button(win, '/compact').click();
    expect(send).toHaveBeenLastCalledWith('/compact\r');
    button(win, '按键', '.fab-drawer-tab').click();
    button(win, '@ 文件').click();
    expect(send).toHaveBeenLastCalledWith('@');
    button(win, '! 命令').click();
    expect(send).toHaveBeenLastCalledWith('!');
    win.document.querySelector('.scene-inline').click();
    expect(win.document.querySelector('.fab-override-menu').textContent).toContain('Codex');
  });

  it('inherits Codex fixtures and reachable tabs into a persistent custom scene', () => {
    const win = boot();
    const api = win.FabDrawer.mount(win.document.getElementById('host'));
    win.document.querySelector('.scene-inline').click();
    win.document.querySelector('.mitem.add').click();
    const form = win.document.querySelector('.fab-form-modal');
    form.querySelector('input').value = 'My Codex';
    const selects = form.querySelectorAll('select');
    selects[0].value = 'codex-set';
    selects[1].value = 'codex';
    form.querySelector('.save').click();

    expect(api.getState().currentScene).toMatch(/^custom-/);
    expect(win.FabScene.loadScenes().find(s => s.id === api.getState().currentScene).name).toBe('My Codex');
    expect(win.FabScene.loadScenes().find(s => s.id === 'codex').builtin).toBe(true);
    button(win, 'C-r 历史');
    button(win, 'Slash', '.fab-drawer-tab').click();
    button(win, '/model');
    button(win, '模板', '.fab-drawer-tab').click();
    button(win, '运行相关测试并修复失败项');
  });
});
