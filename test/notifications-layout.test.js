import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const source = readFileSync('public/js/notifications.js', 'utf8');
let dom;

afterEach(() => {
  dom?.window.close();
  dom = null;
});

describe('notification viewport layout', () => {
  it('anchors delegated desktop clicks to the actual toolbar and keeps clear-all clickable after rerender', async () => {
    dom = new JSDOM('<button class="notification-bell" hidden></button><button class="workspace-notification" data-action="notifications">通知</button>', {
      url: 'https://panel.example/', runScripts: 'outside-only',
    });
    const win = dom.window;
    const bell = win.document.querySelector('.workspace-notification');
    bell.getBoundingClientRect = () => ({ left: 980, right: 1008, top: 8, bottom: 36, width: 28, height: 28 });
    win.api = { post: vi.fn(async () => ({})), delete: vi.fn(async () => ({})) };
    win.eval(source);
    win.NotificationPanel.handleServerPush([{ id: 'n1', session: 'work', windowIndex: 1, timestamp: Date.now() }]);
    win.NotificationPanel.render({ currentTarget: win.document, stopPropagation: vi.fn() }, bell);
    const panel = win.document.getElementById('notification-panel');
    expect(panel.style.top).toBe('40px');
    expect(parseFloat(panel.style.left) + 360).toBeLessThanOrEqual(win.innerWidth - 12);
    await new Promise(resolve => win.setTimeout(resolve, 15));
    panel.querySelector('.notification-clear-btn').click();
    expect(win.api.delete).toHaveBeenCalledExactlyOnceWith('/api/notifications');
    expect(win.NotificationPanel.unreadCount()).toBe(0);
    expect(panel.isConnected).toBe(true);
    expect(panel.textContent).toContain('暂无通知');
    win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape' }));
    expect(panel.isConnected).toBe(false);
    expect(bell.getAttribute('aria-expanded')).toBe('false');
    expect(win.document.activeElement).toBe(bell);
  });

  it('uses a visible modern bell for shortcut opens and closes listeners on a rapid toggle', async () => {
    dom = new JSDOM('<button class="notification-bell" hidden></button><button class="workspace-notification"></button>', {
      url: 'https://panel.example/', runScripts: 'outside-only',
    });
    const win = dom.window;
    const bell = win.document.querySelector('.workspace-notification');
    bell.getClientRects = () => [{}];
    bell.getBoundingClientRect = () => ({ left: 900, top: 8, bottom: 36 });
    win.eval(source);
    win.NotificationPanel.render();
    expect(win.document.getElementById('notification-panel').style.top).toBe('40px');
    win.NotificationPanel.render();
    await new Promise(resolve => win.setTimeout(resolve, 15));
    expect(win.document.getElementById('notification-panel')).toBeNull();
    expect(() => win.document.body.click()).not.toThrow();
  });

  it.each([
    { width: 844, mobile: true, sheet: true },
    { width: 844, mobile: false, sheet: false },
    { width: 375, mobile: undefined, sheet: true },
    { width: 1024, mobile: undefined, sheet: false },
  ])('uses the shared viewport decision at $width px (MobileUI=$mobile)', ({ width, mobile, sheet }) => {
    dom = new JSDOM('<div id="sidebar" hidden><button class="notification-bell"></button></div><button id="visible-bell" class="notification-bell"></button>', {
      url: 'https://panel.example/', runScripts: 'outside-only',
    });
    const win = dom.window;
    win.innerWidth = width;
    if (mobile !== undefined) win.MobileUI = { isMobile: vi.fn(() => mobile) };
    const hiddenBell = win.document.querySelector('#sidebar .notification-bell');
    hiddenBell.getBoundingClientRect = vi.fn(() => ({ left: 0, bottom: 0 }));
    const visibleBell = win.document.getElementById('visible-bell');
    visibleBell.getBoundingClientRect = vi.fn(() => ({ left: 120, bottom: 60 }));
    win.eval(source);
    const stopPropagation = vi.fn();
    win.NotificationPanel.render({ currentTarget: visibleBell, stopPropagation });

    const panel = win.document.getElementById('notification-panel');
    expect(panel.classList.contains('notification-mobile-sheet')).toBe(sheet);
    expect(Boolean(win.document.getElementById('notification-sheet-overlay'))).toBe(sheet);
    expect(hiddenBell.getBoundingClientRect).not.toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalledOnce();
    if (mobile !== undefined) expect(win.MobileUI.isMobile).toHaveBeenCalledOnce();
    if (!sheet) {
      expect(panel.style.top).toBe('64px');
      expect(panel.style.left).toBe('120px');
      expect(visibleBell.getBoundingClientRect).toHaveBeenCalledOnce();
    }
    const icon = panel.querySelector('.notification-panel-title svg');
    expect(icon.getAttribute('aria-hidden')).toBe('true');
    expect(icon.getAttribute('stroke')).toBe('currentColor');
    expect(panel.textContent).not.toContain('🔔');
  });
});
