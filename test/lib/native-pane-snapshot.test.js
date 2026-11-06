import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import headless from '@xterm/headless';
import { cleanupPrivateTmux, parsePrivateTmuxIdentity, PRIVATE_TMUX_IDENTITY_FORMAT } from '../helpers/private-tmux.js';

// Opt in to the project-built executable. Never contacts the user's tmux socket.
const binary = process.env.TMUX_SNAPSHOT_TEST_BIN;
const write = (term, data) => new Promise(resolve => term.write(data, resolve));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

async function snapshotOf(prefix, check, resize) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'twp-snapshot-')));
  const socket = join(dir, 'socket');
  const env = { ...process.env, LC_ALL: 'en_US.UTF-8' };
  delete env.TMUX; delete env.TMUX_PANE;
  const tmux = (...args) => execFileSync(binary, ['-S', socket, ...args], { env, encoding: 'utf8', timeout: 5000 });
  let identity; let error;
  try {
    const worker = join(dir, 'writer.cjs');
    const continuation = join(dir, 'continuation');
    writeFileSync(worker, `const fs=require('fs');const input=${JSON.stringify(continuation)};process.stdout.write(Buffer.from(${JSON.stringify(Buffer.from(prefix).toString('base64'))},'base64'));setInterval(()=>{if(!fs.existsSync(input))return;const data=fs.readFileSync(input);fs.unlinkSync(input);process.stdout.write(data)},10);`);
    tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'snapshot-test', '-x', '80', '-y', '24', `${quote(process.execPath)} ${quote(worker)}`);
    identity = parsePrivateTmuxIdentity(tmux('display-message', '-p', PRIVATE_TMUX_IDENTITY_FORMAT), socket);
    // Poll the actual pane output instead of guessing a process-start delay.
    let initialized = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (tmux('capture-pane', '-p', '-t', '%0').includes('READY')) { initialized = true; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(initialized).toBe(true);
    if (resize) tmux('resize-window', '-t', '@0', '-x', String(resize.cols), '-y', String(resize.rows));
    const packet = JSON.parse(tmux('capture-pane', '-Q', '-p', '-t', '%0'));
    expect(packet).toMatchObject({ version: 1, paneId: '%0', cols: resize?.cols ?? 80, rows: resize?.rows ?? 24 });
    const restored = new headless.Terminal({ cols: packet.cols, rows: packet.rows, allowProposedApi: true });
    const original = new headless.Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    try {
      await write(original, prefix);
      if (resize) original.resize(resize.cols, resize.rows);
      await write(restored, Buffer.from(packet.data, 'base64'));
      await check(restored, original, {
        async continueWith(data, title) {
          // File delivery also works when native Windows Node cannot set raw
          // mode on an MSYS PTY. Rename exposes only complete continuations.
          writeFileSync(continuation + '.new', data);
          renameSync(continuation + '.new', continuation);
          for (let attempt = 0; attempt < 100; attempt++) {
            if (tmux('display-message', '-p', '-t', '%0', '#{pane_title}').trim() === title) return;
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          throw new Error('The private pane did not render the continuation');
        },
        visible() {
          const [x, y] = tmux('display-message', '-p', '-t', '%0', '#{cursor_x}|#{cursor_y}').trim().split('|').map(Number);
          const lines = tmux('capture-pane', '-p', '-t', '%0').replace(/\n$/, '').split('\n').map(line => line.trimEnd());
          return { x, y, lines };
        },
      });
    } finally { restored.dispose(); original.dispose(); }
  } catch (err) { error = err; throw err; }
  finally {
    await cleanupPrivateTmux({ dir, socket, identity, primaryError: error,
      readIdentity: async () => parsePrivateTmuxIdentity(tmux('display-message', '-p', PRIVATE_TMUX_IDENTITY_FORMAT), socket),
      killServer: async () => tmux('kill-server') });
  }
}

function state(term) {
  const b = term.buffer.active;
  return { type: b.type, x: b.cursorX, y: b.cursorY,
    lines: Array.from({ length: term.rows }, (_, y) => {
      const line = b.getLine(b.baseY + y);
      return Array.from({ length: term.cols }, (_, x) => {
        const c = line?.getCell(x);
        return [c?.getChars() || ' ', c?.getFgColor(), c?.getBgColor(), c?.isBold(), c?.isItalic(), c?.isUnderline()];
      });
    }) };
}

