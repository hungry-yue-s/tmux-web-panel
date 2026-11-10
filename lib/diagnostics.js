import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

export const CAPTURE_DURATION_MS = 7_200_000;
export const CAPTURE_MAX_BYTES = 64 * 1024 * 1024;
export const CAPTURE_QUEUE_BYTES = 1024 * 1024;
export const SAMPLE_INTERVAL_MS = 5000;
export const CLIENT_BATCH_BYTES = 100 * 1024;
const ID = /^[A-Za-z0-9_-]{8,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SERVER = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;
const KINDS = new Set(['http', 'api', 'proxy', 'terminal', 'command', 'git', 'node', 'windows', 'platform', 'capture', 'client', 'navigation']);
const CLIENT_KINDS = new Set(['api', 'terminal', 'git', 'client', 'navigation']);
const NUMBER_FIELDS = new Set(('durationMs ttfbMs responseBytes requestBytes bytesRead bytesWritten writableLength readableLength bufferedAmount queueMs connectMs tlsMs ensureMs headersMs firstByteMs stdoutBytes stderrBytes exitCode pid active queued starting leaving waitingToEnd stillRunning heldBytes cols rows count frameCount inputBytes outputBytes parseMs renderMs lagMs elapsedMs processCpuPercent rssBytes heapUsedBytes heapTotalBytes externalBytes arrayBufferBytes eventLoopP50Ms eventLoopP95Ms eventLoopP99Ms eventLoopMaxMs eventLoopUtilization cpuPercent memTotalBytes memFreeBytes sampleMs sampleIntervalMs loopLagMs totalMatchingProcesses cpuCount socketCount samplerMs clientTs').split(' '));
const BOOLEAN_FIELDS = new Set(['reusedSocket', 'aborted', 'timedOut', 'maxOutput', 'truncated', 'hadError', 'complete', 'compressed']);
const ID_FIELDS = new Set(['requestId', 'parentRequestId', 'hubRequestId', 'connectionId', 'clientId', 'traceId']);
const ENUM_FIELDS = new Set(['operation', 'phase', 'outcome', 'code', 'transportCode', 'reason', 'side', 'provider', 'signal', 'type', 'platform']);
const CLIENT_CODES = new Set(('OK HTTP_ERROR SERVER_ERROR NETWORK_ERROR ABORTED TIMEOUT PARSE_ERROR NOT_REPO RENDER_ERROR FOCUS_ERROR STALE UNHANDLED_ERROR GIT_LOAD_OK GIT_API_ERROR GIT_RENDER_ERROR GIT_NOT_REPO GIT_DIFF_OK GIT_DIFF_ERROR GIT_FOCUS_ERROR GIT_STALE TERM_SAMPLE WS_OPEN WS_ERROR WS_CLOSE_NORMAL WS_CLOSE_GOING_AWAY WS_CLOSE_ABNORMAL WS_CLOSE_REJECTED WS_CLOSE_OTHER CLIENT_STALL CLIENT_LONGTASK CLIENT_ERROR CLIENT_DROPPED NAV_WORKSPACE NAV_PANES NAV_RENDERER_READY NAV_WS_CREATED NAV_WS_OPEN NAV_READY NAV_FIRST_OUTPUT NAV_FIRST_PARSED NAV_FIRST_RENDER NAV_STABLE').split(' '));
const PROCESS_NAME = /^(?:Anymux|Tmux ?Panel|WindowServer|node|tmux|ssh|sshd|claude|codex|git|bash|fish|zsh|sh|powershell|pwsh|conhost|OpenConsole|WebKit|com\.apple\.WebKit\.(?:WebContent|Networking|GPU))(?:\.exe)?$/i;
const API_PATHS = new Set(('auth node/info git/status git/diff git/line-changes git/log git/show git/branches git/remotes git/root git/stage git/unstage git/discard git/apply git/commit git/push git/pull git/fetch git/checkout git/branch git/generate-message git/file git/raw git/commit-files git/undo-commit git/commit-message git/sync workspace workspace/focused-pane windows/:window/panes workspace/windows/:window/panes metrics metrics/current metrics/history metrics/drilldown system-stats window-stats perf/history perf/drilldown files/list files/read files/raw files/stat files/preview files/search session-protection servers notifications agent-events').split(' '));

const error = (message, status = 400) => Object.assign(new Error(message), { status });
const finite = (value) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
const byteSize = (chunk, encoding) => chunk == null ? 0 : typeof chunk === 'string'
  ? Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : undefined)
  : ArrayBuffer.isView(chunk) ? chunk.byteLength : chunk instanceof ArrayBuffer ? chunk.byteLength : 0;

