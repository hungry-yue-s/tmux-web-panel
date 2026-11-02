import express from 'express';
import { requireSameOrigin } from './same-origin.js';

/** Authentication is supplied by the existing /api token middleware. */
export function createDiagnosticsRouter({ diagnostics }) {
  const router = express.Router();
  router.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.use(requireSameOrigin);
  const route = (fn) => async (req, res) => {
    try { res.json({ success: true, data: await fn(req), error: null }); }
    catch (err) { res.status(err.status || 500).json({ success: false, data: null,
      error: { code: err.status ? err.message : 'diagnostics_failed' } }); }
  };
  router.get('/status', route(() => diagnostics.status()));
  router.post('/start', route((req) => diagnostics.start(req.body || {})));
  router.post('/stop', route(() => diagnostics.stop()));
  router.post('/client', route((req) => diagnostics.acceptClient(req.body)));
  router.get('/captures/:id', (req, res) => {
    let path;
    try { path = diagnostics.capturePath(req.params.id); }
    catch { res.status(400).json({ success: false, data: null, error: { code: 'invalid_capture_id' } }); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.download(path, req.params.id + '.jsonl', (err) => {
      if (err && !res.headersSent) res.status(err.code === 'ENOENT' ? 404 : 500).json({
        success: false, data: null, error: { code: 'capture_unavailable' },
      });
    });
  });
  return router;
}
