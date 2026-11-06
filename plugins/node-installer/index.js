// `ctx.nodeInstaller`: installing a Node, or the Mosh components, on a server
// (lib/hub/node-installer.js). The one place the hub runs anything remotely,
// and only when the user starts it (root CLAUDE.md, Hub 与 Node). Afterwards
// the server is probed again; a Mosh component install also refreshes the
// Node's component probe and lets mosh-hub, when loaded, try again.

import { NodeInstaller } from '../../lib/hub/node-installer.js';
import { createNodeInstallRouter } from '../../lib/api/node-install.js';
import { REPO_ROOT } from '../../lib/paths.js';

export const name = 'node-installer';

export const inject = ['http', 'serverRegistry', 'hubLinks', 'serverHealth'];

export function apply(ctx) {
  const links = ctx.hubLinks;
  const health = ctx.serverHealth;
  const installer = new NodeInstaller({
    links,
    registry: ctx.serverRegistry,
    projectDir: REPO_ROOT,
    onInstalled: (serverId) => {
      health.invalidate(serverId);
      health.probe(serverId, { force: true }).catch(() => {});
    },
    onComponentInstalled: async (serverId) => {
      if (serverId === 'local') {
        // The mosh plugin refreshes this Node's components.
        await ctx.parallel('mosh/refresh-components').catch(() => {});
      } else {
        // Older Nodes may not expose this yet; their normal capability cache still expires.
        await links.link(serverId).requestJson('POST', '/api/mosh/components/refresh', undefined, { timeout: 10_000 }).catch(() => {});
      }
      ctx.get('moshHub')?.retry(serverId);
      health.invalidate(serverId);
      await health.probe(serverId, { force: true }).catch(() => {});
    },
  });
  ctx.http.mount('/api/servers', createNodeInstallRouter({ installer }));
  ctx.provide('nodeInstaller', installer);
}
