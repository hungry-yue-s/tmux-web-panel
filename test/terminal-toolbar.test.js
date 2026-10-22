import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const terminalSource = readFileSync('public/js/terminal.js', 'utf8');
const styles = readFileSync('public/css/style.css', 'utf8');
const routerSource = readFileSync('public/js/router.js', 'utf8');
const actualRouter = new Function('window', routerSource + '\nreturn window.Router;')({});

describe('terminal toolbar controls', () => {
  it('uses accessible SVG controls for the terminal header actions', () => {
    expect(terminalSource).toContain('function _terminalToolIcon(paths)');
    expect(terminalSource).toContain('class="terminal-tool-icon"');

    ['返回窗口列表', '刷新终端', '标签页模式', '分屏模式', '减小字号',
      '增大字号', '新增分屏', '设置当前窗格标签', '从 tmux 缓冲区打开文件',
      '在新窗口打开', '全屏'].forEach((label) => {
      expect(terminalSource).toContain(`aria-label="${label}"`);
    });
  });

  it('exposes pressed state for the tab and split mode toggle', () => {
    expect(terminalSource).toContain('aria-pressed="\' + (displayMode === \'tab\' ? \'true\' : \'false\')');
    expect(terminalSource).toContain('aria-pressed="\' + (displayMode === \'split\' ? \'true\' : \'false\')');
  });

  it('keeps desktop controls uniform and theme driven', () => {
    expect(styles).toMatch(/\.terminal-tool-btn[\s\S]*?width:\s*32px[\s\S]*?height:\s*32px/);
    expect(styles).toContain('background: color-mix(in srgb, var(--accent-blue) 14%, transparent);');
    expect(styles).toContain('.terminal-tool-icon');
  });
});


describe('terminal pop-out routing', () => {
  function install({ mobile, remote = false, native = false }) {
    let click;
    const route = { name: 'terminal', params: { serverId: remote ? 'remote' : 'local', sessionId: '$3', windowId: '@5', paneId: '%9' } };
    const state = { currentPane: '%12' };
    const nativePost = vi.fn();
    const win = {
      location: { href: 'https://panel.example/?theme=ivory&standalone=status#/terminal/local' },
      Router: { current: () => route, serialize: vi.fn(actualRouter.serialize) },
      open: vi.fn(),
      webkit: native ? { messageHandlers: { tmuxPanelOpenWindow: { postMessage: nativePost } } } : null,
    };
    const toast = vi.fn();
    const code = terminalSource.slice(terminalSource.indexOf('  // Pop-out button'), terminalSource.indexOf('  // Fullscreen button'));
    const view = { querySelector: () => ({ addEventListener: (_, fn) => { click = fn; } }) };
    new Function('view', 'window', 'state', 'TerminalTarget', '_isMobileTerminal', '_showToast', code)(
      view, win, state, { isRemote: () => remote }, () => mobile, toast,
    );
    return { click, win, route, state, nativePost, toast };
  }

  it.each([false, true])('opens the full phone workbench synchronously (remote=%s)', (remote) => {
    const { click, win, route, toast } = install({ mobile: true, remote });
    click();
    expect(win.Router.serialize).toHaveBeenCalledWith({
      name: 'terminal', params: { ...route.params, paneId: '%12' },
    });
    expect(route.params.paneId).toBe('%9');
    expect(win.open).toHaveBeenCalledOnce();
    const [href, target] = win.open.mock.calls[0];
    const url = new URL(href);
    expect(url.pathname).toBe('/');
    expect(url.searchParams.get('theme')).toBe('ivory');
    expect(url.searchParams.has('standalone')).toBe(false);
    expect(url.hash).toBe('#/terminal/' + route.params.serverId + '/%243/%405/%2512');
    expect(target).toBe('_blank');
    expect(toast).not.toHaveBeenCalled();
  });

  it('uses the live pane after switching while keeping stable server, session and window ids', () => {
    const { click, win, route, state } = install({ mobile: true, remote: true });
    state.currentPane = '%21';
    click();
    const url = new URL(win.open.mock.calls[0][0]);
    expect(actualRouter.parse(url.hash)).toEqual({
      name: 'terminal', params: { serverId: 'remote', sessionId: '$3', windowId: '@5', paneId: '%21' },
    });
    expect(route.params.paneId).toBe('%9');
  });

  it('keeps the desktop browser pane window unchanged', () => {
    const { click, win } = install({ mobile: false });
    click();
    expect(win.open).toHaveBeenCalledWith('/terminal.html?pane=%2512', '_blank', 'width=800,height=600');
    expect(win.Router.serialize).not.toHaveBeenCalled();
  });

  it('keeps the desktop native window bridge unchanged', () => {
    const { click, win, nativePost } = install({ mobile: false, native: true });
    click();
    expect(nativePost).toHaveBeenCalledWith({ url: '/terminal.html?pane=%2512', title: 'Tmux Terminal', width: 800, height: 600 });
    expect(win.open).not.toHaveBeenCalled();
  });

  it('still prevents desktop remote panes from reaching the local pop-out endpoint', () => {
    const { click, win, toast } = install({ mobile: false, remote: true });
    click();
    expect(win.open).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith('远端服务器暂不支持在新窗口打开');
  });
});