describe.skipIf(!binary)('native atomic pane snapshot', () => {
  it.each([{ cols: 40, rows: 12 }, { cols: 100, rows: 12 }, { cols: 40, rows: 30 }])('matches the live pane after exiting alternate screen at $cols by $rows', async resize => {
    const lines = Array.from({ length: 10 }, (_, i) => `ROW${i}:` + String(i).repeat(55));
    const prefix = '\x1bc' + lines.join('\r\n') + '\x1b[10;60H\x1b[?1049h\x1b[HREADY';
    await snapshotOf(prefix, async (restored, _original, pane) => {
      // A title acknowledges parsing without moving the saved cursor under test.
      const suffix = '\x1b[?1049lEND\x1b]0;CONTINUED\x07';
      await pane.continueWith(suffix, 'CONTINUED');
      await write(restored, suffix);
      const buffer = restored.buffer.active;
      expect({ x: buffer.cursorX, y: buffer.cursorY,
        lines: Array.from({ length: restored.rows }, (_, y) => buffer.getLine(buffer.baseY + y).translateToString(true).trimEnd()),
      }).toEqual(pane.visible());
    }, resize);
  });

  it('keeps complete normal lines after a narrower resize during alternate screen', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `ROW${i}:` + String(i).repeat(55));
    const prefix = '\x1bc' + lines.join('\r\n') + '\x1b[?1049h\x1b[HREADY';
    await snapshotOf(prefix, async restored => {
      await write(restored, '\x1b[?1049l');
      const b = restored.buffer.active;
      const content = Array.from({ length: b.length }, (_, i) => b.getLine(i).translateToString(true)).join('');
      for (const line of lines) expect(content).toContain(line);
    }, { cols: 40, rows: 12 });
  });

  it('restores REP when the next sequence repeats the last printed glyph', async () => {
    await snapshotOf('\x1bcREADY\x1b[4;4HZ', async (restored, original) => {
      await write(original, '\x1b[3b'); await write(restored, '\x1b[3b');
      expect(state(restored)).toEqual(state(original));
    });
  });

  it('keeps the right-edge cursor when leaving alternate screen', async () => {
    await snapshotOf('\x1bcREADY\x1b[5;80HX\x1b[?1049h\x1b[8;8HREADY', async (restored, original) => {
      await write(original, '\x1b[?1049lZ'); await write(restored, '\x1b[?1049lZ');
      expect(state(restored)).toEqual(state(original));
    });
  });

  it('restores an unapplied SGR pen, saved cursor and attributes before the next bytes arrive', async () => {
    const prefix = '\x1bcREADY\x1b[4;7H\x1b[1;31m\x1b7\x1b[8;3H\x1b[0;38;2;3;90;170m';
    await snapshotOf(prefix, async (restored, original) => {
      const suffix = '青色\x1b8SAVED';
      await write(original, suffix); await write(restored, suffix);
      expect(state(restored)).toEqual(state(original));
    });
  });

  it('restores both alternate and normal buffers and the cursor on leaving alternate screen', async () => {
    const prefix = '\x1bcNORMAL\x1b[3;9H\x1b[32m\x1b[?1049h\x1b[HREADY\x1b[7;8H\x1b[35m';
    await snapshotOf(prefix, async (restored, original) => {
      await write(original, 'ALT'); await write(restored, 'ALT');
      expect(state(restored)).toEqual(state(original));
      await write(original, '\x1b[?1049lEND'); await write(restored, '\x1b[?1049lEND');
      expect(state(restored)).toEqual(state(original));
    });
  });

  it('preserves a partial control sequence, custom tab stops and scrolling region', async () => {
    const prefix = '\x1bcREADY\x1b[3g\x1b[1;12H\x1bH\x1b[2;9r\x1b[5;1H\x1b[38;2;';
    await snapshotOf(prefix, async (restored, original) => {
      const suffix = '120;30;80m\tTAB\r\nline\r\nline\r\nline\r\nline\r\nline';
      await write(original, suffix); await write(restored, suffix);
      expect(state(restored)).toEqual(state(original));
    });
  });
});
