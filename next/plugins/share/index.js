// `ctx.shares`: rendered previews shared as /s/:id snapshots (lib/share-store.js).
//
// /s/:id is public on purpose — recipients need no login — and only ever reads
// the snapshot store, never the file system. Snapshots inline their images, so
// /api/share takes bodies up to 16 MB (the store enforces its own cap).

import { join } from 'node:path';
import express from 'express';
import { ShareStore } from '../../lib/share-store.js';
import { createShareRouter } from '../../lib/api/share.js';

export const name = 'share';

export const inject = ['launch', 'http', 'timer'];

const SHARE_ID_RE = /^[A-Za-z0-9_-]{16,48}$/;
const SWEEP_MS = 10 * 60 * 1000;

function gone(res) {
  res.status(410).type('html').send(
    '<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>链接已失效</title>'
    + '<body style="margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;'
    + 'font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0d1117;color:#c9d1d9;text-align:center">'
    + '<div><div style="font-size:42px;margin-bottom:12px">🔗</div>'
    + '<h2 style="margin:0 0 6px">链接已过期或不存在</h2>'
    + '<p style="color:#8b949e;margin:0">分享可能已被回收或已超过有效期。</p></div></body>',
  );
}

export async function apply(ctx) {
  const store = new ShareStore(join(ctx.launch.configDir, 'shares.json'));
  await store.load();

  ctx.http.mount('/api/share', createShareRouter(store), { json: { limit: '16mb' } });

  const viewer = express.Router();
  viewer.get('/:id', async (req, res) => {
    try {
      const { id } = req.params;
      if (!SHARE_ID_RE.test(id)) return gone(res);
      const snapshot = await store.get(id);
      if (!snapshot) return gone(res);
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Referrer-Policy', 'no-referrer');
      res.set('Cache-Control', 'no-store');
      res.type('html').send(snapshot.html);
    } catch {
      res.status(500).type('html').send('<h1>500</h1>');
    }
    return undefined;
  });
  ctx.http.mount('/s', viewer, { json: false });

  ctx.interval(() => {
    store.sweep().catch(() => {});
  }, SWEEP_MS);
  ctx.provide('shares', store);
}
