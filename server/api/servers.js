/**
 * Server registry API.
 *
 * Every route resolves the serverId through the registry before doing anything,
 * so a client can never hand us a host, user or command to connect to.
 */

import express from 'express';

import { AppError, ErrorCode, handle } from '../servers/errors.js';
import { requireSameOrigin } from './same-origin.js';


const SERVER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function requireServerId(req) {
  const serverId = req.params.serverId;
  if (typeof serverId !== 'string' || !SERVER_ID_RE.test(serverId)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid server id', { details: { field: 'serverId' } });
  }
  return serverId;
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

  router.patch('/:serverId', handle(async (req) => serverService.update(requireServerId(req), req.body || {})));

  router.delete('/:serverId', handle(async (req, res) => {
    await serverService.remove(requireServerId(req));
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
