// Bounded diagnostics for remote performance (lib/diagnostics.js).
//
// The recorder is one per process; this plugin configures it, counts every
// response's bytes before compression and relaying (order -100), tracks every
// upgraded socket, serves /api/diagnostics, and stops it when unloaded.

import { diagnostics } from '../../lib/diagnostics.js';
import { startPlatformSampler } from '../../lib/diagnostics-platform.js';
import { createDiagnosticsRouter } from '../../lib/api/diagnostics.js';
import { UPGRADED_SOCKET } from '../http/index.js';

export const name = 'diagnostics';

export const inject = ['launch', 'http'];

const NODE_PATH_RE = /^\/n\/([a-z0-9][a-z0-9._-]{0,63})\//;

export function apply(ctx) {
  diagnostics.configure({ configDir: ctx.launch.configDir, platformSampler: startPlatformSampler });
  ctx.effect(() => () => diagnostics.stop('shutdown').catch(() => {
    ctx.logger.warn('capture close failed');
  }), 'diagnostics.stop');

  const middleware = diagnostics.middleware();
  ctx.http.use(middleware, { order: -100 });

  ctx.http.useUpgrade(({ req, socket }) => {
    const path = String(req.url || '').split('?', 1)[0];
    const server = NODE_PATH_RE.exec(path);
    diagnostics.trackSocket(socket, {
      serverId: server ? server[1] : 'local',
      path,
      side: 'client',
      provider: 'http-ws-framing',
    }, () => req[UPGRADED_SOCKET]?.bufferedAmount ?? null);
    return false;
  }, { order: -100 });

  ctx.http.mount('/api/diagnostics', createDiagnosticsRouter({ diagnostics }));
  ctx.provide('diagnostics', diagnostics);
}
