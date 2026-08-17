import { Router } from 'express';
import os from 'node:os';
import { readSystemMemory } from '../platform-system-stats.js';

// CPU usage requires sampling between two snapshots.
let prevCpu = sampleCpu();

function sampleCpu() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    for (const t of Object.values(cpu.times)) total += t;
    idle += cpu.times.idle;
  }
  return { idle, total };
}

function getCpuPercent() {
  const cur = sampleCpu();
  const idleDiff = cur.idle - prevCpu.idle;
  const totalDiff = cur.total - prevCpu.total;
  prevCpu = cur;
  if (totalDiff <= 0) return 0;
  return Math.max(0, Math.min(100, (1 - idleDiff / totalDiff) * 100));
}

const router = Router();

export function getNetworkAddresses(networkInterfaces = os.networkInterfaces()) {
  const addresses = [];
  for (const [name, entries] of Object.entries(networkInterfaces)) {
    for (const entry of entries || []) {
      const family = typeof entry.family === 'string'
        ? entry.family
        : entry.family === 4 ? 'IPv4' : entry.family === 6 ? 'IPv6' : String(entry.family);
      if (entry.internal || (family !== 'IPv4' && family !== 'IPv6')) continue;
      addresses.push({ interface: name, address: entry.address, family });
    }
  }
  return addresses.sort((a, b) => {
    if (a.family !== b.family) return a.family === 'IPv4' ? -1 : 1;
    return a.interface.localeCompare(b.interface) || a.address.localeCompare(b.address);
  });
}

export function getPrimaryAddress(addresses) {
  const ipv4 = addresses.filter((item) => item.family === 'IPv4');
  const score = (name) => {
    if (/^en0$/.test(name)) return 0;
    if (/^(en|eth|wlan|wl)[a-z0-9._-]*$/i.test(name)) return 1;
    if (/^(bridge|docker|veth|virbr|vmnet|utun|tun|tap|awdl|llw)/i.test(name)) return 3;
    return 2;
  };
  return [...ipv4].sort((a, b) => score(a.interface) - score(b.interface))[0]
    ?? addresses[0]
    ?? null;
}

router.get('/', async (_req, res) => {
  const systemMemory = await readSystemMemory();
  const load = os.loadavg();
  const cpuCount = os.cpus().length;
  const networkAddresses = getNetworkAddresses();
  const primaryAddress = getPrimaryAddress(networkAddresses);

  res.json({
    success: true,
    data: {
      cpuPercent: getCpuPercent(),
      cpuCount,
      memTotal: systemMemory.total,
      memUsed: systemMemory.used,
      memCached: systemMemory.cached,
      memPercent: systemMemory.total > 0
        ? (systemMemory.used / systemMemory.total) * 100
        : 0,
      memMetric: systemMemory.metric,
      load1: load[0],
      load5: load[1],
      load15: load[2],
      uptime: os.uptime(),
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      ip: primaryAddress?.address ?? null,
      ipInterface: primaryAddress?.interface ?? null,
      networkAddresses,
    },
    error: null,
  });
});

export default router;
