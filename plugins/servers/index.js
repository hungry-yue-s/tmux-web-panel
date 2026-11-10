// `ctx.servers`: the servers API (/api/servers, lib/servers/server-service.js):
// list, add, edit and remove servers, probe them, and scan and trust their
// host keys. Only the hub answers it; it is never relayed (root CLAUDE.md).
// A transport change lets mosh-hub, when loaded, try again.
//
// The hub side of multi-server is a set of plugins: server-registry,
// hub-links, server-health, hub-relay, servers (this one), node-installer,
// basic-mode and mosh-hub. A Node-only installation loads none of them.

import { ServerService } from '../../lib/servers/server-service.js';
import { createServersRouter } from '../../lib/api/servers.js';

export const name = 'servers';

export const inject = ['http', 'serverRegistry', 'hubLinks', 'serverHealth'];

export function apply(ctx) {
  const service = new ServerService({
    registry: ctx.serverRegistry,
    links: ctx.hubLinks,
    health: ctx.serverHealth,
    mosh: { retry: (serverId) => ctx.get('moshHub')?.retry(serverId) },
  });
  ctx.http.mount('/api/servers', createServersRouter({ serverService: service }));
  ctx.provide('servers', service);
}
