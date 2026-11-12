/** Persistent, owned native tmux clients. Disconnecting a view never ends a pane. */
import { randomBytes } from 'node:crypto';
import { NativeWindowProcess } from './native-window-process.js';
import { ControlProcess } from './control-process.js';
import { quoteTmux } from './control-service.js';
import { validControlSize } from './control-pool.js';
import { tmuxEnv, tmuxServerArgs } from '../tmux-server.js';
import { AppError, ErrorCode } from '../servers/errors.js';
import { MAX_INPUT_BYTES } from './protocol.js';

const unavailable = message => new AppError(ErrorCode.WORKSPACE_UNAVAILABLE, message);
const auxiliaryError = () => new AppError(ErrorCode.TERMINAL_BUSY, 'The native terminal control channel is recovering');
const identityError = message => Object.assign(unavailable(message), { fatalNative: true });
const clientFormat = '#{pid}:#{start_time}|#{client_pid}|#{client_tty}|#{session_id}|#{window_id}|#{pane_id}|#{client_width}|#{client_height}';
const completeContext = value => value && /^\$\d+$/.test(value.sessionId) && /^@\d+$/.test(value.windowId) && /^%\d+$/.test(value.paneId) && validControlSize(value.cols, value.rows);
export function validateNativeTarget(target) {
  if (!target || !/^\d+:\d+$/.test(target.instanceId) || !/^\$\d+$/.test(target.sessionId) || !/^@\d+$/.test(target.windowId)
    || target.cols < 2 || target.rows < 2 || typeof target.clientId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(target.clientId) || !validControlSize(target.cols, target.rows)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid native window identity');
  }
  return target;
}

export class NativeWindowPool {
  constructor({ tmux, createNative = options => new NativeWindowProcess(options), createControl = options => new ControlProcess(options),
    args = tmuxServerArgs(), env = tmuxEnv(), idleMs = 5 * 60_000, maxEntries = 16, pollMs = 1000, timeoutMs = 15_000 }) {
    Object.assign(this, { tmux, createNative, createControl, idleMs, maxEntries, pollMs, timeoutMs });
    this.args = [...args]; this.env = { ...env }; this.entries = new Map(); this.closed = false;
  }

  async capability() {
    try {
      const available = !this.closed && String(await this.tmux.run(['display-message', '-p', '#{native_client_protocol}'])).trim() === '1';
      return { available, protocol: 1, mode: 'native-window', ...(available ? {} : { reason: 'native_client_required' }) };
    } catch { return { available: false, protocol: 1, mode: 'native-window', reason: 'tmux_unavailable' }; }
  }

  _assert(entry, lease) {
    if (this.closed || entry.closed || (lease && (lease.closed || entry.active !== lease || lease.cancelled?.()))) throw unavailable('The native terminal subscription ended');
  }

  async subscribe(target, send, { cancelled = () => false, end = () => {} } = {}) {
    validateNativeTarget(target);
    if (this.closed) throw unavailable('The native terminal service is stopping');
    let entry = this.entries.get(target.clientId), fresh = !entry;
    if (entry?.active) throw new AppError(ErrorCode.TERMINAL_BUSY, 'This native view is already connected');
    if (entry && entry.target.instanceId !== target.instanceId) {
      throw unavailable('The saved native view belongs to a different window');
    }
    if (fresh) {
      if (this.entries.size >= this.maxEntries) throw new AppError(ErrorCode.CONNECTION_LIMIT, 'Too many persistent native views');
      entry = { target: { ...target }, closed: false, verified: false, context: null, early: [], earlyBytes: 0, responses: [], responseBytes: 0, cols: target.cols, rows: target.rows };
      this.entries.set(target.clientId, entry);
    }
    clearTimeout(entry.idleTimer);
    const lease = { closed: false, synced: false, seq: -1, contextRequests: 0, send, end, cancelled,
      input: data => this._input(entry, lease, data, false), response: data => this._input(entry, lease, data, true),
      context: requestId => this._requestContext(entry, lease, requestId),
      resize: (cols, rows) => this._resize(entry, lease, cols, rows), visibility: () => !lease.closed,
      close: () => this._unsubscribe(entry, lease) };
    entry.active = lease;
    try {
      if (fresh) {
        const windows = String(await this.tmux.run(['list-windows', '-t', target.sessionId, '-F', '#{pid}:#{start_time}|#{session_id}|#{window_id}'])).trim().split('\n');
        this._assert(entry, lease);
        if (!windows.includes(`${target.instanceId}|${target.sessionId}|${target.windowId}`)) throw unavailable('The tmux instance or window changed');
      }
      // Return before hydration so terminal DA/DSR replies can reach the native TTY.
      if (fresh) entry.start = this._start(entry);
      const work = (entry.hydration || entry.start).then(() => {
        if (!lease.closed && entry.active === lease) return this._hydrate(entry, lease, target);
      });
      entry.hydration = work.catch(error => {
        if (entry.closed) return;
        if (entry.native && !entry.native.closed && !error.fatalNative) this._dropLease(entry, lease, error);
        else this._close(entry, error);
      });
      return lease;
    } catch (error) {
      if (fresh) this._close(entry); else this._unsubscribe(entry, lease);
      throw error;
    }
  }

