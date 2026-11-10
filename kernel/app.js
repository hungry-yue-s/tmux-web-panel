// One running panel: a root context, and the loader that mounts the profile.

import { Context } from 'cordis';
import { Loader } from './loader.js';
import { resolveEntries } from './profile.js';
import { appDir } from '../lib/legacy-names.js';

/**
 * Where the user's own layer lives: <home>/patch.yml, next to the panel's
 * other settings (ANYMUX_CONFIG_DIR moves both; ANYMUX_HOME only the patch).
 */
export function defaultHome(env = process.env) {
  return env.ANYMUX_HOME || env.ANYMUX_CONFIG_DIR || appDir('config');
}

/**
 * The profile when none is named: a Node-only installation (NODE_ONLY=1, set
 * by the service installers) runs `node`, everything else `panel`.
 */
export function defaultProfile(env = process.env) {
  return env.NODE_ONLY === '1' ? 'node' : 'panel';
}

/**
 * Assembles and starts an application.
 * Resolves once every entry has loaded, failed, or is waiting for a service no
 * entry provides; `loader.status()` tells which.
 */
export async function createApp({ profile = defaultProfile(), patches = [], home = defaultHome(), importer } = {}) {
  const assembled = await resolveEntries({ profile, patches, home });
  const ctx = new Context();
  const fiber = ctx.plugin(Loader, { entries: assembled.entries, importer });
  await fiber;
  const loader = ctx.get('loader');
  let stopping = null;
  return {
    ctx,
    loader,
    assembled,
    /** Disposes every plugin, in reverse order of what they registered. */
    stop() {
      stopping ??= fiber.dispose();
      return stopping;
    },
  };
}
