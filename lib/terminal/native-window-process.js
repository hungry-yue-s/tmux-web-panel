/** Framed stdio to tmux's own POSIX PTY adapter, including on MSYS2. */
import { EventEmitter } from 'node:events';
import { spawn as spawnChild } from 'node:child_process';
import { TMUX_BIN, msysExecArgs } from '../msys.js';
import { tmuxEnv, tmuxServerArgs } from '../tmux-server.js';
import { AppError, ErrorCode } from '../servers/errors.js';
import { TmuxOutput } from './tmux-output.js';

const MAX_FRAME = 1024 * 1024;
const MAX_SNAPSHOT = 8 * 1024 * 1024;
const failed = message => new AppError(ErrorCode.WORKSPACE_UNAVAILABLE, message);
export function encodeNativeFrame(type, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(5); header[0] = type.charCodeAt(0); header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

export class NativeWindowProcess extends EventEmitter {
  constructor({ instanceId, sessionId, windowId, cols, rows, binary = TMUX_BIN, args = tmuxServerArgs(), env = tmuxEnv(), spawn = spawnChild, timeoutMs = 15_000 }) {
    super();
    this.closed = false; this.buffer = Buffer.alloc(0); this.pending = null; this.timeoutMs = timeoutMs; this.hello = null;
    this.screen = new TmuxOutput();
    const childEnv = { ...env, TERM: 'xterm-256color' }; delete childEnv.TMUX; delete childEnv.TMUX_PANE;
    if (!/^\$\d+$/.test(sessionId) || !/^@\d+$/.test(windowId) || (instanceId !== undefined && !/^\d+:\d+$/.test(instanceId))) throw failed('Invalid native terminal target');
    const attach = instanceId === undefined ? ['attach-session', '-t', `${sessionId}:${windowId}`]
      : ['if-shell', '-F', '-t', sessionId, `#{==:#{pid}:#{start_time},${instanceId}}`,
        `attach-session -t ${sessionId}:${windowId}`, 'display-message -p TWP_NATIVE_STALE'];
    const argv = ['--panel-pty', `${cols}x${rows}`, ...args, '-N', '-u', ...attach];
    const [words, options] = msysExecArgs(argv, { argv0: binary, env: childEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = spawn(binary, words, options);
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.ready.catch(() => {});
    this.startTimer = setTimeout(() => this._fail(failed('The native terminal did not start')), timeoutMs); this.startTimer.unref?.();
    this.child.stdout.on('data', bytes => { try { this._read(bytes); } catch (error) { this._fail(error); } });
    this.child.stderr.on('data', () => {}); // Local paths/configuration never go to browsers.
    this.child.stdin.on('error', () => this._fail(failed('The native terminal input closed')));
    this.child.on('error', () => this._fail(failed('The native terminal could not start')));
    this.child.once('exit', (code, signal) => {
      this.exited = true;
      clearTimeout(this.killTimer);
      if (!this.closed) { this.emit('exit', { code, signal, reason: this.screen.reason }); this._fail(failed('The native terminal ended')); }
    });
  }

  _read(bytes) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, bytes]);
    while (this.buffer.length >= 5) {
      const length = this.buffer.readUInt32BE(1);
      if (length > MAX_FRAME) throw failed('The native terminal frame exceeded its limit');
      if (this.buffer.length < 5 + length) return;
      const type = String.fromCharCode(this.buffer[0]), data = this.buffer.subarray(5, 5 + length);
      this.buffer = this.buffer.subarray(5 + length);
      if (type === 'H') {
        if (this.hello) throw failed('Repeated native terminal identity');
        const hello = JSON.parse(data.toString());
        if (hello.protocol !== 1 || !Number.isSafeInteger(hello.pid) || hello.pid < 1 || typeof hello.tty !== 'string'
          || !hello.tty.startsWith('/dev/') || /[\x00-\x20\x7f|]/.test(hello.tty) || hello.tty.length > 256) throw failed('Invalid native terminal identity');
        this.hello = Object.freeze(hello); clearTimeout(this.startTimer); this.resolveReady(this.hello);
      } else if (type === 'O') {
        if (!this.hello) throw failed('Native output arrived before its identity');
        const visible = this.screen.push(data);
        if (visible.length) this._output(visible);
      } else if (type === 'E') {
        const exit = JSON.parse(data.toString()); this.emit('exit', { code: exit.exitCode, signal: exit.signal, reason: this.screen.reason });
        this._fail(failed('The native terminal ended'));
      } else throw failed('Unsupported native terminal frame');
    }
  }

  _output(data) {
    const pending = this.pending;
    if (!pending) { this.emit('output', data); return; }
    pending.buffer = Buffer.concat([pending.buffer, data]);
    if (pending.stage === 'begin') {
      const start = pending.buffer.indexOf(pending.begin);
      if (start < 0) { pending.buffer = pending.buffer.subarray(Math.max(0, pending.buffer.length - pending.begin.length + 1)); return; }
      pending.buffer = pending.buffer.subarray(start + pending.begin.length); pending.stage = 'meta';
    }
    if (pending.stage === 'meta') {
      const end = pending.buffer.indexOf('\x1b\\');
      if (end < 0) { if (pending.buffer.length > 4096) throw failed('Invalid native snapshot metadata'); return; }
      try { pending.meta = JSON.parse(pending.buffer.subarray(0, end).toString()); }
      catch { throw failed('Invalid native snapshot metadata'); }
      pending.buffer = pending.buffer.subarray(end + 2); pending.stage = 'body';
    }
    const end = pending.buffer.indexOf(pending.end);
    if (end < 0) { if (pending.buffer.length > MAX_SNAPSHOT) throw failed('The native snapshot exceeded its limit'); return; }
    const snapshot = { meta: pending.meta, data: Buffer.from(pending.buffer.subarray(0, end)) };
    const following = pending.buffer.subarray(end + pending.end.length);
    clearTimeout(pending.timer); this.pending = null;
    try { pending.onSnapshot?.(snapshot); pending.resolve(snapshot); }
    catch (error) { pending.reject(error); throw error; }
    if (following.length) this.emit('output', following);
  }

  capture(nonce, onSnapshot) {
    if (this.closed || this.pending || !/^[a-f0-9]{32}$/.test(nonce)) return Promise.reject(failed('The native snapshot is unavailable'));
    return new Promise((resolve, reject) => {
      const pending = { stage: 'begin', buffer: Buffer.alloc(0), onSnapshot, resolve, reject,
        begin: Buffer.from(`\x1bP+twppanel;${nonce};begin;`), end: Buffer.from(`\x1bP+twppanel;${nonce};end\x1b\\`) };
      pending.timer = setTimeout(() => this.cancelCapture(failed('The native snapshot timed out')), this.timeoutMs); pending.timer.unref?.();
      this.pending = pending;
    });
  }

  cancelCapture(error = failed('The native snapshot was cancelled')) {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  _send(type, data) {
    if (this.closed || this.child.stdin.destroyed || this.child.stdin.writableLength + data.length > MAX_FRAME) {
      this._fail(failed('The native terminal input is too slow')); return false;
    }
    this.child.stdin.write(encodeNativeFrame(type, data)); return true;
  }
  input(data) { return this._send('I', Buffer.isBuffer(data) ? data : Buffer.from(data)); }
  resize(cols, rows) { const size = Buffer.alloc(8); size.writeUInt32BE(cols); size.writeUInt32BE(rows, 4); return this._send('R', size); }

  _fail(error) {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.startTimer);
    this.rejectReady(error);
    this.cancelCapture(error);
    this.buffer = Buffer.alloc(0);
    // EOF must not wait behind queued input. The native adapter owns and reaps
    // its attach child; on Windows child.kill is an unconditional TerminateProcess.
    this.child.stdin.destroy();
    // This is the exact wrapper child we spawned, never a tmux server or process group.
    if (!this.exited) { this.killTimer = setTimeout(() => this.child.kill('SIGTERM'), 6000); this.killTimer.unref?.(); }
    this.emit('closed', error);
  }
  dispose() { this._fail(failed('The native terminal was released')); }
}
