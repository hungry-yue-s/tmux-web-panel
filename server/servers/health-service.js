/**
 * Liveness and capability detection.
 *
 * A server running this same panel (a node) is probed with one call to its
 * /api/node/info — locally a function call, remotely a request over the
 * server's link (which opens the SSH forward on first use). A server reachable
 * over SSH without the panel is in basic mode: one detection script says
 * whether it has tmux. Runtime status is kept in memory only.
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

/** Maps a node's self-description onto the status the UI renders. */
export function statusFromNodeInfo(serverId, info, { transport, latencyMs, now }) {
  const tmux = info && info.tmux ? info.tmux : { available: false, version: null, reason: 'unknown' };
  const capabilities = (info && info.capabilities) || {};
  const at = new Date(now).toISOString();
  return {
    serverId,
    state: tmux.available ? ServerState.ONLINE : ServerState.DEGRADED,
    latencyMs,
    checkedAt: at,
    lastOnlineAt: at,
    error: null,
    facts: {
      hostname: info?.hostname || null,
      platform: info?.platform || null,
      arch: info?.arch || null,
      version: info?.version || null,
    },
    capabilities: {
      ssh: { available: transport !== 'local' },
      tmux: { available: Boolean(tmux.available), version: tmux.version || null, reason: tmux.reason || null },
      metrics: capabilities.metrics || { available: false, level: 'none' },
      files: capabilities.files || { available: false },
      processStats: capabilities.processStats || { available: false },
    },
    workspace: tmux.available
      ? { provider: 'tmux', transport, persistence: 'tmux' }
      : unavailableWorkspace(transport),
    node: { installed: true, version: info?.version || null },
  };
}

/**
 * Basic mode: SSH works, the panel is not installed there. Workspace and
 * terminals still work (remote tmux, or shells hosted by this hub); everything
 * that needs the node is reported unavailable with the reason the UI turns
 * into an "install" offer.
 */
export function statusFromBasic(serverId, facts, { latencyMs, now }) {
  const at = new Date(now).toISOString();
  const tmux = facts.tmux || { available: false, version: null, reason: null };
  const missing = { available: false, reason: 'node_not_installed' };
  return {
    serverId,
    state: ServerState.ONLINE,
    latencyMs,
    checkedAt: at,
    lastOnlineAt: at,
    error: null,
    facts: { hostname: facts.hostname, platform: facts.platform, arch: facts.arch, version: null },
    capabilities: {
      ssh: { available: true },
      tmux,
      metrics: { ...missing, level: 'none' },
      files: missing,
      processStats: missing,
    },
    workspace: tmux.available
      ? { provider: 'tmux', transport: 'ssh', persistence: 'tmux' }
      : { provider: 'ssh', transport: 'ssh', persistence: 'process-memory' },
    node: { installed: false, version: null, posix: facts.posix !== false, platform: facts.platform },
  };
}

export class HealthService {
  /**
   * @param {object} deps
   * @param {import('./registry.js').ServerRegistry} deps.registry
   * @param {import('../hub/link-pool.js').LinkPool} deps.links
   * @param {() => Promise<object>} deps.localInfo this node's /api/node/info
   */
  constructor({ registry, links, localInfo, now = () => Date.now(), onStatus = null } = {}) {
    if (!registry) throw new Error('HealthService requires a registry');
    if (!links) throw new Error('HealthService requires a link pool');
    if (typeof localInfo !== 'function') throw new Error('HealthService requires localInfo');
    this.registry = registry;
    this.links = links;
    this._localInfo = localInfo;
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
    const info = await this._localInfo();
    return statusFromNodeInfo(server.id, info, { transport: 'local', latencyMs: this._now() - startedAt, now: this._now() });
  }

  async _probeRemote(server, startedAt) {
    if (await this.links.mode(server.id) === 'node') {
      const info = await this.links.link(server.id).info();
      return statusFromNodeInfo(server.id, info, { transport: 'ssh', latencyMs: this._now() - startedAt, now: this._now() });
    }
    const facts = await this.links.basic(server.id).detect({ force: true });
    return statusFromBasic(server.id, facts, { latencyMs: this._now() - startedAt, now: this._now() });
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
        node: status.node,
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
