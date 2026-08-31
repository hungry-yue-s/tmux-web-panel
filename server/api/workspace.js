/**
 * Server-scoped workspace API.
 *
 * Mounted under /api/servers so every route inherits :serverId. Stable ids are
 * the addressing scheme; names are display data and are only used for renames.
 *
 * Mutations carry the provider the page was rendered against in the
 * X-Workspace-Provider header. It travels as a header rather than in the body so
 * the strict body validators do not have to tolerate an extra field.
 */

import express from 'express';

import { AppError, ErrorCode, handle } from '../servers/errors.js';
import { requireSameOrigin } from './servers.js';

const SERVER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ID_MAX = 64;
const PROVIDERS = new Set(['tmux', 'ssh']);

function requireServerId(req) {
  const serverId = req.params.serverId;
  if (typeof serverId !== 'string' || !SERVER_ID_RE.test(serverId)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid server id', { details: { field: 'serverId' } });
  }
  return serverId;
}

function requireId(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.length > ID_MAX) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, `Invalid ${field}`, { details: { field } });
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, `Invalid ${field}`, { details: { field } });
  }
  return value;
}

/**
 * The provider the client believed it was acting on. Required for mutations so
 * a stale page cannot apply a tmux action to an SSH workspace or vice versa.
 */
function expectedProvider(req, { required = true } = {}) {
  const header = req.get('x-workspace-provider');
  if (!header) {
    if (!required) return null;
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      'X-Workspace-Provider header is required for workspace changes',
      { details: { field: 'X-Workspace-Provider' } },
    );
  }
  const value = String(header).trim().toLowerCase();
  if (!PROVIDERS.has(value)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, `Unknown workspace provider: ${value}`, {
      details: { field: 'X-Workspace-Provider' },
    });
  }
  return value;
}

export function createWorkspaceRouter({ workspaceService }) {
  const router = express.Router();
  router.use(requireSameOrigin);

  router.get('/:serverId/workspace', handle(async (req) => workspaceService.getWorkspace(requireServerId(req))));

  router.get('/:serverId/sessions', handle(async (req) => {
    const workspace = await workspaceService.getWorkspace(requireServerId(req));
    return { provider: workspace.provider, revision: workspace.revision, sessions: workspace.sessions };
  }));

  router.get('/:serverId/windows/:windowId/panes', handle(async (req) => workspaceService.getWindowPanes(
    requireServerId(req),
    requireId(req.params.windowId, 'windowId'),
  )));

  router.post('/:serverId/sessions', handle(async (req, res) => {
    const created = await workspaceService.createSession(
      requireServerId(req),
      req.body || {},
      expectedProvider(req),
    );
    res.status(201);
    return created;
  }));

  router.patch('/:serverId/sessions/:sessionId', handle(async (req) => workspaceService.renameSession(
    requireServerId(req),
    requireId(req.params.sessionId, 'sessionId'),
    req.body || {},
    expectedProvider(req),
  )));

  router.delete('/:serverId/sessions/:sessionId', handle(async (req, res) => {
    await workspaceService.closeSession(
      requireServerId(req),
      requireId(req.params.sessionId, 'sessionId'),
      expectedProvider(req),
    );
    res.status(204).end();
  }));

  router.post('/:serverId/sessions/:sessionId/windows', handle(async (req, res) => {
    const created = await workspaceService.createWindow(
      requireServerId(req),
      requireId(req.params.sessionId, 'sessionId'),
      req.body || {},
      expectedProvider(req),
    );
    res.status(201);
    return created;
  }));

  router.patch('/:serverId/windows/:windowId', handle(async (req) => workspaceService.renameWindow(
    requireServerId(req),
    requireId(req.params.windowId, 'windowId'),
    req.body || {},
    expectedProvider(req),
  )));

  router.delete('/:serverId/windows/:windowId', handle(async (req, res) => {
    await workspaceService.closeWindow(
      requireServerId(req),
      requireId(req.params.windowId, 'windowId'),
      expectedProvider(req),
    );
    res.status(204).end();
  }));

  router.post('/:serverId/windows/:windowId/panes', handle(async (req, res) => {
    const created = await workspaceService.splitPane(
      requireServerId(req),
      requireId(req.params.windowId, 'windowId'),
      req.body || {},
      expectedProvider(req),
    );
    res.status(201);
    return created;
  }));

  router.patch('/:serverId/panes/:paneId', handle(async (req) => workspaceService.updatePane(
    requireServerId(req),
    requireId(req.params.paneId, 'paneId'),
    req.body || {},
    expectedProvider(req),
  )));

  router.delete('/:serverId/panes/:paneId', handle(async (req, res) => {
    await workspaceService.closePane(
      requireServerId(req),
      requireId(req.params.paneId, 'paneId'),
      expectedProvider(req),
    );
    res.status(204).end();
  }));

  // Provider switching is an explicit, destructive user choice, never automatic.
  router.post('/:serverId/workspace/adopt-provider', handle(async (req) => {
    const serverId = requireServerId(req);
    const switched = workspaceService.forceProviderSwitch(serverId);
    return { serverId, switched, provider: (await workspaceService.getWorkspace(serverId)).provider };
  }));

  return router;
}
