import { Router } from 'express';
import * as tmux from '../tmux.js';

// --- Nested Router (mounted at /api/sessions/:name/windows/:index/panes) ---

const nestedPanesRouter = Router({ mergeParams: true });

// GET /api/sessions/:name/windows/:index/panes[?unzoom=1]
nestedPanesRouter.get('/', async (req, res) => {
  try {
    const { name: session, index } = req.params;
    // In split mode the frontend passes ?unzoom=1 so we get the real
    // (non-zoomed) pane geometry instead of the zoomed pane covering 100%.
    if (req.query.unzoom === '1') {
      await tmux.unzoomWindow(session, index);
    }
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

// POST /api/panes/:paneId/select — switch tmux focus to this pane
flatPanesRouter.post('/:paneId/select', async (req, res) => {
  try {
    const { paneId } = req.params;
    await tmux.selectPane(paneId);
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

// GET /api/panes/:paneId/capture
flatPanesRouter.get('/:paneId/capture', async (req, res) => {
  try {
    const { paneId } = req.params;
    const content = await tmux.capturePane(paneId, { escape: req.query.escape === '1' });
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

// POST /api/panes/:paneId/swap
flatPanesRouter.post('/:paneId/swap', async (req, res) => {
  try {
    const { paneId } = req.params;
    const { target } = req.body ?? {};
    if (!target || typeof target !== 'string') {
      return res.status(400).json({ success: false, data: null, error: 'Missing or invalid "target"' });
    }
    await tmux.swapPane(paneId, target);
    res.json({
      success: true,
      data: { source: paneId, target },
      error: null,
    });
  } catch (err) {
    res.status(500).json({ success: false, data: null, error: err.message });
  }
});

// POST /api/panes/:paneId/resize
flatPanesRouter.post('/:paneId/resize', async (req, res) => {
  try {
    const { paneId } = req.params;
    const { direction, amount } = req.body ?? {};
    if (!direction || !amount) {
      return res.status(400).json({ success: false, data: null, error: 'Missing "direction" or "amount"' });
    }
    await tmux.resizePane(paneId, direction, Number(amount));
    res.json({
      success: true,
      data: { paneId, direction, amount: Number(amount) },
      error: null,
    });
  } catch (err) {
    res.status(500).json({ success: false, data: null, error: err.message });
  }
});

// PUT /api/panes/:paneId/label — set or clear a pane's custom label (@pane_label)
flatPanesRouter.put('/:paneId/label', async (req, res) => {
  try {
    const { paneId } = req.params;
    if (!tmux.validatePaneId(paneId)) {
      return res.status(400).json({ success: false, data: null, error: 'Invalid pane ID' });
    }
    const { label } = req.body ?? {};
    if (label != null && typeof label !== 'string') {
      return res.status(400).json({ success: false, data: null, error: '"label" must be a string' });
    }
    const value = label ?? '';
    if (value !== '' && !tmux.validatePaneLabel(value)) {
      return res.status(400).json({
        success: false,
        data: null,
        error: 'Invalid label (max 32 chars, no control characters)',
      });
    }
    await tmux.setPaneLabel(paneId, value);
    res.json({ success: true, data: { paneId, label: value }, error: null });
  } catch (err) {
    res.status(500).json({ success: false, data: null, error: err.message });
  }
});

export { nestedPanesRouter, flatPanesRouter };
