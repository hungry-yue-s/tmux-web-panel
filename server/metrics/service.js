/**
 * This machine's metrics: a cached snapshot plus an in-memory history ring.
 *
 * Another machine's numbers come from that machine's own MetricsService via
 * the hub relay, so nothing here ever samples a remote host — and nothing can
 * show the panel host's numbers under another server's name. History starts
 * fresh after a restart.
 */

import { AppError, ErrorCode } from '../servers/errors.js';

/** Two seconds matches the existing local sampler cadence. */
export const SAMPLE_MIN_INTERVAL_MS = 2_000;
/** Failures are cached briefly so several polling widgets cost one attempt. */
export const FAILURE_CACHE_MS = 5_000;
export const HISTORY_POINTS = 900;

export class MetricsService {
  /**
   * @param {object} deps
   * @param {() => Promise<object>} deps.collector local host snapshot
   * @param {(params: object) => Promise<object>} [deps.drilldown] per-process detail
   */
  constructor({ collector, drilldown = null, now = () => Date.now() }) {
    if (typeof collector !== 'function') throw new Error('MetricsService requires a collector');
    this._collector = collector;
    this._drilldown = drilldown;
    this._now = now;
    this._cache = null; // { at, data, ok, last }
    this._history = [];
    this._inFlight = null;
  }

  _degraded(reason, extra = {}) {
    const stale = this._cache;
    return {
      sampledAt: null,
      cpuPercent: null,
      memPercent: null,
      disk: null,
      availability: {
        cpu: 'unavailable',
        memory: 'unavailable',
        disk: 'unavailable',
        load: 'unavailable',
        processes: 'unavailable',
        diskIo: 'unavailable',
        swap: 'unavailable',
      },
      reason,
      // The last real sample keeps its own timestamp so the UI can say how old it is.
      last: stale && stale.ok ? stale.data : (stale && stale.last) || null,
      ...extra,
    };
  }

  /** Serves the cache inside the sampling interval and shares one in-flight sample. */
  async current({ force = false } = {}) {
    const cached = this._cache;
    if (!force && cached) {
      const ttl = cached.ok ? SAMPLE_MIN_INTERVAL_MS : FAILURE_CACHE_MS;
      if (this._now() - cached.at < ttl) return cached.data;
    }
    if (this._inFlight) return this._inFlight;

    const run = this._sample()
      .then((data) => {
        const ok = Boolean(data.sampledAt);
        this._cache = { at: this._now(), data, ok, last: data.last || null };
        if (ok) this._pushHistory(data);
        return data;
      })
      .finally(() => {
        if (this._inFlight === run) this._inFlight = null;
      });
    this._inFlight = run;
    return run;
  }

  async _sample() {
    try {
      const snapshot = await this._collector();
      return {
        sampledAt: new Date(this._now()).toISOString(),
        ...snapshot,
        availability: {
          ...(snapshot.availability || {}),
          processes: typeof this._drilldown === 'function' ? 'available' : 'unsupported',
        },
      };
    } catch (err) {
      const appError = err instanceof AppError ? err : new AppError(ErrorCode.INTERNAL, 'Local metrics failed');
      return this._degraded(appError.code, { error: appError.toJSON() });
    }
  }

  _pushHistory(data) {
    this._history.push({
      ts: data.sampledAt,
      cpuPercent: data.cpuPercent ?? null,
      memPercent: data.memPercent ?? null,
      load1: data.load1 ?? null,
    });
    if (this._history.length > HISTORY_POINTS) this._history.splice(0, this._history.length - HISTORY_POINTS);
  }

  /** History, optionally limited to the last N seconds (10..3600). */
  history({ windowSeconds = 300 } = {}) {
    const clamped = Math.min(Math.max(Number(windowSeconds) || 300, 10), 3600);
    const cutoff = this._now() - clamped * 1000;
    const points = this._history.filter((point) => {
      const ts = Date.parse(point.ts);
      return Number.isFinite(ts) ? ts >= cutoff : true;
    });
    return { windowSeconds: clamped, points, persisted: false };
  }

  /** Per-process detail; an explicit unsupported marker when none is wired. */
  async drilldown(params = {}) {
    if (typeof this._drilldown !== 'function') {
      return { partial: true, procs: [], availability: { processes: 'unsupported' }, reason: 'no_local_drilldown' };
    }
    return this._drilldown(params);
  }
}
