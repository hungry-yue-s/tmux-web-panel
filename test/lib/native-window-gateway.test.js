import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { NativeWindowGateway, parseNativeWindowTarget } from '../../lib/terminal/native-window-gateway.js';
import { AppError, ErrorCode } from '../../lib/servers/errors.js';
const params = () => new URLSearchParams('instanceId=1:2&sessionId=$1&clientId=browser-123&protocol=1&cols=80&rows=24');
class Socket extends EventEmitter {
  constructor() { super(); this.OPEN = 1; this.readyState = 1; this.frames = []; this.bufferedAmount = 0; }
  send(data) { this.frames.push(JSON.parse(data)); }
  close(code) { this.code = code; this.readyState = 3; this.emit('close'); }
  ping() {}
}
describe('native window gateway', () => {
  it('accepts a stable native window and tab identity, never a command or malformed grid', () => {
    expect(parseNativeWindowTarget('/ws/native-window/%402', params())).toEqual({ instanceId: '1:2', sessionId: '$1', windowId: '@2', clientId: 'browser-123', cols: 80, rows: 24 });
    for (const [key, value] of [['clientId', 'x;kill-server'], ['cols', '0'], ['rows', '2x'], ['instanceId', 'stale']]) {
      const query = params(); query.set(key, value); expect(() => parseNativeWindowTarget('/ws/native-window/@2', query)).toThrow();
    }
  });
  it('passes startup responses separately from gated user input and releases only the subscription', async () => {
    const lease = { input: vi.fn(), response: vi.fn(), close: vi.fn() }, ws = new Socket();
    const pool = { subscribe: vi.fn(async () => lease) };
    await new NativeWindowGateway({ pool }).handle(ws, '/ws/native-window/@2', params());
    ws.emit('message', JSON.stringify({ type: 'response', encoding: 'base64', data: Buffer.from('\x1b[?62;4c').toString('base64') }));
    ws.emit('message', JSON.stringify({ type: 'input', encoding: 'base64', data: 'Ag==' }));
    await Promise.resolve();
    expect(lease.response).toHaveBeenCalledWith(Buffer.from('\x1b[?62;4c'));
    expect(lease.input).toHaveBeenCalledWith(Buffer.from([2]));
    ws.close(1000); expect(lease.close).toHaveBeenCalledOnce();
  });
  it('closes an asynchronous hydration failure with its safe error', async () => {
    const ws = new Socket(); let end;
    const pool = { subscribe: async (_target, _send, options) => { end = options.end; return { close() {} }; } };
    await new NativeWindowGateway({ pool }).handle(ws, '/ws/native-window/@2', params());
    end(new AppError(ErrorCode.WORKSPACE_UNAVAILABLE, 'Native client unavailable'));
    expect(ws.frames.at(-1)).toMatchObject({ type: 'error', message: 'Native client unavailable' });
    expect(ws.readyState).toBe(3);
  });
  it('requests fresh focus on the owned native client and rejects unbounded identifiers', async () => {
    const lease = { context: vi.fn(), close: vi.fn() }, ws = new Socket();
    await new NativeWindowGateway({ pool: { subscribe: async () => lease } }).handle(ws, '/ws/native-window/@2', params());
    ws.emit('message', JSON.stringify({ type: 'context-request', requestId: 'focus_1' }));
    await Promise.resolve();
    expect(lease.context).toHaveBeenCalledWith('focus_1');
    ws.emit('message', JSON.stringify({ type: 'context-request', requestId: 'x'.repeat(65) }));
    await Promise.resolve(); await Promise.resolve();
    expect(ws.frames.at(-1)).toMatchObject({ type: 'error', code: 'VALIDATION_ERROR' });
    expect(lease.context).toHaveBeenCalledTimes(1);
    expect(lease.close).toHaveBeenCalledOnce();
  });
});
