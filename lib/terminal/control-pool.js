/** Shared, server-instance scoped control clients. They never detach legacy clients. */
import { ControlProcess } from './control-process.js';
import { tmuxEnv, tmuxServerArgs } from '../tmux-server.js';
import { AppError, ErrorCode } from '../servers/errors.js';
import { MAX_DIMENSION, MAX_INPUT_BYTES } from './protocol.js';

const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_SUBSCRIBERS = 5;
const fail = (code, message) => new AppError(ErrorCode[code], message);

export function validateControlTarget(target) {
  if (!target || !/^\d+:\d+$/.test(target.instanceId) || !/^\$\d+$/.test(target.sessionId)
    || !/^@\d+$/.test(target.windowId) || !/^%\d+$/.test(target.paneId)) throw fail('VALIDATION_ERROR', 'Invalid pane identity');
  return target;
}
export function validControlSize(cols, rows) {
  return Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0 && cols <= MAX_DIMENSION && rows <= MAX_DIMENSION;
}

export function decodeSnapshot(value) {
  let snapshot;
  try { snapshot = JSON.parse(value.toString('utf8')); } catch { throw fail('UNSUPPORTED', 'A native pane snapshot is required'); }
  snapshot.dataBase64 ??= snapshot.data;
  if (snapshot.version !== 1 || !validControlSize(snapshot.cols, snapshot.rows) || typeof snapshot.dataBase64 !== 'string'
    || snapshot.dataBase64.length > MAX_SNAPSHOT_BYTES || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(snapshot.dataBase64)) {
    throw fail('UNSUPPORTED', 'Unsupported native pane snapshot');
  }
  return snapshot;
}

export class ControlPool {
  constructor({ tmux, workspace, createControl = options => new ControlProcess(options), snapshotCommand = paneId => `capture-pane -Q -p -t ${paneId}`, idleMs = 30_000, maxSessions = 32, args = tmuxServerArgs(), env = tmuxEnv() }) {
    this.tmux = tmux;
    this.workspace = workspace;
    this.createControl = createControl;
    this.snapshotCommand = snapshotCommand;
    this.idleMs = idleMs;
    this.maxSessions = maxSessions;
    this.serverArgs = [...args];
    this.env = { ...env };
    this.socketIdentity = JSON.stringify(this.serverArgs);
    this.entries = new Map();
    this.order = 0;
    this.closed = false;
  }

  async capability() {
    try {
      const version = String(await this.tmux.run(['display-message', '-p', '#{pane_snapshot_version}'])).trim();
      return { available: version === '1' && !this.closed, protocol: 1, snapshotVersion: version === '1' ? 1 : null,
        ...(version === '1' ? {} : { reason: 'native_snapshot_required' }) };
    } catch { return { available: false, protocol: 1, snapshotVersion: null, reason: 'tmux_unavailable' }; }
  }

  async resolve(target) {
    validateControlTarget(target);
    const resolved = await this.workspace.resolvePane(target.paneId);
    if (resolved.windowId !== target.windowId) throw fail('PANE_NOT_FOUND', 'The pane moved to a different window');
    // One invocation binds the tree and server lifetime. The explicit session/window
    // target also supports windows linked into more than one session.
    const output = String(await this.tmux.run(['list-panes', '-t', `${target.sessionId}:${target.windowId}`, '-F',
      '#{pid}:#{start_time}|#{session_id}|#{window_id}|#{pane_id}|#{pane_width}|#{pane_height}|#{window_panes}|#{window_linked}|#{window_width}|#{window_height}']));
    const row = output.trim().split('\n').map(line => line.split('|')).find(fields => fields[3] === target.paneId);
    if (!row || row[1] !== target.sessionId || row[2] !== target.windowId) throw fail('PANE_NOT_FOUND', 'The pane no longer belongs to this session');
    if (row[0] !== target.instanceId) throw fail('WORKSPACE_UNAVAILABLE', 'The tmux server changed; refresh the workspace');
    if (row[7] !== '0') throw fail('UNSUPPORTED', 'Linked tmux windows use the compatible terminal view');
    const cols = Number(row[4]), rows = Number(row[5]);
    if (!validControlSize(cols, rows)) throw fail('WORKSPACE_UNAVAILABLE', 'The pane grid is unavailable');
    const windowCols = Number(row[8]), windowRows = Number(row[9]);
    if (!Number.isInteger(windowCols) || !Number.isInteger(windowRows) || windowCols < cols || windowRows < rows) throw fail('WORKSPACE_UNAVAILABLE', 'The window grid is unavailable');
    return { ...target, cols, rows, windowCols, windowRows, singlePane: row[6] === '1' };
  }

