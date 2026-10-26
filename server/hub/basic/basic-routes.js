/**
 * What the hub answers under /n/:serverId for a basic-mode host.
 *
 * The workspace API and terminal sockets have the exact shape a node serves,
 * so the browser needs no special case. Every other machine path answers
 * NODE_NOT_INSTALLED, which the UI turns into an offer to install the panel.
 */

import express from 'express';

import { createWorkspaceRouter } from '../../api/workspace.js';
import { AppError, ErrorCode, fail } from '../../servers/errors.js';
import { attachBasicTerminal } from './basic-terminal.js';

function sendError(res, err) {
  const appError = err instanceof AppError ? err : new AppError(ErrorCode.INTERNAL, 'Basic mode request failed');
  if (res.headersSent) { res.destroy(); return; }
  res.status(appError.status).json(fail(appError));
}

export function needsNode() {
  return new AppError(ErrorCode.NODE_NOT_INSTALLED, 'This needs tmux-web-panel installed on that machine');
}

export function createBasicHttp({ links }) {
  const routers = new Map();
  const parseJson = express.json();
  return (req, res, serverId, target) => {
    if (!/^\/api\/workspace(\/|$|\?)/.test(target.path)) {
      sendError(res, needsNode());
      return;
    }
    let host;
    try {
      host = links.basic(serverId);
    } catch (err) {
      sendError(res, err);
      return;
    }
    let entry = routers.get(serverId);
    if (!entry || entry.host !== host) {
      entry = { host, router: createWorkspaceRouter({ workspaceService: host }) };
      routers.set(serverId, entry);
    }
    req.url = target.path.slice('/api/workspace'.length) || '/';
    if (req.url.startsWith('?')) req.url = '/' + req.url;
    parseJson(req, res, (err) => {
      if (err) { sendError(res, new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid JSON body')); return; }
      entry.router(req, res, () => sendError(res, new AppError(ErrorCode.UNSUPPORTED, 'Unknown workspace route')));
    });
  };
}

/**
 * @param {object} deps
 * @param {import('ws').WebSocketServer} deps.wss
 * @param {import('../../terminal.js').TerminalManager} deps.terminalManager
 */
export function createBasicUpgrade({ links, wss, terminalManager }) {
  return (req, socket, head, serverId, target) => {
    let host;
    try {
      host = links.basic(serverId);
    } catch {
      socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (target.pathname === '/ws/status') {
        // A basic host has no event source; the socket stays open so the page
        // does not spin reconnecting, and the workspace is polled instead.
        return;
      }
      const searchParams = new URLSearchParams(target.path.includes('?') ? target.path.slice(target.path.indexOf('?') + 1) : '');
      attachBasicTerminal(ws, host, {
        serverId,
        pathname: target.pathname,
        searchParams,
        terminalManager,
        maxConnectionsPerPane: terminalManager.maxConnectionsPerPane || 5,
      }).catch(() => {
        try { ws.close(1011, 'terminal setup failed'); } catch { /* gone */ }
      });
    });
  };
}
