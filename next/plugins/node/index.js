// `ctx.node`: this installation as a Node — the pairing file a hub reads over
// SFTP, the node token that only opens this machine's own API, and
// GET /api/node/info (docs/architecture.md, "Hub 与 Node").
//
// `home` (the directory holding ~/.config/tmux-web-panel/node.json) exists so
// tests and smoke runs never overwrite the real pairing file.

import { homedir } from 'node:os';
import { initNodeIdentity } from '../../lib/node/identity.js';
import { collectNodeInfo } from '../../lib/node/info.js';
import { handle } from '../../lib/servers/errors.js';
import express from 'express';

export const name = 'node';

export const inject = ['launch', 'http', 'tmux'];

/** @param {{ home?: string }} [config] */
export async function apply(ctx, config) {
  const launch = ctx.launch;
  const identity = await initNodeIdentity({
    configDir: launch.configDir,
    port: launch.port,
    listenHost: launch.host,
    tlsCertPath: launch.tls ? launch.tls.cert : null,
    home: config?.home || homedir(),
  });
  const info = () => collectNodeInfo({ tmuxVersion: () => ctx.tmux.version() });
  const router = express.Router();
  router.get('/', handle(async () => info()));
  ctx.http.mount('/api/node/info', router);
  ctx.provide('node', Object.freeze({ ...identity, info }));
}
