/**
 * Installing the panel on a managed machine (hub-level, never relayed).
 *
 *   GET  /api/servers/:serverId/node/install   job status and log tail
 *   POST /api/servers/:serverId/node/install   { sudoPassword? } starts it
 *
 * The sudo password is used for this run only and never stored or echoed.
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

export function createNodeInstallRouter({ installer }) {
  const router = express.Router();
  router.use(requireSameOrigin);

  router.get('/:serverId/node/install', handle(async (req) => installer.status(requireServerId(req))));

  router.post('/:serverId/node/install', handle(async (req, res) => {
    const body = req.body || {};
    if (body.sudoPassword !== undefined && (typeof body.sudoPassword !== 'string' || body.sudoPassword.length > 1024)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid sudo password', { details: { field: 'sudoPassword' } });
    }
    const status = installer.start(requireServerId(req), { sudoPassword: body.sudoPassword || '' });
    res.status(202);
    return status;
  }));

  return router;
}
