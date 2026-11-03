// @vitest-environment jsdom
import { Context, Service } from 'cordis';
import Timer from '@cordisjs/plugin-timer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ShellService from '../client/core/shell.js';
import * as workspaceView from '../plugins/workspace/client/index.js';

const TREE = {
  provider: 'tmux',
  instanceId: '1:2',
  complete: true,
  sessions: [{
    id: '$1',
    name: 'main',
    active: true,
    windowCount: 1,
    windows: [{
      id: '@1',
      index: 0,
      name: 'editor',
      active: true,
      panes: [
        { id: '%1', name: 'vim', command: 'vim', label: null, active: true, geometry: { x: 0, y: 0, width: 80, height: 24 } },
        { id: '%2', name: 'logs', command: 'bash', label: 'logs', active: false, geometry: { x: 81, y: 0, width: 40, height: 24 } },
      ],
    }],
  }],
};

class FakeApi extends Service {
  constructor(ctx, config) {
    super(ctx, 'api');
    this.answers = config.answers;
  }
  async get() {
    const next = this.answers.shift();
    if (next instanceof Error) throw next;
    return structuredClone(next);
  }
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

let ctx;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  document.body.innerHTML = '<div id="app"></div>';
  document.title = '面板';
  ctx = new Context();
});

afterEach(() => {
  vi.useRealTimers();
});

async function mount(answers) {
  await ctx.plugin(Timer);
  await ctx.plugin(FakeApi, { answers });
  await ctx.plugin(ShellService);
  const fiber = ctx.plugin(workspaceView);
  await fiber;
  await flush();
  return fiber;
}

describe('workspace view', () => {
  it('lists panes and shows the one selected', async () => {
    await mount([TREE]);
    const buttons = [...document.querySelectorAll('.ws-pane')];
    expect(buttons.map((button) => button.textContent)).toEqual(['vim%1', 'logs%2']);
    expect(document.querySelector('.shell-status').textContent).toBe('1 个会话');
    buttons[1].click();
    expect(document.querySelector('.ws-detail-title').textContent).toBe('main › 0:editor › logs');
    expect(document.querySelector('.ws-pane[aria-pressed="true"]').textContent).toBe('logs%2');
  });

  it('keeps the tree on screen when a refresh fails, and recovers on the next one', async () => {
    await mount([TREE, new Error('offline'), TREE]);
    vi.advanceTimersByTime(workspaceView.REFRESH_MS);
    await flush();
    expect(document.querySelectorAll('.ws-pane')).toHaveLength(2);
    expect(document.querySelector('.shell-status').textContent).toBe('刷新失败');
    expect(document.querySelector('.shell-status').dataset.tone).toBe('error');
    vi.advanceTimersByTime(workspaceView.REFRESH_MS);
    await flush();
    expect(document.querySelector('.shell-status').textContent).toBe('1 个会话');
  });

  it('forgets a vanished pane only after a complete read', async () => {
    const without = structuredClone(TREE);
    without.sessions[0].windows[0].panes.pop();
    const partial = { ...structuredClone(without), complete: false };
    await mount([TREE, partial, without]);
    document.querySelectorAll('.ws-pane')[1].click();
    vi.advanceTimersByTime(workspaceView.REFRESH_MS);
    await flush();
    // Partial read: %2 is not listed, but the selection is kept.
    expect(document.querySelector('.ws-placeholder')).not.toBeNull();
    vi.advanceTimersByTime(workspaceView.REFRESH_MS);
    await flush();
    expect(document.querySelector('.ws-pane[aria-pressed="true"]')).toBeNull();
  });

  it('removes its elements and stops refreshing when disposed', async () => {
    const answers = [TREE, TREE, TREE];
    const fiber = await mount(answers);
    expect(document.querySelector('.ws')).not.toBeNull();
    await fiber.dispose();
    expect(document.querySelector('.ws')).toBeNull();
    expect(document.querySelector('.ws-detail')).toBeNull();
    vi.advanceTimersByTime(workspaceView.REFRESH_MS * 3);
    await flush();
    expect(answers).toHaveLength(2);
  });
});
