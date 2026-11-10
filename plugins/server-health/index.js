// `ctx.serverHealth`: each server's state, one GET /api/node/info per probe
// through its link (lib/servers/health-service.js), and which transport its
// terminals and API take. Changes go to open pages as status/server-status.
// A server that wants Mosh is reported through mosh-hub when that is loaded.

import { HealthService } from '../../lib/servers/health-service.js';

export const name = 'server-health';

export const inject = ['node', 'serverRegistry', 'hubLinks'];

const INTERVAL_MS = 5000;

export function apply(ctx) {
  const health = new HealthService({
    registry: ctx.serverRegistry,
    links: ctx.hubLinks,
    localInfo: () => ctx.node.info(),
    moshStatus: (serverId, context) => ctx.get('moshHub')?.status(serverId, context) ?? null,
    onStatus: (status) => ctx.emit('status/server-status', status),
  });
  ctx.effect(() => {
    health.start(INTERVAL_MS);
    return () => health.stop();
  }, 'server-health.probes');
  ctx.provide('serverHealth', health);
}
