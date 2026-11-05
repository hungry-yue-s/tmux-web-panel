// Where things live. next/ sits inside the repository during the migration:
// shared assets that are not JavaScript modules — scripts/ (service, remote
// install, Windows sampler), vendor/tmux-plugins/, plugins/ (tmux-agent),
// skills/ and the version in package.json — stay at the repository root.
// TWP_REPO_ROOT overrides it (a packaged runtime lays files out differently).

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The next/ directory. */
export const NEXT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The repository (or packaged app) root that holds the shared assets. */
export const REPO_ROOT = process.env.TWP_REPO_ROOT ? resolve(process.env.TWP_REPO_ROOT) : resolve(NEXT_ROOT, '..');

export function repoPath(...parts) {
  return resolve(REPO_ROOT, ...parts);
}
