/**
 * Server-scoped metrics service.
 *
 * Every cache key and history ring is namespaced by serverId, because the whole
 * point is that switching servers must not show another machine's numbers. The
 * local host reuses the existing collectors; remote hosts use the read-only SSH
 * probe. History is in memory only and starts fresh after a restart.
 */

import { AppError, ErrorCode } from '../servers/errors.js';
import { LOCAL_SERVER_ID } from '../servers/registry.js';
import { ServerState } from '../servers/health-service.js';
import { collectRemoteMetrics } from './ssh-collector.js';

/** Two seconds matches the existing local sampler cadence. */
export const SAMPLE_MIN_INTERVAL_MS = 2_000;
/**
 * Failures are cached too, briefly. Without this, a page with several widgets
 * polling an unreachable host would open a new SSH connection every render.
 */
export const FAILURE_CACHE_MS = 5_000;
export const HISTORY_POINTS = 900;

/**
 * Reasons that mean "this will never work here", as opposed to "it did not work
 * this time". Conflating the two would tell the user their platform is
 * unsupported every time the network hiccuped.
 */
const UNSUPPORTED_REASONS = new Set(['unsupported_platform', 'no_local_collector']);

export class MetricsService {
  /**
   * @param {object} deps
   * @param {() => Promise<object>} [deps.localCollector] existing local host snapshot
   */
  constructor({ registry, pool, health, localCollector = null, now = () => Date.now() }) {
    if (!registry) throw new Error('MetricsService requires a registry');
    if (!pool) throw new Error('MetricsService requires an executor pool');
    if (!health) throw new Error('MetricsService requires a health service');
    this.registry = registry;
    this.pool = pool;
    this.health = health;
    this._localCollector = localCollector;
    this._now = now;
    /** serverId -> { at, data, ok } */
    this._cache = new Map();
    /** serverId -> ring array */
    this._history = new Map();
    /** serverId -> in-flight promise */
    this._inFlight = new Map();
    /** serverId -> generation, bumped on forget so late samples cannot backfill. */
    this._generations = new Map();
  }

  _generation(serverId) {
    return this._generations.get(serverId) || 0;
  }

  _degraded(serverId, reason, extra = {}) {
    const stale = this._cache.get(serverId);
    const level = UNSUPPORTED_REASONS.has(reason) ? 'unsupported' : 'unavailable';
    return {
      serverId,
      sampledAt: null,
      cpuPercent: null,
      memPercent: null,
      disk: null,
      availability: {
        cpu: level,
        memory: level,
        disk: level,
        load: level,
        // Genuinely not implemented for remote hosts in this version.
        processes: 'unsupported',
        diskIo: 'unsupported',
        swap: 'unsupported',
      },
      reason,
      // The last real sample keeps its own timestamp so the UI can say how old it is.
      last: stale && stale.ok ? stale.data : (stale && stale.last) || null,
      ...extra,
    };
  }

  /**
   * Current snapshot. Serves the cache inside the sampling interval and shares
   * one in-flight probe, so several widgets on a page cost one SSH round trip.
   */
  async current(serverId, { force = false } = {}) {
    this.registry.require(serverId);

    const cached = this._cache.get(serverId);
    if (!force && cached) {
      const ttl = cached.ok ? SAMPLE_MIN_INTERVAL_MS : FAILURE_CACHE_MS;
      if (this._now() - cached.at < ttl) return cached.data;
    }
    const pending = this._inFlight.get(serverId);
    if (pending) return pending;

    const generation = this._generation(serverId);
    const run = this._sample(serverId)
      .then((data) => {
        // A server removed while this was in flight must not be repopulated.
        if (this._generation(serverId) !== generation || !this.registry.has(serverId)) return data;
        const ok = Boolean(data.sampledAt);
        this._cache.set(serverId, { at: this._now(), data, ok, last: data.last || null });
        if (ok) this._pushHistory(serverId, data);
        return data;
      })
      .finally(() => {
        if (this._inFlight.get(serverId) === run) this._inFlight.delete(serverId);
      });

    this._inFlight.set(serverId, run);
    return run;
  }

