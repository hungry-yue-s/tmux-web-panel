import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const source = readFileSync('public/js/notifications.js', 'utf8');
let dom;

function setup(state) {
  dom = new JSDOM(
    '<!doctype html><html><body><span class="notification-bell-count"></span></body></html>',
    { runScripts: 'outside-only' },
  );
  const postMessage = vi.fn();
  dom.window.api = {
    get: vi.fn(() => Promise.resolve({ success: true, data: [] })),
    post: vi.fn(() => Promise.resolve({ success: true })),
    delete: vi.fn(() => Promise.resolve({ success: true })),
  };
  dom.window.state = state;
  dom.window.webkit = {
    messageHandlers: {
      tmuxPanelNotification: { postMessage },
    },
  };
  dom.window.eval(source);
  return { postMessage, panel: dom.window.NotificationPanel };
}

afterEach(() => {
  if (dom) dom.window.close();
  dom = null;
});

describe('macOS native notification bridge', () => {
  it('forwards a new background-window notification once', () => {
    const { postMessage, panel } = setup({
      currentTab: 'windows',
      currentSession: 'work',
      currentWindow: '1',
    });
    const notification = {
      id: 'notice-1',
      session: 'work',
      windowIndex: 2,
      windowName: 'build',
      command: 'npm test',
    };

    panel.handleServerPush([notification]);
    panel.handleServerPush([notification]);

    expect(postMessage).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith({
      id: 'notice-1',
      session: 'work',
      windowIndex: '2',
      windowName: 'build',
      command: 'npm test',
    });
  });

  it('does not notify natively for the window already being viewed', () => {
    const { postMessage, panel } = setup({
      currentTab: 'terminal',
      currentSession: 'work',
      currentWindow: '2',
    });

    panel.handleServerPush([{
      id: 'notice-2',
      session: 'work',
      windowIndex: 2,
      windowName: 'build',
      command: 'npm test',
    }]);

    expect(postMessage).not.toHaveBeenCalled();
    expect(dom.window.api.post).toHaveBeenCalledWith('/api/notifications/notice-2/read');
  });

  it('keeps browser-only notification handling functional', () => {
    const { panel } = setup({ currentTab: 'windows' });
    delete dom.window.webkit;

    expect(() => panel.handleServerPush([{
      id: 'notice-3',
      session: 'work',
      windowIndex: 3,
      command: 'done',
    }])).not.toThrow();
    expect(panel.unreadCount()).toBe(1);
  });
});

describe('sidebar notification breathing attention', () => {
  function seedTree() {
    const group = dom.window.document.createElement('div');
    group.className = 'tree-session-group';
    group.innerHTML = '<div class="tree-session-row" data-entity-name="work"></div>'
      + '<div class="tree-window-list">'
      + '<div class="tree-window-row" data-window-index="2"></div>'
      + '<div class="tree-window-row" data-window-index="3"></div>'
      + '</div>';
    dom.window.document.body.appendChild(group);
    return group;
  }

  it('breathes the emitting window row while the session is expanded', () => {
    const { panel } = setup({ currentTab: 'windows' });
    const group = seedTree();

    panel.handleServerPush([{ id: 'n1', session: 'work', windowIndex: 2, command: 'done' }]);

    const rows = group.querySelectorAll('.tree-window-row');
    expect(rows[0].classList.contains('notify-breathe')).toBe(true);
    expect(rows[1].classList.contains('notify-breathe')).toBe(false);
    expect(group.querySelector('.tree-session-row').classList.contains('notify-breathe')).toBe(false);
  });

  it('breathes the session row when the session is collapsed', () => {
    const { panel } = setup({ currentTab: 'windows' });
    const group = seedTree();
    panel.handleServerPush([{ id: 'n1', session: 'work', windowIndex: 2, command: 'done' }]);

    group.querySelector('.tree-window-list').remove();
    panel.syncAttention();

    expect(group.querySelector('.tree-session-row').classList.contains('notify-breathe')).toBe(true);
  });

  it('clears the breathing once the window is marked read', () => {
    const { panel } = setup({ currentTab: 'windows' });
    const group = seedTree();
    panel.handleServerPush([{ id: 'n1', session: 'work', windowIndex: 2, command: 'done' }]);
    expect(group.querySelectorAll('.notify-breathe')).toHaveLength(1);

    panel._markReadByWindow('work', 2);
    expect(group.querySelectorAll('.notify-breathe')).toHaveLength(0);
  });
});
