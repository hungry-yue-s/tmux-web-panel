import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';

import { createPlugin } from '../plugins/tmux-agent/server.mjs';

/** Captures registered tools the way McpServer would expose them. */
function fakeMcp() {
  const tools = new Map();
  return { tools, registerTool: (name, meta, handler) => tools.set(name, { meta, handler }) };
}

function setup() {
  const workspaceService = {
    getWorkspace: vi.fn(async () => ({ provider: 'tmux', sessions: [{ id: '$1' }] })),
    createSession: vi.fn(async ({ name }) => ({ id: '$9', name })),
  };
  const tmux = {
    getPaneAddress: vi.fn(async (paneId) => ({ paneId, sessionId: '$1', windowId: '@1' })),
    run: vi.fn(async () => ''),
    executor: { exec: vi.fn() },
  };
  const remote = { call: vi.fn(async (serverId, pluginId, tool, args) => ({ serverId: 'local', tool, args })) };
  const servers = { list: () => ({ servers: [{ id: 'local' }, { id: 'api-linux' }] }) };
  const plugin = createPlugin({ tmux, workspaceService, servers, remote, jobDirectory: '/tmp/jobs' });
  return { plugin, workspaceService, tmux, remote };
}

async function callTool(server, name, args) {
  const result = await server.tools.get(name).handler(args);
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text);
}

describe('tmux-agent across servers', () => {
  it('runs a local call on this machine', async () => {
    const { plugin, workspaceService, remote } = setup();
    const server = fakeMcp();
    plugin.register(server, z, () => {});

    await expect(callTool(server, 'workspace', { serverId: 'local' })).resolves.toMatchObject({ provider: 'tmux' });
    expect(workspaceService.getWorkspace).toHaveBeenCalled();
    expect(remote.call).not.toHaveBeenCalled();
  });

  it('hands a call for another server to that server\'s copy of the plugin', async () => {
    const { plugin, tmux, remote } = setup();
    const server = fakeMcp();
    plugin.register(server, z, () => {});

    const result = await callTool(server, 'send_key', { serverId: 'api-linux', paneId: '%3', key: 'C-c' });

    expect(remote.call).toHaveBeenCalledWith('api-linux', 'tmux-agent', 'send_key', { serverId: 'local', paneId: '%3', key: 'C-c' });
    // Nothing ran against this machine's tmux.
    expect(tmux.run).not.toHaveBeenCalled();
    // The answer is reported under the id the agent used.
    expect(result.serverId).toBe('api-linux');
  });

  it('lists servers from the hub rather than forwarding', async () => {
    const { plugin, remote } = setup();
    const server = fakeMcp();
    plugin.register(server, z, () => {});

    await expect(callTool(server, 'list_servers', { serverId: 'api-linux' })).resolves.toEqual({
      servers: [{ id: 'local' }, { id: 'api-linux' }],
    });
    expect(remote.call).not.toHaveBeenCalled();
  });

  it('validates a forwarded call and always runs it locally', async () => {
    const { plugin, tmux, remote } = setup();

    await expect(plugin.call('send_key', { serverId: 'other', paneId: '%3', key: 'Enter' }, z, () => {}))
      .resolves.toEqual({ serverId: 'local', paneId: '%3', key: 'Enter' });
    expect(tmux.run).toHaveBeenCalledWith(['send-keys', '-t', '%3', 'Enter']);
    expect(remote.call).not.toHaveBeenCalled();

    await expect(plugin.call('send_key', { paneId: 'not-a-pane', key: 'Enter' }, z, () => {})).rejects.toThrow();
    await expect(plugin.call('no_such_tool', {}, z, () => {})).rejects.toThrow(/Unknown tool/);
  });

  it('checks that the plugin is still enabled before a forwarded call', async () => {
    const { plugin } = setup();
    const guard = vi.fn(() => { throw new Error('Plugin is not enabled'); });
    await expect(plugin.call('workspace', {}, z, guard)).rejects.toThrow(/not enabled/);
  });
});
