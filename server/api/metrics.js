/**
 * Server-scoped metrics API.
 *
 * Mounted under /api/servers. Unknown values are reported through the
 * `availability` map and stay null — a remote host that cannot be sampled must
 * never render as 0%.
 */

import express from 'express';

import { AppError, ErrorCode, handle } from '../servers/errors.js';
import { requireSameOrigin } from './servers.js';

const SERVER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function requireServerId(req) {
  const serverId = req.params.serverId;
  if (typeof serverId !== 'string' || !SERVER_ID_RE.test(serverId)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid server id', { details: { field: 'serverId' } });
  }
  return serverId;
}

export function createServerMetricsRouter({ metricsService }) {
  const router = express.Router();
  router.use(requireSameOrigin);

  router.get('/:serverId/metrics/current', handle(async (req) => {
    const force = req.query.force === '1';
    return metricsService.current(requireServerId(req), { force });
  }));

  router.get('/:serverId/metrics/history', handle(async (req) => metricsService.history(requireServerId(req), {
    windowSeconds: req.query.window,
  })));

  router.get('/:serverId/metrics/drilldown', handle(async (req) => metricsService.drilldown(requireServerId(req), {
    session: req.query.session,
    windowIndex: req.query.windowIndex,
  })));

  return router;
}
