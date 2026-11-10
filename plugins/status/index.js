// `ctx.status`: the /ws/status socket every open page keeps (lib/monitor.js).
//
// It polls tmux for completion and activity, and relays what other plugins
// announce as events:
//   status/workspace-changed (revision)   a workspace mutation
//   status/server-status (status)         a server's health changed
//   status/notifications (notifications)  new notices from agent events
//   status/event (event)                  anything else for open pages (`anymux open`)

import { StatusMonitor } from '../../lib/monitor.js';

export const name = 'status';

export const inject = ['launch', 'http'];

export function apply(ctx) {
  // Notices and agent hook state are optional: the socket carries workspace
  // changes and server health with or without them.
  const monitor = new StatusMonitor();
  ctx.inject(['notifications'], (ctx) => {
    ctx.effect(() => monitor.useNotificationStore(ctx.notifications), 'status.notifications');
  });
  ctx.inject(['agentEvents'], (ctx) => {
    ctx.effect(() => monitor.useAgentEvents(ctx.agentEvents), 'status.agent-events');
  });

  ctx.on('status/workspace-changed', (revision) => monitor.broadcastWorkspaceChanged(revision));
  ctx.on('status/server-status', (status) => monitor.broadcastServerStatus(status));
  ctx.on('status/notifications', (notifications) => monitor.broadcastNotifications(notifications));
  ctx.on('status/event', (event) => monitor.broadcastEvent(event));

  const sockets = new Set();
  ctx.http.websocket('/ws/status', ({ ws }) => {
    sockets.add(ws);
    monitor.subscribe(ws);
    ws.on('close', () => {
      sockets.delete(ws);
      monitor.unsubscribe(ws);
    });
  });

  ctx.effect(() => {
    monitor.start(ctx.launch.pollInterval);
    return () => {
      monitor.stop();
      for (const ws of sockets) ws.close(1001, 'Server shutting down');
    };
  }, 'status.monitor');

  ctx.provide('status', monitor);
}
