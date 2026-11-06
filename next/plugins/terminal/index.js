// `ctx.terminals`: browser terminals attached to tmux panes (lib/terminal.js,
// lib/terminal/gateway.js). Every Windows contract in the root CLAUDE.md —
// one client change at a time, held input, the console reaper, taking over
// without waiting for onExit — lives in TerminalManager unchanged.
//
// /ws/terminal/:paneId: the gateway resolves the pane through the workspace
// before anything attaches, and never throws; a bad address closes only that
// socket.

import { diagnostics } from '../../lib/diagnostics.js';
import { TerminalManager } from '../../lib/terminal.js';
import { TerminalGateway } from '../../lib/terminal/gateway.js';

export const name = 'terminal';

export const inject = ['launch', 'http', 'workspace'];

export function apply(ctx) {
  const manager = new TerminalManager({ maxConnectionsPerPane: ctx.launch.maxConnections });
  const gateway = new TerminalGateway({ workspace: ctx.workspace, terminalManager: manager });

  ctx.http.websocket('/ws/terminal/*', ({ ws, url }) => {
    diagnostics.record('terminal', { serverId: 'local', phase: 'upgraded', compressed: ws.extensions.includes('permessage-deflate') });
    gateway.handle(ws, url.pathname, url.searchParams).catch(() => {
      try {
        ws.close(1011, 'terminal setup failed');
      } catch {
        // Socket already gone.
      }
    });
  });

  ctx.effect(() => {
    manager.startReaper();
    return () => {
      manager.stopReaper();
      manager.destroyAll();
    };
  }, 'terminal.manager');

  ctx.provide('terminals', manager);
  // The front end, where there are pages at all.
  ctx.inject(['ui'], (ctx) => ctx.ui.contribute(new URL('./client/page.json', import.meta.url)));
}
