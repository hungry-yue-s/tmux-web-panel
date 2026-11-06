// /n/:serverId/… relayed untouched to that server's Node (lib/hub/proxy.js,
// root CLAUDE.md Hub 与 Node): before compression and body parsing (order -50),
// login tokens only, so a node token cannot chain hubs. A server without the
// panel is answered by basic mode, a terminal that wants Mosh by mosh-hub:
// both are looked up per request and may be absent. /n/local/ is not this
// plugin's: the node plugin strips it first.

import { createNodeProxy, relayNodeUpgrade } from '../../lib/hub/proxy.js';
import { requireSameOrigin } from '../../lib/api/same-origin.js';

export const name = 'hub-relay';

export const inject = ['http', 'auth', 'serverRegistry', 'hubLinks'];

export function apply(ctx) {
  const registry = ctx.serverRegistry;
  const links = ctx.hubLinks;

  ctx.http.use(createNodeProxy({
    registry,
    links,
    authorize: ctx.auth.loginOnly,
    sameOrigin: requireSameOrigin,
    getBasic: () => ctx.get('basicMode')?.http ?? null,
  }), { order: -50 });

  ctx.http.useUpgrade(({ req, socket, head }) => relayNodeUpgrade(req, socket, head, {
    registry,
    links,
    authorize: ctx.auth.authorizeRelayUpgrade,
    getBasic: () => ctx.get('basicMode')?.upgrade ?? null,
    getMosh: () => ctx.get('moshHub') ?? null,
  }), { order: -50 });
}
