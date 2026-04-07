import { Router } from 'express';
import os from 'node:os';

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

router.get('/', (_req, res) => {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const load = os.loadavg();
  const cpuCount = os.cpus().length;

  res.json({
    success: true,
    data: {
      cpuPercent: getCpuPercent(),
      cpuCount,
      memTotal: totalMem,
      memUsed: usedMem,
      memPercent: (usedMem / totalMem) * 100,
      load1: load[0],
      load5: load[1],
      load15: load[2],
      uptime: os.uptime(),
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
    },
    error: null,
  });
});

export default router;
