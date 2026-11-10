// `ctx.agentEvents`: what agent hooks report (/api/agent-events, written by
// scripts/agent-event-router.js from Claude, Codex and Qoder hooks): a pane's
// agent stopped, waits for permission or failed (lib/agent-events.js). The
// status monitor uses them for pane state; with the notifications plugin
// loaded they also become notices.

import { AgentEventService } from '../../lib/agent-events.js';
import { createAgentEventsRouter } from '../../lib/api/agent-events.js';

export const name = 'agent-events';

export const inject = ['http'];

export function apply(ctx) {
  const service = new AgentEventService();
  ctx.inject(['notifications'], (ctx) => {
    service.notificationStore = ctx.notifications;
    ctx.effect(() => () => {
      if (service.notificationStore === ctx.notifications) service.notificationStore = null;
    }, 'agent-events.notices');
  });
  ctx.http.mount('/api/agent-events', createAgentEventsRouter(service, {
    onNotifications: (notifications) => ctx.emit('status/notifications', notifications),
  }));
  ctx.provide('agentEvents', service);
}
