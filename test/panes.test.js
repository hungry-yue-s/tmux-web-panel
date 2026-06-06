import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { JSDOM } from 'jsdom';
import { resolve } from 'path';

const panesScript = readFileSync(
  resolve(import.meta.dirname, '../public/js/panes.js'),
  'utf-8'
);

function createEnv() {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="c"></div></body></html>', {
    runScripts: 'dangerously',
  });
  // Provide escapeHtml global
  dom.window.eval(`
    function escapeHtml(s) {
      var d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }
  `);
  dom.window.eval(panesScript);
  return dom;
}

const samplePanes = [
  { id: 10, index: 0, command: 'zsh', width: 80, height: 24, top: 0, left: 0 },
  { id: 11, index: 1, command: 'vim', width: 40, height: 24, top: 0, left: 80 },
];

describe('renderPaneLayout', () => {
  let dom, container;

  beforeEach(() => {
    dom = createEnv();
    container = dom.window.document.getElementById('c');
  });

  it('renders a .pane-layout container with pane boxes', () => {
    dom.window.renderPaneLayout(container, samplePanes, null, null);
    const layout = container.querySelector('.pane-layout');
    expect(layout).not.toBeNull();
    const boxes = layout.querySelectorAll('.pane-box');
    expect(boxes.length).toBe(2);
  });

  it('marks active pane with .active class', () => {
    dom.window.renderPaneLayout(container, samplePanes, 11, null);
    const boxes = container.querySelectorAll('.pane-box');
    expect(boxes[0].classList.contains('active')).toBe(false);
    expect(boxes[1].classList.contains('active')).toBe(true);
  });

  it('calculates correct percentage positions', () => {
    dom.window.renderPaneLayout(container, samplePanes, null, null);
    const boxes = container.querySelectorAll('.pane-box');
    // Pane 0: left=0, width=80/120=66.67%
    // jsdom normalizes 0.00% to 0%, so use parseFloat for comparison
    expect(parseFloat(boxes[0].style.left)).toBeCloseTo(0, 1);
    expect(parseFloat(boxes[0].style.width)).toBeCloseTo(66.67, 1);
    // Pane 1: left=80/120=66.67%, width=40/120=33.33%
    expect(parseFloat(boxes[1].style.left)).toBeCloseTo(66.67, 1);
    expect(parseFloat(boxes[1].style.width)).toBeCloseTo(33.33, 1);
  });

  it('calls onPaneClick with correct pane id', () => {
    const onClick = vi.fn();
    dom.window.renderPaneLayout(container, samplePanes, null, onClick);
    const boxes = container.querySelectorAll('.pane-box');
    boxes[1].click();
    expect(onClick).toHaveBeenCalledWith(11);
  });

  it('shows pane index and command in each box', () => {
    dom.window.renderPaneLayout(container, samplePanes, null, null);
    const boxes = container.querySelectorAll('.pane-box');
    expect(boxes[0].querySelector('.pane-box-index').textContent).toBe('P0');
    expect(boxes[0].querySelector('.pane-box-cmd').textContent).toBe('zsh');
    expect(boxes[1].querySelector('.pane-box-index').textContent).toBe('P1');
    expect(boxes[1].querySelector('.pane-box-cmd').textContent).toBe('vim');
  });

  it('handles empty panes array', () => {
    dom.window.renderPaneLayout(container, [], null, null);
    expect(container.querySelector('.pane-layout')).toBeNull();
    expect(container.textContent).toContain('No panes');
  });

  it('handles null panes', () => {
    dom.window.renderPaneLayout(container, null, null, null);
    expect(container.querySelector('.pane-layout')).toBeNull();
  });

  it('sets title attribute with pane details', () => {
    dom.window.renderPaneLayout(container, samplePanes, null, null);
    const boxes = container.querySelectorAll('.pane-box');
    expect(boxes[0].getAttribute('title')).toBe('Pane 0: zsh (80x24)');
    expect(boxes[1].getAttribute('title')).toBe('Pane 1: vim (40x24)');
  });
});

