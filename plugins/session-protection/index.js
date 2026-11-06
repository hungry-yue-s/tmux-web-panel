// Project-managed resources (the tmux build, skills, the base tmux config)
// and session protection: periodic tmux-resurrect saves and automatic
// restore of a new tmux server (root CLAUDE.md, "tmux server 守护与会话持久化").
//
// Session protection runs tmux-resurrect's scripts, which call plain `tmux`
// on the user's server. With a private server selected (tests, smoke runs)
// it does not start at all: it must never save or restore the user's
// sessions on behalf of a panel that is looking at another server.

import { join } from 'node:path';
import { ManagedResources } from '../../lib/managed-resources.js';
import { SessionProtection } from '../../lib/session-protection/service.js';
import { createManagedResourcesRouter } from '../../lib/api/managed-resources.js';
import { createSessionProtectionRouter } from '../../lib/api/session-protection.js';
import { IS_WINDOWS, TMUX_BIN, tmuxUserHome } from '../../lib/msys.js';
import { isPrivateServer } from '../../lib/tmux-server.js';
import { REPO_ROOT } from '../../lib/paths.js';

export const name = 'session-protection';

export const inject = ['launch', 'http', 'tmux'];

export async function apply(ctx) {
  const launch = ctx.launch;
  const userConfigPath = join(tmuxUserHome(), '.tmux.conf');

  const resources = new ManagedResources({
    projectDir: REPO_ROOT,
    configDir: launch.configDir,
    packaged: launch.managedRuntime,
    runtimePath: launch.runtimePath,
    userConfigPath,
    serverTmuxBin: IS_WINDOWS ? TMUX_BIN : null,
  });
  await resources.load();
  ctx.http.mount('/api/managed-resources', createManagedResourcesRouter(resources));
  ctx.provide('managedResources', resources);

  if (isPrivateServer()) {
    ctx.logger.warn('session protection is off: a private tmux server is selected');
    return;
  }

  const protection = new SessionProtection({
    configDir: launch.configDir,
    projectDir: REPO_ROOT,
    baseConfig: resources,
    userConfigPath,
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
