import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
const src = fs.readFileSync('public/js/perf-utils.js', 'utf8');
const sandbox = { window: {} };
new Function('window', src)(sandbox.window);
const { fmtBytes, fmtBps, fmtUptime, fmtPercent, colorFor, sparkPath, pressureScore, detectAlerts, ALERT_THRESHOLDS } = sandbox.window.PerfUtils;

describe('formatters', () => {
  it('fmtBytes', () => {
    expect(fmtBytes(0)).toBe('0 B');
    expect(fmtBytes(1024)).toBe('1.0 KB');
    expect(fmtBytes(1024 * 1024 * 1024)).toBe('1.0 GB');
    expect(fmtBytes(null)).toBe('—');
  });
  it('fmtBps appends /s', () => {
    expect(fmtBps(1024)).toBe('1.0 KB/s');
  });
  it('fmtUptime', () => {
    expect(fmtUptime(45)).toBe('0m');
    expect(fmtUptime(60)).toBe('1m');
    expect(fmtUptime(3600)).toBe('1h 0m');
    expect(fmtUptime(86400 + 3600)).toBe('1d 1h');
  });
  it('fmtPercent', () => {
    expect(fmtPercent(12.345)).toBe('12%');
    expect(fmtPercent(5.6)).toBe('5.6%');
  });
});

describe('colorFor', () => {
  it('is deterministic', () => {
    expect(colorFor('a|0')).toBe(colorFor('a|0'));
    expect(colorFor('a|0')).not.toBe(colorFor('zzz|99')); // not guaranteed but extremely likely
  });
});

describe('sparkPath', () => {
  it('returns line and fill paths', () => {
    const p = sparkPath([1, 2, 3, 4], 100, 20);
    expect(p.line).toMatch(/^M[\d.]+,[\d.]+L/);
    expect(p.fill).toContain(p.line);
  });
  it('handles single-value series without NaN', () => {
    const p = sparkPath([5], 100, 20);
    expect(p.line).not.toContain('NaN');
  });
});

describe('pressureScore', () => {
  const total = { cpuCount: 4, systemMemTotal: 8e9, windowIoBps: 1e6 };
  it('weights cpu 0.5 / mem 0.35 / io 0.15', () => {
    const onlyCpu = pressureScore({ cpuPercent: 400, memBytes: 0, ioBps: 0 }, total);
    expect(onlyCpu).toBeCloseTo(50, 5); // 400/400 * 50
    const onlyMem = pressureScore({ cpuPercent: 0, memBytes: 8e9, ioBps: 0 }, total);
    expect(onlyMem).toBeCloseTo(35, 5);
    const onlyIo  = pressureScore({ cpuPercent: 0, memBytes: 0, ioBps: 1e6 }, total);
    expect(onlyIo).toBeCloseTo(15, 5);
  });
  it('avoids NaN when windowIoBps = 0', () => {
    const r = pressureScore({ cpuPercent: 0, memBytes: 0, ioBps: 0 }, { ...total, windowIoBps: 0 });
    expect(Number.isFinite(r)).toBe(true);
  });
});

describe('detectAlerts', () => {
  // Default window: 1% of system RAM, well below the 5% warn / 8% critical thresholds.
  const t = (over) => ({
    total: { cpuCount: 4, systemMemTotal: 8e9, systemMemUsed: 4e9, windowCpuPercent: 100, load1: 1 },
    windows: [{ session: 'a', windowIndex: '0', windowName: 'x', cpuPercent: 50, memBytes: 8e7, swapBytes: 0, ioBps: 0, procCount: 1, ...over }],
    external: [], disks: [],
  });
  it('flags single-window CPU >= 200% as critical', () => {
    const a = detectAlerts(t({ cpuPercent: 250 }));
    expect(a.critical.length).toBe(1);
    expect(a.critical[0].kind).toBe('window-cpu');
  });
  it('flags single-window MEM >= 8% of system RAM as critical', () => {
    // 1e9 / 8e9 = 12.5% > 8% critical threshold
    const a = detectAlerts(t({ memBytes: 1e9 }));
    expect(a.critical.some((x) => x.kind === 'window-mem')).toBe(true);
  });
  it('flags disk >= 95% as critical', () => {
    const snap = t();
    snap.disks = [{ mount: '/', percent: 96, total: 1, used: 1, avail: 0 }];
    const a = detectAlerts(snap);
    expect(a.critical.length).toBe(1);
  });
  it('returns empty arrays when healthy', () => {
    expect(detectAlerts(t())).toEqual({ critical: [], warn: [] });
  });
  it('exports thresholds', () => {
    expect(ALERT_THRESHOLDS.cpuMachine.critical).toBe(80);
  });
});
