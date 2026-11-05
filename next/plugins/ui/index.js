// The pages: index, login and the standalone terminal, with every local
// script, stylesheet and font URL pinned to a content hash (lib/static-assets.js).
// Pages always revalidate; hashed assets are cached for a year. Mounted last
// (order 1000), so every API is tried first; the site itself is public — the
// pages send the user to /login.html when the API answers 401.

import express from 'express';
import { createStaticAssets } from '../../lib/static-assets.js';
import { repoPath } from '../../lib/paths.js';

export const name = 'ui';

export const inject = ['launch', 'http'];

/** @param {{ publicDir?: string }} [config] */
export function apply(ctx, config) {
  const launch = ctx.launch;
  if (launch.managedRuntime) {
    const relay = express.Router();
    relay.get('/', (_req, res) => {
      res.type('application/javascript').set('Cache-Control', 'no-store')
        .send(`window.PANEL_RELAY_PAGE = ${JSON.stringify(launch.relayPage)};\n`);
    });
    ctx.http.mount('/js/relay-config.js', relay, { json: false });
  }
  ctx.http.mount('/', createStaticAssets(config?.publicDir ?? repoPath('public')), { json: false, order: 1000 });
}
