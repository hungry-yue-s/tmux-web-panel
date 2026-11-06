/** Browser JSON protocol for byte-exact, natively snapshotted pane streams. */
import { AppError, ErrorCode } from '../servers/errors.js';
import { MAX_HELD_INPUT_BYTES, MAX_INPUT_BYTES, outputFrameOptions } from './protocol.js';
import { validControlSize, validateControlTarget } from './control-pool.js';

export function parsePaneStreamTarget(pathname, query) {
  let paneId;
  try {
    const match = /^\/ws\/pane-stream\/([^/]+)$/.exec(pathname);
    if (!match) throw new Error();
    paneId = decodeURIComponent(match[1]);
  } catch { throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid pane stream address'); }
  if (query.get('protocol') !== '1') throw new AppError(ErrorCode.UNSUPPORTED, 'Unsupported pane stream protocol');
  return validateControlTarget({ paneId, instanceId: query.get('instanceId'), sessionId: query.get('sessionId'), windowId: query.get('windowId') });
}

export class ControlGateway {
  constructor({ pool, parseTarget = parsePaneStreamTarget, responses = false, contextRequests = false }) { this.pool = pool; this.parseTarget = parseTarget; this.responses = responses; this.contextRequests = contextRequests; }

  async handle(ws, pathname, query) {
    let lease = null, detached = false, earlyBytes = 0, pongTimer = null;
    const early = [];
    const send = frame => {
      if (ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount > MAX_HELD_INPUT_BYTES) {
        ws.close(1013, 'pane stream backpressure');
        throw new AppError(ErrorCode.CONNECTION_LIMIT, 'The terminal view is too slow');
      }
      const data = JSON.stringify(frame);
      ws.send(data, outputFrameOptions(data));
    };
    const fail = error => {
      const safe = error instanceof AppError ? error : new AppError(ErrorCode.INTERNAL, 'Pane stream failed');
      try { send({ type: 'error', code: safe.code, message: safe.message, retryable: safe.retryable }); } catch { /* already closed for backpressure */ }
      if (ws.readyState === ws.OPEN) ws.close(safe.retryable ? 1011 : 1008, safe.code);
    };
    const dispatch = async raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (!message || !lease || detached) return;
      if (message.type === 'input' || (message.type === 'response' && this.responses)) {
        if (typeof message.data !== 'string') throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid terminal input');
        let input = message.data;
        if (message.encoding === 'base64') {
          if (input.length > 4 * Math.ceil(MAX_INPUT_BYTES / 3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input)) throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid terminal input encoding');
          input = Buffer.from(input, 'base64');
        } else if (message.encoding !== undefined) throw new AppError(ErrorCode.VALIDATION_ERROR, 'Unsupported terminal input encoding');
        if (Buffer.byteLength(input) > MAX_INPUT_BYTES) throw new AppError(ErrorCode.VALIDATION_ERROR, 'Terminal input exceeded its limit');
        if (message.type === 'response') await lease.response(input);
        else await lease.input(input);
      } else if (message.type === 'resize') {
        if (!validControlSize(message.cols, message.rows)) throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid terminal grid');
        await lease.resize(message.cols, message.rows);
      } else if (message.type === 'visibility') {
        if (typeof message.visible !== 'boolean') throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid terminal visibility');
        await lease.visibility(message.visible);
      } else if (message.type === 'context-request' && this.contextRequests) {
        if (typeof message.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(message.requestId)) throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid terminal context request');
        await lease.context(message.requestId);
      }
    };
    const receive = raw => {
      if (detached) return;
      if (!lease) {
        earlyBytes += Buffer.byteLength(raw);
        if (earlyBytes > MAX_HELD_INPUT_BYTES || early.length >= 128) {
          fail(new AppError(ErrorCode.VALIDATION_ERROR, 'Too much input before the snapshot'));
          return;
        }
        early.push(raw);
      } else dispatch(raw).catch(fail);
    };
    const detach = () => {
      if (detached) return;
      detached = true;
      clearInterval(ping);
      clearTimeout(pongTimer);
      early.length = 0;
      ws.off('message', receive);
      ws.off('pong', pong);
      lease?.close();
    };
    const pong = () => { clearTimeout(pongTimer); pongTimer = null; };
    const ping = setInterval(() => {
      if (ws.readyState !== ws.OPEN || pongTimer) return;
      pongTimer = setTimeout(() => {
        // Releasing the lease must not depend on a half-open TCP socket closing.
        detach();
        ws.terminate?.();
      }, 10_000);
      pongTimer.unref?.();
      try { ws.ping?.(); } catch { detach(); ws.terminate?.(); }
    }, 15_000);
    ping.unref?.();
    ws.on('pong', pong);
    ws.on('message', receive);
    ws.once('close', detach);
    ws.on('error', detach);
    try {
      const target = this.parseTarget(pathname, query);
      lease = await this.pool.subscribe(target, send, {
        cancelled: () => detached || ws.readyState !== ws.OPEN,
        end: (code, reason) => { if (code instanceof Error) fail(code); else if (ws.readyState === ws.OPEN) ws.close(code, reason); },
      });
      if (detached || ws.readyState !== ws.OPEN) { lease?.close(); return null; }
      if (lease) for (const raw of early.splice(0)) await dispatch(raw);
      return lease;
    } catch (error) { fail(error); detach(); return null; }
  }
}
