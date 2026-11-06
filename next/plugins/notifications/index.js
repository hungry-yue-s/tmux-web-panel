// `ctx.notifications`: completion notices kept on disk (lib/notifications.js)
// and `ctx.agentEvents`: agent hook events that become notifications.

import { join } from 'node:path';
import { NotificationStore } from '../../lib/notifications.js';
import { AgentEventService } from '../../lib/agent-events.js';
import { createNotificationsRouter } from '../../lib/api/notifications.js';
import { createAgentEventsRouter } from '../../lib/api/agent-events.js';

export const name = 'notifications';

export const inject = ['launch', 'http'];

export function apply(ctx) {
  const store = new NotificationStore(join(ctx.launch.configDir, 'notifications.json'));
  ctx.effect(() => {
    store.startReaper();
    return () => store.stopReaper();
  }, 'notifications.reaper');
  const agentEvents = new AgentEventService({ notificationStore: store });
  ctx.http.mount('/api/notifications', createNotificationsRouter(store));
  ctx.http.mount('/api/agent-events', createAgentEventsRouter(agentEvents, {
    onNotifications: (notifications) => ctx.emit('status/notifications', notifications),
  }));
  ctx.provide('notifications', store);
  ctx.provide('agentEvents', agentEvents);
  // The front end, where there are pages at all.
  ctx.inject(['ui'], (ctx) => ctx.ui.contribute(new URL('./client/page.json', import.meta.url)));
}
