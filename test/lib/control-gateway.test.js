import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { ControlGateway, parsePaneStreamTarget } from '../../lib/terminal/control-gateway.js';
class Socket extends EventEmitter {
  constructor() { super(); this.OPEN = 1; this.readyState = 1; this.frames = []; this.bufferedAmount = 0; }
  send(data) { this.frames.push(JSON.parse(data)); }
  close(code) { this.code = code; this.readyState = 3; this.emit('close'); }
  ping() {}
}
const params = () => new URLSearchParams('instanceId=1:2&sessionId=$1&windowId=@2&protocol=1&cols=80&rows=24');
describe('pane stream gateway', () => {
  it('expires a half-open socket lease while pong replies keep a healthy view attached', async () => {
    vi.useFakeTimers();
    const ws = new Socket(), lease = { close: vi.fn() };
    ws.ping = vi.fn(); ws.terminate = vi.fn();
    try {
      await new ControlGateway({ pool: { subscribe: async () => lease } }).handle(ws, '/ws/pane-stream/%253', params());
      await vi.advanceTimersByTimeAsync(15_000);
      expect(ws.ping).toHaveBeenCalledOnce(); ws.emit('pong');
      await vi.advanceTimersByTimeAsync(15_000);
      expect(lease.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(lease.close).toHaveBeenCalledOnce(); expect(ws.terminate).toHaveBeenCalledOnce();
      expect(ws.listenerCount('pong')).toBe(0);
      ws.emit('close'); await vi.advanceTimersByTimeAsync(30_000);
      expect(lease.close).toHaveBeenCalledOnce();
    } finally { ws.close(1000); vi.useRealTimers(); }
  });
  it('requires the complete scoped identity and never accepts browser commands or server selectors', () => {
    expect(parsePaneStreamTarget('/ws/pane-stream/%253', params())).toMatchObject({ paneId: '%3', instanceId: '1:2', sessionId: '$1', windowId: '@2' });
    const query = params(); query.delete('instanceId');
    expect(() => parsePaneStreamTarget('/ws/pane-stream/%253', query)).toThrow();
    expect(() => parsePaneStreamTarget('/ws/pane-stream/%zz', params())).toThrow();
  });
  it('cancels a pending subscription when the browser leaves and sends input only after the snapshot fence', async () => {
    const ws = new Socket(); let send, done; let detached = 0, input = [];
    const pool = { subscribe: async (target, callback, { cancelled }) => { send = callback; await new Promise(resolve => { done = resolve; });
      if (cancelled()) return null;
      callback({ type: 'snapshot', seq: 0, data: '', encoding: 'base64', cols: 80, rows: 24 });
      return { close: () => detached++, input: value => input.push(value), resize: () => {}, visibility: () => {} };
    } };
    const gateway = new ControlGateway({ pool });
    const pending = gateway.handle(ws, '/ws/pane-stream/%253', params());
    ws.emit('message', JSON.stringify({ type: 'input', data: 'once' }));
    expect(input).toEqual([]);
    done(); await pending;
    await Promise.resolve();
    expect(input).toEqual(['once']);
    ws.close(1000);
    expect(detached).toBe(1);
    send({ type: 'output', data: 'unused', seq: 1 });
    expect(ws.frames).toHaveLength(1);
  });
  it('validates binary input encoding and forwards the exact decoded bytes', async () => {
    const ws = new Socket(); const received = [];
    const pool = { subscribe: async () => ({ close: () => {}, input: bytes => received.push(bytes) }) };
    await new ControlGateway({ pool }).handle(ws, '/ws/pane-stream/%253', params());
    ws.emit('message', JSON.stringify({ type: 'input', encoding: 'base64', data: 'G1tNIP+A' }));
    await Promise.resolve();
    expect(received[0]).toEqual(Buffer.from([27, 91, 77, 32, 255, 128]));
    ws.emit('message', JSON.stringify({ type: 'input', encoding: 'base64', data: '!!!' }));
    await Promise.resolve(); await Promise.resolve();
    expect(received).toHaveLength(1);
    expect(ws.code).toBe(1008);
  });

  it('disconnects a slow view without letting it queue unbounded output or kill panes', async () => {
    const ws = new Socket(); ws.bufferedAmount = 2 * 1024 * 1024;
    const pool = { subscribe: async (target, send) => { send({ type: 'ready' }); return null; } };
    await new ControlGateway({ pool }).handle(ws, '/ws/pane-stream/%253', params());
    expect(ws.code).toBe(1013);
  });
});
