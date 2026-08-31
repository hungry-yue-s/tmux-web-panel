/**
 * Server registry API.
 *
 * Every route resolves the serverId through the registry before doing anything,
 * so a client can never hand us a host, user or command to connect to.
 */

import express from 'express';

import { AppError, ErrorCode, handle } from '../servers/errors.js';

const SERVER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function requireServerId(req) {
  const serverId = req.params.serverId;
  if (typeof serverId !== 'string' || !SERVER_ID_RE.test(serverId)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid server id', { details: { field: 'serverId' } });
  }
  return serverId;
}

/**
 * Rejects credentialed cross-origin writes. The panel authenticates with a
 * bearer token, so this is defence in depth rather than the only control.
 */
export function requireSameOrigin(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.get('origin');
  if (!origin) return next();
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    originHost = null;
  }
  if (originHost && originHost === req.get('host')) return next();
  res.status(403).json({
    success: false,
    data: null,
    error: {
      code: 'FORBIDDEN_ORIGIN',
      message: 'Cross-origin request rejected',
      retryable: false,
      action: 'none',
    },
    meta: { requestId: null },
  });
  return undefined;
}

export function createServersRouter({ serverService }) {
  const router = express.Router();
  router.use(requireSameOrigin);

  router.get('/', handle(async () => serverService.list()));

  router.post('/', handle(async (req, res) => {
    const created = await serverService.create(req.body || {});
    // 201 means "the record is saved", never "the server is connected".
    res.status(201);
    return created;
  }));

  router.get('/:serverId', handle(async (req) => serverService.get(requireServerId(req))));

  router.patch('/:serverId', handle(async (req) => {
    const force = req.query.force === '1' || req.query.force === 'true';
    return serverService.update(requireServerId(req), req.body || {}, { force });
  }));

  router.delete('/:serverId', handle(async (req, res) => {
    const force = req.query.force === '1' || req.query.force === 'true';
    await serverService.remove(requireServerId(req), { force });
    res.status(204).end();
  }));

  router.post('/:serverId/probe', handle(async (req) => serverService.probe(requireServerId(req))));

  router.post('/:serverId/host-key/scan', handle(async (req) => serverService.scanHostKey(requireServerId(req))));

  router.post('/:serverId/host-key/trust', handle(async (req) => {
    const body = req.body || {};
    return serverService.trustHostKey(requireServerId(req), body.fingerprint);
  }));

  return router;
}
