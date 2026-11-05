import { Router } from 'express';
import * as tmux from '../tmux.js';

const router = Router({ mergeParams: true });

// GET /api/sessions/:name/windows
router.get('/', async (req, res) => {
  try {
    const { name } = req.params;
    const windows = await tmux.listWindows(name);
    res.json({
      success: true,
      data: windows,
      error: null,
      meta: { total: windows.length },
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      data: null,
      error: err.message,
    });
  }
});

// POST /api/sessions/:name/windows
router.post('/', async (req, res) => {
  try {
    const { name: session } = req.params;
    const { name } = req.body ?? {};
    const windowIndex = await tmux.createWindow(session, name || undefined);
    res.status(201).json({
      success: true,
      data: { session, name, index: windowIndex },
      error: null,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      data: null,
      error: err.message,
    });
  }
});

// PUT /api/sessions/:name/windows/:index
router.put('/:index', async (req, res) => {
  try {
    const { name: session, index } = req.params;
    const { newName } = req.body ?? {};
    if (!newName || typeof newName !== 'string') {
      return res.status(400).json({
        success: false,
        data: null,
        error: 'Missing or invalid "newName" in request body',
      });
    }
    await tmux.renameWindow(session, index, newName);
    res.json({
      success: true,
      data: { session, index, newName },
      error: null,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      data: null,
      error: err.message,
    });
  }
});

// DELETE /api/sessions/:name/windows/:index
router.delete('/:index', async (req, res) => {
  try {
    const { name: session, index } = req.params;
    await tmux.killWindow(session, index);
    res.json({
      success: true,
      data: { session, index },
      error: null,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      data: null,
      error: err.message,
    });
  }
});

// GET /api/sessions/:name/windows/:index/layout
router.get('/:index/layout', async (req, res) => {
  try {
    const { name: session, index } = req.params;
    const windows = await tmux.listWindows(session);
    const win = windows.find(w => String(w.index) === String(index));
    if (!win) {
      return res.status(404).json({ success: false, data: null, error: 'Window not found' });
    }
    res.json({
      success: true,
      data: { session, index, width: win.width, height: win.height },
      error: null,
    });
  } catch (err) {
    res.status(500).json({ success: false, data: null, error: err.message });
  }
});

// POST /api/sessions/:name/windows/:index/layout
router.post('/:index/layout', async (req, res) => {
  try {
    const { name: session, index } = req.params;
    const { layout } = req.body ?? {};
    if (!layout || typeof layout !== 'string') {
      return res.status(400).json({ success: false, data: null, error: 'Missing or invalid "layout"' });
    }
    await tmux.selectLayout(session, index, layout);
    res.json({
      success: true,
      data: { session, index, layout },
      error: null,
    });
  } catch (err) {
    res.status(500).json({ success: false, data: null, error: err.message });
  }
});

const WINDOW_ID_RE = /^@\d+$/;

/**
 * Returns the session name containing a given window_id, or null if not found.
 */
async function findWindowSession(windowId) {
  const sessions = await tmux.listSessions();
  for (const s of sessions) {
    try {
      const wins = await tmux.listWindows(s.name);
      if (wins.some((w) => w.id === windowId)) return s.name;
    } catch { /* skip */ }
  }
  return null;
}

// PUT /by-id/:windowId  body: { newName }
router.put('/by-id/:windowId', async (req, res) => {
  try {
    const { name: srcSession, windowId } = req.params;
    const { newName } = req.body ?? {};

    if (!WINDOW_ID_RE.test(windowId)) {
      return res.status(400).json({ success: false, data: null, error: 'invalid_window_id' });
    }
    if (!newName || typeof newName !== 'string') {
      return res.status(400).json({ success: false, data: null, error: 'missing_newName' });
    }

    const srcWindows = await tmux.listWindows(srcSession);
    if (!srcWindows.some((w) => w.id === windowId)) {
      const actualSession = await findWindowSession(windowId);
      if (actualSession) {
        return res.status(409).json({
          success: false,
          data: { currentSession: actualSession },
          error: 'moved_window',
        });
      }
      return res.status(404).json({ success: false, data: null, error: 'window_not_found' });
    }

    await tmux.renameWindowById(windowId, newName);
    res.json({ success: true, data: { srcSession, windowId, newName }, error: null });
  } catch (err) {
    res.status(500).json({ success: false, data: null, error: err.message });
  }
});

// DELETE /by-id/:windowId
router.delete('/by-id/:windowId', async (req, res) => {
  try {
    const { name: srcSession, windowId } = req.params;
    if (!WINDOW_ID_RE.test(windowId)) {
      return res.status(400).json({ success: false, data: null, error: 'invalid_window_id' });
    }
    const srcWindows = await tmux.listWindows(srcSession);
    if (!srcWindows.some((w) => w.id === windowId)) {
      const actualSession = await findWindowSession(windowId);
      if (actualSession) {
        return res.status(409).json({
          success: false,
          data: { currentSession: actualSession },
          error: 'moved_window',
        });
      }
      return res.status(404).json({ success: false, data: null, error: 'window_not_found' });
    }
    await tmux.killWindowById(windowId);
    res.json({ success: true, data: { srcSession, windowId }, error: null });
  } catch (err) {
    res.status(500).json({ success: false, data: null, error: err.message });
  }
});

// POST /by-id/:windowId/move  body: { targetSession, confirmDestroySource? }
router.post('/by-id/:windowId/move', async (req, res) => {
  try {
    const { name: srcSession, windowId } = req.params;
    const { targetSession, confirmDestroySource = false } = req.body ?? {};

    if (!WINDOW_ID_RE.test(windowId)) {
      return res.status(400).json({ success: false, data: null, error: 'invalid_window_id' });
    }
    if (!targetSession || typeof targetSession !== 'string') {
      return res.status(400).json({ success: false, data: null, error: 'missing_targetSession' });
    }
    if (targetSession === srcSession) {
      return res.status(400).json({ success: false, data: null, error: 'target_equals_source' });
    }

    const sessions = await tmux.listSessions();
    if (!sessions.some((s) => s.name === targetSession)) {
      return res.status(404).json({ success: false, data: null, error: 'target_session_not_found' });
    }
    if (!sessions.some((s) => s.name === srcSession)) {
      return res.status(404).json({ success: false, data: null, error: 'source_session_not_found' });
    }

    const srcWindows = await tmux.listWindows(srcSession);
    if (!srcWindows.some((w) => w.id === windowId)) {
      const actualSession = await findWindowSession(windowId);
      if (actualSession) {
        return res.status(409).json({
          success: false,
          data: { currentSession: actualSession },
          error: 'moved_window',
        });
      }
      return res.status(404).json({ success: false, data: null, error: 'window_not_found' });
    }

    if (srcWindows.length === 1 && confirmDestroySource !== true) {
      return res.status(409).json({
        success: false,
        data: { sourceWindowCount: 1 },
        error: 'requires_confirmation',
      });
    }

    await tmux.moveWindowById(windowId, targetSession);
    res.json({ success: true, data: { srcSession, windowId, targetSession }, error: null });
  } catch (err) {
    res.status(500).json({ success: false, data: null, error: err.message });
  }
});

export default router;
