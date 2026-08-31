/**
 * Local host metrics, shaped like the remote probe output.
 *
 * Reuses the existing platform collectors rather than reimplementing them, so
 * the local numbers stay exactly what the current panel shows. The only new work
 * is presenting them in the same shape the SSH collector returns, so the
 * frontend has one contract for every server.
 */

import os from 'node:os';

import {
  readSystemMemory,
  readDiskStats,
  sampleSystemCpuPercent,
} from '../platform-system-stats.js';

function clampPercent(value) {
  if (!Number.isFinite(value)) return null;
  return Number(Math.min(100, Math.max(0, value)).toFixed(1));
}

/** Root filesystem entry, which is what the overview cards show. */
function pickRootDisk(disks) {
  if (!Array.isArray(disks) || disks.length === 0) return null;
  return disks.find((disk) => disk.mount === '/') || disks[0];
}

/** Reports the real platform: labelling every non-Darwin host "linux" would lie. */
function localPlatform() {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'linux') return 'linux';
  return process.platform;
}

export async function collectLocalMetrics() {
  const [memory, disks] = await Promise.all([
    readSystemMemory().catch(() => null),
    readDiskStats().catch(() => []),
  ]);

  const cpuPercent = clampPercent(sampleSystemCpuPercent());
  const load = os.loadavg();
  const rootDisk = pickRootDisk(disks);

  const memTotal = memory && Number.isFinite(memory.total) ? memory.total : null;
  const memUsed = memory && Number.isFinite(memory.used) ? memory.used : null;
  const memCached = memory && Number.isFinite(memory.cached) ? memory.cached : null;
  const memPercent = memTotal && memUsed !== null && memTotal > 0
    ? clampPercent((memUsed / memTotal) * 100)
    : null;

  const diskPercent = rootDisk && Number.isFinite(rootDisk.percent) ? clampPercent(rootDisk.percent) : null;

  return {
    platform: localPlatform(),
    cpuPercent,
    cpuCount: os.cpus().length,
    memTotal,
    memUsed,
    memCached,
    memPercent,
    memMetric: memory ? memory.metric : null,
    load1: Number.isFinite(load[0]) ? Number(load[0].toFixed(2)) : null,
    load5: Number.isFinite(load[1]) ? Number(load[1].toFixed(2)) : null,
    load15: Number.isFinite(load[2]) ? Number(load[2].toFixed(2)) : null,
    uptime: Math.trunc(os.uptime()),
    disk: rootDisk
      ? { total: rootDisk.total, used: rootDisk.used, percent: diskPercent, mount: rootDisk.mount }
      : null,
    diskPercent,
    availability: {
      cpu: cpuPercent === null ? 'unavailable' : 'available',
      memory: memPercent === null ? 'unavailable' : 'available',
      disk: diskPercent === null ? 'unavailable' : 'available',
      load: Number.isFinite(load[0]) ? 'available' : 'unavailable',
      // Whether per-process detail can be served depends on a drilldown being
      // wired into the metrics service, so that verdict is not ours to make.
      processes: 'unsupported',
      diskIo: process.platform === 'darwin' ? 'partial' : 'available',
      swap: 'unsupported',
    },
  };
}
