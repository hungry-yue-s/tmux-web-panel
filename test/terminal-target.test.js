import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const SRC = readFileSync('public/js/terminal-target.js', 'utf8');
const API_SRC = readFileSync('public/js/api.js', 'utf8');

/**
 * Every machine runs the same panel, so a pane is addressed by the same path
 * everywhere and only the /n/:serverId prefix says which machine. These tests
 * pin that rule: a remote window never reaches the panel host's own paths.
 */
function loadTarget() {
  const dom = new JSDOM('', { url: 'https://panel.example:7681/' });
  const win = dom.window;
  const legacy = {
    get: vi.fn(async () => ({ data: [] })),
    post: vi.fn(async () => ({ success: true })),
    put: vi.fn(async () => ({ success: true })),
    delete: vi.fn(async () => ({ success: true })),
  };
  win.api = legacy;
  win.Auth = { wsTokenParam: () => 'token=abc' };
  // eslint-disable-next-line no-new-func
  new Function('window', API_SRC)(win);
  const scoped = {
    get: vi.spyOn(win.Api, 'get').mockImplementation(async () => ({ panes: [] })),
    post: vi.spyOn(win.Api, 'post').mockImplementation(async () => ({})),
    patch: vi.spyOn(win.Api, 'patch').mockImplementation(async () => ({})),
    del: vi.spyOn(win.Api, 'del').mockImplementation(async () => null),
  };
  // eslint-disable-next-line no-new-func
  new Function('window', SRC)(win);
  return { TerminalTarget: win.TerminalTarget, legacy, scoped, win };
}

describe('TerminalTarget defaults', () => {
  it('starts on the local server with the tmux provider', () => {
    const { TerminalTarget } = loadTarget();
    expect(TerminalTarget.serverId).toBe('local');
    expect(TerminalTarget.isRemote()).toBe(false);
    expect(TerminalTarget.supportsTmuxActions()).toBe(true);
  });

  it('reset returns to local', () => {
    const { TerminalTarget } = loadTarget();
    TerminalTarget.set({ serverId: 'api-linux' });
    TerminalTarget.reset();
    expect(TerminalTarget.isRemote()).toBe(false);
  });

  it('announces a server switch so the status socket can follow it', () => {
    const { TerminalTarget, win } = loadTarget();
    const seen = [];
    win.addEventListener('terminal-target-server', (event) => seen.push(event.detail.serverId));

    TerminalTarget.set({ serverId: 'api-linux', windowId: '@1' });
    TerminalTarget.set({ serverId: 'api-linux', windowId: '@2' });
    TerminalTarget.reset();

    expect(seen).toEqual(['api-linux', 'local']);
  });
});

describe('TerminalTarget.hasNode', () => {
  it('is false only for a remote server reported in basic mode', () => {
    const { TerminalTarget, win } = loadTarget();
    expect(TerminalTarget.hasNode()).toBe(true);
    const healths = { 'api-linux': { node: { installed: false } }, full: { node: { installed: true } } };
    win.AppShell = { health: (id) => healths[id] || {} };
    TerminalTarget.set({ serverId: 'api-linux' });
    expect(TerminalTarget.hasNode()).toBe(false);
    TerminalTarget.set({ serverId: 'full' });
    expect(TerminalTarget.hasNode()).toBe(true);
    TerminalTarget.set({ serverId: 'unknown' });
    expect(TerminalTarget.hasNode()).toBe(true);
  });
});

describe('local server', () => {
  it('uses the machine API directly with stable ids', async () => {
    const { TerminalTarget, legacy, scoped } = loadTarget();
    TerminalTarget.set({ serverId: 'local', sessionId: '$1', windowId: '@5' });

    await TerminalTarget.listPanes('DataAnt', '2');
    await TerminalTarget.splitPane('DataAnt', '2', '%12', 'horizontal');
    await TerminalTarget.setPaneLabel('%12', 'build');
    await expect(TerminalTarget.closePane('DataAnt', '2', '%12')).resolves.toEqual({ ok: true });

    expect(scoped.get).toHaveBeenCalledWith('/api/workspace/windows/%405/panes');
    expect(scoped.post).toHaveBeenCalledWith('/api/workspace/windows/%405/panes', { direction: 'horizontal', paneId: '%12' });
    expect(scoped.patch).toHaveBeenCalledWith('/api/workspace/panes/%2512', { label: 'build' });
    expect(scoped.del).toHaveBeenCalledWith('/api/workspace/panes/%2512');
    expect(legacy.get).not.toHaveBeenCalled();
  });

  it('builds the socket address without a relay prefix', () => {
    const { TerminalTarget } = loadTarget();
    expect(TerminalTarget.wsUrl('%12', false)).toBe('wss://panel.example:7681/ws/terminal/%2512?token=abc');
  });

  it('falls back to the name/index API only when no stable window id is known', async () => {
    const { TerminalTarget, legacy } = loadTarget();
    await TerminalTarget.listPanes('DataAnt', '2');
    expect(legacy.get).toHaveBeenCalledWith('/api/sessions/DataAnt/windows/2/panes');
  });
});

