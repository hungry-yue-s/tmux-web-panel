import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { NativeWindowProcess, encodeNativeFrame } from '../../lib/terminal/native-window-process.js';

const nonce = 'a'.repeat(32);
const meta = { protocol: 1, instanceId: '100:200', clientPid: 42, sessionId: '$0', windowId: '@1', paneId: '%2', cols: 80, rows: 24 };
function fixture() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  const spawn = vi.fn(() => child);
  const process = new NativeWindowProcess({ args: ['-S', '/private-test/socket'], sessionId: '$0', windowId: '@1', cols: 80, rows: 24, spawn });
  return { process, child, spawn, send: (type, data) => child.stdout.write(encodeNativeFrame(type, Buffer.from(data))) };
}

describe('native window framed PTY transport', () => {
  it('withholds terminal cleanup and reports a detach without erasing the native screen', async () => {
    const f = fixture(), outputs = [], exits = [];
    f.process.on('output', data => outputs.push(data)); f.process.on('exit', info => exits.push(info));
    f.send('H', JSON.stringify({ protocol: 1, pid: 42, tty: '/dev/pts/4' })); await f.process.ready;
    f.send('O', 'last native screen\x1b[?1l\x1b>\x1b[H\x1b[2J\x1b[?1049l[detached (from session test)]\r\n');
    f.send('E', JSON.stringify({ exitCode: 0, signal: null }));
    expect(Buffer.concat(outputs).toString()).toBe('last native screen');
    expect(exits).toEqual([{ code: 0, signal: null, reason: 'detached' }]);
    f.process.dispose();
  });
  it('parses byte-split frames and an atomic snapshot without losing output after its fence', async () => {
    const f = fixture(), outputs = [];
    f.process.on('output', data => outputs.push(data.toString()));
    const hello = encodeNativeFrame('H', Buffer.from(JSON.stringify({ protocol: 1, pid: 42, tty: '/dev/pts/4' })));
    for (const byte of hello) f.child.stdout.write(Buffer.from([byte]));
    await expect(f.process.ready).resolves.toEqual({ protocol: 1, pid: 42, tty: '/dev/pts/4' });
    const received = [];
    const capture = f.process.capture(nonce, snapshot => received.push(snapshot));
    const body = Buffer.from('\x1b[H原生框架\r\nstatus');
    const stream = Buffer.concat([Buffer.from(`old\x1bP+twppanel;${nonce};begin;${JSON.stringify(meta)}\x1b\\`), body,
      Buffer.from(`\x1bP+twppanel;${nonce};end\x1b\\LIVE`)]);
    for (let i = 0; i < stream.length; i += 7) f.send('O', stream.subarray(i, i + 7));
    await expect(capture).resolves.toMatchObject({ meta });
    expect(received[0].data).toEqual(body);
    expect(outputs.join('')).toBe('LIVE');
    f.process.dispose();
  });

  it('frames raw input and resizes without restarting the native child', async () => {
    const f = fixture(); f.send('H', JSON.stringify({ protocol: 1, pid: 42, tty: '/dev/pts/4' })); await f.process.ready;
    f.process.input(Buffer.from([0, 0xff, 0xc2, 0x80])); f.process.resize(120, 35);
    const bytes = f.child.stdin.read();
    expect(bytes.subarray(0, 9)).toEqual(encodeNativeFrame('I', Buffer.from([0, 0xff, 0xc2, 0x80])));
    expect(bytes.subarray(9, 14)).toEqual(Buffer.from([82, 0, 0, 0, 8]));
    expect(bytes.readUInt32BE(14)).toBe(120); expect(bytes.readUInt32BE(18)).toBe(35);
    expect(f.spawn).toHaveBeenCalledOnce(); f.process.dispose();
  });

  it('rejects an oversized native frame before allocating or buffering it', async () => {
    const f = fixture(); const failed = f.process.ready.catch(e => e);
    f.child.stdout.write(Buffer.from([79, 0, 0x20, 0, 0]));
    expect((await failed).code).toBe('WORKSPACE_UNAVAILABLE');
    expect(f.process.closed).toBe(true);
  });

  it('does not resolve an unfinished or malformed checkpoint and bounds its memory', async () => {
    const f = fixture(); f.send('H', JSON.stringify({ protocol: 1, pid: 42, tty: '/dev/pts/4' })); await f.process.ready;
    const capture = f.process.capture(nonce).catch(e => e);
    f.send('O', `\x1bP+twppanel;${nonce};begin;invalid-json\x1b\\`);
    expect((await capture).code).toBe('WORKSPACE_UNAVAILABLE'); expect(f.process.closed).toBe(true);
  });
  it('cancels an auxiliary checkpoint without ending its persistent native client', async () => {
    const f = fixture(); f.send('H', JSON.stringify({ protocol: 1, pid: 42, tty: '/dev/pts/4' })); await f.process.ready;
    const first = f.process.capture(nonce).catch(e => e);
    f.send('O', `\x1bP+twppanel;${nonce};begin;${JSON.stringify(meta)}\x1b\\partial`);
    const reason = new Error('sidecar ended'); f.process.cancelCapture(reason);
    expect(await first).toBe(reason); expect(f.process.closed).toBe(false);
    const nextNonce = 'b'.repeat(32), next = f.process.capture(nextNonce);
    f.send('O', `\x1bP+twppanel;${nonce};end\x1b\\\x1bP+twppanel;${nextNonce};begin;${JSON.stringify(meta)}\x1b\\complete\x1bP+twppanel;${nextNonce};end\x1b\\`);
    expect((await next).data.toString()).toBe('complete');
    expect(f.spawn).toHaveBeenCalledOnce(); expect(f.child.kill).not.toHaveBeenCalled(); f.process.dispose();
  });
});
