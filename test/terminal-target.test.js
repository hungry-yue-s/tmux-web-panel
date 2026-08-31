import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const SRC = readFileSync('public/js/terminal-target.js', 'utf8');

/**
 * The terminal renderer originally addressed panes through /api/sessions/... and
 * /ws/terminal/:paneId, which always mean the panel's own machine. These tests
 * pin the rule that a remote server never reaches those legacy paths.
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
  const scoped = {
    get: vi.fn(async () => ({ panes: [] })),
    request: vi.fn(async () => ({})),
  };
  win.api = legacy;
  win.Api = scoped;
  win.Auth = { wsTokenParam: () => 'token=abc' };
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
    TerminalTarget.set({ serverId: 'api-linux', provider: 'ssh' });
    TerminalTarget.reset();
    expect(TerminalTarget.isRemote()).toBe(false);
  });
});

describe('local server uses stable ids in the new shell', () => {
  it('lists panes through the server-scoped window endpoint', async () => {
    const { TerminalTarget, legacy, scoped } = loadTarget();
    TerminalTarget.set({ serverId: 'local', provider: 'tmux', sessionId: '$1', windowId: '@5' });

    await TerminalTarget.listPanes('DataAnt', '2');

    expect(scoped.get).toHaveBeenCalledWith('/api/servers/local/windows/%405/panes');
    expect(legacy.get).not.toHaveBeenCalled();
  });

  it('builds the single-segment socket address', () => {
    const { TerminalTarget } = loadTarget();
    const url = TerminalTarget.wsUrl('%12', false);
    expect(url).toBe('wss://panel.example:7681/ws/terminal/%2512?token=abc');
  });

  it('splits, labels and closes through stable server-scoped endpoints', async () => {
    const { TerminalTarget, legacy, scoped } = loadTarget();
    TerminalTarget.set({ serverId: 'local', provider: 'tmux', sessionId: '$1', windowId: '@5' });

    await TerminalTarget.splitPane('DataAnt', '2', '%12', 'horizontal');
    await TerminalTarget.setPaneLabel('%12', 'build');
    await TerminalTarget.closePane('DataAnt', '2', '%12');

    expect(scoped.request.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      ['POST', '/api/servers/local/windows/%405/panes'],
      ['PATCH', '/api/servers/local/panes/%2512'],
      ['DELETE', '/api/servers/local/panes/%2512'],
    ]);
    expect(legacy.post).not.toHaveBeenCalled();
    expect(legacy.put).not.toHaveBeenCalled();
    expect(legacy.delete).not.toHaveBeenCalled();
  });
});

describe('remote server never touches the legacy local API', () => {
  function remote(provider = 'tmux') {
    const loaded = loadTarget();
    loaded.TerminalTarget.set({
      serverId: 'api-linux',
      provider,
      sessionId: '$1',
      windowId: '@5',
    });
    return loaded;
  }

  it('reads panes from the stable window endpoint', async () => {
    const { TerminalTarget, legacy, scoped } = remote();
    scoped.get.mockResolvedValue({ panes: [{ id: '%12' }, { id: '%13' }] });

    const panes = await TerminalTarget.listPanes('DataAnt', '2');

    expect(scoped.get).toHaveBeenCalledWith('/api/servers/api-linux/windows/%405/panes');
    expect(panes.map((p) => p.id)).toEqual(['%12', '%13']);
    // The whole point: no legacy call happened.
    expect(legacy.get).not.toHaveBeenCalled();
  });

  it('ignores a stale display index when a stable window id exists', async () => {
    const { TerminalTarget, scoped } = remote();
    scoped.get.mockResolvedValue({ panes: [{ id: '%12' }] });

    // The passed index (2) belongs to @9, but the target's stable id is @5.
    const panes = await TerminalTarget.listPanes('DataAnt', '2');

    expect(panes.map((p) => p.id)).toEqual(['%12']);
    expect(scoped.get).toHaveBeenCalledWith('/api/servers/api-linux/windows/%405/panes');
  });

  it('returns an empty list when the window is gone', async () => {
    const { TerminalTarget, scoped } = remote();
    scoped.get.mockResolvedValue({ panes: [] });
    await expect(TerminalTarget.listPanes('DataAnt', '2')).resolves.toEqual([]);
  });

  it('builds the server-scoped socket address', () => {
    const { TerminalTarget } = remote();
    const url = TerminalTarget.wsUrl('%12', true, 120, 34);

    expect(url).toContain('/ws/terminal/api-linux/%2512');
    expect(url).toContain('nozoom=1');
    expect(url).toContain('cols=120');
    expect(url).toContain('rows=34');
    expect(url).not.toMatch(/\/ws\/terminal\/%2512/);
  });

  it('splits through the server-scoped window endpoint, carrying the pane id', async () => {
    const { TerminalTarget, legacy, scoped } = remote();

    await TerminalTarget.splitPane('DataAnt', '2', '%12', 'horizontal');

    expect(scoped.request).toHaveBeenCalledWith(
      'POST',
      '/api/servers/api-linux/windows/%405/panes',
      { direction: 'horizontal', paneId: '%12' },
      { headers: { 'X-Workspace-Provider': 'tmux' } },
    );
    expect(legacy.post).not.toHaveBeenCalled();
  });

  it('refuses a split with no window id rather than guessing', async () => {
    const { TerminalTarget, legacy } = remote();
    TerminalTarget.set({ serverId: 'api-linux', provider: 'tmux', sessionId: '$1' });

    await expect(TerminalTarget.splitPane('DataAnt', '2', '%12', 'vertical')).rejects.toThrow(/window id/);
    expect(legacy.post).not.toHaveBeenCalled();
  });

  it('labels through the server-scoped pane endpoint', async () => {
    const { TerminalTarget, legacy, scoped } = remote();

    await TerminalTarget.setPaneLabel('%12', 'build');

    expect(scoped.request).toHaveBeenCalledWith(
      'PATCH',
      '/api/servers/api-linux/panes/%2512',
      { label: 'build' },
      { headers: { 'X-Workspace-Provider': 'tmux' } },
    );
    expect(legacy.put).not.toHaveBeenCalled();
  });

  it('closes through the server-scoped pane endpoint and resolves truthy', async () => {
    const { TerminalTarget, legacy, scoped } = remote();
    // A 204 answers with an empty body; callers use the value to detect cancel.
    scoped.request.mockResolvedValue('');

    const result = await TerminalTarget.closePane('DataAnt', '2', '%12');

    expect(result).toEqual({ ok: true });
    expect(scoped.request).toHaveBeenCalledWith(
      'DELETE',
      '/api/servers/api-linux/panes/%2512',
      undefined,
      { headers: { 'X-Workspace-Provider': 'tmux' } },
    );
    expect(legacy.delete).not.toHaveBeenCalled();
  });

  it('sends the provider header so a stale page is rejected', async () => {
    const { TerminalTarget } = remote('ssh');
    await TerminalTarget.setPaneLabel('pane_1', 'x');
    expect(TerminalTarget.headers()).toEqual({ 'X-Workspace-Provider': 'ssh' });
  });

  it('reports that an ssh workspace has no tmux-native split', () => {
    const { TerminalTarget } = remote('ssh');
    expect(TerminalTarget.supportsTmuxActions()).toBe(false);
  });

  it('still allows ssh panes to be created, labelled and closed', async () => {
    const { TerminalTarget, scoped } = remote('ssh');

    await TerminalTarget.splitPane('main', '0', 'pane_1', 'vertical');
    await TerminalTarget.setPaneLabel('pane_1', 'logs');
    await TerminalTarget.closePane('main', '0', 'pane_1');

    const methods = scoped.request.mock.calls.map((call) => call[0]);
    expect(methods).toEqual(['POST', 'PATCH', 'DELETE']);
  });

  it('local close also resolves truthy so the re-render still happens', async () => {
    const { TerminalTarget } = loadTarget();
    await expect(TerminalTarget.closePane('DataAnt', '2', '%12')).resolves.toEqual({ ok: true });
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

  it('gates native split mode and file preview on the provider', () => {
    expect(terminalSrc).toContain('TerminalTarget.supportsTmuxActions()');
    expect(terminalSrc).toMatch(/FilePreview !== 'undefined' && !TerminalTarget\.isRemote\(\)/);
  });
});
