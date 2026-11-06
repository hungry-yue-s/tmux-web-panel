import { describe, it, expect } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import headless from '@xterm/headless';
import { cleanupPrivateTmux, parsePrivateTmuxIdentity, PRIVATE_TMUX_IDENTITY_FORMAT } from '../helpers/private-tmux.js';

const binary = process.env.TMUX_NATIVE_CLIENT_TEST_BIN;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const frame = (type, value = Buffer.alloc(0)) => {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const header = Buffer.alloc(5); header[0] = type.charCodeAt(0); header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
};
async function until(read, label, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = read(); if (result) return result; await delay(10); }
  throw new Error('Timed out: ' + label);
}
function visible(term) {
  const buffer = term.buffer.active;
  return { x: buffer.cursorX, y: buffer.cursorY, type: buffer.type,
    lines: Array.from({ length: term.rows }, (_, y) => buffer.getLine(buffer.baseY + y)?.translateToString(true)) };
}

async function privateClient(run) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'twp-native-client-test-')));
  const socket = join(dir, 'socket');
  const env = { ...process.env, TERM: 'xterm-256color', LC_ALL: 'en_US.UTF-8' };
  delete env.TMUX; delete env.TMUX_PANE;
  const tmux = (...args) => execFileSync(binary, ['-S', socket, ...args], { env, cwd: dir, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
  let identity, child, error;
  const term = new headless.Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  try {
    const worker = join(dir, 'worker.cjs');
    writeFileSync(worker, "process.stdout.write(Array.from({length:50},(_,i)=>'LINE'+i).join('\\r\\n')+'\\r\\nREADY');setInterval(()=>{},1000);");
    tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'native-test', '-x', '80', '-y', '24', `${quote(process.execPath)} ${quote(worker)}`);
    identity = parsePrivateTmuxIdentity(tmux('display-message', '-p', PRIVATE_TMUX_IDENTITY_FORMAT), socket);
    tmux('set-option', '-g', 'status-left', 'NATIVE-STATUS');
    tmux('set-option', '-g', 'status-left-length', '30');
    tmux('set-option', '-g', 'pane-border-status', 'top');
    tmux('set-option', '-g', 'pane-border-format', 'NATIVE-BORDER #{pane_id}');
    tmux('set-option', '-g', 'mouse', 'on');
    tmux('bind-key', 'x', 'split-window', '-h');
    child = spawn(binary, ['--panel-pty', '80x24', '-S', socket, '-u', 'attach-session', '-t', 'native-test:0'], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let input = Buffer.alloc(0), output = Buffer.alloc(0), hello, exitFrame, exited = false, stderr = '', parsingError;
    let render = Promise.resolve();
    child.stderr.on('data', value => { stderr += value; });
    child.on('exit', () => { exited = true; });
    child.stdin.on('error', () => {});
    const send = (type, payload) => child.stdin.write(frame(type, payload));
    term.onData(data => { if (!exited) send('I', data); });
    child.stdout.on('data', chunk => {
      input = Buffer.concat([input, chunk]);
      while (input.length >= 5) {
        const length = input.readUInt32BE(1);
        if (length > 1024 * 1024) { parsingError = new Error('Oversized native frame'); return; }
        if (input.length < 5 + length) return;
        const type = String.fromCharCode(input[0]);
        const payload = Buffer.from(input.subarray(5, 5 + length)); input = input.subarray(5 + length);
        if (type === 'H') hello = JSON.parse(payload);
        else if (type === 'E') exitFrame = JSON.parse(payload);
        else if (type === 'O') {
          output = Buffer.concat([output, payload]);
          render = render.then(() => new Promise(resolve => term.write(payload, resolve)));
        } else parsingError = new Error('Unexpected frame ' + type);
      }
    });
    await until(() => { if (parsingError) throw parsingError; if (exited) throw new Error('Missing native hello: ' + stderr); return hello; }, 'native hello');
    expect(hello).toMatchObject({ protocol: 1, pid: expect.any(Number), tty: expect.any(String) });
    await until(() => tmux('capture-pane', '-p', '-t', '%0').includes('READY'), 'pane startup');
    const snapshot = async () => {
      const nonce = randomBytes(16).toString('hex');
      const begin = Buffer.from('\x1bP+twppanel;' + nonce + ';begin;');
      const end = Buffer.from('\x1bP+twppanel;' + nonce + ';end\x1b\\');
      const startAt = output.length;
      tmux('refresh-client', '-t', hello.tty, '-Q', nonce);
      const packet = await until(() => {
        const start = output.indexOf(begin, startAt);
        if (start === -1) return;
        const metadataEnd = output.indexOf(Buffer.from('\x1b\\'), start + begin.length);
        if (metadataEnd === -1) return;
        const stop = output.indexOf(end, metadataEnd + 2);
        if (stop === -1) return;
        return { meta: JSON.parse(output.subarray(start + begin.length, metadataEnd)), data: output.subarray(metadataEnd + 2, stop) };
      }, 'complete snapshot');
      await render;
      return packet;
    };
    await run({ tmux, child, hello, term, send, snapshot, render: () => render,
      resize(cols, rows) { const data = Buffer.alloc(8); data.writeUInt32BE(cols, 0); data.writeUInt32BE(rows, 4); term.resize(cols, rows); send('R', data); },
      exitFrame: () => exitFrame, exited: () => exited, identity, dir, socket, env });
  } catch (caught) { error = caught; throw caught; }
  finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.stdin.end(frame('X'));
      await until(() => child.exitCode !== null || child.signalCode !== null, 'owned wrapper exit').catch(() => child.kill());
    }
    term.dispose();
    await cleanupPrivateTmux({ dir, socket, identity, primaryError: error,
      readIdentity: async () => parsePrivateTmuxIdentity(tmux('display-message', '-p', PRIVATE_TMUX_IDENTITY_FORMAT), socket),
      killServer: async () => tmux('kill-server') });
  }
}

