// `ctx.moshHub`: Mosh terminals this hub runs to a Node (lib/hub/mosh-terminal.js,
// the optional transport.terminal = 'mosh' experiment, root CLAUDE.md). The
// relay hands it a terminal socket for a server that wants Mosh; the health
// service reports its state; the servers API retries it after a change.
//
// Unloading ends the Node sessions through the links. hub-links waits for
// that: this plugin injects it, and Cordis unloads dependents first.

import { MoshTerminals } from '../../lib/hub/mosh-terminal.js';

export const name = 'mosh-hub';

export const inject = ['http', 'node', 'serverRegistry', 'hubLinks'];

export function apply(ctx) {
  const mosh = new MoshTerminals({ registry: ctx.serverRegistry, links: ctx.hubLinks, wss: ctx.http.wss });
  ctx.effect(() => () => mosh.closeAll().catch(() => false), 'mosh-hub.terminals');
  ctx.effect(() => ctx.node.setCapability('moshClient', () => mosh.clientCapability()), 'mosh-hub.client');
  ctx.provide('moshHub', mosh);
}
