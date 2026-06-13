import { Router } from 'express';
import { MAX_TTL_MS } from '../share-store.js';

/**
 * Authenticated management routes for shared preview snapshots.
 * The public view route (GET /s/:id) lives in index.js, before the /api auth
 * gate, so recipients need no panel login.
 */
export function createShareRouter(shareStore) {
  const router = Router();

  // Create a share from a client-rendered, self-contained HTML snapshot.
  router.post('/', async (req, res) => {
    try {
      const { html, filename, ttlMs } = req.body ?? {};
      if (typeof html !== 'string' || html.length === 0) {
        return res.status(400).json({ success: false, data: null, error: 'html_required' });
      }
      const ttl = Number(ttlMs);
      if (!Number.isFinite(ttl) || ttl <= 0) {
        return res.status(400).json({ success: false, data: null, error: 'invalid_ttl' });
      }
      const { id, filename: name, createdAt, expiresAt } =
        await shareStore.create({ html, filename, ttlMs: Math.min(ttl, MAX_TTL_MS) });
      res.json({ success: true, data: { id, url: '/s/' + id, filename: name, createdAt, expiresAt }, error: null });
    } catch (err) {
      const code = (err.message === 'html_too_large') ? 413 : 500;
      res.status(code).json({ success: false, data: null, error: err.message });
    }
  });

  // List the caller's live shares (single-user panel — all shares).
  router.get('/', (_req, res) => {
    try {
      res.json({ success: true, data: { shares: shareStore.list() }, error: null });
    } catch (err) {
      res.status(500).json({ success: false, data: null, error: err.message });
    }
  });

  // Manually revoke a share before it expires.
  router.delete('/:id', async (req, res) => {
    try {
      const existed = await shareStore.delete(req.params.id);
      res.json({ success: true, data: { deleted: existed }, error: null });
    } catch (err) {
      res.status(500).json({ success: false, data: null, error: err.message });
    }
  });

  return router;
}
