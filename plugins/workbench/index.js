import { createHash } from 'node:crypto';
import { hostname } from 'node:os';

export const name = 'workbench';
export const inject = ['launch', 'client'];

export function apply(ctx) {
  // Non-secret installation/account identity. Tokens rotate independently and
  // are deliberately never used as layout keys or written to layout storage.
  const storageScope = createHash('sha256').update([
    hostname(), ctx.launch.configDir, ctx.launch.authCredentials?.username || 'local',
  ].join('\u0000')).digest('hex').slice(0, 24);
  ctx.client.entry(new URL('./client/index.js', import.meta.url), { storageScope });
  ctx.inject(['ui'], (ctx) => ctx.ui.contribute(new URL('./client/page.json', import.meta.url)));
}
