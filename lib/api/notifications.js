import { Router } from 'express';

/**
 * Create notification API routes.
 * @param {import('../notifications.js').NotificationStore} store
 * @returns {Router}
 */
export function createNotificationsRouter(store) {
  const router = Router();

  // GET /api/notifications — list all notifications
  router.get('/', (_req, res) => {
    res.json({
      success: true,
      data: store.getAll(),
      error: null,
    });
  });

  // POST /api/notifications/:id/read — mark one as read
  router.post('/:id/read', (req, res) => {
    const found = store.markRead(req.params.id);
    if (!found) {
      res.status(404).json({ success: false, data: null, error: 'Notification not found' });
      return;
    }
    res.json({ success: true, data: null, error: null });
  });

  // POST /api/notifications/read-by-window — mark all for a window as read
  router.post('/read-by-window', (req, res) => {
    const { session, windowIndex } = req.body || {};
    if (!session || windowIndex === undefined) {
      res.status(400).json({ success: false, data: null, error: 'session and windowIndex required' });
      return;
    }
    const count = store.markReadByWindow(session, windowIndex);
    res.json({ success: true, data: { count }, error: null });
  });

  // DELETE /api/notifications — clear all
  router.delete('/', (_req, res) => {
    store.clearAll();
    res.json({ success: true, data: null, error: null });
  });

  return router;
}