describe('remote server', () => {
  it('reaches the same machine API through the /n/:serverId relay', async () => {
    const { TerminalTarget, legacy, scoped } = loadTarget();
    TerminalTarget.set({ serverId: 'api-linux', sessionId: '$1', windowId: '@5' });

    await TerminalTarget.listPanes('DataAnt', '2');
    await TerminalTarget.splitPane('DataAnt', '2', '%12', 'vertical');
    await TerminalTarget.setPaneLabel('%12', 'build');
    await expect(TerminalTarget.closePane('DataAnt', '2', '%12')).resolves.toEqual({ ok: true });

    expect(scoped.get).toHaveBeenCalledWith('/n/api-linux/api/workspace/windows/%405/panes');
    expect(scoped.post).toHaveBeenCalledWith('/n/api-linux/api/workspace/windows/%405/panes', { direction: 'vertical', paneId: '%12' });
    expect(scoped.patch).toHaveBeenCalledWith('/n/api-linux/api/workspace/panes/%2512', { label: 'build' });
    expect(scoped.del).toHaveBeenCalledWith('/n/api-linux/api/workspace/panes/%2512');
    expect(legacy.get).not.toHaveBeenCalled();
  });

  it('builds the relayed socket address', () => {
    const { TerminalTarget } = loadTarget();
    TerminalTarget.set({ serverId: 'api-linux' });
    expect(TerminalTarget.wsUrl('%12', true, 120, 40)).toBe(
      'wss://panel.example:7681/n/api-linux/ws/terminal/%2512?nozoom=1&cols=120&rows=40&token=abc',
    );
  });

  it('prefixes the name/index fallback too, so it can never hit the panel host', async () => {
    const { TerminalTarget, legacy } = loadTarget();
    TerminalTarget.set({ serverId: 'api-linux' });

    await TerminalTarget.listPanes('DataAnt', '2');
    await TerminalTarget.setPaneLabel('%3', 'x');

    expect(legacy.get).toHaveBeenCalledWith('/n/api-linux/api/sessions/DataAnt/windows/2/panes');
    expect(legacy.put).toHaveBeenCalledWith('/n/api-linux/api/panes/%253/label', { label: 'x' });
  });

  it('returns an empty list when the window is gone', async () => {
    const { TerminalTarget, scoped } = loadTarget();
    scoped.get.mockResolvedValue(null);
    TerminalTarget.set({ serverId: 'api-linux', windowId: '@5' });
    await expect(TerminalTarget.listPanes('DataAnt', '2')).resolves.toEqual([]);
  });
});

describe('terminal renderer wiring', () => {
  const terminalSrc = readFileSync('public/js/terminal.js', 'utf8');
  const panesSrc = readFileSync('public/js/panes.js', 'utf8');

  it('has no hardcoded session paths left in the terminal renderer', () => {
    expect(terminalSrc).not.toMatch(/'\/api\/sessions\//);
  });

  it('has no hardcoded pane or session paths left in panes.js', () => {
    expect(panesSrc).not.toMatch(/'\/api\/sessions\//);
    expect(panesSrc).not.toMatch(/'\/api\/panes\//);
  });

  it('builds the socket address through the adapter', () => {
    expect(terminalSrc).toContain('TerminalTarget.wsUrl(');
    expect(terminalSrc).not.toMatch(/'\/ws\/terminal\/' \+ encodeURIComponent/);
  });

  it('re-renders into the recorded mount container, not hidden #content', () => {
    expect(terminalSrc).toContain('terminalState.mountContainer');
    expect(terminalSrc).toContain('function _terminalContainer()');
    // Every re-render path goes through the helper.
    const renderCalls = terminalSrc.match(/renderTerminal\(content\)/g) || [];
    expect(renderCalls.length).toBeGreaterThan(0);
    expect(terminalSrc).not.toMatch(/var content = document\.getElementById\('content'\)/);
  });

  it('keeps the mount container across a cleanup', () => {
    // Cleanup clears the xterm container but must leave mountContainer intact.
    const cleanup = terminalSrc.slice(
      terminalSrc.indexOf('function _cleanupTerminalResources'),
      terminalSrc.indexOf('function cleanupTerminal'),
    );
    expect(cleanup).not.toContain('mountContainer');
  });

  it('routes the refresh button to the server-scoped refresh', () => {
    expect(terminalSrc).toContain('MsApp.refreshCurrentTerminal');
  });

  it('gates native split mode on the provider and uploads to the server in view', () => {
    expect(terminalSrc).toContain('TerminalTarget.supportsTmuxActions()');
    expect(terminalSrc).toContain("fetch(Api.activeUrl('/api/upload')");
  });
});
