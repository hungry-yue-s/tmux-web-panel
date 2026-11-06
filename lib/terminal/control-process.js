/** A pipe-based tmux control client. Browser bytes never enter its command parser. */
import { EventEmitter } from 'node:events';
import { spawn as spawnProcess } from 'node:child_process';
import { TMUX_BIN, msysExecArgs } from '../msys.js';
import { tmuxEnv, tmuxServerArgs } from '../tmux-server.js';
import { AppError, ErrorCode } from '../servers/errors.js';

export function decodeControlBytes(value) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const output = Buffer.allocUnsafe(input.length);
  let n = 0;
  for (let i = 0; i < input.length; i++) {
    if (input[i] === 92 && i + 3 < input.length && input[i + 1] >= 48 && input[i + 1] <= 55
      && input[i + 2] >= 48 && input[i + 2] <= 55 && input[i + 3] >= 48 && input[i + 3] <= 55) {
      output[n++] = (input[++i] - 48) * 64 + (input[++i] - 48) * 8 + input[++i] - 48;
    } else output[n++] = input[i];
  }
  return output.subarray(0, n);
}

export class ControlProcess extends EventEmitter {
  constructor({ sessionId, spawn = spawnProcess, args = tmuxServerArgs(), env = tmuxEnv(), maxBytes = 8 * 1024 * 1024, timeoutMs = 10_000 }) {
    super();
    if (!/^\$\d+$/.test(sessionId)) throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid session');
    this.maxBytes = maxBytes;
    this.timeoutMs = timeoutMs;
    this.pending = [];
    this.buffer = Buffer.alloc(0);
    this.block = null;
    this.closed = false;
    this.exited = false;
    const [argv, options] = msysExecArgs([...args, '-u', '-C', 'attach-session', '-f', 'ignore-size', '-t', sessionId], {
      argv0: TMUX_BIN, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = spawn(TMUX_BIN, argv, options);
    this.child.stdout.on('data', bytes => this._read(bytes));
    // stderr can contain shell paths or configuration; never expose it to a socket.
    this.child.stderr.on('data', () => {});
    this.child.once('error', () => this._close(new AppError(ErrorCode.INTERNAL, 'Control client could not start')));
    this.child.once('exit', () => {
      this.exited = true;
      this._close(new AppError(ErrorCode.WORKSPACE_UNAVAILABLE, 'Control client ended'));
    });
    this.child.stdin.on('error', () => this._close(new AppError(ErrorCode.WORKSPACE_UNAVAILABLE, 'Control client input ended')));
  }

  transaction(lines) {
    if (!Array.isArray(lines) || !lines.length || lines.length > 8 || lines.some(line => typeof line !== 'string' || /[\r\n\0]/.test(line))) return Promise.reject(new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid control transaction'));
    return this.command(lines.join(' ; '), { blocks: lines.length, collect: true });
  }

  command(line, { onResult, blocks = 1, collect = false } = {}) {
    if (this.closed) return Promise.reject(new AppError(ErrorCode.WORKSPACE_UNAVAILABLE, 'Control client ended'));
    if (typeof line !== 'string' || /[\r\n\0]/.test(line) || Buffer.byteLength(line) > 256 * 1024) {
      return Promise.reject(new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid control command'));
    }
    if (this.pending.length >= 128 || this.child.stdin.writableLength > 1024 * 1024) {
      return Promise.reject(new AppError(ErrorCode.CONNECTION_LIMIT, 'Control client is busy'));
    }
    return new Promise((resolve, reject) => {
      const request = { resolve, reject, onResult, remaining: blocks, collect, results: [], bytes: 0 };
      request.timer = setTimeout(() => this._close(new AppError(ErrorCode.TERMINAL_BUSY, 'Control command timed out')), this.timeoutMs);
      request.timer.unref?.();
      this.pending.push(request);
      this.child.stdin.write(line + '\n');
    });
  }

  _read(bytes) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, bytes]);
    if (this.buffer.length > this.maxBytes) return this._close(new AppError(ErrorCode.CONNECTION_LIMIT, 'Control output exceeded its limit'));
    let end;
    while (!this.closed && (end = this.buffer.indexOf(10)) !== -1) {
      const line = this.buffer.subarray(0, end);
      this.buffer = this.buffer.subarray(end + 1);
      this._line(line);
    }
  }

  _line(line) {
    const text = line.toString('utf8');
    if (this.block) {
      const marker = /^%(end|error) (\d+ \d+ [01])$/.exec(text);
      if (marker && marker[2] === this.block.id) {
        const block = this.block;
        this.block = null;
        if (!block.request) return;
        const request = block.request;
        if (marker[1] === 'error') {
          this.pending.shift();
          clearTimeout(request.timer);
          request.reject(new AppError(ErrorCode.INTERNAL, 'tmux control command failed'));
          return; // tmux removes the remainder of this same command group
        }
        const result = Buffer.concat(block.lines.flatMap((part, index) => index ? [Buffer.from('\n'), part] : [part]));
        request.bytes += result.length;
        if (request.bytes > this.maxBytes) return this._close(new AppError(ErrorCode.CONNECTION_LIMIT, 'Control response exceeded its limit'));
        request.results.push(result);
        if (--request.remaining !== 0) return;
        this.pending.shift();
        clearTimeout(request.timer);
        const value = request.collect ? request.results : result;
        try {
          // Runs before any following %output in this same read: the snapshot/live fence.
          request.onResult?.(value);
          request.resolve(value);
        } catch (error) { request.reject(error); }
        return;
      }
      this.block.bytes += line.length + 1;
      if (this.block.bytes > this.maxBytes) return this._close(new AppError(ErrorCode.CONNECTION_LIMIT, 'Control response exceeded its limit'));
      this.block.lines.push(line);
      return;
    }
    const begin = /^%begin (\d+ \d+ [01])$/.exec(text);
    if (begin) {
      const requested = begin[1].endsWith(' 1');
      this.block = { id: begin[1], request: requested ? this.pending[0] : null, lines: [], bytes: 0 };
      return;
    }
    const output = /^%(?:output|extended-output) (%\d+) /.exec(text);
    if (output) {
      let offset = Buffer.byteLength(output[0]);
      if (text.startsWith('%extended-output ')) {
        const colon = line.indexOf(Buffer.from(' : '), offset);
        if (colon === -1) return this._close(new AppError(ErrorCode.INTERNAL, 'Invalid control output'));
        offset = colon + 3;
      }
      this.emit('output', output[1], decodeControlBytes(line.subarray(offset)));
    } else if (text.startsWith('%exit')) {
      this._close(new AppError(ErrorCode.WORKSPACE_UNAVAILABLE, 'Control session ended'));
    } else this.emit('notification', text);
  }

  _close(error) {
    if (this.closed) return;
    this.closed = true;
    const requests = [...this.pending];
    this.pending = [];
    this.block = null;
    this.buffer = Buffer.alloc(0);
    for (const request of requests) { clearTimeout(request.timer); request.reject(error); }
    this.emit('closed', error);
    this.dispose();
  }

  dispose() {
    if (!this.closed) this._close(new AppError(ErrorCode.WORKSPACE_UNAVAILABLE, 'Control client disposed'));
    if (this._ending || this.exited) return;
    this._ending = true;
    this.child.stdin.end('\n'); // an empty control line detaches this client, never its panes
    this._killTimer = setTimeout(() => { if (!this.exited) this.child.kill(); }, 1000);
    this._killTimer.unref?.();
  }
}