  async _start(entry) {
    // A persistent client may outlive its subscriber only after it exists.
    // During startup, each await must still have a current, uncancelled owner.
    const assertOwner = () => {
      if (!entry.active) throw unavailable('The native terminal subscription ended');
      this._assert(entry, entry.active);
    };
    assertOwner();
    const options = { ...entry.target, args: this.args, env: this.env, timeoutMs: this.timeoutMs };
    entry.control = this._newControl(entry, entry.target.sessionId);
    const identity = String(await entry.control.command("display-message -p '#{pid}:#{start_time}|#{session_id}'")).trim();
    assertOwner();
    if (identity !== `${entry.target.instanceId}|${entry.target.sessionId}`) throw unavailable('The tmux server changed during attach');
    await entry.control.command('refresh-client -f no-output');
    assertOwner();
    entry.native = this.createNative(options);
    entry.native.on('output', bytes => this._output(entry, bytes));
    entry.native.on('exit', exit => this._close(entry, null, exit));
    entry.native.on('closed', error => this._close(entry, error));
    await this._verifyNative(entry);
  }

  async _verifyNative(entry) {
    entry.hello = await entry.native.ready;
    this._assert(entry);
    const expires = Date.now() + this.timeoutMs;
    let context;
    do {
      context = await this._context(entry);
      this._assert(entry);
      if (context) break;
      if (Date.now() >= expires) throw unavailable('The native tmux client could not be verified');
      await this._delay(entry);
    } while (!entry.closed);
    entry.verified = true;
    for (const bytes of entry.early) this._bootstrap(entry, bytes);
    entry.early = []; entry.earlyBytes = 0;
    for (const bytes of entry.responses) entry.native.input(bytes);
    entry.responses = []; entry.responseBytes = 0;
    if (!entry.poll) { entry.poll = setInterval(() => this._check(entry), this.pollMs); entry.poll.unref?.(); }
  }

  async _context(entry) {
    const control = await this._availableControl(entry);
    const text = String(await control.command(`list-clients -F ${quoteTmux(clientFormat)}`)).trim();
    this._assert(entry);
    return this._parseContext(entry, text);
  }

  _parseContext(entry, text) {
    for (const line of text.split('\n')) {
      const [instanceId, pid, tty, sessionId, windowId, paneId, cols, rows] = line.split('|');
      if (pid !== String(entry.hello.pid) || tty !== entry.hello.tty) continue;
      if (instanceId !== entry.target.instanceId) throw identityError('The native client belongs to a replaced tmux server');
      return { instanceId, sessionId, windowId, paneId, cols: Number(cols), rows: Number(rows) };
    }
    return null;
  }

  _newControl(entry, sessionId) {
    const control = this.createControl({ ...entry.target, sessionId, args: this.args, env: this.env, timeoutMs: this.timeoutMs });
    control.on('notification', () => { if (entry.verified && entry.control === control) this._check(entry); });
    control.on('closed', error => {
      if (entry.closed || entry.control !== control) return;
      entry.control = null;
      if (!entry.native) { this._close(entry, error); return; }
      // A helper losing its session is not a reason to detach the real client.
      entry.native.cancelCapture?.(auxiliaryError());
      this._recover(entry);
    });
    return control;
  }

  async _availableControl(entry) {
    this._assert(entry);
    if (entry.recovering) return entry.recovering;
    if (entry.control && !entry.control.closed) return entry.control;
    return this._recover(entry);
  }

  _recover(entry) {
    if (entry.recovering) return entry.recovering;
    const recovering = this._recoverControl(entry).finally(() => {
      if (entry.recovering === recovering) entry.recovering = null;
    });
    entry.recovering = recovering;
    recovering.catch(error => {
      if (entry.closed) return;
      if (error.fatalNative) this._close(entry, error);
      else if (entry.active) this._dropLease(entry, entry.active, auxiliaryError());
    });
    return recovering;
  }

