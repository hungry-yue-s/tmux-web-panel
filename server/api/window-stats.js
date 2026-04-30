// Per-window resource stats: aggregates CPU/MEM/IO across each window's pane process trees.

import { Router } from 'express';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as tmux from '../tmux.js';
import { sampleTree, pruneStaleSamples, cpuCount, collectPids, sampleNonTmuxByComm } from '../proc-stats.js';

const execFileAsync = promisify(execFile);

async function readSystemSwap() {
  try {
    const buf = await readFile('/proc/meminfo', 'utf8');
    const t = buf.match(/^SwapTotal:\s+(\d+)\s+kB/m);
    const f = buf.match(/^SwapFree:\s+(\d+)\s+kB/m);
    const total = t ? Number(t[1]) * 1024 : 0;
    const free = f ? Number(f[1]) * 1024 : 0;
    return { total, used: Math.max(0, total - free) };
  } catch {
    return { total: 0, used: 0 };
  }
}

// Filesystem types to exclude from disk stats
const EXCLUDED_FS = new Set([
  'tmpfs', 'devtmpfs', 'sysfs', 'proc', 'devpts', 'securityfs',
  'cgroup', 'cgroup2', 'pstore', 'debugfs', 'hugetlbfs', 'mqueue',
  'configfs', 'fusectl', 'tracefs', 'bpf', 'efivarfs', 'autofs',
  'overlay', 'squashfs', 'nsfs', 'binfmt_misc',
]);

async function readDiskStats() {
  try {
    const { stdout } = await execFileAsync('df', [
      '-B1', '--output=source,fstype,size,used,avail,pcent,target',
    ]);
    const lines = stdout.trim().split('\n').slice(1); // skip header
    const disks = [];
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 7) continue;
      const [source, fstype, size, used, avail, pcent, ...mountParts] = parts;
      const mount = mountParts.join(' ');
      if (EXCLUDED_FS.has(fstype)) continue;
      if (source.startsWith('/dev/loop')) continue;
      const total = Number(size);
      if (total <= 0) continue;
      disks.push({
        device: source,
        fstype,
        mount,
        total,
        used: Number(used),
        avail: Number(avail),
        percent: parseFloat(pcent),
      });
    }
    return disks;
  } catch {
    return [];
  }
}

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const sessions = await tmux.listSessions();
    const windowMap = new Map(); // key: session|index → { session, windowIndex, windowName, paneRoots: [pid] }

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

    // Sample each window's aggregate (panes are sampled in parallel)
    const windowStats = await Promise.all(
      Array.from(windowMap.values()).map(async (w) => {
        const samples = await Promise.all(w.paneRoots.map((pid) => sampleTree(pid)));
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

    // Collect every tmux-owned PID (full process trees) to exclude from "external" sampling
    const tmuxPids = new Set();
    for (const w of windowMap.values()) {
      for (const root of w.paneRoots) {
        const pids = await collectPids(root);
        pids.forEach((p) => tmuxPids.add(p));
      }
    }

    // Total / system
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const [sysSwap, disks, external] = await Promise.all([
      readSystemSwap(),
      readDiskStats(),
      sampleNonTmuxByComm(tmuxPids),
    ]);
    const sumCpu = windowStats.reduce((a, w) => a + w.cpuPercent, 0);
    const sumMem = windowStats.reduce((a, w) => a + w.memBytes, 0);
    const sumSwap = windowStats.reduce((a, w) => a + w.swapBytes, 0);
    const sumIo = windowStats.reduce((a, w) => a + w.ioBps, 0);

    // Prune old PID samples (>30s untouched → process likely gone)
    pruneStaleSamples(30_000);

    res.json({
      success: true,
      data: {
        windows: windowStats,
        external,
        disks,
        total: {
          windowCpuPercent: sumCpu,
          windowMemBytes: sumMem,
          windowSwapBytes: sumSwap,
          windowIoBps: sumIo,
          systemMemTotal: totalMem,
          systemMemUsed: totalMem - freeMem,
          systemSwapTotal: sysSwap.total,
          systemSwapUsed: sysSwap.used,
          cpuCount,
          hostname: os.hostname(),
          uptime: os.uptime(),
          load1: os.loadavg()[0],
        },
      },
      error: null,
    });
  } catch (err) {
    res.status(500).json({ success: false, data: null, error: err.message });
  }
});

export default router;
