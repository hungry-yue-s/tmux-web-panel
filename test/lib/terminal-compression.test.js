import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import net from 'node:net';
import http from 'node:http';
import { WebSocketServer } from 'ws';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node-pty', () => ({ default: { spawn } }));

import { TerminalManager } from '../../lib/terminal.js';
import { COMPRESS_MIN_BYTES, SOCKET_DEFLATE, ServerMessage, outputFrameOptions } from '../../lib/terminal/protocol.js';

/**
 * A server with the node's deflate settings, and a client that speaks raw TCP so
 * it can see each frame's RSV1 bit, which says whether that frame was compressed.
 */
async function deflateSocketPair() {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: SOCKET_DEFLATE });
  const accepted = new Promise((resolve) => {
    server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, resolve));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = net.connect({ host: '127.0.0.1', port: server.address().port });
  client.write(`GET / HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n`
    + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Extensions: permessage-deflate; client_max_window_bits\r\n\r\n');
  const frames = [];
  let buffer = Buffer.alloc(0);
  let handshake = null;
  client.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (handshake === null) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      handshake = buffer.subarray(0, end).toString();
      buffer = buffer.subarray(end + 4);
    }
    // Server frames are unmasked: FIN|RSV1|opcode, then a 7/16/64-bit length.
    while (buffer.length >= 2) {
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
      if (buffer.length < offset + length) return;
      frames.push({ rsv1: Boolean(buffer[0] & 0x40), opcode: buffer[0] & 0x0f, bytes: offset + length });
      buffer = buffer.subarray(offset + length);
    }
  });
  const ws = await accepted;
  return {
    ws,
    frames,
    handshake: () => handshake,
    close: () => { client.destroy(); ws.terminate(); server.close(); },
  };
}

const echo = ServerMessage.output('a');
const redraw = ServerMessage.output('\x1b[2J\x1b[H' + 'line of output\r\n'.repeat(200));

describe('terminal output compression', () => {
  it('needs the per-frame option: with context takeover, ws compresses even a keystroke echo by default', async () => {
    const pair = await deflateSocketPair();
    expect(pair.ws.extensions).toContain('permessage-deflate');
    pair.ws.send(echo);
    await vi.waitFor(() => expect(pair.frames).toHaveLength(1));
    expect(pair.frames[0].rsv1).toBe(true);
    pair.close();
  });

  it('sends a keystroke echo uncompressed, a redraw compressed, and keeps their order', async () => {
    const pair = await deflateSocketPair();
    const sequence = [redraw, echo, redraw, echo, echo];
    for (const frame of sequence) pair.ws.send(frame, outputFrameOptions(frame));
    await vi.waitFor(() => expect(pair.frames).toHaveLength(sequence.length));
    expect(pair.frames.map((frame) => frame.rsv1)).toEqual([true, false, true, false, false]);
    // A small frame is not held back behind nothing, nor sent ahead of a redraw still in zlib.
    expect(pair.frames.every((frame) => frame.opcode === 1)).toBe(true);
    // The redraw still benefits from deflate.
    expect(pair.frames[0].bytes).toBeLessThan(Buffer.byteLength(redraw) / 4);
    pair.close();
  });

  it('measures the threshold in bytes, so short text of wide characters still compresses', () => {
    expect(outputFrameOptions(ServerMessage.output('x'))).toEqual({ compress: false });
    const wide = ServerMessage.output('中'.repeat(90));
    expect(wide.length).toBeLessThan(COMPRESS_MIN_BYTES);
    expect(outputFrameOptions(wide)).toEqual({ compress: true });
    expect(outputFrameOptions(ServerMessage.output('x'.repeat(COMPRESS_MIN_BYTES)))).toEqual({ compress: true });
  });
});

describe('TerminalManager output frames', () => {
  function fakeTerm() {
    const handlers = {};
    return {
      handlers,
      onData: vi.fn((fn) => { handlers.data = fn; return { dispose: vi.fn() }; }),
      onExit: vi.fn((fn) => { handlers.exit = fn; }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      pid: 4242,
    };
  }

  let term;
  beforeEach(() => {
    vi.useFakeTimers();
    spawn.mockReset();
    spawn.mockImplementation(() => { term = fakeTerm(); return term; });
  });
  afterEach(() => vi.useRealTimers());

  it('asks for compression only when a batch is large enough to gain from it', () => {
    const ws = { OPEN: 1, readyState: 1, on: vi.fn(), close: vi.fn(), send: vi.fn(), ping: vi.fn(), terminate: vi.fn() };
    const manager = new TerminalManager({ platform: 'linux' });
    expect(manager.create(ws, '%0')).toBeTruthy();

    term.handlers.data('a');
    vi.advanceTimersByTime(0);
    term.handlers.data('x'.repeat(4096));
    vi.advanceTimersByTime(10);

    expect(ws.send.mock.calls).toEqual([
      [ServerMessage.output('a'), { compress: false }],
      [ServerMessage.output('x'.repeat(4096)), { compress: true }],
    ]);
  });
});
