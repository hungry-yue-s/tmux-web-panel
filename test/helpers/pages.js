// The pages as the browser gets them, for tests that inspect markup.
//
// The main page is composed from every plugin's page.json (see
// plugins/ui/compose.js); this is the same composition the ui plugin serves,
// before content hashes replace the ?v= markers.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { composePageSync, findContributions, readContribution } from '../../plugins/ui/compose.js';
import { ROOT } from '../../lib/paths.js';

let cached = null;

/**
 * Where a former public/ file lives now: plugins/<id>/client/<relative>
 * for whichever plugin owns it (relative to next/).
 */
export function clientPath(relative) {
  const plugins = join(ROOT, 'plugins');
  for (const id of readdirSync(plugins)) {
    const candidate = join('plugins', id, 'client', relative);
    if (existsSync(join(ROOT, candidate))) return candidate;
  }
  throw new Error(`no plugin serves ${relative}`);
}

/** The composed main page (index.html). */
export function indexSource() {
  if (cached === null) {
    const parts = findContributions(join(ROOT, 'plugins')).flatMap((file) => readContribution(file).parts);
    cached = composePageSync(readFileSync(join(ROOT, 'plugins', 'ui', 'client', 'index.html'), 'utf8'), parts);
  }
  return cached;
}
