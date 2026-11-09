// `ctx.node`: this installation as a Node — the pairing file a hub reads over
// SFTP, the node token that only opens this machine's own API, and
// GET /api/node/info (docs/architecture.md, "Hub 与 Node").
//
// `home` (the directory holding ~/.config/tmux-web-panel/node.json) exists so
// tests and smoke runs never overwrite the real pairing file.
//
// Optional components report themselves in the info through
// `setCapability(name, probe)` (e.g. mosh, moshClient); the caller wraps it
// in ctx.effect so the capability goes away with the plugin that set it.
//
// `/n/local/…` is this machine's own address: the prefix comes off here
// (order -60), before the hub relay, which handles every other server and may
// not be loaded at all.

import { homedir } from 'node:os';
import { rewriteLocalNodePath } from '../../lib/hub/proxy.js';
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
  /** capability name → probe returning { available, version, reason } */
  const capabilities = new Map();
  // The plugins this installation runs, so a hub's pages only call what is there.
  const plugins = () => {
    const loader = ctx.get('loader');
    return loader ? loader.status().filter((entry) => entry.state === 'active').map((entry) => entry.id) : null;
  };
  const info = async () => ({
    ...await collectNodeInfo({
      tmuxVersion: () => ctx.tmux.version(),
      mosh: capabilities.get('mosh') ?? null,
      moshClient: capabilities.get('moshClient') ?? null,
    }),
    plugins: plugins(),
  });
  const setCapability = (capability, probe) => {
    capabilities.set(capability, probe);
    return () => {
      if (capabilities.get(capability) === probe) capabilities.delete(capability);
    };
  };
  ctx.http.use((req, res, next) => {
    rewriteLocalNodePath(req);
    next();
  }, { order: -60 });
  ctx.http.useUpgrade(({ req }) => {
    rewriteLocalNodePath(req);
    return false;
  }, { order: -60 });

  const router = express.Router();
  router.get('/', handle(async () => info()));
  ctx.http.mount('/api/node/info', router);
  ctx.provide('node', Object.freeze({ ...identity, info, setCapability }));
}
