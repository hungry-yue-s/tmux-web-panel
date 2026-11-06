/**
 * Metrics API for this machine, mounted at /api/metrics.
 *
 * Unknown values are reported through the `availability` map and stay null —
 * a host that cannot be sampled must never render as 0%.
 */

import express from 'express';

import { handle } from '../servers/errors.js';
import { requireSameOrigin } from './same-origin.js';

export function createMetricsRouter({ metricsService }) {
  const router = express.Router();
  router.use(requireSameOrigin);

  router.get('/current', handle(async (req) => metricsService.current({ force: req.query.force === '1' })));

  router.get('/history', handle(async (req) => metricsService.history({ windowSeconds: req.query.window })));

  router.get('/drilldown', handle(async (req) => metricsService.drilldown({
    session: req.query.session,
    windowIndex: req.query.windowIndex,
  })));

  return router;
}
