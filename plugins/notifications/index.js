// `ctx.notifications`: completion notices kept on disk (lib/notifications.js),
// listed and cleared through /api/notifications. They come from the status
// monitor (a window finished) and from agent hooks (the agent-events plugin).

import { join } from 'node:path';
import { NotificationStore } from '../../lib/notifications.js';
import { createNotificationsRouter } from '../../lib/api/notifications.js';

export const name = 'notifications';

export const inject = ['launch', 'http'];

export function apply(ctx) {
  const store = new NotificationStore(join(ctx.launch.configDir, 'notifications.json'));
  ctx.effect(() => {
    store.startReaper();
    return () => store.stopReaper();
  }, 'notifications.reaper');
  ctx.http.mount('/api/notifications', createNotificationsRouter(store));
  ctx.provide('notifications', store);
  // The front end, where there are pages at all.
  ctx.inject(['ui'], (ctx) => ctx.ui.contribute(new URL('./client/page.json', import.meta.url)));
}
