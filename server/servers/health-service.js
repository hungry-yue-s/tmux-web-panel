/**
 * Liveness and capability detection.
 *
 * Runtime status is kept in memory only — it is an observation, not a
 * declaration, so it never gets written back into servers.json. Detection is
 * strictly read-only: the panel checks whether tmux exists and what version it
 * reports, and never installs, upgrades or starts anything on a remote host.
 */

import { AppError, ErrorCode } from './errors.js';
import { LOCAL_SERVER_ID } from './registry.js';

export const ServerState = Object.freeze({
  UNKNOWN: 'unknown',
  CHECKING: 'checking',
  ONLINE: 'online',
  DEGRADED: 'degraded',
  OFFLINE: 'offline',
  AUTH_REQUIRED: 'auth_required',
  HOST_KEY_ERROR: 'host_key_error',
  DISABLED: 'disabled',
});

/** Backoff after consecutive failures, capped at five minutes. */
const FAILURE_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000];
export const VIEWED_POLL_MS = 5_000;
export const IDLE_POLL_MS = 30_000;

/**
 * One round trip that collects every fact we need. Read-only by construction:
 * `command -v` and `tmux -V` cannot modify the host.
 */
export const FACTS_SCRIPT = [
  'printf "kernel=%s\\n" "$(uname -s 2>/dev/null || echo unknown)"',
  'printf "arch=%s\\n" "$(uname -m 2>/dev/null || echo unknown)"',
  'printf "hostname=%s\\n" "$(hostname 2>/dev/null || echo unknown)"',
  'if command -v tmux >/dev/null 2>&1; then',
  '  printf "tmux_found=1\\n"',
  '  printf "tmux_version=%s\\n" "$(tmux -V 2>&1 | head -n 1)"',
  'else',
  '  printf "tmux_found=0\\n"',
  'fi',
].join('\n');

/**
 * The Windows equivalent, for hosts that answer ssh with cmd.exe and have no
 * POSIX shell at all. Same key=value shape, and read-only for the same reason.
 * UTF-8 is pinned so a non-ASCII hostname is not mangled by the legacy code page.
 */
export const WINDOWS_FACTS_SCRIPT = [
  '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new()',
  'Write-Output "kernel=Windows"',
  'Write-Output ("arch=" + $env:PROCESSOR_ARCHITECTURE)',
  'Write-Output ("hostname=" + [System.Net.Dns]::GetHostName())',
  // tmux has no native Windows build, so an SSH workspace is the only option.
  'Write-Output "tmux_found=0"',
].join('\n');