describe.skipIf(!binary)('native panel PTY client', () => {
  it('preserves prefix bindings and resizes the same native client', async () => {
    await privateClient(async ({ tmux, child, hello, resize, identity }) => {
      expect(tmux('display-message', '-p', '#{native_client_protocol}').trim()).toBe('1');
      // Exercise framing split across arbitrary native pipe reads.
      for (const byte of frame('I', '\x02x')) child.stdin.write(Buffer.from([byte]));
      await until(() => tmux('list-panes', '-t', '@0', '-F', '#{pane_id}').trim().split('\n').length === 2, 'native prefix split');
      resize(100, 30);
      await until(() => tmux('list-clients', '-F', '#{client_pid}|#{client_width}|#{client_height}').trim() === `${hello.pid}|100|30`, 'same client resize');
      expect(Number(tmux('display-message', '-p', '#{pid}').trim())).toBe(identity.pid);
    });
  }, 45000);

  it('restores native copy-mode, pane borders, status and terminal modes into a fresh emulator', async () => {
    await privateClient(async ({ tmux, hello, send, snapshot, term }) => {
      send('I', '\x02[');
      await until(() => tmux('display-message', '-p', '-t', '%0', '#{pane_in_mode}').trim() === '1', 'native copy mode');
      const packet = await snapshot();
      expect(packet.meta).toMatchObject({ protocol: 1, clientPid: hello.pid, sessionId: '$0', windowId: '@0', paneId: '%0', cols: 80, rows: 24 });
      expect(packet.meta.instanceId).toBe(tmux('display-message', '-p', '#{pid}:#{start_time}').trim());
      const restored = new headless.Terminal({ cols: 80, rows: 24, allowProposedApi: true });
      try {
        await new Promise(resolve => restored.write(packet.data, resolve));
        expect(visible(restored)).toEqual(visible(term));
        expect(visible(restored).lines.join('\n')).toContain('NATIVE-STATUS');
        expect(restored.modes.bracketedPasteMode).toBe(true);
        expect(restored.modes.applicationCursorKeysMode).toBe(true);
        expect(restored.modes.mouseTrackingMode).toBe(term.modes.mouseTrackingMode);
      } finally { restored.dispose(); }
    });
  }, 45000);

  it('includes the in-progress native command prompt and its cursor in the baseline', async () => {
    await privateClient(async ({ tmux, hello, snapshot, term }) => {
      tmux('command-prompt', '-b', '-t', hello.tty, '-p', 'NATIVE-PROMPT', '-I', 'in-progress', '');
      const packet = await snapshot();
      const restored = new headless.Terminal({ cols: 80, rows: 24, allowProposedApi: true });
      try {
        await new Promise(resolve => restored.write(packet.data, resolve));
        expect(visible(restored)).toEqual(visible(term));
        expect(visible(restored).lines.join('\n')).toContain('NATIVE-PROMPT');
        expect(visible(restored).lines.join('\n')).toContain('in-progress');
      } finally { restored.dispose(); }
    });
  }, 45000);

  it('includes a native popup overlay in the same atomic baseline', async () => {
    await privateClient(async ({ tmux, send, snapshot, term }) => {
      tmux('bind-key', 'p', 'display-popup', '-E', '-T', 'NATIVE-POPUP', '-w', '40', '-h', '10', "printf 'POPUP-CONTENT'; sleep 60");
      send('I', '\x02p');
      await until(() => visible(term).lines.join('\n').includes('POPUP-CONTENT'), 'popup content');
      const packet = await snapshot();
      const restored = new headless.Terminal({ cols: 80, rows: 24, allowProposedApi: true });
      try {
        await new Promise(resolve => restored.write(packet.data, resolve));
        expect(visible(restored)).toEqual(visible(term));
        expect(visible(restored).lines.join('\n')).toContain('POPUP-CONTENT');
      } finally { restored.dispose(); }
    });
  }, 45000);

  it('rejects oversized input frames and closes only its own native attach', async () => {
    await privateClient(async ({ tmux, child, exited, exitFrame, identity }) => {
      const header = Buffer.alloc(5); header[0] = 'I'.charCodeAt(0); header.writeUInt32BE(1024 * 1024 + 1, 1);
      child.stdin.write(header);
      await until(exited, 'malformed wrapper exit');
      expect(exitFrame()).toHaveProperty('exitCode');
      expect(exitFrame()).toHaveProperty('signal');
      expect(Number(tmux('display-message', '-p', '#{pid}').trim())).toBe(identity.pid);
      expect(tmux('list-clients', '-F', '#{client_pid}').trim()).toBe('');
    });
  }, 45000);

  it('exits with bounded queues when stdout is not consumed, without resuming the pipe', async () => {
    await privateClient(async ({ tmux, dir, socket, env, identity }) => {
      const flood = join(dir, 'flood.cjs');
      writeFileSync(flood, "const chunk=Buffer.alloc(65536,79);let left=32*1024*1024;function more(){while(left>0){left-=chunk.length;if(!process.stdout.write(chunk)){process.stdout.once('drain',more);return}}}more();");
      const blocked = spawn(binary, ['--panel-pty', '80x24', '-S', socket, '-c', `exec ${quote(process.execPath)} ${quote(flood)}`], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      blocked.stdin.on('error', () => {});
      blocked.stderr.resume();
      // Do not attach a stdout consumer: the native parent's output cap must
      // end its own child and return without a process-exit stdio flush.
      try {
        await until(() => blocked.exitCode !== null || blocked.signalCode !== null, 'unread stdout exit', 15000);
        expect(blocked.exitCode).toBe(1);
        expect(Number(tmux('display-message', '-p', '#{pid}').trim())).toBe(identity.pid);
      } finally {
        blocked.stdin.end(frame('X'));
        if (blocked.exitCode === null && blocked.signalCode === null) blocked.kill();
        blocked.stdout.destroy();
      }
    });
  }, 45000);

  it('keeps another native client attached and gives it an independent key table', async () => {
    await privateClient(async ({ tmux, hello, send, socket, env }) => {
      const peer = spawn(binary, ['--panel-pty', '80x24', '-S', socket, '-u', 'attach-session', '-t', 'native-test:0'], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      peer.stdin.on('error', () => {}); peer.stdout.resume(); peer.stderr.resume();
      try {
        await until(() => tmux('list-clients', '-F', '#{client_pid}').trim().split('\n').length === 2, 'two native clients');
        send('I', '\x02');
        const rows = await until(() => {
          const values = tmux('list-clients', '-F', '#{client_pid}|#{client_key_table}').trim().split('\n');
          return values.includes(`${hello.pid}|prefix`) ? values : null;
        }, 'first client prefix table');
        expect(rows.filter(row => !row.startsWith(`${hello.pid}|`))[0]).toMatch(/\|root$/);
        peer.stdin.end(frame('X'));
        await until(() => peer.exitCode !== null || peer.signalCode !== null, 'second client exit');
        expect(tmux('list-clients', '-F', '#{client_pid}').trim()).toBe(String(hello.pid));
      } finally {
        peer.stdin.end(frame('X'));
        if (peer.exitCode === null && peer.signalCode === null) peer.kill();
      }
    });
  }, 45000);

  it.skipIf(process.platform === 'win32')('cleans up a blocked input writer after its upstream pipe closes', async () => {
    await privateClient(async ({ tmux, child, identity, exited }) => {
      expect(Number(tmux('display-message', '-p', '#{pid}').trim())).toBe(identity.pid);
      process.kill(identity.pid, 'SIGSTOP'); // This fixture's recorded private server only.
      try {
        for (let i = 0; i < 32; i++) child.stdin.write(frame('I', Buffer.alloc(128 * 1024, 120)));
        await delay(100);
        child.stdin.destroy(); // Simulate upstream EOF without waiting for queued writes.
        await until(exited, 'blocked input wrapper exit', 8000);
      } finally { process.kill(identity.pid, 'SIGCONT'); }
      expect(Number(tmux('display-message', '-p', '#{pid}').trim())).toBe(identity.pid);
    });
  }, 45000);
});
