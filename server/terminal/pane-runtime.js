/**
 * PaneRuntime: one SSH PTY, many WebSocket subscribers.
 *
 * The legacy model tied a PTY to a WebSocket, so closing the browser killed the
 * shell. tmux does not care — the shell lives in tmux — but an SSH pane has no
 * multiplexer behind it, so the PTY has to outlive the socket for a refresh to
 * be survivable. A pane therefore stays alive, detached, for a TTL after its
 * last subscriber leaves.
 *
 * This is deliberately weaker than tmux: it survives a browser disconnect, not a
 * panel restart. The UI must say so.
 */

import { randomUUID } from 'node:crypto';

import { AppError, ErrorCode } from '../servers/errors.js';

/** Replay buffer per pane. Bounded so a runaway remote process cannot eat RAM. */
export const DEFAULT_BUFFER_BYTES = 256 * 1024;
export const DEFAULT_DETACHED_TTL_MS = 30 * 60 * 1000;
const KILL_ESCALATION_MS = 500;
/** Beyond this a resize is a bug or a hostile client, not a real terminal. */
const MAX_DIMENSION = 2000;

/**
 * Returns the last `maxBytes` bytes of a UTF-8 string, starting at a character
 * boundary. Slicing by string length would blow the byte budget on multi-byte
 * text, and a blind byte slice would emit a replacement character.
 */
export function utf8Tail(text, maxBytes) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let start = buf.length - maxBytes;
  // 0b10xxxxxx is a continuation byte; skip forward to the next lead byte.
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start += 1;
  return buf.slice(start).toString('utf8');
}

/**
 * Byte-bounded ring of output chunks. Keeps whole chunks and drops from the
 * front, so a replay never starts mid escape sequence more than once.
 */
export class OutputRing {
  constructor(maxBytes = DEFAULT_BUFFER_BYTES) {
    this.maxBytes = maxBytes;
    this.chunks = [];
    this.bytes = 0;
  }

  push(text) {
    if (!text) return;
    const size = Buffer.byteLength(text, 'utf8');
    if (size >= this.maxBytes) {
      // A single oversized chunk: keep only its tail, measured in bytes.
      const kept = utf8Tail(text, Math.floor(this.maxBytes / 2));
      this.chunks = [kept];
      this.bytes = Buffer.byteLength(kept, 'utf8');
      return;
    }
    this.chunks.push(text);
    this.bytes += size;
    while (this.bytes > this.maxBytes && this.chunks.length > 1) {
      this.bytes -= Buffer.byteLength(this.chunks.shift(), 'utf8');
    }
  }

  read() {
    return this.chunks.join('');
  }

  clear() {
    this.chunks = [];
    this.bytes = 0;
  }
}

export class PaneRuntime {
  /**
   * @param {object} options
   * @param {() => {pty: object}} options.spawn creates the PTY; injected for tests
   */
  constructor({
    serverId,
    sessionId,
    windowId,
    paneId,
    spawn,
    cols = 80,
    rows = 24,
    bufferBytes = DEFAULT_BUFFER_BYTES,
    detachedTtlMs = DEFAULT_DETACHED_TTL_MS,
    now = () => Date.now(),
    onExit = null,
  }) {
    this.serverId = serverId;
    this.sessionId = sessionId;
    this.windowId = windowId;
    this.paneId = paneId;
    this.cols = cols;
    this.rows = rows;
    this.subscribers = new Set();
    this.outputBuffer = new OutputRing(bufferBytes);
    this.detachedTtlMs = detachedTtlMs;
    this._now = now;
    this._spawn = spawn;
    this._onExit = onExit;
    this.createdAt = now();
    this.lastActivityAt = now();
    this.detachedAt = null;
    this.pty = null;
    this.exited = false;
    this.exitInfo = null;
    /** Set as soon as teardown begins, before the PTY has actually gone. */
    this._destroyed = false;
    this._exitNotified = false;
    /** Highest focus epoch seen; decides whose window size wins. */
    this._focusEpoch = -1;
    this._focusOwner = null;
    this._killTimer = null;
  }

  get alive() {
    return Boolean(this.pty) && !this.exited && !this._destroyed;
  }

  /** Starts the PTY. Called lazily on first subscribe, or eagerly to preheat. */
  start() {
    if (this.pty || this.exited || this._destroyed) return this;
    this.pty = this._spawn({ cols: this.cols, rows: this.rows });
    this.pty.onData((data) => {
      this.lastActivityAt = this._now();
      this.outputBuffer.push(data);
      this._fanout(data);
    });
    this.pty.onExit((event) => {
      this.exited = true;
      this.exitInfo = {
        code: event && typeof event.exitCode === 'number' ? event.exitCode : null,
        signal: event && event.signal !== undefined ? event.signal : null,
      };
      this._clearKillTimer();
      // Subscribers must learn the shell ended, or their sockets hang open.
      this._broadcastExit({ ...this.exitInfo, reason: 'remote_shell_exit' });
      if (typeof this._onExit === 'function') this._onExit(this);
    });
    return this;
  }

  /**
   * Attaches a subscriber. Returns the replay so the caller can announce how
   * many bytes it is about to resend before live output starts.
   */
  subscribe(subscriber) {
    if (this.exited || this._destroyed) {
      throw new AppError(ErrorCode.PANE_NOT_FOUND, 'This pane has already exited');
    }
    this.start();
    this.subscribers.add(subscriber);
    this.detachedAt = null;
    this.lastActivityAt = this._now();
    return this.outputBuffer.read();
  }

