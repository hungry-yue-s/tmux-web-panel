// Cross-platform host memory, swap, CPU and disk collectors.

import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const IS_DARWIN = process.platform === 'darwin';

let _previousCpu = null;

const EXCLUDED_FS = new Set([
  'tmpfs', 'devtmpfs', 'sysfs', 'proc', 'devpts', 'securityfs',
  'cgroup', 'cgroup2', 'pstore', 'debugfs', 'hugetlbfs', 'mqueue',
  'configfs', 'fusectl', 'tracefs', 'bpf', 'efivarfs', 'autofs',
  'overlay', 'squashfs', 'nsfs', 'binfmt_misc',
]);

function bytesFromUnit(value, unit) {
  const multipliers = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
  return Number(value) * (multipliers[String(unit || '').toUpperCase()] || 1);
}

export function parseDarwinSwap(output) {
  const total = String(output || '').match(/total\s*=\s*([\d.]+)([KMGT])/i);
  const used = String(output || '').match(/used\s*=\s*([\d.]+)([KMGT])/i);
  if (!total || !used) return null;
  return { total: bytesFromUnit(total[1], total[2]), used: bytesFromUnit(used[1], used[2]) };
}

export function parseMemoryPressure(output, totalBytes) {
  const m = String(output || '').match(/free percentage:\s*([\d.]+)%/i);
  if (!m) return null;
  const freePercent = Math.max(0, Math.min(100, Number(m[1])));
  if (!Number.isFinite(freePercent)) return null;
  return {
    total: totalBytes,
    used: Math.round(totalBytes * (1 - freePercent / 100)),
    availablePercent: freePercent,
    metric: 'pressure',
  };
}

export function parseDarwinDf(output) {
  const disks = [];
  const excludedMount = /^\/System\/Volumes\/(?:VM|Preboot|Update|xarts|iSCPreboot|Hardware)(?:\/|$)/;
  for (const line of String(output || '').trim().split('\n').slice(1)) {
    const m = line.match(/^(\/dev\/\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/);
    if (!m || excludedMount.test(m[6])) continue;
    const total = Number(m[2]) * 1024;
    if (!Number.isFinite(total) || total <= 0) continue;
    disks.push({
      device: m[1],
      fstype: null,
      mount: m[6],
      total,
      used: Number(m[3]) * 1024,
      avail: Number(m[4]) * 1024,
      percent: Number(m[5]),
    });
  }
  return disks;
}

export function parseDarwinIostat(output) {
  const lines = String(output || '').trim().split('\n').filter(Boolean);
  const deviceLine = lines.find((line) => /\bdisk\d+\b/.test(line));
  const deviceCount = deviceLine ? (deviceLine.match(/\bdisk\d+\b/g) || []).length : 0;
  if (deviceCount === 0) return null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const values = lines[i].trim().split(/\s+/).map(Number);
    if (values.length < deviceCount * 3 || values.some((v) => !Number.isFinite(v))) continue;
    let transferredMb = 0;
    for (let d = 0; d < deviceCount; d++) transferredMb += values[d * 3 + 2];
    return transferredMb * 1024 * 1024;
  }
  return null;
}

export function sampleSystemCpuPercent(cpus = os.cpus()) {
  const current = cpus.reduce((sum, cpu) => {
    const times = cpu.times || {};
    const idle = Number(times.idle) || 0;
    const total = Object.values(times).reduce((a, v) => a + (Number(v) || 0), 0);
    return { idle: sum.idle + idle, total: sum.total + total };
  }, { idle: 0, total: 0 });
  const previous = _previousCpu;
  _previousCpu = current;
  if (!previous) return null;
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (totalDelta <= 0) return null;
  return Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
}

export async function readSystemMemory() {
  const total = os.totalmem();
  if (IS_DARWIN) {
    try {
      const { stdout } = await execFileAsync('/usr/bin/memory_pressure', ['-Q'], { timeout: 3_000 });
      const parsed = parseMemoryPressure(stdout, total);
      if (parsed) return parsed;
    } catch {}
  }
  const free = os.freemem();
  return { total, used: Math.max(0, total - free), availablePercent: total > 0 ? (free / total) * 100 : null, metric: 'allocated' };
}

export async function readSystemSwap() {
  if (IS_DARWIN) {
    try {
      const { stdout } = await execFileAsync('/usr/sbin/sysctl', ['-n', 'vm.swapusage'], { timeout: 3_000 });
      return parseDarwinSwap(stdout) || { total: 0, used: 0 };
    } catch {
      return { total: 0, used: 0 };
    }
  }
  try {
    const buf = await readFile('/proc/meminfo', 'utf8');
    const total = buf.match(/^SwapTotal:\s+(\d+)\s+kB/m);
    const free = buf.match(/^SwapFree:\s+(\d+)\s+kB/m);
    const totalBytes = total ? Number(total[1]) * 1024 : 0;
    const freeBytes = free ? Number(free[1]) * 1024 : 0;
    return { total: totalBytes, used: Math.max(0, totalBytes - freeBytes) };
  } catch {
    return { total: 0, used: 0 };
  }
}

export async function readDiskStats() {
  if (IS_DARWIN) {
    try {
      const { stdout } = await execFileAsync('/bin/df', ['-kP'], { timeout: 3_000 });
      return parseDarwinDf(stdout);
    } catch {
      return [];
    }
  }
  try {
    const { stdout } = await execFileAsync('df', [
      '-B1', '--output=source,fstype,size,used,avail,pcent,target',
    ]);
    const disks = [];
    for (const line of stdout.trim().split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 7) continue;
      const [source, fstype, size, used, avail, pcent, ...mountParts] = parts;
      if (EXCLUDED_FS.has(fstype) || source.startsWith('/dev/loop')) continue;
      const total = Number(size);
      if (total <= 0) continue;
      disks.push({
        device: source, fstype, mount: mountParts.join(' '), total,
        used: Number(used), avail: Number(avail), percent: parseFloat(pcent),
      });
    }
    return disks;
  } catch {
    return [];
  }
}

export async function readSystemDiskIo() {
  if (!IS_DARWIN) return null;
  try {
    const { stdout } = await execFileAsync('/usr/sbin/iostat', ['-Id', '-w', '1', '-c', '2'], {
      timeout: 4_000,
      maxBuffer: 1024 * 1024,
    });
    return parseDarwinIostat(stdout);
  } catch {
    return null;
  }
}

export const platformCapabilities = Object.freeze(IS_DARWIN ? {
  platform: 'darwin',
  systemCpu: true,
  systemMemory: true,
  systemSwap: true,
  systemDiskIo: true,
  diskCapacity: true,
  diskIoPerDevice: false,
  processCpu: true,
  processMemory: true,
  processSwap: false,
  processIo: false,
  externalProcesses: true,
} : {
  platform: process.platform,
  systemCpu: true,
  systemMemory: true,
  systemSwap: true,
  systemDiskIo: true,
  diskCapacity: true,
  diskIoPerDevice: true,
  processCpu: true,
  processMemory: true,
  processSwap: true,
  processIo: true,
  externalProcesses: true,
});

export function _resetSystemCpuForTests() {
  _previousCpu = null;
}
