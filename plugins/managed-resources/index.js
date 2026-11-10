// `ctx.managedResources`: what the project manages on this machine
// (/api/managed-resources, lib/managed-resources.js): the tmux built from the
// vendor/tmux submodule, the agent skills linked into ~/.claude and ~/.codex,
// and the base tmux configuration session protection applies.
//
// Skill links installed before the tmux-agent skill moved to catalog/ point at
// nothing; they are repointed at start-up. Only links into this checkout count
// as the panel's, and never with a private tmux server (a test or smoke run).

import { join } from 'node:path';
import { ManagedResources } from '../../lib/managed-resources.js';
import { createManagedResourcesRouter } from '../../lib/api/managed-resources.js';
import { IS_WINDOWS, TMUX_BIN, tmuxUserHome } from '../../lib/msys.js';
import { isPrivateServer } from '../../lib/tmux-server.js';
import { REPO_ROOT } from '../../lib/paths.js';

export const name = 'managed-resources';

export const inject = ['launch', 'http', 'tmux'];

export async function apply(ctx) {
  const launch = ctx.launch;
  const resources = new ManagedResources({
    projectDir: REPO_ROOT,
    configDir: launch.configDir,
    packaged: launch.managedRuntime,
    runtimePath: launch.runtimePath,
    userConfigPath: join(tmuxUserHome(), '.tmux.conf'),
    serverTmuxBin: IS_WINDOWS ? TMUX_BIN : null,
  });
  await resources.load();
  ctx.http.mount('/api/managed-resources', createManagedResourcesRouter(resources));
  ctx.provide('managedResources', resources);
  // Its panels in the management centre, where there are pages at all.
  ctx.inject(['ui'], (ctx) => ctx.ui.contribute(new URL('./client/page.json', import.meta.url)));

  if (isPrivateServer()) return;
  try {
    for (const path of await resources.relinkMovedSkills()) ctx.logger.info('relinked moved skill %s', path);
  } catch (error) {
    ctx.logger.warn('could not relink moved skills: %s', error.message);
  }
}
