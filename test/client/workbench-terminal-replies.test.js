import { describe, expect, it } from 'vitest';
import xterm from '@xterm/headless';
import { installInputHandler, installClipboardHandler } from '../../plugins/workbench/client/native-window-session.js';

describe('native tmux client terminal input', () => {
  it('forwards generated terminal answers and identical user bytes to the real native tty', async () => {
    const term = new xterm.Terminal({ cols: 80, rows: 24, allowProposedApi: true }); const sent = [];
    const restore = installInputHandler(term, (data, user) => sent.push({ data, user }));
    await new Promise((resolve) => term.write('hello\x1b[c\x1b[5n\x1b[6n', resolve));
    expect(sent.length).toBeGreaterThanOrEqual(3); expect(sent.every((event) => !event.user)).toBe(true);
    expect(sent.some((event) => event.data === '\x1b[0n')).toBe(true);
    const paste = '\x1b[0n\x1b[?1;2c'; term.input(paste, true);
    expect(sent.at(-1)).toEqual({ data: paste, user: true }); restore(); term.dispose();
  });

  it('parses a split OSC52 copy without reading the clipboard or replaying queries', async () => {
    const term = new xterm.Terminal({ allowProposedApi: true });
    const copies = [];
    const titles = [];
    const sent = [];
    const clipboard = installClipboardHandler(term, (value) => copies.push(value));
    const title = term.onTitleChange((value) => titles.push(value));
    term.onData((data) => sent.push(data));
    await new Promise((resolve) => term.write('\x1b]52;c;5L2g', resolve));
    expect(copies).toEqual([]);
    await new Promise((resolve) => term.write('5aW9\x1b\\\x1b]52;c;?\x07\x1b]2;Build running\x07', resolve));
    expect(copies).toEqual(['你好']);
    expect(titles).toEqual(['Build running']);
    expect(sent).toEqual([]);
    clipboard.dispose(); title.dispose(); term.dispose();
  });

  it('preserves real X10 mouse reports containing bytes above 127', async () => {
    const term = new xterm.Terminal({ cols: 120, rows: 30, allowProposedApi: true });
    const data = []; term.onBinary((bytes) => data.push([...bytes].map((char) => char.charCodeAt(0))));
    await new Promise((resolve) => term.write('\x1b[?1000h', resolve));
    term._core.coreMouseService.triggerMouseEvent({ col: 95, row: 4, x: 600, y: 60, button: 0, action: 1, ctrl: false, alt: false, shift: false });
    expect(data).toEqual([[27, 91, 77, 32, 128, 37]]);
    term.dispose();
  });
});
