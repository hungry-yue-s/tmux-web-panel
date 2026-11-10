// `ctx.mosh`: Mosh sessions this Node runs for a hub's mosh-client
// (lib/mosh/server.js, an optional experiment: transport.terminal = 'mosh').
//
// /api/mosh only answers the node token with the hub-call mark; hubs never
// relay it, so a session key cannot reach a browser (root CLAUDE.md). The
// sessions attach through tmux like any terminal, to the server the tmux
// plugin selected. Unloading ends their processes; the tmux server stays.

import { MoshService } from '../../lib/mosh/server.js';
import { createMoshRouter } from '../../lib/api/mosh.js';
import { tmuxServerArgs } from '../../lib/tmux-server.js';

export const name = 'mosh';

export const inject = ['http', 'node', 'workspace', 'terminals'];

/** This machine's mosh-client is the hub's (mosh-hub); a Node-only install has none. */
const NO_CLIENT = Object.freeze({ available: false, version: null, reason: 'not_a_hub' });

export function apply(ctx) {
  const service = new MoshService({
    workspace: ctx.workspace,
    terminalManager: ctx.terminals,
    tmuxSocketArgs: tmuxServerArgs(),
  });

  // Both components, probed again: after an explicit install.
  const refreshComponents = async () => {
    const hubMosh = ctx.get('moshHub');
    const [server, client] = await Promise.all([
      service.refreshCapability(),
      hubMosh ? hubMosh.clientCapability({ force: true }) : NO_CLIENT,
    ]);
    return { server: { available: server.available, version: server.version, reason: server.reason }, client };
  };

  ctx.http.mount('/api/mosh', createMoshRouter({ mosh: service, isNodeToken: ctx.node.isNodeToken, refreshComponents }));
  ctx.effect(() => ctx.node.setCapability('mosh', () => service.capability()), 'mosh.capability');
  ctx.on('mosh/refresh-components', () => refreshComponents());
  ctx.effect(() => () => service.stopAll().catch(() => false), 'mosh.sessions');

  ctx.provide('mosh', service);
}
