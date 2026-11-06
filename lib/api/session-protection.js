/**
 * Session protection API for this machine. Mounted at /api/session-protection;
 * a hub reaches another machine's at /n/:serverId/api/session-protection.
 */

import express from 'express';

import { AppError, ErrorCode, handle } from '../servers/errors.js';
import { requireSameOrigin } from './same-origin.js';

const TEXT_MAX = 256;

function requireText(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.length > TEXT_MAX || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, `Invalid ${field}`, { details: { field } });
  }
  return value;
}

export function createSessionProtectionRouter({ protection }) {
  const router = express.Router();
  router.use(requireSameOrigin);

  router.get('/', handle(() => protection.status()));
  router.put('/', handle((req) => {
    const { enabled, programs } = req.body || {};
    return protection.update({ enabled, programs });
  }));
  router.post('/save', handle(() => protection.saveNow()));
  router.get('/snapshots', handle(() => protection.snapshots()));
  router.post('/snapshots/:id/restore', handle(async (req, res) => {
    const restored = await protection.restore(requireText(req.params.id, 'id'), requireText((req.body || {}).session, 'session'));
    res.status(201);
    return restored;
  }));
  router.post('/base/link', handle(() => protection.linkBase()));
  return router;
}