/** Only fixed route labels survive. Names, ids, paths and query strings never do. */
export function normalizeDiagnosticPath(value) {
  if (typeof value !== 'string') return null;
  const path = value.split(/[?#]/, 1)[0].replace(/^\/n\/[a-z0-9][a-z0-9._-]{0,63}(?=\/)/, '');
  if (path.startsWith('/api/')) {
    const route = path.slice(5);
    if (API_PATHS.has(route)) return '/api/' + route;
    if (/^windows\/[^/]+\/panes$/.test(route)) return '/api/windows/:window/panes';
    if (/^workspace\/windows\/[^/]+\/panes$/.test(route)) return '/api/workspace/windows/:window/panes';
    if (/^workspace\/windows\/[^/]+\/layout$/.test(route)) return '/api/workspace/windows/:window/layout';
    if (/^workspace\/windows\/[^/]+$/.test(route)) return '/api/workspace/windows/:window';
    if (/^workspace\/panes\/[^/]+\/[a-z-]+$/.test(route)) return '/api/workspace/panes/:pane/:operation';
    if (/^workspace\/panes\/[^/]+$/.test(route)) return '/api/workspace/panes/:pane';
    if (/^workspace\/sessions\/[^/]+\/windows$/.test(route)) return '/api/workspace/sessions/:session/windows';
    if (/^workspace\/sessions(?:\/[^/]+)?$/.test(route)) return '/api/workspace/sessions';
    if (route.startsWith('files/')) return '/api/files/:operation';
    if (route.startsWith('git/')) return '/api/git/:operation';
    return '/api/:other';
  }
  if (path.startsWith('/ws/terminal/')) return '/ws/terminal/:pane';
  if (path === '/ws/status') return path;
  return '/:other';
}

function processRows(value, groups = false) {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, groups ? 30 : 60).filter((row) => row && PROCESS_NAME.test(row.name)).map((row) => {
    const out = { name: row.name };
    for (const key of groups ? ['count', 'rssBytes', 'cpuPercent'] : ['pid', 'rssBytes', 'cpuPercent', 'cpuSeconds']) {
      if (row[key] === null || finite(row[key])) out[key] = row[key];
    }
    if (!groups && typeof row.startedAt === 'string' && Number.isFinite(Date.parse(row.startedAt))) out.startedAt = new Date(row.startedAt).toISOString();
    return out;
  });
}

/** Drop unknown fields rather than accepting arbitrary diagnostic text. */
export function sanitizeDiagnosticFields(fields = {}, { client = false } = {}) {
  const out = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (NUMBER_FIELDS.has(key) && (finite(value) || value === null)) out[key] = value;
    else if (BOOLEAN_FIELDS.has(key) && typeof value === 'boolean') out[key] = value;
    else if (ID_FIELDS.has(key) && typeof value === 'string' && ID.test(value)) out[key] = value;
    else if (key === 'serverId' && typeof value === 'string' && SERVER.test(value)) out[key] = value;
    else if (key === 'method' && /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(value)) out[key] = value;
    else if (key === 'status' && Number.isInteger(value) && value >= 100 && value <= 599) out[key] = value;
    else if (key === 'path') out.path = normalizeDiagnosticPath(value);
    else if (!client && ENUM_FIELDS.has(key) && typeof value === 'string' && TOKEN.test(value)) out[key] = value;
    else if (client && key === 'code' && CLIENT_CODES.has(value)) out.code = value;
  }
  if (!client) {
    if (typeof fields.at === 'string' && Number.isFinite(Date.parse(fields.at))) out.sampledAt = new Date(fields.at).toISOString();
    for (const key of ['processes', 'processGroups']) {
      const rows = processRows(fields[key], key === 'processGroups');
      if (rows) out[key] = rows;
    }
    if (Array.isArray(fields.interfaces)) out.interfaces = fields.interfaces.slice(0, 32).map((row, index) => {
      // Stable across reordering, without retaining a user-assigned adapter label.
      const item = { index, id: createHash('sha256').update(typeof row?.name === 'string' ? row.name : String(index)).digest('hex').slice(0, 12) };
      for (const key of ['receivedBytes', 'sentBytes', 'rxBps', 'txBps']) if (row && (row[key] === null || finite(row[key]))) item[key] = row[key];
      return item;
    });
    if (Array.isArray(fields.errors)) out.errors = fields.errors.filter((code) => typeof code === 'string' && /^[a-z_]{1,64}$/.test(code)).slice(0, 16);
  }
  return out;
}

function cpuTotals() {
  return os.cpus().reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle,
    total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 });
}

