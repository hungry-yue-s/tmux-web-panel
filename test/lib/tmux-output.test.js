import { describe, expect, it } from 'vitest';
import { TmuxOutput } from '../../lib/terminal/tmux-output.js';

const stop = '\x1b[?1l\x1b>\x1b[H\x1b[2J\x1b[?25h\x1b[?1049l';

describe('tmux client teardown output', () => {
  it('preserves the screen when teardown and its detach message arrive byte by byte', () => {
    const output = new TmuxOutput();
    const received = [];
    for (const byte of Buffer.from('任务继续运行' + stop + '[detached (from session test)]\r\n')) received.push(output.push(Buffer.from([byte])));
    expect(Buffer.concat(received).toString()).toBe('任务继续运行');
    expect(output.reason).toBe('detached');
  });

  it('passes ordinary keypad resets and text through without calling them a detach', () => {
    const output = new TmuxOutput();
    const text = 'printed [detached]\r\n\x1b[?1l\x1b>normal text';
    expect(output.push(Buffer.from(text)).toString()).toBe(text);
    expect(output.reason).toBe('tmux_client_exit');
  });

  it.each(['[exited]', '[server exited]'])('distinguishes %s from a detached client', (message) => {
    const output = new TmuxOutput();
    expect(output.push(Buffer.from('last screen' + stop + message)).toString()).toBe('last screen');
    expect(output.reason).toBe('session_ended');
  });

  it('resumes output if the same tmux client returns after suspension', () => {
    const output = new TmuxOutput();
    output.push(Buffer.from('old' + stop));
    const redraw = '\x1b[?1049h' + 'new screen'.repeat(1000);
    expect(output.push(Buffer.from(redraw)).toString()).toBe(redraw);
    expect(output.reason).toBe('tmux_client_exit');
  });

  it('preserves a resume and a large redraw coalesced with the stop sequence', () => {
    const output = new TmuxOutput();
    const redraw = '\x1b[?1049h' + 'screen'.repeat(2000);
    expect(output.push(Buffer.from('before' + stop + redraw)).toString()).toBe('before' + redraw);
    expect(output.reason).toBe('tmux_client_exit');
  });
});