  async _recoverControl(entry) {
    if (!entry.hello) entry.hello = await entry.native.ready;
    for (let attempt = 0; attempt < 3; attempt++) {
      this._assert(entry);
      let control;
      try {
        // Read only: a dead initial session may no longer be a valid target.
        const context = this._parseContext(entry, String(await this.tmux.run(['list-clients', '-F', clientFormat])).trim());
        this._assert(entry);
        if (!completeContext(context)) throw auxiliaryError();
        control = this._newControl(entry, context.sessionId);
        entry.control = control;
        const identity = String(await control.command("display-message -p '#{pid}:#{start_time}|#{session_id}'")).trim();
        this._assert(entry);
        if (identity !== `${entry.target.instanceId}|${context.sessionId}`) throw identityError('The tmux server changed during control recovery');
        await control.command('refresh-client -f no-output');
        this._assert(entry);
        return control;
      } catch (error) {
        if (entry.control === control) entry.control = null;
        control?.dispose();
        if (error.fatalNative || entry.closed) throw error;
        if (attempt === 2) throw auxiliaryError();
        await this._delay(entry);
      }
    }
  }

  async _hydrate(entry, lease, target, context) {
    this._assert(entry, lease);
    if (!entry.verified) await this._verifyNative(entry);
    this._assert(entry, lease);
    if (entry.cols !== target.cols || entry.rows !== target.rows) {
      if (!entry.native.resize(target.cols, target.rows)) throw unavailable('The native client could not resize');
      entry.cols = target.cols; entry.rows = target.rows;
    }
    const expires = Date.now() + this.timeoutMs;
    while (!completeContext(context)) {
      context = await this._context(entry);
      this._assert(entry);
      if (lease.closed || entry.active !== lease) return;
      if (!context) throw unavailable('The native client ended');
      if (completeContext(context)) break;
      if (Date.now() >= expires) throw unavailable('The native client did not attach a window');
      await this._delay(entry);
    }
    const control = await this._availableControl(entry);
    this._assert(entry, lease);
    const nonce = randomBytes(16).toString('hex');
    const captured = entry.native.capture(nonce, snapshot => {
      this._assert(entry);
      const meta = snapshot.meta;
      if (!meta || meta.protocol !== 1 || meta.instanceId !== entry.target.instanceId || meta.clientPid !== entry.hello.pid || !completeContext(meta)
        || !Buffer.isBuffer(snapshot.data) || snapshot.data.length > 8 * 1024 * 1024) throw identityError('The native snapshot identity did not match');
      entry.context = { instanceId: meta.instanceId, sessionId: meta.sessionId, windowId: meta.windowId, paneId: meta.paneId, cols: meta.cols, rows: meta.rows };
      entry.cols = meta.cols; entry.rows = meta.rows;
      if (lease.closed || entry.active !== lease || lease.cancelled?.()) return;
      if (!this._send(lease, { type: 'ready', protocol: 1, mode: 'native-window', ...entry.context, clientId: entry.target.clientId, resizeAllowed: true })) return;
      if (!this._send(lease, { type: 'snapshot', protocol: 1, ...entry.context, clientId: entry.target.clientId, seq: ++lease.seq, encoding: 'base64', data: snapshot.data.toString('base64') })) return;
      lease.synced = true;
    });
    // Catch immediately: command failure may synchronously dispose a pending capture.
    captured.catch(() => {});
    try { await control.command(`refresh-client -t ${quoteTmux(entry.hello.tty)} -Q ${nonce}`); }
    catch (error) { entry.native.cancelCapture?.(error); throw error; }
    await captured;
    this._assert(entry);
  }

  _delay(entry) {
    return new Promise(resolve => {
      entry.retryResolve = () => { entry.retryTimer = null; entry.retryResolve = null; resolve(); };
      entry.retryTimer = setTimeout(entry.retryResolve, 25);
    }).then(() => this._assert(entry));
  }

  _send(lease, frame) {
    if (lease.closed) return false;
    if (lease.cancelled?.()) { lease.close(); return false; }
    try { lease.send(frame); return true; }
    catch (error) {
      lease.close(); // A slow browser must not turn into a native transport error.
      try { lease.end(error); } catch { /* the failed subscriber is already released */ }
      return false;
    }
  }

  _bootstrap(entry, bytes) {
    const lease = entry.active;
    if (lease) this._send(lease, { type: 'bootstrap', encoding: 'base64', data: bytes.toString('base64') });
  }

  _output(entry, bytes) {
    if (entry.closed || !entry.active) return;
    if (!entry.verified) {
      if (entry.earlyBytes + bytes.length > 1024 * 1024) return this._close(entry, unavailable('The native startup output exceeded its limit'));
      entry.early.push(Buffer.from(bytes)); entry.earlyBytes += bytes.length; return;
    }
    const lease = entry.active;
    if (lease.synced) this._send(lease, { type: 'output', seq: ++lease.seq, encoding: 'base64', data: bytes.toString('base64') });
    else this._bootstrap(entry, bytes);
  }