  unsubscribe(subscriber) {
    this.subscribers.delete(subscriber);
    if (this._focusOwner === subscriber) {
      // Otherwise the departed client would keep veto power over resizes and
      // whoever remains could never fit the terminal to their window.
      this._focusOwner = null;
      this._focusEpoch = -1;
    }
    if (this.subscribers.size === 0) {
      // Detached, not dead: a refresh within the TTL reconnects to this PTY.
      this.detachedAt = this._now();
    }
  }

  write(data) {
    if (!this.alive || typeof data !== 'string') return false;
    this.lastActivityAt = this._now();
    this.pty.write(data);
    return true;
  }

  /**
   * Resizes to match one subscriber. With several clients attached the most
   * recently focused one wins, otherwise two different window sizes would fight
   * and the remote program would redraw forever.
   */
  resize(cols, rows, { focusEpoch = null, subscriber = null } = {}) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) return false;
    if (cols <= 0 || rows <= 0 || cols > MAX_DIMENSION || rows > MAX_DIMENSION) return false;
    if (focusEpoch !== null) {
      if (focusEpoch < this._focusEpoch) return false;
      this._focusEpoch = focusEpoch;
      this._focusOwner = subscriber;
    } else if (this._focusOwner && subscriber && this._focusOwner !== subscriber) {
      return false;
    }
    if (cols === this.cols && rows === this.rows) return true;
    this.cols = cols;
    this.rows = rows;
    if (this.alive) {
      try {
        this.pty.resize(cols, rows);
      } catch {
        // A PTY that died between the check and the call is handled by onExit.
        return false;
      }
    }
    return true;
  }

  noteFocus(subscriber, focusEpoch) {
    if (!Number.isInteger(focusEpoch) || focusEpoch < this._focusEpoch) return false;
    this._focusEpoch = focusEpoch;
    this._focusOwner = subscriber;
    return true;
  }

  /**
   * True once the pane has gone the whole TTL with no subscribers and no I/O.
   * Activity renews the lease, per the documented rule ("30 minutes with no
   * subscriber and no input/output"), so a detached but working process is not
   * killed out from under the user.
   */
  isExpired(now = this._now()) {
    if (this.subscribers.size > 0) return false;
    if (this.detachedAt === null) return false;
    const idleSince = Math.max(this.detachedAt, this.lastActivityAt);
    return now - idleSince >= this.detachedTtlMs;
  }

  /**
   * Ends the PTY. SIGHUP/SIGTERM first so the remote shell can clean up, with a
   * SIGKILL fallback because an ssh client does not always honor a polite signal.
   */
  destroy(reason = 'closed') {
    this._clearKillTimer();
    this._destroyed = true;
    const info = {
      code: this.exitInfo ? this.exitInfo.code : null,
      signal: this.exitInfo ? this.exitInfo.signal : null,
      reason,
    };
    this.exitInfo = this.exitInfo || { code: null, signal: null, reason };
    // Tell attached clients first: clearing the set before notifying is what
    // left browser sockets open forever after a pane was closed.
    this._broadcastExit(info);

    if (!this.pty || this.exited) {
      this.exited = true;
      return;
    }
    const pty = this.pty;
    try {
      pty.kill('SIGHUP');
    } catch {
      try { pty.kill(); } catch { /* already gone */ }
    }
    this._killTimer = setTimeout(() => {
      this._killTimer = null;
      if (this.exited) return;
      try { pty.kill('SIGKILL'); } catch { /* already gone */ }
    }, KILL_ESCALATION_MS);
    if (this._killTimer.unref) this._killTimer.unref();
  }

  _clearKillTimer() {
    if (this._killTimer) clearTimeout(this._killTimer);
    this._killTimer = null;
  }

  _fanout(data) {
    for (const subscriber of this.subscribers) {
      try {
        subscriber.send(data);
      } catch {
        // A broken socket is removed by its own close handler.
      }
    }
  }

  /** Delivers exactly one exit notification, then releases every subscriber. */
  _broadcastExit(info) {
    if (this._exitNotified) return;
    this._exitNotified = true;
    const subscribers = [...this.subscribers];
    this.subscribers.clear();
    for (const subscriber of subscribers) {
      try {
        if (typeof subscriber.exit === 'function') subscriber.exit(info);
      } catch {
        // A socket that is already gone needs nothing from us.
      }
    }
  }

  describe() {
    return {
      serverId: this.serverId,
      sessionId: this.sessionId,
      windowId: this.windowId,
      paneId: this.paneId,
      cols: this.cols,
      rows: this.rows,
      subscribers: this.subscribers.size,
      bufferedBytes: this.outputBuffer.bytes,
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
      detachedAt: this.detachedAt,
      alive: this.alive,
    };
  }
}

export function newPaneId() {
  return 'pane_' + randomUUID().replace(/-/g, '').slice(0, 20);
}

export function newWindowId() {
  return 'win_' + randomUUID().replace(/-/g, '').slice(0, 20);
}

export function newSessionId() {
  return 'ses_' + randomUUID().replace(/-/g, '').slice(0, 20);
}
