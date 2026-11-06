// Where things live. Shared assets that are not JavaScript modules —
// scripts/ (service, remote install, Windows sampler), vendor/tmux-plugins/,
// catalog/ (reviewed panel plugins such as tmux-agent), skills/ and the
// version in package.json — are found from here, never from the current
// directory. TWP_REPO_ROOT overrides it (a packaged runtime lays files out
// differently).

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The directory holding kernel/, plugins/, lib/ and client/. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The root that holds the shared assets; the same directory unless overridden. */
export const REPO_ROOT = process.env.TWP_REPO_ROOT ? resolve(process.env.TWP_REPO_ROOT) : ROOT;

export function repoPath(...parts) {
  return resolve(REPO_ROOT, ...parts);
}
