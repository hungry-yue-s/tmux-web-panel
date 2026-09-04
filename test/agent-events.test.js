import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import { AgentEventService, agentEventDedupeKey, normalizeAgentEvent } from '../server/agent-events.js';
import { createAgentEventsRouter } from '../server/api/agent-events.js';

function makeStore() {
  return {
    notifications: [],
    add(entry) {
      const notification = { id: String(this.notifications.length + 1), ...entry };
      this.notifications.unshift(notification);
      return notification;
    },
  };
}

async function startApp(agentEvents, onNotifications) {
  const app = express();
  app.use(express.json());
  app.use('/api/agent-events', createAgentEventsRouter(agentEvents, { onNotifications }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: 'localhost', port, path: urlPath, method, headers: { 'content-type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null });
          } catch (err) { reject(err); }
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('agent event normalization', () => {
  it('maps qoder stop hook input to an agent-stopped event', () => {
    const event = normalizeAgentEvent({
      agent: 'qoder',
      hook_event_name: 'Stop',
      session_id: 's1',
      cwd: '/repo',
    });

    expect(event).toMatchObject({
      source: 'qoder',
      event: 'Stop',
      state: 'agent_stopped',
      sessionId: 's1',
      cwd: '/repo',
    });
  });

  it('dedupes stop hook and tmux bell for the same window', () => {
    let now = 1_000;
    const store = makeStore();
    const service = new AgentEventService({ notificationStore: store, now: () => now });

    const first = service.ingest({
      agent: 'qoder',
      event: 'Stop',
      session: 'main',
      windowIndex: 1,
      windowId: '@7',
    });
    const second = service.ingest({
      source: 'tmux',
      event: 'bell',
      session: 'main',
      windowIndex: 1,
      windowId: '@7',
    });

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(store.notifications).toHaveLength(1);

    now += 10_001;
    const third = service.ingest({
      source: 'tmux',
      event: 'bell',
      session: 'main',
      windowIndex: 1,
      windowId: '@7',
    });
    expect(third.duplicate).toBe(false);
    expect(store.notifications).toHaveLength(2);
  });

  it('uses state and location in dedupe keys rather than source', () => {
    expect(agentEventDedupeKey(normalizeAgentEvent({ agent: 'qoder', event: 'Stop', windowId: '@1' })))
      .toBe(agentEventDedupeKey(normalizeAgentEvent({ source: 'tmux', event: 'bell', windowId: '@1' })));
  });

  it('suppresses lower-priority process exit after session end at the same location', () => {
    const store = makeStore();
    const service = new AgentEventService({ notificationStore: store });

    const ended = service.ingest({ agent: 'qoder', event: 'SessionEnd', paneId: '%1' });
    const exited = service.ingest({ source: 'pty', event: 'process_exit', paneId: '%1' });

    expect(ended.duplicate).toBe(false);
    expect(exited.duplicate).toBe(true);
    expect(store.notifications).toHaveLength(1);
    expect(store.notifications[0].state).toBe('session_ended');
  });
});

describe('agent events API', () => {
  it('stores and broadcasts a waiting-attention event once', async () => {
    const store = makeStore();
    const broadcast = vi.fn();
    const agentEvents = new AgentEventService({ notificationStore: store });
    const { server, port } = await startApp(agentEvents, broadcast);

    try {
      const first = await request(port, 'POST', '/api/agent-events', {
        agent: 'qoder',
        event: 'PermissionRequest',
        session: 'main',
        windowIndex: 0,
        reason: 'Bash needs approval',
      });
      const second = await request(port, 'POST', '/api/agent-events', {
        agent: 'qoder',
        event: 'Notification',
        session: 'main',
        windowIndex: 0,
        reason: 'Bash needs approval',
      });

      expect(first.status).toBe(200);
      expect(first.body.data.duplicate).toBe(false);
      expect(second.body.data.duplicate).toBe(true);
      expect(store.notifications).toHaveLength(1);
      expect(store.notifications[0]).toMatchObject({
        type: 'agent-event',
        state: 'waiting_attention',
        source: 'qoder',
        session: 'main',
        windowIndex: 0,
        reason: 'Bash needs approval',
      });
      expect(broadcast).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
