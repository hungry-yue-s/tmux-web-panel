import { Router } from 'express';
import * as tmux from '../tmux.js';

// --- Nested Router (mounted at /api/sessions/:name/windows/:index/panes) ---

const nestedPanesRouter = Router({ mergeParams: true });

// GET /api/sessions/:name/windows/:index/panes
nestedPanesRouter.get('/', async (req, res) => {
  try {
    const { name: session, index } = req.params;
    const panes = await tmux.listPanes(session, index);
    res.json({
      success: true,
      data: panes,
      error: null,
      meta: { total: panes.length },
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      data: null,
      error: err.message,
    });
  }
});

// POST /api/sessions/:name/windows/:index/panes
nestedPanesRouter.post('/', async (req, res) => {
  try {
    const { paneId, direction } = req.body ?? {};
    if (!paneId || typeof paneId !== 'string') {
      return res.status(400).json({
        success: false,
        data: null,
        error: 'Missing or invalid "paneId" in request body',
      });
    }
    if (direction !== 'horizontal' && direction !== 'vertical') {
      return res.status(400).json({
        success: false,
        data: null,
        error: '"direction" must be "horizontal" or "vertical"',
      });
    }
    await tmux.splitPane(paneId, direction);
    res.status(201).json({
      success: true,
      data: { paneId, direction },
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

// DELETE /api/sessions/:name/windows/:index/panes/:paneId
nestedPanesRouter.delete('/:paneId', async (req, res) => {
  try {
    const { paneId } = req.params;
    await tmux.killPane(paneId);
    res.json({
      success: true,
      data: { paneId },
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

// --- Flat Router (mounted at /api/panes) ---

const flatPanesRouter = Router();

// POST /api/panes/:paneId/send
flatPanesRouter.post('/:paneId/send', async (req, res) => {
  try {
    const { paneId } = req.params;
    const { command } = req.body ?? {};
    if (!command || typeof command !== 'string') {
      return res.status(400).json({
        success: false,
        data: null,
        error: 'Missing or invalid "command" in request body',
      });
    }
    await tmux.sendKeys(paneId, command);
    res.json({
      success: true,
      data: { paneId, command },
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

// GET /api/panes/:paneId/capture
flatPanesRouter.get('/:paneId/capture', async (req, res) => {
  try {
    const { paneId } = req.params;
    const content = await tmux.capturePane(paneId);
    res.json({
      success: true,
      data: { paneId, content },
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

export { nestedPanesRouter, flatPanesRouter };
