/**
 * Terminal WebSocket gateway: `/ws/terminal/:paneId` on this machine.
 *
 * The pane is verified through the workspace before anything is spawned, so a
 * client-supplied id cannot attach to something that is not a live pane. A
 * hub reaches another machine's pane by relaying the socket to that machine's
 * gateway; nothing here ever spawns ssh.
 */

import { AppError, ErrorCode } from '../servers/errors.js';
import { ServerMessage, parseTerminalPath, parseTerminalQuery } from './protocol.js';

export class TerminalGateway {
  constructor({ workspace, terminalManager }) {
    this.workspace = workspace;
    this.terminalManager = terminalManager;
  }

  /**
   * Entry point for the HTTP upgrade handler. Never throws: every failure ends
   * as a structured error frame plus a close, so one bad URL cannot take down
   * the server's upgrade listener.
   */
  async handle(ws, pathname, searchParams) {
    const target = parseTerminalPath(pathname);
    if (!target) {
      this._fail(ws, 1008, { code: ErrorCode.VALIDATION_ERROR, message: 'Malformed terminal address' });
      return null;
    }
    const { cols, rows, nozoom } = parseTerminalQuery(searchParams);
    try {
      const resolved = await this.workspace.resolvePane(target.paneId);
      // Whoever opened this may have moved on during the check. `attach-session -d`
      // for nobody would take the pane from the client they moved on to.
      if (ws.readyState !== ws.OPEN) return null;
      return this._attach(ws, resolved, { cols, rows, nozoom });
    } catch (err) {
      const appError = err instanceof AppError ? err : new AppError(ErrorCode.INTERNAL, 'Terminal setup failed');
      this._fail(ws, appError.code === ErrorCode.CONNECTION_LIMIT ? 1013 : 1008, appError);
      return null;
    }
  }

  _fail(ws, closeCode, error) {
    try {
      if (ws.readyState === ws.OPEN) {
        ws.send(ServerMessage.error({
          code: error.code || ErrorCode.INTERNAL,
          message: error.message || 'Terminal unavailable',
          retryable: error.retryable === true,
        }));
      }
      ws.close(closeCode, error.code || 'error');
    } catch {
      // Socket already gone.
    }
  }

  /** tmux keeps the pane's state, so each socket owns its own attach client. */
  _attach(ws, resolved, { cols, rows, nozoom }) {
    const options = {
      sessionTarget: resolved.sessionId,
      onReject: ({ code, message }) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(ServerMessage.error({ code, message, retryable: code === ErrorCode.CONNECTION_LIMIT }));
        }
      },
      onPtyExit: (info) => {
        if (ws.readyState === ws.OPEN) ws.send(ServerMessage.exit(info));
      },
    };
    const connectionId = this.terminalManager.create(ws, resolved.paneId, cols, rows, nozoom, options);
    if (!connectionId) return null;
    if (ws.readyState === ws.OPEN) {
      ws.send(ServerMessage.ready({ paneId: resolved.paneId, provider: 'tmux', persistence: 'tmux' }));
    }
    return connectionId;
  }
}
