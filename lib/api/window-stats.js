// Per-window resource stats: aggregates CPU/MEM/IO across each window's pane process trees.

import { Router } from 'express';
import os from 'node:os';
import * as tmux from '../tmux.js';
import * as procStats from '../process-stats.js';
import {
  platformCapabilities,
  readDiskStats,
  readSystemDiskIo,
  readSystemMemory,
  readSystemSwap,
  sampleSystemCpuPercent,
} from '../platform-system-stats.js';

const SNAPSHOT_CACHE_MS = 1_750;

let _cachedSnapshot = null;
let _cachedAt = 0;
let _samplePromise = null;

async function collectWindowStats() {
  const sessions = await tmux.listSessions();
  const windowMap = new Map();

  for (const s of sessions) {
    const panes = await tmux.listPaneCommands(s.name);
    const windows = await tmux.listWindows(s.name);
    const nameByIdx = new Map(windows.map((w) => [w.index, w.name]));
    for (const p of panes) {
      if (!p.pid) continue;
      const key = `${s.name}|${p.windowIndex}`;
      if (!windowMap.has(key)) {
        windowMap.set(key, {
          session: s.name,
          windowIndex: p.windowIndex,
          windowName: nameByIdx.get(p.windowIndex) || String(p.windowIndex),
          paneRoots: [],
        });
      }
      windowMap.get(key).paneRoots.push(p.pid);
    }
  }

  const windowStats = await Promise.all(
    Array.from(windowMap.values()).map(async (w) => {
      const samples = await Promise.all(w.paneRoots.map((pid) => procStats.sampleTree(pid)));
      let cpu = 0, mem = 0, swap = 0, io = 0, procs = 0;
      for (const s of samples) {
        cpu += s.cpuPercent;
        mem += s.memBytes;
        swap += s.swapBytes;
        io += s.ioBps;
        procs += s.procCount;
      }
      return {
        session: w.session,
        windowIndex: w.windowIndex,
        windowName: w.windowName,
        cpuPercent: cpu,
        memBytes: mem,
        swapBytes: swap,
        ioBps: io,
        procCount: procs,
      };
    }),
  );

  const tmuxPids = new Set();
  for (const w of windowMap.values()) {
    for (const root of w.paneRoots) {
      const pids = await procStats.collectPids(root);
      pids.forEach((p) => tmuxPids.add(p));
    }
  }

  const [systemMemory, sysSwap, disks, externalAll, darwinDiskIo] = await Promise.all([
    readSystemMemory(),
    readSystemSwap(),
    readDiskStats(),
    procStats.sampleNonTmuxByComm(tmuxPids),
    readSystemDiskIo(),
  ]);
  const diskIo = await procStats.readDiskIo();
  disks.forEach((d) => {
    const devName = (d.device || '').replace(/^\/dev\//, '');
    const io = diskIo.get(devName);
    d.readBps = io ? io.readBps : null;
    d.writeBps = io ? io.writeBps : null;
  });
  const sumCpu = windowStats.reduce((a, w) => a + w.cpuPercent, 0);
  const sumMem = windowStats.reduce((a, w) => a + w.memBytes, 0);
  const sumSwap = windowStats.reduce((a, w) => a + w.swapBytes, 0);
  const sumIo = windowStats.reduce((a, w) => a + w.ioBps, 0);
  const external = externalAll
    .sort((a, b) => {
      const aScore = a.cpuPercent / (procStats.cpuCount * 100) + a.memBytes / systemMemory.total;
      const bScore = b.cpuPercent / (procStats.cpuCount * 100) + b.memBytes / systemMemory.total;
      return bScore - aScore;
    })
    .slice(0, 50);

  procStats.pruneStaleSamples(30_000);

  const perDiskIo = disks.reduce((sum, d) => {
    return sum + (Number(d.readBps) || 0) + (Number(d.writeBps) || 0);
  }, 0);
  const systemDiskIoBps = Number.isFinite(darwinDiskIo)
    ? darwinDiskIo
    : (platformCapabilities.diskIoPerDevice ? perDiskIo : null);
  const capabilities = {
    ...platformCapabilities,
    systemDiskIo: Number.isFinite(systemDiskIoBps),
  };

  return {
    capabilities,
    windows: windowStats,
    external,
    disks,
    total: {
      windowCpuPercent: sumCpu,
      windowMemBytes: sumMem,
      windowSwapBytes: sumSwap,
      windowIoBps: sumIo,
      systemCpuPercent: sampleSystemCpuPercent(),
      systemMemTotal: systemMemory.total,
      systemMemUsed: systemMemory.used,
      systemMemCached: systemMemory.cached,
      systemMemAvailablePercent: systemMemory.availablePercent,
      systemMemoryMetric: systemMemory.metric,
      systemSwapTotal: sysSwap.total,
      systemSwapUsed: sysSwap.used,
      systemDiskIoBps,
      externalGroupCount: externalAll.length,
      cpuCount: procStats.cpuCount,
      hostname: os.hostname(),
      uptime: os.uptime(),
      load1: os.loadavg()[0],
    },
  };
}

// The history sampler and the visible panel both poll every two seconds. Share
// one in-flight/recent snapshot so Linux delta counters are not consumed twice
// and Darwin does not run duplicate ps/iostat commands.
export async function sampleWindowStats() {
  const now = Date.now();
  if (_cachedSnapshot && now - _cachedAt < SNAPSHOT_CACHE_MS) return _cachedSnapshot;
  if (_samplePromise) return _samplePromise;
  _samplePromise = collectWindowStats()
    .then((snapshot) => {
      _cachedSnapshot = snapshot;
      _cachedAt = Date.now();
      return snapshot;
    })
    .finally(() => { _samplePromise = null; });
  return _samplePromise;
}

export function _resetWindowStatsCacheForTests() {
  _cachedSnapshot = null;
  _cachedAt = 0;
  _samplePromise = null;
}

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const data = await sampleWindowStats();
    res.json({ success: true, data, error: null });
  } catch (err) {
    res.status(500).json({ success: false, data: null, error: err.message });
  }
});

export default router;
