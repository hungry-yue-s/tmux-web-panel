import { Router } from 'express';
import * as tmux from '../tmux.js';
import { collectPids, samplePidDetail } from '../proc-stats.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const { session, windowIndex, comm } = req.query;

    if (!comm && !(session && windowIndex != null)) {
      return res.status(400).json({
        success: false, data: null,
        error: 'require session+windowIndex or comm',
      });
    }

    if (comm) {
      // External (non-tmux) comm group — out of scope for v1
      return res.status(501).json({
        success: false, data: null,
        error: 'comm-group drilldown not yet implemented',
      });
    }

    // Find pane roots for the requested window
    const panes = await tmux.listPaneCommands(session);
    const roots = panes.filter((p) => p.windowIndex === String(windowIndex) && p.pid).map((p) => p.pid);
    if (roots.length === 0) {
      return res.status(404).json({
        success: false, data: null,
        error: `window ${session}:${windowIndex} not found`,
      });
    }

    const windows = await tmux.listWindows(session);
    const windowName = (windows.find((w) => w.index === String(windowIndex)) || {}).name || String(windowIndex);

    // Collect all descendant PIDs across pane roots
    const allPids = new Set();
    for (const r of roots) {
      const pids = await collectPids(r);
      pids.forEach((p) => allPids.add(p));
    }

    const details = await Promise.all(Array.from(allPids).map((p) => samplePidDetail(p)));
    const procs = details.filter(Boolean).sort((a, b) => b.cpuPercent - a.cpuPercent);

    res.json({
      success: true,
      data: {
        window: { session, windowIndex: String(windowIndex), windowName },
        procs,
      },
      error: null,
    });
  } catch (err) {
    res.status(500).json({ success: false, data: null, error: err.message });
  }
});

export default router;
