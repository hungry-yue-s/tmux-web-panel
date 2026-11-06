// `ctx.hubLinks`: one SSH link per server (lib/hub/link-pool.js): SFTP for
// the pairing file plus an `ssh -N -L` forward to its Node (docs/architecture.md,
// Hub 与 Node). A server without the panel gets its shell host from the
// basic-mode plugin, when that is loaded.
//
// The links close last: every plugin that talks through them (the Mosh
// terminals ending their Node sessions, for one) injects hubLinks, and Cordis
// unloads a service's dependents before the service itself.

import { LinkPool } from '../../lib/hub/link-pool.js';
import { AppError, ErrorCode } from '../../lib/servers/errors.js';

export const name = 'hub-links';

export const inject = ['launch', 'serverRegistry'];

export function apply(ctx) {
  const links = new LinkPool({
    registry: ctx.serverRegistry,
    configDir: ctx.launch.configDir,
    createBasicHost: (connection, serverId) => {
      const basic = ctx.get('basicMode');
      if (!basic) throw new AppError(ErrorCode.UNSUPPORTED, 'Basic mode is not available');
      return basic.createHost(connection, serverId);
    },
  });
  ctx.effect(() => () => links.closeAll(), 'hub-links.close');
  ctx.provide('hubLinks', links);
}
