// `ctx.serverRegistry`: the servers this hub manages (servers.json in the
// configuration directory), their addresses, SSH settings, transports and
// encrypted passwords (lib/servers/registry.js). The rest of the hub (links,
// health, relay, the servers API, the installer) is built on it.

import { ServerRegistry } from '../../lib/servers/registry.js';

export const name = 'server-registry';

export const inject = ['launch'];

export async function apply(ctx) {
  const registry = new ServerRegistry({ configDir: ctx.launch.configDir });
  await registry.load();
  ctx.provide('serverRegistry', registry);
}