export class DiagnosticsCapture {
  constructor({ now = Date.now, openFile = open, maxBytes = CAPTURE_MAX_BYTES, maxQueueBytes = CAPTURE_QUEUE_BYTES } = {}) {
    this._now = now;
    this._openFile = openFile;
    this._maxBytes = Math.min(maxBytes, CAPTURE_MAX_BYTES);
    this._maxQueueBytes = Math.min(maxQueueBytes, CAPTURE_QUEUE_BYTES);
    this._context = new AsyncLocalStorage();
    this._sockets = new Set();
    this._session = null;
    this._opening = false;
  }

  configure({ configDir, platformSampler = null }) {
    if (this._session?.active || this._opening) throw error('capture_already_active', 409);
    if (typeof configDir !== 'string' || !configDir) throw error('diagnostics_not_configured', 503);
    this._directory = join(configDir, 'diagnostics');
    this._platformSampler = platformSampler;
    return this;
  }

  status() {
    const s = this._session;
    return { active: Boolean(s?.active), id: s?.id || null, groupId: s?.groupId || null,
      targetServerId: s?.targetServerId || null, startedAt: s?.startedAt || null, expiresAt: s?.expiresAt || null,
      sampleIntervalMs: SAMPLE_INTERVAL_MS, bytesWritten: s?.bytesWritten || 0, queuedBytes: s?.queuedBytes || 0,
      dropped: s?.dropped || 0, eventsWritten: s?.eventsWritten || 0, reason: s?.reason || null };
  }

