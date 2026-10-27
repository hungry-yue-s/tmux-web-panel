import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  MetricsService,
  SAMPLE_MIN_INTERVAL_MS,
  FAILURE_CACHE_MS,
  HISTORY_POINTS,
} from '../server/metrics/service.js';
import { AppError, ErrorCode } from '../server/servers/errors.js';

function snapshot(cpuPercent = 25) {
  return { platform: 'linux', cpuPercent, memPercent: 40, load1: 0.5, availability: { cpu: 'available' } };
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

describe('MetricsService', () => {
  let now;
  let collector;
  let service;

  beforeEach(() => {
    now = 1_000_000;
    collector = vi.fn(async () => snapshot());
    service = new MetricsService({ collector, now: () => now });
  });

  it('requires a collector', () => {
    expect(() => new MetricsService({})).toThrow(/collector/);
  });

  it('samples this machine and caches within the interval', async () => {
    const first = await service.current();
    const second = await service.current();

    expect(first.sampledAt).toBe(new Date(now).toISOString());
    expect(first.cpuPercent).toBe(25);
    expect(second).toBe(first);
    expect(collector).toHaveBeenCalledTimes(1);
  });

  it('resamples after the interval, or when forced', async () => {
    await service.current();
    now += SAMPLE_MIN_INTERVAL_MS;
    await service.current();
    await service.current({ force: true });
    expect(collector).toHaveBeenCalledTimes(3);
  });

  it('shares one in-flight sample across concurrent callers', async () => {
    const gate = deferred();
    collector.mockImplementation(() => gate.promise);

    const all = Promise.all([service.current(), service.current(), service.current()]);
    gate.resolve(snapshot());
    await all;

    expect(collector).toHaveBeenCalledTimes(1);
  });

  describe('failure handling', () => {
    it('degrades a throwing collector to explicit unavailability, never zeros', async () => {
      collector.mockRejectedValue(new AppError(ErrorCode.INTERNAL, 'boom'));
      const result = await service.current();

      expect(result.sampledAt).toBeNull();
      expect(result.cpuPercent).toBeNull();
      expect(result.availability.cpu).toBe('unavailable');
      expect(result.error.code).toBe(ErrorCode.INTERNAL);
    });

    it('caches a failure briefly, then retries', async () => {
      collector.mockRejectedValue(new Error('boom'));
      await service.current();
      await service.current();
      expect(collector).toHaveBeenCalledTimes(1);

      now += FAILURE_CACHE_MS;
      await service.current();
      expect(collector).toHaveBeenCalledTimes(2);
    });

    it('keeps the last good sample alongside the failure and out of history', async () => {
      const good = await service.current();
      now += SAMPLE_MIN_INTERVAL_MS;
      collector.mockRejectedValue(new Error('boom'));

      const failed = await service.current();

      expect(failed.last).toEqual(good);
      expect(service.history().points).toHaveLength(1);
    });
  });

  describe('history', () => {
    it('records one point per successful sample', async () => {
      await service.current();
      now += SAMPLE_MIN_INTERVAL_MS;
      collector.mockResolvedValue(snapshot(60));
      await service.current();

      const { points, persisted } = service.history();
      expect(points.map((p) => p.cpuPercent)).toEqual([25, 60]);
      expect(persisted).toBe(false);
    });

    it('clamps the requested window', () => {
      expect(service.history({ windowSeconds: 1 }).windowSeconds).toBe(10);
      expect(service.history({ windowSeconds: 99999 }).windowSeconds).toBe(3600);
      expect(service.history({ windowSeconds: 'junk' }).windowSeconds).toBe(300);
    });

    it('drops points outside the window', async () => {
      await service.current();
      now += 400_000;
      expect(service.history({ windowSeconds: 300 }).points).toEqual([]);
    });

    it('is bounded', async () => {
      for (let i = 0; i < HISTORY_POINTS + 5; i += 1) {
        await service.current({ force: true });
      }
      expect(service._history).toHaveLength(HISTORY_POINTS);
    });
  });

  describe('drilldown', () => {
    it('reports process detail unsupported when none is wired', async () => {
      await expect(service.drilldown({})).resolves.toMatchObject({
        partial: true,
        procs: [],
        availability: { processes: 'unsupported' },
      });
      expect((await service.current()).availability.processes).toBe('unsupported');
    });

    it('delegates when a drilldown is installed', async () => {
      const drilldown = vi.fn(async () => ({ procs: [{ pid: 1 }] }));
      const wired = new MetricsService({ collector, drilldown, now: () => now });

      await expect(wired.drilldown({ session: 'a', windowIndex: '0' })).resolves.toEqual({ procs: [{ pid: 1 }] });
      expect(drilldown).toHaveBeenCalledWith({ session: 'a', windowIndex: '0' });
      expect((await wired.current()).availability.processes).toBe('available');
    });
  });
});
