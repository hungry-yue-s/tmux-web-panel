import { Router } from 'express';
import * as tmux from '../tmux.js';

const WINDOW_ID_RE = /^@\d+$/;

async function collectLiveWindowIds() {
  const sessions = await tmux.listSessions();
  const all = new Set();
  for (const s of sessions) {
    try {
      const windows = await tmux.listWindows(s.name);
      for (const w of windows) {
        if (w.id) all.add(w.id);
      }
    } catch {
      // Skip sessions we can't read.
    }
  }
  return all;
}

export function createPinsRouter({ pinStore }) {
  const router = Router();

  router.get('/', async (_req, res) => {
    try {
      const live = await collectLiveWindowIds();
      await pinStore.sweep(live);
      res.json({ success: true, data: { pins: pinStore.list() }, error: null });
    } catch (err) {
      res.status(500).json({ success: false, data: null, error: err.message });
    }
  });

  router.put('/:windowId', async (req, res) => {
    try {
      const { windowId } = req.params;
      if (!WINDOW_ID_RE.test(windowId)) {
        return res.status(400).json({ success: false, data: null, error: 'invalid_window_id' });
      }
      const { pinned } = req.body ?? {};
      if (typeof pinned !== 'boolean') {
        return res.status(400).json({ success: false, data: null, error: 'pinned_must_be_boolean' });
      }

      if (pinned) {
        const live = await collectLiveWindowIds();
        if (!live.has(windowId)) {
          return res.status(400).json({ success: false, data: null, error: 'unknown_window_id' });
        }
      }

      await pinStore.set(windowId, pinned);
      res.json({ success: true, data: { windowId, pinned }, error: null });
    } catch (err) {
      res.status(500).json({ success: false, data: null, error: err.message });
    }
  });

  return router;
}
