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
    const open = () => host.querySelector('.fab-tool').click();
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

describe('mobile input deck', () => {
  function start() {
    const win = boot();
    const send = vi.fn();
    const dock = win.document.createElement('nav');
    dock.className = 'mobile-dock';
    win.document.body.appendChild(dock);
    const textarea = win.document.createElement('textarea');
    textarea.className = 'xterm-helper-textarea';
    win.document.getElementById('host').appendChild(textarea);
    win.state = { currentPane: '%1', panes: [{ id: '%1', command: 'zsh' }] };
    win.terminalState = { ws: { readyState: 1, send, close: vi.fn() } };
    win._syncTerminalSize = vi.fn();
    const fabCode = terminalSource.slice(terminalSource.indexOf('function _sendTermData'), terminalSource.indexOf('// === Terminal State ==='));
    win.eval(fabCode);
    win.eval(terminalSource.slice(terminalSource.indexOf('function _cleanupTerminalResources('), terminalSource.indexOf('function cleanupTerminal()')));
    const host = win.document.getElementById('host');
    win.terminalState._mobileControlsCleanup = win._createFabPanel(host);
    return { win, host, textarea, send };
  }

  it('keeps semantic input controls in the layout and focuses the keyboard during the click', () => {
    const { win, host, textarea, send } = start();
    const deck = host.querySelector('.mobile-terminal-controls');
    expect(deck.getAttribute('role')).toBe('toolbar');
    expect(host.querySelector('.fab-tool').tagName).toBe('BUTTON');
    deck.querySelector('[data-terminal-key="esc"]').click();
    expect(send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'input', data: '\x1b' }));
    deck.querySelector('[data-terminal-key="tab"]').click();
    expect(send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'input', data: '\t' }));
    expect(win.document.activeElement).not.toBe(textarea);

    const focus = vi.fn(() => textarea.focus());
    win.terminalState.term = { focus, dispose: vi.fn() };
    deck.querySelector('.mobile-terminal-keyboard').click();
    // No timer or promise may move this out of iOS's trusted user gesture.
    expect(focus).toHaveBeenCalledOnce();
    expect(win.document.activeElement).toBe(textarea);
    expect(host.querySelector('.fab-drawer-mount')).toBeNull();
  });

  it('keeps key taps open, blurs the keyboard on opening, and closes only on terminal focus or explicit controls', () => {
    const { win, host, textarea, send } = start();
    win.terminalState.term = { focus: () => textarea.focus(), dispose: vi.fn() };
    const tools = host.querySelector('.fab-tool');
    textarea.focus();
    tools.click();
    expect(win.document.activeElement).not.toBe(textarea);
    expect(tools.getAttribute('aria-expanded')).toBe('true');
    expect(host.classList.contains('drawer-pushed')).toBe(true);
    const mount = host.querySelector('.fab-drawer-mount');
    expect(mount.inert).toBe(false);
    expect(win.document.querySelector('.mobile-dock').inert).toBe(true);
    expect(win.document.documentElement.classList.contains('mobile-tools-open')).toBe(true);
    expect(mount.getAttribute('aria-hidden')).toBe('false');
    expect(mount.querySelector('.scene-inline').tagName).toBe('BUTTON');
    button(win, '↑').click();
    expect(send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'input', data: '\x1b[A' }));
    expect(mount.classList.contains('open')).toBe(true);
    expect(win.document.activeElement).not.toBe(textarea);

    mount.querySelector('.fab-drawer-kbd-btn').click();
    expect(win.document.activeElement).toBe(textarea);
    expect(mount.classList.contains('open')).toBe(false);
    expect(mount.inert).toBe(true);
    expect(win.document.querySelector('.mobile-dock').inert).toBe(false);
    tools.click();
    textarea.focus();
    expect(mount.classList.contains('open')).toBe(false);
    expect(tools.getAttribute('aria-expanded')).toBe('false');
    tools.click();
    const close = mount.querySelector('.fab-drawer-close');
    close.focus();
    close.click();
    expect(win.document.activeElement).toBe(tools);
  });

  it('destroys any shortcut editor when leaving its terminal', () => {
    const { win, host } = start();
    host.querySelector('.fab-tool').click();
    host.querySelector('.scene-inline').click();
    host.querySelector('.mitem.add').click();
    expect(win.document.querySelector('.fab-form-overlay')).not.toBeNull();
    win._cleanupTerminalResources();
    expect(win.document.querySelector('.fab-form-overlay')).toBeNull();
  });

  it('preserves the deck across pane reconnection and destroys it when leaving the terminal', () => {
    const { win, host } = start();
    host.querySelector('.fab-tool').click();
    const deck = host.querySelector('.mobile-terminal-controls');
    const instance = win._fabDrawerInstance;
    win._cleanupTerminalResources(true);
    expect(host.querySelector('.mobile-terminal-controls')).toBe(deck);
    expect(win._fabDrawerInstance).toBe(instance);
    win._cleanupTerminalResources();
    expect(host.querySelector('.mobile-terminal-controls')).toBeNull();
    expect(host.querySelector('.fab-drawer-mount')).toBeNull();
    expect(host.querySelector('input[type="file"]')).toBeNull();
    expect(host.classList.contains('drawer-pushed')).toBe(false);
    expect(win._fabDrawerInstance).toBeNull();
    expect(win.document.querySelector('.mobile-dock').inert).toBe(false);
    expect(win.document.documentElement.classList.contains('mobile-tools-open')).toBe(false);
    expect(win.terminalState._mobileControlsCleanup).toBeNull();
  });
});
