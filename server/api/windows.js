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

export default router;