describe('renderPanePills', () => {
  let dom, container;

  beforeEach(() => {
    dom = createEnv();
    container = dom.window.document.getElementById('c');
  });

  it('renders a .pane-pills container with pill buttons', () => {
    dom.window.renderPanePills(container, samplePanes, null, null);
    const pills = container.querySelector('.pane-pills');
    expect(pills).not.toBeNull();
    expect(pills.querySelectorAll('.pane-pill').length).toBe(2);
  });

  it('marks active pill with .active class', () => {
    dom.window.renderPanePills(container, samplePanes, 10, null);
    const pills = container.querySelectorAll('.pane-pill');
    expect(pills[0].classList.contains('active')).toBe(true);
    expect(pills[1].classList.contains('active')).toBe(false);
  });

  it('shows pane index in pill text', () => {
    dom.window.renderPanePills(container, samplePanes, null, null);
    const pills = container.querySelectorAll('.pane-pill');
    expect(pills[0].textContent).toBe('0');
    expect(pills[1].textContent).toBe('1');
  });

  it('calls onPaneClick with correct pane id', () => {
    const onClick = vi.fn();
    dom.window.renderPanePills(container, samplePanes, null, onClick);
    const pills = container.querySelectorAll('.pane-pill');
    pills[0].click();
    expect(onClick).toHaveBeenCalledWith(10);
  });

  it('handles empty panes', () => {
    dom.window.renderPanePills(container, [], null, null);
    expect(container.querySelector('.pane-pills')).toBeNull();
  });

  it('handles null panes', () => {
    dom.window.renderPanePills(container, null, null, null);
    expect(container.querySelector('.pane-pills')).toBeNull();
  });
});

describe('pane context menu (label)', () => {
  let dom, container;
  beforeEach(() => {
    dom = createEnv();
    container = dom.window.document.getElementById('c');
  });

  function rightClick(el) {
    el.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
  }

  it('opens a menu with 设置标签 (+ 关闭窗格 when >1 pane) on right-click', () => {
    dom.window.renderPanePills(container, samplePanes, null, null);
    rightClick(container.querySelector('.pane-pill'));
    const menu = dom.window.document.querySelector('.pane-context-menu');
    expect(menu).not.toBeNull();
    const actions = Array.from(menu.querySelectorAll('.context-menu-item')).map((i) => i.getAttribute('data-action'));
    expect(actions).toContain('label');
    expect(actions).toContain('close');
  });

  it('omits 关闭窗格 with a single pane', () => {
    dom.window.renderPanePills(container, [samplePanes[0]], null, null);
    rightClick(container.querySelector('.pane-pill'));
    const actions = Array.from(
      dom.window.document.querySelectorAll('.pane-context-menu .context-menu-item')
    ).map((i) => i.getAttribute('data-action'));
    expect(actions).toContain('label');
    expect(actions).not.toContain('close');
  });

  it('clicking 设置标签 PUTs the trimmed label and updates the pane in memory', async () => {
    let putArgs = null;
    dom.window.api = { put: (url, body) => { putArgs = { url, body }; return Promise.resolve({ success: true }); } };
    dom.window.showPrompt = () => Promise.resolve('  构建  ');
    dom.window.showAlert = () => {};
    const panes = [{ id: 10, index: 0, command: 'zsh', label: '' }];
    dom.window.renderPanePills(container, panes, null, null);
    rightClick(container.querySelector('.pane-pill'));
    dom.window.document
      .querySelector('.pane-context-menu .context-menu-item[data-action="label"]')
      .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(putArgs.url).toContain('/api/panes/');
    expect(putArgs.url).toContain('/label');
    expect(putArgs.body).toEqual({ label: '构建' });
    expect(panes[0].label).toBe('构建'); // in-memory sync so re-open prefills new value
  });
});

describe('_promptSetPaneLabelById (header button entry)', () => {
  let dom;
  beforeEach(() => { dom = createEnv(); });

  it('prefills the current label from state.panes and PUTs the new one', async () => {
    let putArgs = null;
    let promptVal = null;
    dom.window.state = { panes: [{ id: '%5', label: '旧' }] };
    dom.window.api = { put: (url, body) => { putArgs = { url, body }; return Promise.resolve({}); } };
    dom.window.showPrompt = (opts) => { promptVal = opts.value; return Promise.resolve('前端'); };
    dom.window.showAlert = () => {};
    dom.window._promptSetPaneLabelById('%5');
    await new Promise((r) => setTimeout(r, 0));
    expect(promptVal).toBe('旧');
    expect(putArgs.url).toContain(encodeURIComponent('%5'));
    expect(putArgs.body).toEqual({ label: '前端' });
    expect(dom.window.state.panes[0].label).toBe('前端'); // in-memory sync
  });

  it('falls back to empty label when the pane is not in state.panes', async () => {
    let promptVal = '__unset__';
    dom.window.state = { panes: [] };
    dom.window.api = { put: () => Promise.resolve({}) };
    dom.window.showPrompt = (opts) => { promptVal = opts.value; return Promise.resolve(null); };
    dom.window._promptSetPaneLabelById('%9');
    await new Promise((r) => setTimeout(r, 0));
    expect(promptVal).toBe('');
  });

  it('does nothing without a pane id', () => {
    let called = false;
    dom.window.state = { panes: [] };
    dom.window.showPrompt = () => { called = true; return Promise.resolve(null); };
    dom.window._promptSetPaneLabelById(null);
    expect(called).toBe(false);
  });
});
