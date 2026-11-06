// Session protection (/api/session-protection, lib/session-protection/):
// periodic tmux-resurrect saves and the automatic restore of a new tmux
// server (root CLAUDE.md, "tmux server 守护与会话持久化"), with the base
// tmux configuration from managed-resources.
//
// It runs tmux-resurrect's scripts, which call plain `tmux` on the user's
// server. With a private server selected (tests, smoke runs) it does not
// start at all: it must never save or restore the user's sessions on behalf
// of a panel that is looking at another server.

import { join } from 'node:path';
import { SessionProtection } from '../../lib/session-protection/service.js';
import { createSessionProtectionRouter } from '../../lib/api/session-protection.js';
import { tmuxUserHome } from '../../lib/msys.js';
import { isPrivateServer } from '../../lib/tmux-server.js';
import { REPO_ROOT } from '../../lib/paths.js';

export const name = 'session-protection';

export const inject = ['launch', 'http', 'tmux', 'managedResources'];

export async function apply(ctx) {
  if (isPrivateServer()) {
    ctx.logger.warn('session protection is off: a private tmux server is selected');
    return;
  }
  const protection = new SessionProtection({
    configDir: ctx.launch.configDir,
    projectDir: REPO_ROOT,
    baseConfig: ctx.managedResources,
    userConfigPath: join(tmuxUserHome(), '.tmux.conf'),
  });
  await protection.load();
  ctx.effect(() => {
    protection.start();
    return () => protection.stop();
  }, 'session-protection.loop');
  ctx.http.mount('/api/session-protection', createSessionProtectionRouter({ protection }));
  ctx.provide('sessionProtection', protection);
  // The front end, where there are pages at all.
  ctx.inject(['ui'], (ctx) => ctx.ui.contribute(new URL('./client/page.json', import.meta.url)));
}
