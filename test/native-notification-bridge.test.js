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
