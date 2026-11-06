// `ctx.pins`: pinned windows, by window id, kept across restarts (lib/pins.js).

import { join } from 'node:path';
import { PinStore } from '../../lib/pins.js';
import { createPinsRouter } from '../../lib/api/pins.js';

export const name = 'pins';

export const inject = ['launch', 'http', 'tmux'];

export async function apply(ctx) {
  const store = new PinStore(join(ctx.launch.configDir, 'pins.json'));
  await store.load();
  // Drop pins of windows that no longer exist. Best effort: tmux may be down.
  try {
    await store.sweep(await ctx.tmux.listAllWindowIds());
  } catch {
    // The next start sweeps again.
  }
  ctx.http.mount('/api/pins', createPinsRouter(store));
  ctx.provide('pins', store);
}