  async _entry(target) {
    if (this.closed) throw fail('WORKSPACE_UNAVAILABLE', 'The terminal service is stopping');
    const key = `${this.socketIdentity}|${target.instanceId}|${target.sessionId}`;
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.maxSessions) throw fail('CONNECTION_LIMIT', 'Too many active terminal sessions');
      const control = this.createControl({ sessionId: target.sessionId, args: this.serverArgs, env: this.env });
      entry = { key, control, sources: new Map(), timer: null, closed: false };
      this.entries.set(key, entry);
      control.on('output', (paneId, bytes) => {
        const source = entry.sources.get(paneId);
        if (source?.synced) this._broadcast(source, { type: 'output', encoding: 'base64', data: bytes.toString('base64') });
      });
      control.on('closed', () => {
        entry.closed = true;
        clearTimeout(entry.timer);
        this.entries.delete(key);
        for (const source of entry.sources.values()) {
          for (const subscriber of [...source.subscribers]) {
            this._send(subscriber, { type: 'error', code: 'WORKSPACE_UNAVAILABLE', message: 'The pane stream ended; reconnect to resynchronize', retryable: true });
            subscriber.end?.(1011, 'stream ended');
            subscriber.closed = true;
          }
        }
        entry.sources.clear();
      });
      control.on('notification', text => {
        if (/^%(?:window-close|unlinked-window-close|window-add|unlinked-window-add|layout-change|session-changed|sessions-changed)\b/.test(text)) this._reconcile(entry);
      });
      entry.ready = control.command("display-message -p '#{pid}:#{start_time}|#{session_id}|#{client_pid}'", {
        onResult: bytes => {
          const [instanceId, sessionId, pid] = bytes.toString().trim().split('|');
          if (instanceId !== target.instanceId || sessionId !== target.sessionId) throw fail('WORKSPACE_UNAVAILABLE', 'The control connection belongs to another server lifetime or session');
          if (!/^\d+$/.test(pid)) throw fail('INTERNAL', 'The control client identity is unavailable');
          control.clientPid = pid; // MSYS uses a POSIX pid, not child_process.pid.
        },
      }).catch(error => { this.entries.delete(key); control.dispose(); throw error; });
    }
    await entry.ready;
    clearTimeout(entry.timer);
    entry.timer = null;
    return entry;
  }

  _send(subscriber, frame) {
    if (subscriber.closed) return;
    try {
      subscriber.send(frame.type === 'output' || frame.type === 'snapshot' ? { ...frame, seq: ++subscriber.seq } : frame);
    } catch {
      subscriber.close?.();
      subscriber.end?.(1013, 'slow subscriber');
    }
  }

  _broadcast(source, frame) {
    for (const subscriber of source.subscribers) {
      if (!subscriber.visible || subscriber.closed || (frame.type === 'output' && !subscriber.synced)) continue;
      if (frame.type === 'snapshot') subscriber.synced = true;
      this._send(subscriber, frame);
    }
  }

  _announce(source, foreign) {
    for (const subscriber of source.subscribers) {
      const resizeAllowed = source.target.singlePane && !foreign && this._owner(source) === subscriber;
      const key = `${source.target.cols}:${source.target.rows}:${resizeAllowed}`;
      if (subscriber.announcement === key) continue;
      subscriber.announcement = key;
      this._send(subscriber, { type: 'ready', protocol: 1, ...source.target, resizeAllowed });
    }
  }

  async _snapshot(entry, source) {
    if (source.snapshotting) return source.snapshotting;
    source.synced = false;
    const task = entry.control.command(this.snapshotCommand(source.target.paneId), {
      onResult: bytes => {
        const snapshot = decodeSnapshot(bytes);
        if (snapshot.paneId !== source.target.paneId || snapshot.instanceId !== source.target.instanceId || snapshot.windowId !== source.target.windowId) throw fail('PANE_NOT_FOUND', 'The snapshot belongs to another pane');
        source.target.cols = snapshot.cols;
        source.target.rows = snapshot.rows;
        source.synced = true;
        // Native capture cuts this pane's queued raw output at the same callback
        // that serializes its state. Resynchronize every subscriber at that fence.
        this._broadcast(source, { type: 'snapshot', encoding: 'base64', data: snapshot.dataBase64, cols: snapshot.cols, rows: snapshot.rows, historyLines: snapshot.historyLines, historyTotal: snapshot.historyTotal });
      },
    });
    source.snapshotting = task;
    try { await task; }
    catch (error) {
      source.synced = false;
      for (const subscriber of [...source.subscribers]) {
        this._send(subscriber, { type: 'error', code: error.code || 'INTERNAL', message: 'The pane could not be resynchronized', retryable: error.retryable === true });
        subscriber.end?.(error.retryable ? 1011 : 1008, 'snapshot failed');
        subscriber.close();
      }
      throw error;
    } finally { if (source.snapshotting === task) source.snapshotting = null; }
  }

  async subscribe(requested, send, { cancelled = () => false, end = null } = {}) {
    const target = await this.resolve(requested);
    if (cancelled()) return null;
    if (!(await this.capability()).available) throw fail('UNSUPPORTED', 'This tmux build does not support native pane snapshots');
    if (cancelled()) return null;
    const entry = await this._entry(target);
    if (cancelled()) { this._idle(entry); return null; }
    let source = entry.sources.get(target.paneId);
    if (!source) {
      source = { target, subscribers: new Set(), synced: false, snapshotting: null };
      entry.sources.set(target.paneId, source);
    } else source.target = target;
    if (source.subscribers.size >= MAX_SUBSCRIBERS) throw fail('CONNECTION_LIMIT', 'Too many views of this pane');
    const subscriber = { send, end, seq: -1, visible: true, order: ++this.order, closed: false, synced: false };
    subscriber.close = () => {
      if (subscriber.closed) return;
      subscriber.closed = true;
      source.subscribers.delete(subscriber);
      if (source.subscribers.size === 0) entry.sources.delete(target.paneId);
      else this._foreignClient(target.sessionId).then(foreign => this._announce(source, foreign)).catch(() => {});
      this._idle(entry);
    };
    const lease = {
      close: subscriber.close,
      input: async data => {
        if (subscriber.closed || !subscriber.synced || !source.synced || !subscriber.visible || this._owner(source) !== subscriber) return false;
        if ((typeof data !== 'string' && !Buffer.isBuffer(data)) || Buffer.byteLength(data) > MAX_INPUT_BYTES) throw fail('VALIDATION_ERROR', 'Terminal input exceeded its limit');
        if (!data.length) return true;
        // This pipe remains bound to the verified server lifetime. Pane ids are
        // never reused within it, so a keystroke needs no subprocess/round trip.
        if (subscriber.closed || entry.closed) return false;
        const hex = [...Buffer.from(data, 'utf8')].map(byte => byte.toString(16).padStart(2, '0')).join(' ');
        await entry.control.command(`send-keys -H -t ${target.paneId} ${hex}`);
        return true;
      },
      resize: async (cols, rows) => {
        if (subscriber.closed || !validControlSize(cols, rows) || this._owner(source) !== subscriber) return false;
        const requestKey = () => `${cols}:${rows}|${source.target.cols}:${source.target.rows}:${source.target.windowCols}:${source.target.windowRows}`;
        if (subscriber.lastResize === requestKey()) return true;
        const current = await this.resolve(target);
        const foreign = await this._foreignClient(target.sessionId);
        source.target = current;
        if (!current.singlePane || foreign || this._owner(source) !== subscriber || subscriber.closed) {
          this._announce(source, foreign);
          await this._snapshot(entry, source);
          return false;
        }
        if (current.cols === cols && current.rows === rows) { subscriber.lastResize = requestKey(); return true; }
        // pane-border-status top/bottom reserves a row inside the window. A
        // requested pane grid is not the window grid; confusing them continually
        // resizes to an impossible size and causes a reset/snapshot feedback loop.
        const windowCols = cols + current.windowCols - current.cols;
        const windowRows = rows + current.windowRows - current.rows;
        await entry.control.command(`resize-window -t ${target.windowId} -x ${windowCols} -y ${windowRows}`);
        source.target = await this.resolve(target);
        // SIGWINCH can redraw a running TUI. The following native capture fences
        // those bytes and announces the resulting remote grid to every view.
        await this._snapshot(entry, source);
        subscriber.lastResize = requestKey();
        this.workspace.invalidate?.();
        return true;
      },
      visibility: async visible => {
        if (subscriber.closed || typeof visible !== 'boolean') return;
        const wasVisible = subscriber.visible;
        subscriber.visible = visible;
        if (!visible) subscriber.synced = false;
        if (visible) {
          subscriber.order = ++this.order;
          this._announce(source, await this._foreignClient(target.sessionId));
          if (!wasVisible) await this._snapshot(entry, source);
        } else this._announce(source, await this._foreignClient(target.sessionId));
      },
    };
    source.subscribers.add(subscriber);
    try {
      const foreign = await this._foreignClient(target.sessionId);
      if (cancelled()) { subscriber.close(); return null; }
      this._announce(source, foreign);
      await this._snapshot(entry, source);
      if (cancelled()) { subscriber.close(); return null; }
      return lease;
    } catch (error) { subscriber.close(); throw error; }
  }

  _owner(source) {
    return [...source.subscribers].filter(item => item.visible && !item.closed).sort((a, b) => b.order - a.order)[0];
  }

  async _foreignClient(sessionId) {
    const clients = String(await this.tmux.run(['list-clients', '-F', '#{session_id}|#{client_pid}']));
    const owned = new Set([...this.entries.values()].map(entry => entry.control.clientPid || entry.control.child?.pid).filter(Boolean).map(String));
    return clients.trim().split('\n').some(line => {
      const [session, pid] = line.split('|');
      return session === sessionId && !owned.has(pid);
    });
  }

  async _reconcile(entry) {
    if (entry.closed || this.closed) return;
    if (entry.reconciling) { entry.reconcileAgain = true; return; }
    entry.reconciling = true;
    try {
      for (const source of [...entry.sources.values()]) {
        try {
          const current = await this.resolve(source.target);
          const changed = current.cols !== source.target.cols || current.rows !== source.target.rows || current.singlePane !== source.target.singlePane;
          source.target = current;
          if (changed) {
            this._announce(source, await this._foreignClient(current.sessionId));
            await this._snapshot(entry, source);
          }
        } catch (error) {
          if (error.code === 'UNSUPPORTED') {
            for (const subscriber of [...source.subscribers]) {
              this._send(subscriber, { type: 'error', code: error.code, message: error.message, retryable: false });
              subscriber.end?.(1008, 'linked window');
              subscriber.close();
            }
            continue;
          }
          if (!['PANE_NOT_FOUND', 'WINDOW_NOT_FOUND', 'SESSION_NOT_FOUND'].includes(error.code)) continue;
          for (const subscriber of [...source.subscribers]) {
            this._send(subscriber, { type: 'exit', reason: 'pane_closed' });
            subscriber.end?.(1000, 'pane closed');
            subscriber.close();
          }
        }
      }
    } finally {
      entry.reconciling = false;
      if (entry.reconcileAgain) { entry.reconcileAgain = false; this._reconcile(entry).catch(() => {}); }
    }
  }

  /** A read-only page in the currently retained tmux history, oldest first. */
  async history(requested, { before, limit = 500 } = {}) {
    if ((before !== undefined && (!Number.isSafeInteger(before) || before < 0 || before > 0x7fffffff))
      || !Number.isInteger(limit) || limit < 1 || limit > 500) throw fail('VALIDATION_ERROR', 'Invalid terminal history range');
    const target = await this.resolve(requested);
    if (!(await this.capability()).available) throw fail('UNSUPPORTED', 'Native pane streams are required for scoped history');
    const entry = await this._entry(target);
    const metadata = `display-message -p -t ${target.paneId} '#{pid}:#{start_time}|#{session_id}|#{window_id}|#{pane_id}|#{history_size}|#{window_linked}'`;
    const parse = bytes => {
      const [instanceId, sessionId, windowId, paneId, total, linked] = bytes.toString().trim().split('|');
      if (instanceId !== target.instanceId || sessionId !== target.sessionId || windowId !== target.windowId || paneId !== target.paneId) throw fail('WORKSPACE_UNAVAILABLE', 'The history target changed; refresh the workspace');
      if (linked !== '0') throw fail('UNSUPPORTED', 'Linked tmux windows use the compatible terminal view');
      if (!/^\d+$/.test(total) || Number(total) > 0x7fffffff) throw fail('WORKSPACE_UNAVAILABLE', 'The terminal history range is unavailable');
      return Number(total);
    };
    try {
      const total = parse(await entry.control.command(metadata));
      const end = Math.min(before ?? total, total);
      const start = Math.max(0, end - limit);
      const capture = `capture-pane -p -t ${target.paneId} -S ${start - total} -E ${end - 1 - total}`;
      // One line is one command queue group. These synchronous commands do not
      // yield; metadata on both sides also rejects a history-changing user hook.
      const results = await entry.control.transaction(end > start ? [metadata, capture, metadata] : [metadata, metadata]);
      if (parse(results[0]) !== total || parse(results.at(-1)) !== total) throw fail('TERMINAL_BUSY', 'Terminal history changed while reading; retry this page');
      return { ...requested, lines: end > start ? results[1].toString('utf8').split('\n') : [], total, before: end, nextBefore: start === 0 ? null : start };
    } finally { this._idle(entry); }
  }

  _idle(entry) {
    if (entry.sources.size || entry.closed || entry.timer) return;
    entry.timer = setTimeout(() => {
      if (entry.sources.size === 0) { this.entries.delete(entry.key); entry.control.dispose(); }
    }, this.idleMs);
    entry.timer.unref?.();
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    for (const entry of [...this.entries.values()]) { clearTimeout(entry.timer); entry.control.dispose(); }
    this.entries.clear();
  }
}