  async start({ durationMs = CAPTURE_DURATION_MS, targetServerId = 'local', groupId = null } = {}) {
    if (this._session?.active || this._opening) throw error('capture_already_active', 409);
    if (!this._directory) throw error('diagnostics_not_configured', 503);
    if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > CAPTURE_DURATION_MS) throw error('invalid_capture_duration');
    if (typeof targetServerId !== 'string' || !SERVER.test(targetServerId)) throw error('invalid_capture_target');
    if (groupId !== null && (typeof groupId !== 'string' || !ID.test(groupId))) throw error('invalid_capture_group');
    this._opening = true;
    let openingDone;
    this._openingDone = new Promise((resolve) => { openingDone = resolve; });
    try {
      if (this._session) await this._session.closed;
      await mkdir(this._directory, { recursive: true, mode: 0o700 });
      const id = randomUUID();
      const file = await this._openFile(join(this._directory, id + '.jsonl'), 'wx', 0o600);
      const began = this._now();
      let resolveClosed;
      const s = { id, groupId, targetServerId, startedAt: new Date(began).toISOString(),
        expiresAt: new Date(began + durationMs).toISOString(), monoStart: performance.now(),
        active: true, file, queue: [], queuedBytes: 0, bytesWritten: 0, eventsWritten: 0, dropped: 0,
        closed: new Promise((resolve) => { resolveClosed = resolve; }), resolveClosed: null };
      s.resolveClosed = resolveClosed;
      this._session = s;
      s.histogram = monitorEventLoopDelay({ resolution: 20 });
      s.histogram.enable();
      s.previousCpu = process.cpuUsage(); s.previousHostCpu = cpuTotals(); s.previousTime = performance.now();
      s.previousElu = performance.eventLoopUtilization();
      for (const entry of this._sockets) this._resetSocket(entry);
      this.record('capture', { phase: 'start', operation: 'capture', sampleIntervalMs: SAMPLE_INTERVAL_MS });
      if (!s.active) return this.status();
      s.timer = setTimeout(() => { this.stop('expired').catch(() => {}); }, durationMs); s.timer.unref?.();
      s.sampler = setInterval(() => this._sample(s), SAMPLE_INTERVAL_MS); s.sampler.unref?.();
      if (this._platformSampler) {
        try {
          const stop = this._platformSampler({ record: (kind, fields) => {
            if (this._session === s && s.active) this.record(kind, fields);
          }, durationMs });
          Promise.resolve(stop).then((fn) => {
            if (typeof fn !== 'function') return;
            if (s.active) s.stopPlatform = fn;
            else { try { Promise.resolve(fn()).catch(() => {}); } catch {} }
          }, () => this._deactivate(s, 'sampler_error'));
        } catch { this._deactivate(s, 'sampler_error'); }
      }
      return this.status();
    } finally { this._opening = false; openingDone(); }
  }

  currentContext() { return this._context.getStore() || null; }

  record(kind, fields = {}) {
    const s = this._session;
    if (!s?.active || !KINDS.has(kind)) return false;
    const clean = sanitizeDiagnosticFields(fields);
    if (clean.serverId && clean.serverId !== s.targetServerId && !['node', 'windows', 'platform', 'capture'].includes(kind)) return false;
    const context = ['node', 'windows', 'platform', 'capture'].includes(kind) ? {} : this.currentContext() || {};
    const event = { ...sanitizeDiagnosticFields(context), ...clean, v: 1, captureId: s.id, groupId: s.groupId, targetServerId: s.targetServerId,
      ts: new Date(this._now()).toISOString(), monoMs: Math.round((performance.now() - s.monoStart) * 1000) / 1000, kind };
    const line = JSON.stringify(event) + '\n'; const bytes = Buffer.byteLength(line);
    if (s.bytesWritten + s.queuedBytes + bytes > this._maxBytes || s.queuedBytes + bytes > this._maxQueueBytes) {
      s.dropped += 1;
      this._deactivate(s, s.bytesWritten + s.queuedBytes + bytes > this._maxBytes ? 'byte_limit' : 'queue_limit');
      return false;
    }
    s.queue.push({ line, bytes }); s.queuedBytes += bytes;
    this._pump(s);
    return true;
  }

  async _pump(s) {
    if (s.pumping) return;
    s.pumping = true;
    try {
      while (s.queue.length) {
        const item = s.queue.shift();
        await s.file.writeFile(item.line);
        s.queuedBytes -= item.bytes; s.bytesWritten += item.bytes; s.eventsWritten += 1;
      }
    } catch {
      s.queue.length = 0; s.queuedBytes = 0;
      this._deactivate(s, 'write_error');
    } finally {
      s.pumping = false;
      if (!s.active) this._close(s);
    }
  }

  _deactivate(s, reason) {
    if (!s.active) return;
    s.active = false; s.reason = reason;
    clearTimeout(s.timer); clearInterval(s.sampler); s.histogram?.disable();
    try { Promise.resolve(s.stopPlatform?.()).catch(() => {}); } catch {}
    if (!s.pumping) this._close(s);
  }

  _close(s) {
    if (s.closing) return;
    s.closing = true;
    Promise.resolve().then(() => s.file.close()).catch(() => { s.reason = 'write_error'; }).finally(s.resolveClosed);
  }

  async stop(reason = 'manual') {
    if (this._opening) await this._openingDone;
    const s = this._session;
    if (!s) return this.status();
    if (s.active) {
      this._sample(s);
      this.record('capture', { phase: 'stop', reason: TOKEN.test(reason) ? reason : 'manual' });
      this._deactivate(s, TOKEN.test(reason) ? reason : 'manual');
    }
    await s.closed;
    return this.status();
  }

  capturePath(id) {
    if (!this._directory || !UUID.test(id)) throw error('invalid_capture_id');
    return join(this._directory, id + '.jsonl');
  }

  acceptClient(body) {
    const s = this._session;
    if (!s?.active || body?.id !== s.id) throw error('capture_not_active', 409);
    if (!body || typeof body.clientId !== 'string' || !ID.test(body.clientId) || !Array.isArray(body.events) || body.events.length > 100) throw error('invalid_client_batch');
    let bytes;
    try { bytes = Buffer.byteLength(JSON.stringify(body)); } catch { throw error('invalid_client_batch'); }
    if (bytes > CLIENT_BATCH_BYTES) throw error('client_batch_too_large', 413);
    let accepted = 0;
    for (const event of body.events) {
      if (!event || !CLIENT_KINDS.has(event.kind)) continue;
      const fields = sanitizeDiagnosticFields(event, { client: true });
      fields.clientId = body.clientId;
      const clientTs = typeof event.ts === 'number' ? event.ts : typeof event.ts === 'string' ? Date.parse(event.ts) : NaN;
      if (finite(clientTs)) fields.clientTs = clientTs;
      if (this.record(event.kind, fields)) accepted += 1;
    }
    return { accepted, dropped: body.events.length - accepted };
  }

  /** Count after downstream compression, preserving write/end arguments and return values. */
  middleware() {
    return (req, res, next) => {
      const s = this._session;
      if (!s?.active || /^\/(?:n\/[^/]+\/)?api\/diagnostics(?:\/|$)/.test(req.url)) return next();
      const match = /^\/n\/([a-z0-9][a-z0-9._-]{0,63})(?:\/|$)/.exec(req.url);
      const serverId = match ? match[1] : 'local';
      if (serverId !== s.targetServerId) return next();
      // x-twp-diagnostic-id: what a Hub installed before the rename sends.
      const incoming = req.headers['x-anymux-diagnostic-id'] || req.headers['x-twp-diagnostic-id'];
      const context = { requestId: randomUUID(), serverId, path: normalizeDiagnosticPath(req.url), method: req.method };
      if (typeof incoming === 'string' && ID.test(incoming)) context.parentRequestId = incoming;
      req.diagnosticContext = context;
      res.setHeader('X-Anymux-Diagnostic-Id', context.requestId);
      if (serverId !== 'local') res.setHeader('X-Anymux-Hub-Diagnostic-Id', context.requestId);
      const began = performance.now(); let first = null; let bytes = 0; let done = false;
      const note = (chunk, encoding) => { if (first === null) first = performance.now(); bytes += byteSize(chunk, encoding); };
      const write = res.write, end = res.end, writeHead = res.writeHead;
      res.write = function (...args) { note(args[0], args[1]); return write.apply(this, args); };
      res.end = function (...args) { note(args[0], args[1]); return end.apply(this, args); };
      res.writeHead = function (...args) { if (first === null) first = performance.now(); return writeHead.apply(this, args); };
      const finish = (aborted) => {
        if (done) return; done = true;
        if (this._session !== s || !s.active) return;
        this.record('http', { ...context, status: res.statusCode, durationMs: performance.now() - began,
          ttfbMs: first === null ? null : first - began, responseBytes: bytes, aborted });
      };
      res.once('finish', () => finish(false)); res.once('close', () => finish(!res.writableFinished));
      return this._context.run(context, next);
    };
  }

  _resetSocket(entry) {
    entry.read = entry.socket.bytesRead || 0; entry.written = entry.socket.bytesWritten || 0;
    entry.at = performance.now();
  }

  /** Register even while off, so an existing terminal is sampled by a later capture. */
  trackSocket(socket, metadata = {}, getBufferedAmount = null) {
    const entry = { socket, getBufferedAmount, metadata: { ...sanitizeDiagnosticFields(metadata), connectionId: metadata.connectionId || randomUUID() } };
    this._resetSocket(entry); this._sockets.add(entry);
    const remove = (hadError = false) => {
      if (!this._sockets.delete(entry)) return;
      this._sampleSocket(entry, hadError, 'socket_close');
      socket.off('close', remove);
    };
    socket.once('close', remove);
    if (socket.destroyed) remove();
    return remove;
  }

  _sampleSocket(entry, hadError = false, phase = 'socket_sample') {
    const { socket } = entry;
    this.record('terminal', { ...entry.metadata, phase, hadError,
      sampleMs: performance.now() - entry.at, bufferedAmount: entry.getBufferedAmount?.() ?? null,
      bytesRead: Math.max(0, (socket.bytesRead || 0) - entry.read), bytesWritten: Math.max(0, (socket.bytesWritten || 0) - entry.written),
      writableLength: socket.writableLength || 0, readableLength: socket.readableLength || 0 });
    this._resetSocket(entry);
  }

  _sample(s) {
    if (this._session !== s || !s.active) return;
    const at = performance.now();
    try {
      const cpu = process.cpuUsage(); const host = cpuTotals(); const memory = process.memoryUsage();
      const elapsed = at - s.previousTime; const total = host.total - s.previousHostCpu.total;
      const delay = s.histogram;
      const elu = performance.eventLoopUtilization();
      this.record('node', {
        pid: process.pid, cpuCount: os.cpus().length, sampleMs: elapsed,
        processCpuPercent: elapsed > 0 ? ((cpu.user - s.previousCpu.user) + (cpu.system - s.previousCpu.system)) / (elapsed * 10) : null,
        rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal,
        externalBytes: memory.external, arrayBufferBytes: memory.arrayBuffers,
        cpuPercent: total > 0 ? 100 * (1 - (host.idle - s.previousHostCpu.idle) / total) : null,
        memTotalBytes: os.totalmem(), memFreeBytes: os.freemem(), socketCount: this._sockets.size,
        eventLoopP50Ms: delay.count ? delay.percentile(50) / 1e6 : null,
        eventLoopP95Ms: delay.count ? delay.percentile(95) / 1e6 : null,
        eventLoopP99Ms: delay.count ? delay.percentile(99) / 1e6 : null,
        eventLoopMaxMs: delay.count ? delay.max / 1e6 : null,
        eventLoopUtilization: performance.eventLoopUtilization(elu, s.previousElu).utilization,
      });
      s.previousCpu = cpu; s.previousHostCpu = host; s.previousTime = at; s.previousElu = elu; delay.reset();
      for (const entry of this._sockets) this._sampleSocket(entry);
    } catch { this._deactivate(s, 'sampler_error'); }
  }
}

export const diagnostics = new DiagnosticsCapture();
