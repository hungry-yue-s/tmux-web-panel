import { createHash } from 'node:crypto';
import { hostname, homedir } from 'node:os';
import { join } from 'node:path';

export const name = 'workbench';
// Reuses terminal's xterm/font assets; unloading it removes this browser view.
export const inject = ['launch', 'client', 'terminals'];

export function apply(ctx) {
  const configDir = ctx.launch.configDir === join(homedir(), '.config', 'anymux')
    ? join(homedir(), '.config', 'tmux-web-panel') : ctx.launch.configDir;
  // Non-secret installation/account identity. Tokens rotate independently and
  // are deliberately never used as layout keys or written to layout storage.
  const storageScope = createHash('sha256').update([
    // Keep the original installation identity when Anymux migrates its directory.
    hostname(), configDir, ctx.launch.authCredentials?.username || 'local',
  ].join('\u0000')).digest('hex').slice(0, 24);
  ctx.client.entry(new URL('./client/index.js', import.meta.url), { storageScope });
  ctx.inject(['ui'], (ctx) => ctx.ui.contribute(new URL('./client/page.json', import.meta.url)));
}
