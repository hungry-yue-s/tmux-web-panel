import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the underlying sampler so we don't hit /proc
vi.mock('../../server/api/window-stats.js', () => ({
  sampleWindowStats: vi.fn(async () => ({
    total: { windowCpuPercent: 100, windowMemBytes: 1e9, windowIoBps: 1e6, load1: 1.5,
             systemMemTotal: 8e9, systemMemUsed: 4e9, systemSwapTotal: 0, systemSwapUsed: 0,
             cpuCount: 4, hostname: 'test', uptime: 100 },
    windows: [
      { session: 'a', windowIndex: 0, windowName: 'x', cpuPercent: 80, memBytes: 6e8, swapBytes: 0, ioBps: 1e6, procCount: 3 },
      { session: 'a', windowIndex: 1, windowName: 'y', cpuPercent: 20, memBytes: 4e8, swapBytes: 0, ioBps: 0,   procCount: 1 },
    ],
    external: [],
    disks: [],
  })),
}));

import { _ringSize, sampleAndStore, getHistory, _resetForTests } from '../../server/api/perf-history.js';

describe('perf-history ring buffer', () => {
  beforeEach(() => _resetForTests());

  it('starts empty', () => {
    expect(getHistory(60).points).toHaveLength(0);
  });

  it('appends one point per sampleAndStore call', async () => {
    await sampleAndStore();
    await sampleAndStore();
    expect(getHistory(3600).points).toHaveLength(2);
  });

  it('keeps top 10 windows per point', async () => {
    await sampleAndStore();
    const p = getHistory(60).points[0];
    expect(p.top.length).toBeLessThanOrEqual(10);
    expect(p.top[0]).toHaveProperty('key');
    expect(p.top[0]).toHaveProperty('cpu');
  });

  it('caps at ring size', async () => {
    for (let i = 0; i < _ringSize + 5; i++) await sampleAndStore();
    expect(getHistory(3600).points).toHaveLength(_ringSize);
  });

  it('window=60 returns last 30 points (2s cadence)', async () => {
    for (let i = 0; i < 60; i++) await sampleAndStore();
    expect(getHistory(60).points.length).toBeLessThanOrEqual(30);
  });
});
