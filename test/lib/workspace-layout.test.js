import { describe, expect, it, vi } from 'vitest';
import { TmuxProvider } from '../../lib/workspace/tmux-provider.js';
import { ErrorCode } from '../../lib/servers/errors.js';

function provider(overrides = {}) {
  const tmux = {
    windowSizeById: vi.fn(async () => ({ width: 120, height: 40 })),
    selectLayoutById: vi.fn(async () => {}),
    capturePane: vi.fn(async () => 'hello\n'),
    resizePane: vi.fn(async () => {}),
    swapPane: vi.fn(async () => {}),
    ...overrides,
  };
  return { tmux, workspace: new TmuxProvider({ tmux }) };
}

describe('the layout picker through the workspace, by id', () => {
  it('reads a window size and sets a preset layout', async () => {
    const { tmux, workspace } = provider();
    await expect(workspace.getWindowLayout('@4')).resolves.toEqual({ width: 120, height: 40 });
    await expect(workspace.setWindowLayout('@4', { layout: 'tiled' })).resolves.toEqual({ id: '@4', layout: 'tiled' });
    expect(tmux.selectLayoutById).toHaveBeenCalledWith('@4', 'tiled');
  });

  it('captures, resizes and swaps panes', async () => {
    const { tmux, workspace } = provider();
    await expect(workspace.capturePane('%3', { escape: true })).resolves.toEqual({ id: '%3', content: 'hello\n' });
    expect(tmux.capturePane).toHaveBeenCalledWith('%3', { escape: true });
    await expect(workspace.resizePane('%3', { direction: 'R', amount: '4' })).resolves.toEqual({ id: '%3', direction: 'R', amount: 4 });
    expect(tmux.resizePane).toHaveBeenCalledWith('%3', 'R', 4);
    await expect(workspace.swapPanes('%3', { target: '%5' })).resolves.toEqual({ id: '%3', target: '%5' });
    expect(tmux.swapPane).toHaveBeenCalledWith('%3', '%5');
  });

  it('refuses bad ids, layouts, directions and amounts before running tmux', async () => {
    const { tmux, workspace } = provider();
    for (const call of [
      () => workspace.getWindowLayout('main:1'),
      () => workspace.setWindowLayout('@4', { layout: 'stacked' }),
      () => workspace.resizePane('%3', { direction: 'X', amount: 1 }),
      () => workspace.resizePane('%3', { direction: 'U', amount: 0 }),
      () => workspace.resizePane('%3', { direction: 'U', amount: 1.5 }),
      () => workspace.swapPanes('%3', { target: 'other' }),
      () => workspace.capturePane('3'),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    }
    for (const fn of Object.values(tmux)) expect(fn).not.toHaveBeenCalled();
  });

  it('says a window or pane is gone when tmux cannot find it', async () => {
    const missing = async () => { throw Object.assign(new Error('failed'), { stderr: "can't find window: @9" }); };
    const { workspace } = provider({ windowSizeById: missing, capturePane: missing });
    await expect(workspace.getWindowLayout('@9')).rejects.toMatchObject({ code: ErrorCode.WINDOW_NOT_FOUND });
    await expect(workspace.capturePane('%9')).rejects.toMatchObject({ code: ErrorCode.PANE_NOT_FOUND });
  });
});
