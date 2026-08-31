/**
 * Terminal WebSocket gateway.
 *
 * Owns the decision of how one socket reaches one pane:
 *   local tmux  -> the existing TerminalManager, unchanged
 *   remote tmux -> the same attach template, run through `ssh -tt`
 *   ssh provider -> subscribe to the pane's long-lived PaneRuntime
 *
 * Ownership is always verified through the workspace before anything is
 * spawned, so a pane id from the client cannot address another server's pane.
 */

import { AppError, ErrorCode } from '../servers/errors.js';
import { extractOsc52, buildTmuxAttachCommand } from '../terminal.js';
import { LOCAL_SERVER_ID } from '../servers/registry.js';
import {
  ServerMessage,
  parseClientMessage,
  parseTerminalPath,
  parseTerminalQuery,
} from './protocol.js';

export class TerminalGateway {
  constructor({ registry, workspace, pool, terminalManager, maxConnectionsPerPane = null }) {
    this.registry = registry;
    this.workspace = workspace;
    this.pool = pool;
    this.terminalManager = terminalManager;
    // Mirror the tmux quota so an SSH pane cannot be attached without bound.
    this.maxConnectionsPerPane = maxConnectionsPerPane
      || (terminalManager && terminalManager.maxConnectionsPerPane)
      || 5;
  }

  _nextFocusEpoch() {
    this._focusSeq = (this._focusSeq || 0) + 1;
    return this._focusSeq;
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
      if (!this.registry.has(target.serverId)) {
        throw new AppError(ErrorCode.SERVER_NOT_FOUND, `Server ${target.serverId} is not registered`);
      }
      // Resolving proves the pane exists on *this* server before we spawn.
      const resolved = await this.workspace.resolvePane(target.serverId, target.paneId);

      if (resolved.provider === 'tmux') {
        return this._attachTmux(ws, resolved, { cols, rows, nozoom });
      }
      return this._attachSsh(ws, resolved, { cols, rows });
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

  /**
   * tmux panes keep their state in tmux, so each socket owns its own attach
   * client exactly as before. Remote hosts run the identical template over ssh.
   */
  _attachTmux(ws, resolved, { cols, rows, nozoom }) {
    const options = {
      serverId: resolved.serverId,
      onReject: ({ code, message }) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(ServerMessage.error({
            code,
            message,
            retryable: code === ErrorCode.CONNECTION_LIMIT,
          }));
        }
      },
      onPtyExit: (info) => {
        if (ws.readyState === ws.OPEN) ws.send(ServerMessage.exit(info));
      },
    };

    if (resolved.serverId !== LOCAL_SERVER_ID) {
      const executor = this.pool.get(resolved.serverId);
      const remoteCommand = buildTmuxAttachCommand(resolved.paneId, { nozoom });
      // Fixed template only: nothing from the client reaches this string.
      options.spawn = { file: 'ssh', args: executor.ptyArgs(remoteCommand) };
    }

    const connectionId = this.terminalManager.create(ws, resolved.paneId, cols, rows, nozoom, options);
    if (!connectionId) return null;

    if (ws.readyState === ws.OPEN) {
      ws.send(ServerMessage.ready({
        serverId: resolved.serverId,
        paneId: resolved.paneId,
        provider: 'tmux',
        persistence: 'tmux',
        replayedBytes: 0,
      }));
    }
    return connectionId;
  }

  /**
   * SSH panes outlive their sockets. The socket becomes a subscriber of the
   * pane's runtime; closing it detaches only, so a refresh reconnects.
   */
  _attachSsh(ws, resolved, { cols, rows }) {
    const runtime = this.workspace.sshRuntime(resolved.serverId, resolved.paneId);
    if (!runtime) {
      throw new AppError(ErrorCode.PANE_NOT_FOUND, `Pane ${resolved.paneId} has no runtime`);
    }
    if (runtime.subscribers.size >= this.maxConnectionsPerPane) {
      throw new AppError(
        ErrorCode.CONNECTION_LIMIT,
        `Connection limit reached for pane ${resolved.paneId}`,
        { retryable: true },
      );
    }

    // Each subscriber parses its own stream: OSC 52 sequences can straddle
    // chunks, and a late subscriber starts from a different point in the buffer.
    let osc52Pending = '';
    const forward = (chunk) => {
      if (ws.readyState !== ws.OPEN) return;
      const { clipboard, cleaned, pending } = extractOsc52(osc52Pending + chunk);
      osc52Pending = pending;
      for (const text of clipboard) ws.send(ServerMessage.clipboard(text));
      if (cleaned.length > 0) ws.send(ServerMessage.output(cleaned));
    };

    const subscriber = {
      send: forward,
      exit: (info) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(ServerMessage.exit({
            code: info.code,
            signal: info.signal,
            reason: info.reason || 'remote_shell_exit',
          }));
          // 1000: a deliberate end, so the client must not auto-reconnect.
          ws.close(1000, 'pane exited');
        }
      },
    };

    runtime.resize(cols, rows, { focusEpoch: this._nextFocusEpoch(), subscriber });
    const replay = runtime.subscribe(subscriber);

    if (ws.readyState === ws.OPEN) {
      ws.send(ServerMessage.ready({
        serverId: resolved.serverId,
        paneId: resolved.paneId,
        provider: 'ssh',
        persistence: 'process-memory',
        replayedBytes: Buffer.byteLength(replay || '', 'utf8'),
      }));
      if (replay) forward(replay);
    }

    ws.on('message', (raw) => {
      const msg = parseClientMessage(raw);
      if (!msg) return;
      if (msg.type === 'input') {
        runtime.write(msg.data);
        return;
      }
      if (msg.type === 'resize') {
        const epoch = msg.focusEpoch === null ? this._nextFocusEpoch() : msg.focusEpoch;
        runtime.resize(msg.cols, msg.rows, { focusEpoch: epoch, subscriber });
        return;
      }
      if (msg.type === 'focus') {
        runtime.noteFocus(subscriber, msg.focusEpoch);
      }
    });

    const detach = () => {
      // Detach only. Killing the PTY here is what made a refresh lose the shell.
      runtime.unsubscribe(subscriber);
    };
    ws.on('close', detach);
    ws.on('error', detach);

    return { runtime, subscriber };
  }
}
