// Per-window resource stats: aggregates CPU/MEM/IO across each window's pane process trees.

import { Router } from 'express';
import os from 'node:os';
import * as tmux from '../tmux.js';
import { sampleTree, pruneStaleSamples, cpuCount } from '../proc-stats.js';

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
        let cpu = 0, mem = 0, io = 0, procs = 0;
        for (const s of samples) {
          cpu += s.cpuPercent;
          mem += s.memBytes;
          io += s.ioBps;
          procs += s.procCount;
        }
        return {
          session: w.session,
          windowIndex: w.windowIndex,
          windowName: w.windowName,
          cpuPercent: cpu,
          memBytes: mem,
          ioBps: io,
          procCount: procs,
        };
      }),
    );

    // Total / system
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const sumCpu = windowStats.reduce((a, w) => a + w.cpuPercent, 0);
    const sumMem = windowStats.reduce((a, w) => a + w.memBytes, 0);
    const sumIo = windowStats.reduce((a, w) => a + w.ioBps, 0);

    // Prune old PID samples (>30s untouched → process likely gone)
    pruneStaleSamples(30_000);

    res.json({
      success: true,
      data: {
        windows: windowStats,
        total: {
          windowCpuPercent: sumCpu,
          windowMemBytes: sumMem,
          windowIoBps: sumIo,
          systemMemTotal: totalMem,
          systemMemUsed: totalMem - freeMem,
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
