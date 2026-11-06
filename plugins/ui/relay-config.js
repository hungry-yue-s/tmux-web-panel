// The login page's relay link (scripts/setup-relay.sh) lives in
// plugins/ui/client/js/relay-config.js. Before the front end moved into the
// plugins, the script wrote public/js/relay-config.js; git ignores the file,
// so an installation updated since then still has it there and nothing at the
// new place, and its login page loses the relay link. Move it once.

import { existsSync, renameSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';

/** Moves <root>/public/js/relay-config.js to `target` unless `target` exists. */
export function moveLegacyRelayConfig(root, target) {
  const legacy = join(root, 'public', 'js', 'relay-config.js');
  if (!existsSync(legacy) || existsSync(target)) return false;
  renameSync(legacy, target);
  // Nothing else of public/ is left untracked; drop the directories once empty.
  for (const dir of [join(root, 'public', 'js'), join(root, 'public')]) {
    try {
      rmdirSync(dir);
    } catch {
      break;
    }
  }
  return true;
}