  async _sample(serverId) {
    const status = this.health.getStatus(serverId);
    if (status.state === ServerState.DISABLED) return this._degraded(serverId, 'server_disabled');

    if (serverId === LOCAL_SERVER_ID) {
      if (typeof this._localCollector !== 'function') {
        return this._degraded(serverId, 'no_local_collector');
      }
      try {
        const snapshot = await this._localCollector();
        return {
          serverId,
          sampledAt: new Date(this._now()).toISOString(),
          ...snapshot,
          availability: {
            ...(snapshot.availability || {}),
            // Only the service knows whether a drilldown is actually wired.
            processes: typeof this._localDrilldown === 'function' ? 'available' : 'unsupported',
          },
        };
      } catch (err) {
        const appError = err instanceof AppError ? err : new AppError(ErrorCode.INTERNAL, 'Local metrics failed');
        return this._degraded(serverId, appError.code, { error: appError.toJSON() });
      }
    }

    const capabilities = status.capabilities || {};
    if (!capabilities.metrics || capabilities.metrics.available !== true) {
      // Never fall back to the panel host's own numbers for a remote server.
      return this._degraded(
        serverId,
        status.state === ServerState.ONLINE ? 'unsupported_platform' : 'server_offline',
      );
    }

    const platform = status.facts ? status.facts.platform : null;
    try {
      const executor = this.pool.get(serverId);
      const collected = await collectRemoteMetrics(executor, platform);
      if (!collected) return this._degraded(serverId, 'unsupported_platform');
      return { serverId, sampledAt: new Date(this._now()).toISOString(), ...collected };
    } catch (err) {
      const appError = err instanceof AppError ? err : new AppError(ErrorCode.INTERNAL, 'Metrics probe failed');
      return this._degraded(serverId, appError.code, { error: appError.toJSON() });
    }
  }

  _pushHistory(serverId, data) {
    let ring = this._history.get(serverId);
    if (!ring) {
      ring = [];
      this._history.set(serverId, ring);
    }
    ring.push({
      ts: data.sampledAt,
      cpuPercent: data.cpuPercent ?? null,
      memPercent: data.memPercent ?? null,
      load1: data.load1 ?? null,
    });
    if (ring.length > HISTORY_POINTS) ring.splice(0, ring.length - HISTORY_POINTS);
  }

  /** Ring history for one server, optionally limited to the last N seconds. */
  history(serverId, { windowSeconds = 300 } = {}) {
    this.registry.require(serverId);
    const ring = this._history.get(serverId) || [];
    const clamped = Math.min(Math.max(Number(windowSeconds) || 300, 10), 3600);
    const cutoff = this._now() - clamped * 1000;
    const points = ring.filter((point) => {
      const ts = Date.parse(point.ts);
      return Number.isFinite(ts) ? ts >= cutoff : true;
    });
    return { serverId, windowSeconds: clamped, points, persisted: false };
  }

  /**
   * Per-process detail. Only the local host supports it in this version; a
   * remote server returns 200 with an explicit unsupported marker rather than
   * an error the UI would have to special-case.
   */
  async drilldown(serverId, params = {}) {
    this.registry.require(serverId);
    if (serverId !== LOCAL_SERVER_ID || typeof this._localDrilldown !== 'function') {
      return {
        serverId,
        partial: true,
        procs: [],
        availability: { processes: 'unsupported' },
        reason: serverId === LOCAL_SERVER_ID ? 'no_local_drilldown' : 'remote_process_drilldown_unsupported',
      };
    }
    return this._localDrilldown(params);
  }

  setLocalDrilldown(fn) {
    this._localDrilldown = fn;
  }

  /** Drops all cached data for a server and orphans any in-flight sample. */
  forget(serverId) {
    this._generations.set(serverId, this._generation(serverId) + 1);
    this._cache.delete(serverId);
    this._history.delete(serverId);
    this._inFlight.delete(serverId);
  }
}
