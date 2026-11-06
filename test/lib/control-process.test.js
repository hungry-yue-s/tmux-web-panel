import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ControlProcess, decodeControlBytes } from '../../lib/terminal/control-process.js';

function child() {
  const proc = new EventEmitter();
  proc.stdin = new PassThrough(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
  proc.kill = () => { proc.emit('exit', 0); return true; };
  return proc;
}

describe('tmux control process', () => {
  it('preserves octal escaped bytes and split UTF-8 without treating pane output as commands', () => {
    expect(decodeControlBytes(Buffer.from('a\\012\\134\\377')).equals(Buffer.from([97, 10, 92, 255]))).toBe(true);
    const proc = child();
    const control = new ControlProcess({ sessionId: '$1', spawn: () => proc });
    const output = [];
    control.on('output', (paneId, bytes) => output.push([paneId, bytes]));
    proc.stdout.write(Buffer.concat([Buffer.from('%output %3 '), Buffer.from([0xe4])]));
    proc.stdout.write(Buffer.from([0xb8, 0xad, 0x0a]));
    expect(output).toHaveLength(1);
    expect(output[0][0]).toBe('%3');
    expect(output[0][1].toString()).toBe('中');
    control.dispose();
  });

  it('separates command guards from notifications and fails command errors without leaking bodies', async () => {
    const proc = child();
    const control = new ControlProcess({ sessionId: '$1', spawn: () => proc });
    proc.stdout.write('%begin 100 1 0\n%end 100 1 0\n%session-changed $1 session\n');
    const result = control.command('display-message -p hello');
    proc.stdout.write('%begin 100 2 1\nhello\n%end 100 2 1\n');
    expect((await result).toString()).toBe('hello');
    const rejected = control.command('display-message -p fail');
    proc.stdout.write('%begin 100 3 1\nsecret error body\n%error 100 3 1\n');
    await expect(rejected).rejects.toMatchObject({ code: 'INTERNAL' });
    control.dispose();
  });

  it('commits a snapshot callback before live output following its guard in the same pipe chunk', async () => {
    const proc = child();
    const control = new ControlProcess({ sessionId: '$1', spawn: () => proc });
    const order = [];
    control.on('output', () => order.push('live'));
    const result = control.command('capture-pane -Q -p -t %3', { onResult: () => order.push('snapshot') });
    proc.stdout.write('%begin 100 2 1\n{}\n%end 100 2 1\n%output %3 next\n');
    await result;
    expect(order).toEqual(['snapshot', 'live']);
    control.dispose();
  });

  it('collects a fixed command transaction before resolving, and does not confuse following output with a guard body', async () => {
    const proc = child();
    const control = new ControlProcess({ sessionId: '$1', spawn: () => proc });
    const result = control.transaction(['display-message -p before', 'capture-pane -p -t %3', 'display-message -p after']);
    proc.stdout.write('%begin 100 2 1\nbefore\n%end 100 2 1\n%begin 100 3 1\nline\n\n%end 100 3 1\n%begin 100 4 1\nafter\n%end 100 4 1\n');
    expect((await result).map(bytes => bytes.toString())).toEqual(['before', 'line\n', 'after']);
    control.dispose();
  });

  it('bounds an unterminated control line and closes only its process', () => {
    const proc = child();
    const control = new ControlProcess({ sessionId: '$1', spawn: () => proc, maxBytes: 32 });
    let ended;
    control.on('closed', error => { ended = error; });
    proc.stdout.write('x'.repeat(33));
    expect(ended.code).toBe('CONNECTION_LIMIT');
  });
});
