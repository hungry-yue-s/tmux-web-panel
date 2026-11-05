// The older per-session tmux API the pages still use: sessions, windows and
// panes by name/index, plus /api/status. The workspace API is the stable,
// id-based one; these routes stay until the pages stop calling them.

import express from 'express';
import sessionsRouter from '../../lib/api/sessions.js';
import windowsRouter from '../../lib/api/windows.js';
import { flatPanesRouter, nestedPanesRouter } from '../../lib/api/panes.js';

export const name = 'tmux-api';

export const inject = ['http', 'tmux'];

export function apply(ctx) {
  ctx.http.mount('/api/sessions', sessionsRouter);
  ctx.http.mount('/api/sessions/:name/windows', windowsRouter);
  ctx.http.mount('/api/sessions/:name/windows/:index/panes', nestedPanesRouter);
  ctx.http.mount('/api/panes', flatPanesRouter);

  const status = express.Router();
  status.get('/', async (_req, res) => {
    try {
      const sessions = await ctx.tmux.listSessions();
      const windows = sessions.reduce((sum, session) => sum + session.windows, 0);
      res.json({ success: true, data: { sessions: sessions.length, windows }, error: null });
    } catch (error) {
      res.status(500).json({ success: false, data: null, error: error.message });
    }
  });
  ctx.http.mount('/api/status', status);
}
