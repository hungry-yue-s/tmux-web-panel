import { Router } from 'express';
import * as tmux from '../tmux.js';

const router = Router();

// GET /api/sessions
router.get('/', async (_req, res) => {
  try {
    const sessions = await tmux.listSessions();
    res.json({
      success: true,
      data: sessions,
      error: null,
      meta: { total: sessions.length },
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      data: null,
      error: err.message,
    });
  }
});

// POST /api/sessions
router.post('/', async (req, res) => {
  try {
    const { name } = req.body ?? {};
    if (!name || typeof name !== 'string') {
      return res.status(400).json({
        success: false,
        data: null,
        error: 'Missing or invalid "name" in request body',
      });
    }
    await tmux.createSession(name);
    res.status(201).json({
      success: true,
      data: { name },
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

// PUT /api/sessions/:name
router.put('/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const { newName } = req.body ?? {};
    if (!newName || typeof newName !== 'string') {
      return res.status(400).json({
        success: false,
        data: null,
        error: 'Missing or invalid "newName" in request body',
      });
    }
    await tmux.renameSession(name, newName);
    res.json({
      success: true,
      data: { oldName: name, newName },
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

// DELETE /api/sessions/:name
router.delete('/:name', async (req, res) => {
  try {
    const { name } = req.params;
    await tmux.killSession(name);
    res.json({
      success: true,
      data: { name },
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
