// Whether the packages the panel imports are installed.
//
// Every entry of package.json's `dependencies` must have its package.json
// under node_modules/. The kernel itself is one of them (vendor/cordis, linked
// by `npm install`), so a checkout updated without `npm install` stops here
// with what to run instead of a module resolution stack trace. Only Node's
// built-in modules are used: this runs before anything else is imported.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The names in package.json's dependencies that node_modules/ lacks. */
export function missingDependencies(root = APP_ROOT) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  return Object.keys(manifest.dependencies ?? {})
    .filter((name) => !existsSync(join(root, 'node_modules', ...name.split('/'), 'package.json')));
}

export function missingDependenciesMessage(missing, root = APP_ROOT) {
  return `missing dependencies: ${missing.join(', ')}\n`
    + `run "npm install" in ${root}, then start the panel again`;
}
