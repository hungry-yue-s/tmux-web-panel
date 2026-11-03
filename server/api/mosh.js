/**
 * /api/mosh/sessions: mosh sessions for a hub's own mosh-client (see mosh/server.js).
 *
 * A session's answer carries the key that decrypts its traffic, so only the node
 * token may ask. A browser's login token is refused even on the machine it is
 * logged in to, and hubs never relay this path (hub/proxy.js), so the key cannot
 * reach a browser that way either.
 */

import express from 'express';

import { AppError, ErrorCode, fail, handle } from '../servers/errors.js';
import { PANE_ID_PATTERN } from '../terminal.js';
import { HUB_CALL_HEADER } from '../hub/node-link.js';
import { SESSION_ID_RE } from '../mosh/server.js';

function bearer(header) {
  return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null;
}

export function createMoshRouter({ mosh, isNodeToken }) {
  const router = express.Router();

  router.use((req, res, next) => {
    const token = bearer(req.headers.authorization);
    // A relayed request has the node token too, but the hub strips this mark from it.
    if (token && isNodeToken(token) && req.headers[HUB_CALL_HEADER] === '1') return next();
    res.status(403).json(fail(new AppError(ErrorCode.UNSUPPORTED, 'Only a hub can open mosh sessions', { status: 403 })));
    return undefined;
  });

  // The hub names the session, so it can end one whose answer never reached it.
  router.post('/sessions', handle(async (req, res) => {
    const { id, paneId, nozoom = false } = req.body || {};
    if (typeof id !== 'string' || !SESSION_ID_RE.test(id)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid session id', { details: { field: 'id' } });
    }
    if (typeof paneId !== 'string' || !PANE_ID_PATTERN.test(paneId)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid paneId', { details: { field: 'paneId' } });
    }
    // A hub that gave up waiting gets nothing started for it.
    res.on('close', () => { if (!res.writableFinished) mosh.stop(id).catch(() => {}); });
    const session = await mosh.start({ id, paneId, nozoom: nozoom === true });
    res.status(201);
    return session;
  }));

  router.get('/sessions/:id', handle(async (req) => {
    if (!SESSION_ID_RE.test(req.params.id)) throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid session id');
    return mosh.state(req.params.id);
  }));

  /** `clean`: nothing the session started is known to be running. Without it, no other terminal may take its place. */
  router.delete('/sessions/:id', handle(async (req) => {
    if (!SESSION_ID_RE.test(req.params.id)) throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid session id');
    return mosh.stop(req.params.id);
  }));

  return router;
}
