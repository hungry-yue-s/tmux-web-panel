/**
 * Terminal sockets for a basic-mode host, answered by the hub.
 *
 *   remote tmux  -> an `ssh -tt` attach client per socket, run through the
 *                   TerminalManager like a local tmux attach
 *   hosted shell -> the socket subscribes to the pane's long-lived PaneRuntime
 *
 * Pane ownership is verified through the host before anything is spawned.
 */

import { AppError, ErrorCode } from '../../servers/errors.js';
import { extractOsc52 } from '../../terminal.js';
import { ServerMessage, parseClientMessage, parseTerminalPath, parseTerminalQuery } from '../../terminal/protocol.js';
import { sshPtyBinary } from '../../transport/ssh-connection.js';

let focusSeq = 0;
const nextFocusEpoch = () => { focusSeq += 1; return focusSeq; };

function fail(ws, closeCode, error) {
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
 * Never throws: a failure ends as an error frame plus a close.
 * @param {import('ws').WebSocket} ws
 * @param {import('./basic-host.js').BasicHost} host
 */
export async function attachBasicTerminal(ws, host, { serverId, pathname, searchParams, terminalManager, maxConnectionsPerPane = 5 }) {
  const target = parseTerminalPath(pathname);
  if (!target) {
    fail(ws, 1008, { code: ErrorCode.VALIDATION_ERROR, message: 'Malformed terminal address' });
    return null;
  }
  const { cols, rows, nozoom } = parseTerminalQuery(searchParams);
  try {
    const resolved = await host.resolvePane(target.paneId);
    if (ws.readyState !== ws.OPEN) return null;
    if (resolved.provider === 'tmux') {
      const args = await host.attachArgs(resolved.paneId, nozoom);
      if (ws.readyState !== ws.OPEN) return null;
      const connectionId = terminalManager.create(ws, resolved.paneId, cols, rows, nozoom, {
        scope: serverId,
        spawn: { file: sshPtyBinary(), args, env: host.connection.sshEnv() },
        onReject: ({ code, message }) => {
          if (ws.readyState === ws.OPEN) ws.send(ServerMessage.error({ code, message, retryable: code === ErrorCode.CONNECTION_LIMIT }));
        },
        onPtyExit: (info) => {
          if (ws.readyState === ws.OPEN) ws.send(ServerMessage.exit(info));
        },
      });
      if (connectionId && ws.readyState === ws.OPEN) {
        ws.send(ServerMessage.ready({ paneId: resolved.paneId, provider: 'tmux', persistence: 'tmux' }));
      }
      return connectionId;
    }
    return attachHostedShell(ws, host, resolved, { cols, rows, maxConnectionsPerPane });
  } catch (err) {
    const appError = err instanceof AppError ? err : new AppError(ErrorCode.INTERNAL, 'Terminal setup failed');
    fail(ws, appError.code === ErrorCode.CONNECTION_LIMIT ? 1013 : 1008, appError);
    return null;
  }
}

/**
 * Hosted shells outlive their sockets. The socket becomes a subscriber of the
 * pane's runtime; closing it detaches only, so a refresh reconnects.
 */
function attachHostedShell(ws, host, resolved, { cols, rows, maxConnectionsPerPane }) {
  const runtime = host.sshRuntime(resolved.paneId);
  if (!runtime) throw new AppError(ErrorCode.PANE_NOT_FOUND, `Pane ${resolved.paneId} has no runtime`);
  if (runtime.subscribers.size >= maxConnectionsPerPane) {
    throw new AppError(ErrorCode.CONNECTION_LIMIT, `Connection limit reached for pane ${resolved.paneId}`, { retryable: true });
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
        ws.send(ServerMessage.exit({ code: info.code, signal: info.signal, reason: info.reason || 'remote_shell_exit' }));
        // 1000: a deliberate end, so the client must not auto-reconnect.
        ws.close(1000, 'pane exited');
      }
    },
  };

  runtime.resize(cols, rows, { focusEpoch: nextFocusEpoch(), subscriber });
  const replay = runtime.subscribe(subscriber);
  if (ws.readyState === ws.OPEN) {
    ws.send(ServerMessage.ready({ paneId: resolved.paneId, provider: 'ssh', persistence: 'process-memory' }));
    if (replay) forward(replay);
  }

  ws.on('message', (raw) => {
    const msg = parseClientMessage(raw);
    if (!msg) return;
    if (msg.type === 'input') runtime.write(msg.data);
    else if (msg.type === 'resize') {
      runtime.resize(msg.cols, msg.rows, { focusEpoch: msg.focusEpoch === null ? nextFocusEpoch() : msg.focusEpoch, subscriber });
    } else if (msg.type === 'focus') runtime.noteFocus(subscriber, msg.focusEpoch);
  });
  const detach = () => runtime.unsubscribe(subscriber);
  ws.on('close', detach);
  ws.on('error', detach);
  return { runtime, subscriber };
}
