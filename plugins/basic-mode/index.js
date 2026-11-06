// `ctx.basicMode`: servers reachable over SSH without the panel installed
// get a workspace and terminals from this hub (lib/hub/basic/, root CLAUDE.md
// 基础模式). Nothing else runs remotely: files, metrics and the rest come
// with installing a Node.
//
// Its terminals are local PTYs running ssh, so each spawn goes through
// trackConsoleSpawn like every other PTY. Unloading ends the hosted shells.

import pty from 'node-pty';
import { BasicHost } from '../../lib/hub/basic/basic-host.js';
import { createBasicHttp, createBasicUpgrade } from '../../lib/hub/basic/basic-routes.js';
import { trackConsoleSpawn } from '../../lib/terminal/console-reaper.js';
import { sshPtyBinary } from '../../lib/transport/ssh-connection.js';

export const name = 'basic-mode';

export const inject = ['http', 'hubLinks', 'terminals', 'timer'];

/** Hosted shells of a detached basic-mode host end after their TTL; checked this often. */
const REAP_MS = 60 * 1000;

function spawnBasicPty(argv, env, { cols, rows }) {
  return trackConsoleSpawn(() => pty.spawn(sshPtyBinary(), argv, {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    env: {
      ...process.env,
      ...env,
      LANG: process.env.LANG || 'C.UTF-8',
      LC_CTYPE: process.env.LC_CTYPE || process.env.LANG || 'C.UTF-8',
    },
  })).term;
}

export function apply(ctx) {
  const links = ctx.hubLinks;
  ctx.effect(() => () => links.closeBasic(), 'basic-mode.hosts');
  ctx.interval(() => {
    try {
      links.reapBasic();
    } catch {
      // The next tick retries.
    }
  }, REAP_MS);

  ctx.provide('basicMode', Object.freeze({
    createHost: (connection) => new BasicHost({ connection, spawnPty: spawnBasicPty }),
    http: createBasicHttp({ links }),
    upgrade: createBasicUpgrade({ links, wss: ctx.http.wss, terminalManager: ctx.terminals }),
  }));
}