export function parseFacts(stdout) {
  const facts = {};
  for (const line of String(stdout || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    facts[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return facts;
}

export function normalizePlatform(kernel) {
  const value = String(kernel || '').toLowerCase();
  if (value.includes('darwin')) return 'darwin';
  if (value.includes('linux')) return 'linux';
  if (value.includes('windows')) return 'windows';
  if (!value || value === 'unknown') return null;
  return value;
}

export function normalizeArch(machine) {
  const value = String(machine || '').toLowerCase();
  if (value === 'x86_64' || value === 'amd64') return 'x64';
  if (value === 'aarch64' || value === 'arm64') return 'arm64';
  if (!value || value === 'unknown') return null;
  return value;
}

/** Extracts a version from `tmux -V`, or null when the output is not a version. */
export function parseTmuxVersion(output) {
  const match = /tmux\s+(?:next-)?([0-9]+\.[0-9]+[a-z]?)/i.exec(String(output || '').trim());
  return match ? match[1] : null;
}

function stateForError(err) {
  const code = err && err.code;
  if (code === ErrorCode.SSH_AUTH_REQUIRED) return ServerState.AUTH_REQUIRED;
  if (code === ErrorCode.SSH_HOST_KEY_UNKNOWN || code === ErrorCode.SSH_HOST_KEY_CHANGED) {
    return ServerState.HOST_KEY_ERROR;
  }
  return ServerState.OFFLINE;
}

function emptyCapabilities() {
  return {
    ssh: { available: false },
    tmux: { available: false, version: null, reason: null },
    metrics: { available: false, level: 'none' },
    files: { available: false },
  };
}

function unavailableWorkspace(transport) {
  return { provider: 'unavailable', transport, persistence: 'none' };
}

export class HealthService {
  /**
   * @param {object} deps
   * @param {import('./registry.js').ServerRegistry} deps.registry
   * @param {import('../transport/executor-pool.js').ExecutorPool} deps.pool
   */
  constructor({ registry, pool, now = () => Date.now(), onStatus = null } = {}) {
    if (!registry) throw new Error('HealthService requires a registry');
    if (!pool) throw new Error('HealthService requires an executor pool');
    this.registry = registry;
    this.pool = pool;
    this._now = now;
    this._onStatus = onStatus;
    /** serverId -> { status, inFlight, generation, nextPollAt, failureCount } */
    this._entries = new Map();
    this._viewedServerId = null;
    this._timer = null;
  }

  _entry(serverId) {
    let entry = this._entries.get(serverId);
    if (!entry) {
      entry = {
        status: {
          serverId,
          state: ServerState.UNKNOWN,
          latencyMs: null,
          checkedAt: null,
          lastOnlineAt: null,
          error: null,
          facts: { hostname: null, platform: null, arch: null },
          capabilities: emptyCapabilities(),
          workspace: unavailableWorkspace(serverId === LOCAL_SERVER_ID ? 'local' : 'ssh'),
        },
        inFlight: null,
        generation: 0,
        nextPollAt: 0,
        failureCount: 0,
      };
      this._entries.set(serverId, entry);
    }
    return entry;
  }

  /** Last known status; never throws so a page render can always show something. */
  getStatus(serverId) {
    return this._entry(serverId).status;
  }

  getAllStatuses() {
    const out = {};
    for (const server of this.registry.list()) out[server.id] = this.getStatus(server.id);
    return out;
  }

  /**
   * Invalidates cached state for a server. Any probe still running is orphaned
   * by the generation bump so its late result cannot overwrite fresh state.
   */
  invalidate(serverId) {
    const entry = this._entry(serverId);
    entry.generation += 1;
    entry.inFlight = null;
    entry.failureCount = 0;
    entry.nextPollAt = 0;
    entry.status = {
      ...entry.status,
      state: ServerState.UNKNOWN,
      capabilities: emptyCapabilities(),
      workspace: unavailableWorkspace(serverId === LOCAL_SERVER_ID ? 'local' : 'ssh'),
      error: null,
    };
  }

  forget(serverId) {
    const entry = this._entries.get(serverId);
    if (entry) entry.generation += 1;
    this._entries.delete(serverId);
  }

  /** The server the user is looking at gets a faster poll cadence. */
  setViewedServer(serverId) {
    this._viewedServerId = serverId || null;
  }

  /**
   * Runs a probe, collapsing concurrent callers onto one in-flight promise so a
   * page load with several widgets cannot fan out into several ssh connections.
   */
  probe(serverId, { force = false } = {}) {
    const server = this.registry.require(serverId);
    const entry = this._entry(serverId);

    if (entry.inFlight && !force) return entry.inFlight;
    if (entry.inFlight && force) {
      // Orphan the running probe: without a generation bump its older result
      // could land after the forced one and overwrite fresh state.
      entry.generation += 1;
      entry.inFlight = null;
    }

    if (server.enabled === false) {
      const alreadyDisabled = entry.status.state === ServerState.DISABLED;
      entry.status = {
        ...entry.status,
        state: ServerState.DISABLED,
        checkedAt: new Date(this._now()).toISOString(),
        error: null,
        capabilities: emptyCapabilities(),
        workspace: unavailableWorkspace(server.kind === 'local' ? 'local' : 'ssh'),
      };
      // Keep the scheduler from rebroadcasting "disabled" on every tick.
      entry.nextPollAt = this._now() + IDLE_POLL_MS;
      if (!alreadyDisabled) this._publish(entry.status);
      return Promise.resolve(entry.status);
    }

    const generation = entry.generation;
    entry.status = { ...entry.status, state: ServerState.CHECKING };
    this._publish(entry.status);

    const run = (async () => {
      const startedAt = this._now();
      try {
        const status = server.kind === 'local'
          ? await this._probeLocal(server, startedAt)
          : await this._probeRemote(server, startedAt);
        return this._settle(serverId, generation, status);
      } catch (err) {
        const appError = err instanceof AppError
          ? err
          : new AppError(ErrorCode.INTERNAL, 'Probe failed');
        const previous = entry.status;
        return this._settle(serverId, generation, {
          serverId,
          state: stateForError(appError),
          latencyMs: null,
          checkedAt: new Date(this._now()).toISOString(),
          // Keep the last success so the UI can show "offline since ..." instead of zeros.
          lastOnlineAt: previous.lastOnlineAt,
          error: appError.toJSON(),
          facts: previous.facts,
          capabilities: {
            ...emptyCapabilities(),
            ssh: { available: false, reason: appError.code },
          },
          workspace: unavailableWorkspace(server.kind === 'local' ? 'local' : 'ssh'),
        }, { failed: true });
      } finally {
        if (entry.inFlight === run) entry.inFlight = null;
      }
    })();

    entry.inFlight = run;
    return run;
  }

  async _probeLocal(server, startedAt) {
    const tmux = this.pool.tmuxFor(server.id);
    let version = null;
    let reason = null;
    try {
      version = await tmux.version();
      if (!version) reason = 'version_unparseable';
    } catch (err) {
      reason = err && err.code === 'ENOENT' ? 'command_not_found' : 'command_failed';
    }

    const available = Boolean(version);
    return {
      serverId: server.id,
      state: available ? ServerState.ONLINE : ServerState.DEGRADED,
      latencyMs: this._now() - startedAt,
      checkedAt: new Date(this._now()).toISOString(),
      lastOnlineAt: new Date(this._now()).toISOString(),
      error: null,
      facts: {
        hostname: process.env.HOSTNAME || null,
        platform: process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : process.platform,
        arch: normalizeArch(process.arch === 'x64' ? 'x86_64' : process.arch),
      },
      capabilities: {
        // The panel process is the host, so there is no ssh hop to verify.
        ssh: { available: true, reason: 'local' },
        tmux: { available, version, reason },
        metrics: { available: true, level: 'full' },
        files: { available: true },
      },
      workspace: available
        ? { provider: 'tmux', transport: 'local', persistence: 'tmux' }
        : unavailableWorkspace('local'),
    };
  }

  /**
   * Collects facts, falling back to PowerShell for hosts with no POSIX shell.
   *
   * ssh reserves exit code 255 for its own failures, so any other numeric code
   * means a remote shell answered and merely rejected `/bin/sh`. Retrying only
   * in that case keeps an unreachable host from paying a second timeout.
   */
  async _collectFacts(executor) {
    try {
      const { stdout } = await executor.runScript(FACTS_SCRIPT, { timeout: 12_000 });
      return parseFacts(stdout);
    } catch (err) {
      const shellAnswered = typeof err?.exitCode === 'number' && err.exitCode !== 255;
      if (!shellAnswered || typeof executor.execPowerShell !== 'function') throw err;
      const { stdout } = await executor.execPowerShell(WINDOWS_FACTS_SCRIPT, { timeout: 12_000 });
      const facts = parseFacts(stdout);
      // A shell that answers but reports nothing useful is still a failed probe.
      if (!facts.kernel) throw err;
      return facts;
    }
  }

  async _probeRemote(server, startedAt) {
    const executor = this.pool.get(server.id);
    const facts = await this._collectFacts(executor);
    const latencyMs = this._now() - startedAt;

    const platform = normalizePlatform(facts.kernel);
    const arch = normalizeArch(facts.arch);
    const tmuxFound = facts.tmux_found === '1';
    const version = tmuxFound ? parseTmuxVersion(facts.tmux_version) : null;

    let tmuxReason = null;
    // tmux has no native Windows build, so say so instead of "not installed".
    if (!tmuxFound) tmuxReason = platform === 'windows' ? 'unsupported_platform' : 'command_not_found';
    else if (!version) tmuxReason = 'version_unparseable';

    // tmux present but unusable is a degraded server, not a healthy one: fall
    // back to an SSH workspace while keeping the reason visible.
    const tmuxUsable = tmuxFound && Boolean(version);
    const state = tmuxFound && !version ? ServerState.DEGRADED : ServerState.ONLINE;
    const metricsAvailable = platform === 'linux' || platform === 'darwin';

    return {
      serverId: server.id,
      state,
      latencyMs,
      checkedAt: new Date(this._now()).toISOString(),
      lastOnlineAt: new Date(this._now()).toISOString(),
      error: null,
      facts: { hostname: facts.hostname || null, platform, arch },
      capabilities: {
        ssh: { available: true },
        tmux: { available: tmuxUsable, version, reason: tmuxReason },
        metrics: { available: metricsAvailable, level: metricsAvailable ? 'basic' : 'none' },
        // Remote file browsing is explicitly out of scope for this version.
        files: { available: false, reason: 'unsupported' },
      },
      workspace: tmuxUsable
        ? { provider: 'tmux', transport: 'ssh', persistence: 'tmux' }
        : { provider: 'ssh', transport: 'ssh', persistence: 'process-memory' },
    };
  }

  /** Applies a probe result unless a newer generation invalidated it. */
  _settle(serverId, generation, status, { failed = false } = {}) {
    const entry = this._entries.get(serverId);
    if (!entry) return status;
    if (entry.generation !== generation) {
      // The server was edited or removed mid-probe; the result describes a
      // configuration that no longer exists.
      return entry.status;
    }

    entry.failureCount = failed ? entry.failureCount + 1 : 0;
    const interval = failed
      ? FAILURE_BACKOFF_MS[Math.min(entry.failureCount - 1, FAILURE_BACKOFF_MS.length - 1)]
      : (serverId === this._viewedServerId ? VIEWED_POLL_MS : IDLE_POLL_MS);
    entry.nextPollAt = this._now() + interval;
    entry.status = status;
    this._publish(status);
    return status;
  }

  _publish(status) {
    if (typeof this._onStatus === 'function') {
      this._onStatus({
        serverId: status.serverId,
        state: status.state,
        latencyMs: status.latencyMs,
        checkedAt: status.checkedAt,
        error: status.error,
        capabilities: status.capabilities,
        workspace: status.workspace,
        facts: status.facts,
      });
    }
  }

  /** Probes every server whose scheduled time has arrived. */
  async tick() {
    const now = this._now();
    const due = this.registry.list().filter((server) => {
      if (server.enabled === false) return false;
      const entry = this._entry(server.id);
      if (entry.inFlight) return false;
      return entry.nextPollAt <= now;
    });
    await Promise.all(due.map((server) => this.probe(server.id).catch(() => {})));
  }

  start(intervalMs = 5_000) {
    this.stop();
    this._timer = setInterval(() => { this.tick().catch(() => {}); }, intervalMs);
    if (this._timer.unref) this._timer.unref();
    return this.tick().catch(() => {});
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}
