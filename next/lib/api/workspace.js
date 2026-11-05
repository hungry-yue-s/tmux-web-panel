/**
 * Workspace API: this machine's sessions, windows and panes by stable id.
 *
 * Mounted at /api/workspace. A hub reaches another machine's workspace at
 * /n/:serverId/api/workspace, which lands here on that machine. Names are
 * display data and are only used for renames.
 */

import express from 'express';

import { AppError, ErrorCode, handle } from '../servers/errors.js';
import { requireSameOrigin } from './same-origin.js';

const ID_MAX = 64;

function requireId(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.length > ID_MAX) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, `Invalid ${field}`, { details: { field } });
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, `Invalid ${field}`, { details: { field } });
  }
  return value;
}

export function createWorkspaceRouter({ workspaceService }) {
  const router = express.Router();
  router.use(requireSameOrigin);

  router.get('/', handle(async () => workspaceService.getWorkspace()));

  router.get('/windows/:windowId/panes', handle(async (req) => workspaceService.getWindowPanes(
    requireId(req.params.windowId, 'windowId'),
  )));

  router.post('/sessions', handle(async (req, res) => {
    const created = await workspaceService.createSession(req.body || {});
    res.status(201);
    return created;
  }));

  router.patch('/sessions/:sessionId', handle(async (req) => workspaceService.renameSession(
    requireId(req.params.sessionId, 'sessionId'),
    req.body || {},
  )));

  router.delete('/sessions/:sessionId', handle(async (req, res) => {
    await workspaceService.closeSession(requireId(req.params.sessionId, 'sessionId'));
    res.status(204).end();
  }));

  router.post('/sessions/:sessionId/windows', handle(async (req, res) => {
    const created = await workspaceService.createWindow(requireId(req.params.sessionId, 'sessionId'), req.body || {});
    res.status(201);
    return created;
  }));

  router.patch('/windows/:windowId', handle(async (req) => workspaceService.renameWindow(
    requireId(req.params.windowId, 'windowId'),
    req.body || {},
  )));

  router.delete('/windows/:windowId', handle(async (req, res) => {
    await workspaceService.closeWindow(requireId(req.params.windowId, 'windowId'));
    res.status(204).end();
  }));

  router.post('/windows/:windowId/panes', handle(async (req, res) => {
    const created = await workspaceService.splitPane(requireId(req.params.windowId, 'windowId'), req.body || {});
    res.status(201);
    return created;
  }));

  router.patch('/panes/:paneId', handle(async (req) => workspaceService.updatePane(
    requireId(req.params.paneId, 'paneId'),
    req.body || {},
  )));

  router.delete('/panes/:paneId', handle(async (req, res) => {
    await workspaceService.closePane(requireId(req.params.paneId, 'paneId'));
    res.status(204).end();
  }));

  return router;
}