  _input(entry, lease, value, response) {
    if (entry.closed || lease.closed || entry.active !== lease || lease.cancelled?.() || (!response && !lease.synced)) return false;
    if (!(typeof value === 'string' || Buffer.isBuffer(value))) return false;
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (!bytes.length || bytes.length > (response ? 16 * 1024 : MAX_INPUT_BYTES)) return false;
    if (entry.verified) return entry.native.input(bytes);
    if (!response || entry.responseBytes + bytes.length > 16 * 1024) return false;
    entry.responses.push(Buffer.from(bytes)); entry.responseBytes += bytes.length; return true;
  }

  _resize(entry, lease, cols, rows) {
    if (entry.closed || lease.closed || entry.active !== lease || !lease.synced || lease.cancelled?.() || !validControlSize(cols, rows) || cols < 2 || rows < 2
      || (entry.cols === cols && entry.rows === rows)) return false;
    entry.cols = cols; entry.rows = rows;
    return entry.native.resize(cols, rows);
  }

  async _requestContext(entry, lease, requestId) {
    this._assert(entry, lease);
    if (!lease.synced) throw unavailable('The native terminal is still synchronizing');
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(requestId)) throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid context request');
    if (lease.contextRequests >= 8) throw new AppError(ErrorCode.CONNECTION_LIMIT, 'Too many native context requests');
    lease.contextRequests++;
    try {
      const context = await this._context(entry);
      this._assert(entry, lease);
      if (!completeContext(context)) throw unavailable('The native client has no active pane');
      entry.context = context;
      this._send(lease, { type: 'context', protocol: 1, ...context, clientId: entry.target.clientId, requestId });
      return context;
    } finally { lease.contextRequests--; }
  }

  _check(entry) {
    if (entry.closed || !entry.verified) return;
    if (entry.checking) { entry.checkAgain = true; return; }
    entry.checking = true;
    this._context(entry).then(context => {
      if (entry.closed) return;
      if (!context) {
        // list-clients can observe removal before the PTY delivers its exit
        // trailer. Let the native process distinguish detach from task exit.
        if (!entry.exitTimer) {
          entry.exitTimer = setTimeout(() => this._close(entry, null, { code: 0,
            reason: entry.native?.screen?.reason || 'tmux_client_exit' }), this.timeoutMs);
          entry.exitTimer.unref?.();
        }
        return;
      }
      clearTimeout(entry.exitTimer); entry.exitTimer = null;
      if (!completeContext(context)) return;
      const previous = JSON.stringify(entry.context);
      entry.context = context;
      if (previous !== JSON.stringify(context) && entry.active?.synced) this._send(entry.active, { type: 'context', protocol: 1, ...context, clientId: entry.target.clientId });
    }).catch(error => {
      if (error.fatalNative) this._close(entry, error);
      // A helper may be reattaching after the native client changed sessions.
    }).finally(() => {
      entry.checking = false;
      if (entry.checkAgain) { entry.checkAgain = false; this._check(entry); }
    });
  }

  _unsubscribe(entry, lease) {
    if (lease.closed) return;
    lease.closed = true; lease.synced = false;
    if (entry.active !== lease) return;
    entry.active = null; entry.responses = []; entry.responseBytes = 0;
    if (!entry.native) { this._close(entry); return; }
    if (!entry.closed) { entry.idleTimer = setTimeout(() => this._close(entry), this.idleMs); entry.idleTimer.unref?.(); }
  }

  _dropLease(entry, lease, error) {
    if (lease.closed) return;
    this._unsubscribe(entry, lease);
    try { lease.end(error); } catch { /* disconnected subscriber */ }
  }

  _close(entry, error, exit) {
    if (entry.closed) return;
    entry.closed = true;
    clearTimeout(entry.idleTimer); clearTimeout(entry.retryTimer); clearTimeout(entry.exitTimer); clearInterval(entry.poll);
    entry.retryResolve?.();
    this.entries.delete(entry.target.clientId);
    const lease = entry.active;
    if (lease && !lease.closed) {
      try {
        if (exit) { this._send(lease, { type: 'exit', ...entry.context, clientId: entry.target.clientId, ...exit }); lease.end(1000, 'ended'); }
        else if (error) lease.end(error);
      } catch { /* subscriber disposal cannot prevent owned client cleanup */ }
      lease.closed = true; lease.synced = false;
    }
    entry.active = null; entry.early = []; entry.responses = [];
    entry.native?.dispose(); entry.control?.dispose();
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    for (const entry of [...this.entries.values()]) this._close(entry, unavailable('The native terminal service is stopping'));
  }
}
