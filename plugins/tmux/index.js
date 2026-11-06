// `ctx.tmux`: this machine's tmux (lib/tmux.js), and the choice of server.
//
// `socket` (tmux -L) or `socketPath` (tmux -S) selects a private server for
// tests and smoke runs; every tmux the panel starts then carries it (see
// lib/tmux-server.js). Without them the panel uses the user's server, as it
// always has. The panel never starts a tmux server (root CLAUDE.md).

import { localTmux } from '../../lib/tmux.js';
import { isPrivateServer, selectTmuxServer, tmuxServerArgs } from '../../lib/tmux-server.js';

export const name = 'tmux';

/** @param {{ socket?: string, socketPath?: string }} [config] */
export function apply(ctx, config) {
  ctx.effect(() => selectTmuxServer({ socket: config?.socket, socketPath: config?.socketPath }), 'tmux.server');
  if (isPrivateServer()) ctx.logger.info('using a private tmux server: tmux %s', tmuxServerArgs().join(' '));
  // Pane labels render in the border title line. Best effort: there may be
  // no server yet, and the panel does not start one.
  localTmux.ensurePaneBorderConfig().catch(() => {});
  ctx.provide('tmux', localTmux);
}
