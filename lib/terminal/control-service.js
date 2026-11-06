/** Workbench mutations: detached windows, persistent request receipts, explicit termination. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError, ErrorCode } from '../servers/errors.js';
import { validControlSize, validateControlTarget } from './control-pool.js';

const stale = 'TWP_WORKBENCH_STALE';
const invalid = message => new AppError(ErrorCode.VALIDATION_ERROR, message);
const hash = value => createHash('sha256').update(value).digest('hex');
export const quoteTmux = word => "'" + String(word).replace(/'/g, "'\\''") + "'";

export class WorkbenchService {
  constructor({ pool, nativePool, tmux, workspace, configDir, onChange = () => workspace.invalidate?.() }) {
    this.pool = pool;
    this.nativePool = nativePool;
    this.tmux = tmux;
    this.workspace = workspace;
    this.receipts = join(configDir, 'workbench-requests');
    this.requests = new Map();
    this.closed = false;
    this.onChange = onChange;
  }

  capability() { return this.closed ? Promise.resolve({ available: false, protocol: 1, reason: 'plugin_unloaded' }) : this.pool.capability(); }

  _assertOpen() { if (this.closed) throw new AppError(ErrorCode.WORKSPACE_UNAVAILABLE, 'The workbench service is stopping', { retryable: false }); }

  dispose() { this.closed = true; }

  async listPanes() {
    const tree = await this.workspace.getWorkspace();
    return { instanceId: tree.instanceId, complete: tree.complete, panes: tree.sessions.flatMap(session => session.windows.flatMap(window => window.panes.map(pane => ({
      instanceId: tree.instanceId, sessionId: session.id, windowId: window.id, paneId: pane.id,
      cols: pane.geometry.width, rows: pane.geometry.height, resizeAllowed: window.panes.length === 1,
    })))) };
  }

  async _session(instanceId, sessionId) {
    if (!/^\d+:\d+$/.test(instanceId) || !/^\$\d+$/.test(sessionId)) throw invalid('Invalid workspace identity');
    const current = String(await this.tmux.run(['display-message', '-p', '-t', sessionId, '#{pid}:#{start_time}|#{session_id}'])).trim();
    if (current !== `${instanceId}|${sessionId}`) throw new AppError(ErrorCode.WORKSPACE_UNAVAILABLE, 'The tmux server changed; refresh the workspace');
  }

  async _mutation(instanceId, sessionId, command) {
    this._assertOpen();
    // The identity test and mutation execute on the same connected tmux server.
    // A server dying after the earlier read must never redirect a kill/new-window
    // to a replacement server that happens to reuse $1 or %1.
    const result = String(await this.tmux.run(['if-shell', '-F', '-t', sessionId,
      `#{==:#{pid}:#{start_time},${instanceId}}`, command, `display-message -p ${stale}`])).trim();
    if (result === stale) throw new AppError(ErrorCode.WORKSPACE_UNAVAILABLE, 'The tmux server changed; refresh the workspace');
    return result;
  }

  createPane(body) { return this._createRequest(body, false); }
  createWindow(body) { return this._createRequest(body, true); }

  _createRequest(body, native) {
    if (this.closed) return Promise.reject(new AppError(ErrorCode.WORKSPACE_UNAVAILABLE, 'The workbench service is stopping', { retryable: false }));
    if (!body || typeof body !== 'object' || Array.isArray(body)) return Promise.reject(invalid('Invalid pane request'));
    if (Object.keys(body).some(key => !['instanceId', 'sessionId', 'requestId', 'cols', 'rows', 'cwd'].includes(key))) return Promise.reject(invalid('Unknown pane request field'));
    const { instanceId, sessionId, requestId, cols, rows, cwd } = body;
    if (!/^\d+:\d+$/.test(instanceId) || !/^\$\d+$/.test(sessionId) || !/^[A-Za-z0-9_-]{8,128}$/.test(requestId)
      || !validControlSize(cols, rows) || (native && (cols < 2 || rows < 2)) || (cwd !== undefined && (typeof cwd !== 'string' || !cwd || cwd.length > 4096 || /[\x00-\x1f\x7f]/.test(cwd)))) return Promise.reject(invalid('Invalid pane request'));
    const signature = hash(JSON.stringify([instanceId, sessionId, requestId, cols, rows, cwd ?? null, ...(native ? ['native-window'] : [])]));
    const key = hash(JSON.stringify([this.pool.socketIdentity, instanceId, requestId]));
    const previous = this.requests.get(key);
    if (previous) return previous.signature === signature ? previous.promise : Promise.reject(invalid('This request id was already used for different parameters'));
    if (this.requests.size >= 4096) return Promise.reject(new AppError(ErrorCode.CONNECTION_LIMIT, 'Too many workbench creation requests'));
    const promise = this._create({ ...body, signature, key, native });
    const request = { signature, promise };
    this.requests.set(key, request);
    // Only concurrent callers share this promise. Durable receipts, not a
    // rejected preflight promise, fence mutations whose outcome is uncertain.
    promise.finally(() => { if (this.requests.get(key) === request) this.requests.delete(key); }).catch(() => {});
    return promise;
  }

  async _create({ instanceId, sessionId, requestId, cols, rows, cwd, signature, key, native }) {
    this._assertOpen();
    await this._session(instanceId, sessionId);
    const capability = native ? await this.nativePool?.capability() : await this.capability();
    if (!capability?.available) throw new AppError(ErrorCode.UNSUPPORTED, native ? 'A native tmux client is required before creating a workbench window' : 'Native pane snapshots are required before creating a workbench pane');
    this._assertOpen();
    await mkdir(this.receipts, { recursive: true, mode: 0o700 });
    this._assertOpen();
    const path = join(this.receipts, key + '.json');
    let receipt, ownedReceipt = false;
    try {
      const file = await open(path, 'wx', 0o600);
      ownedReceipt = true;
      try { await file.writeFile(JSON.stringify({ signature, state: 'pending' })); await file.sync(); } finally { await file.close(); }
    } catch (error) {
      if (error.code !== 'EEXIST') {
        if (ownedReceipt) await unlink(path).catch(() => {});
        throw error; // no mutation without a durable pending receipt
      }
      try { receipt = JSON.parse(await readFile(path, 'utf8')); } catch { throw new AppError(ErrorCode.TERMINAL_BUSY, 'The previous request could not be confirmed; refresh the workspace'); }
      if (receipt.signature !== signature) throw invalid('This request id was already used for different parameters');
      if (receipt.state === 'created') return receipt.result;
      throw new AppError(ErrorCode.TERMINAL_BUSY, 'The previous creation may have completed; refresh the workspace before creating another pane', { retryable: false });
    }
    let created = false, attempted = false;
    try {
      this._assertOpen();
      const command = ['new-window', '-d', '-P', '-F', quoteTmux('#{window_id}|#{pane_id}'), '-t', quoteTmux(sessionId + ':'),
        '-n', 'workbench', ...(cwd ? ['-c', quoteTmux(cwd.replaceAll('#', '##'))] : [])].join(' ');
      attempted = true;
      const output = await this._mutation(instanceId, sessionId, command);
      const [windowId, paneId, extra] = output.split('|');
      if (!/^@\d+$/.test(windowId) || !/^%\d+$/.test(paneId) || extra !== undefined) throw new AppError(ErrorCode.INTERNAL, 'The created pane identity could not be confirmed', { retryable: false });
      created = true;
      if (!native) {
        const grid = await this.pool.resolve({ instanceId, sessionId, windowId, paneId });
        if (grid.singlePane === false) throw new AppError(ErrorCode.UNSUPPORTED, 'The new window was changed by a tmux hook; inspect the workspace before continuing');
        const windowCols = cols + (grid.windowCols ?? grid.cols) - grid.cols;
        const windowRows = rows + (grid.windowRows ?? grid.rows) - grid.rows;
        await this._mutation(instanceId, sessionId, `resize-window -t ${windowId} -x ${windowCols} -y ${windowRows}`);
      }
      const result = { instanceId, sessionId, requestId, windowId, paneId, cols, rows, resizeAllowed: true };
      await this._save(path, { signature, state: 'created', result });
      this.onChange();
      return result;
    } catch (error) {
      if (!attempted) { await unlink(path).catch(() => {}); throw error; }
      if (created) this.onChange();
      // Failed/ambiguous mutations are deliberately never retried, even after a
      // panel restart. The receipt preserves that fence instead of guessing.
      try { await this._save(path, { signature, state: 'uncertain' }); } catch { /* pending is also a no-retry receipt */ }
      throw error;
    }
  }

  async _save(path, value) {
    const temporary = path + '.' + randomUUID();
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
  }

  history(target, range) {
    this._assertOpen();
    return this.pool.history(target, range);
  }

  async terminate(target) {
    this._assertOpen();
    validateControlTarget(target);
    await this.pool.resolve(target);
    await this._mutation(target.instanceId, target.sessionId, `kill-pane -t ${target.paneId}`);
    this.onChange();
  }
}
