import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { apply } from '../../plugins/control-terminal/index.js';

function setup() {
  const app = express(), cleanups = [], capabilities = new Map();
  const calls = [], sockets = new Map();
  const ctx = {
    launch: { configDir: '/unused-control-test' },
    tmux: { run: async args => { calls.push(args); return ''; } },
    workspace: { getWorkspace: async () => ({ instanceId: '1:2', complete: true, sessions: [] }) },
    http: { websocket: (path, handler) => sockets.set(path, handler), mount: (prefix, router) => app.use(prefix, express.json(), router) },
    node: { setCapability: (name, probe) => { capabilities.set(name, probe); return () => capabilities.delete(name); } },
    effect: effect => { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); },
    provide: (name, service) => { ctx[name] = service; },
  };
  apply(ctx);
  return { app, calls, ctx, sockets, capabilities, dispose: () => cleanups.reverse().forEach(fn => fn()) };
}
describe('control terminal plugin HTTP boundary', () => {
  it('advertises native snapshot unavailability and never creates anything on a cross-origin write or unsupported target', async () => {
    const { app, capabilities, calls, dispose } = setup();
    try {
      const capability = await request(app).get('/api/workbench/capability').expect(200);
      expect(capability.body.data).toMatchObject({ available: false, protocol: 1, reason: 'native_snapshot_required' });
      const blocked = await request(app).post('/api/workbench/panes').set('Origin', 'https://other.example').send({}).expect(403);
      expect(blocked.body.error.code).toBe('FORBIDDEN_ORIGIN');
      await request(app).post('/api/workbench/panes').send({ instanceId: '1:2', sessionId: '$1', requestId: 'request-1234', cols: 80, rows: 24 }).expect(409);
      expect(calls.every(call => call[0] === 'display-message')).toBe(true);
      expect(capabilities.has('controlTerminal')).toBe(true);
    } finally { dispose(); }
    expect(capabilities.has('controlTerminal')).toBe(false);
  });
  it('lists an empty but complete workspace without synthesizing sessions', async () => {
    const { app, calls, dispose } = setup();
    try {
      const response = await request(app).get('/api/workbench/panes').expect(200);
      expect(response.body.data).toEqual({ instanceId: '1:2', complete: true, panes: [] });
      expect(calls).toEqual([]);
    } finally { dispose(); }
  });
  it('gates native creation and disposes both native and raw providers on plugin removal', async () => {
    const { app, ctx, sockets, capabilities, dispose } = setup();
    const nativeDispose = vi.spyOn(ctx.controlTerminals.nativePool, 'dispose');
    const rawDispose = vi.spyOn(ctx.controlTerminals.pool, 'dispose');
    try {
      expect([...sockets.keys()]).toEqual(['/ws/pane-stream/*', '/ws/native-window/*']);
      const capability = await request(app).get('/api/workbench/native-capability').expect(200);
      expect(capability.body.data).toMatchObject({ available: false, protocol: 1, mode: 'native-window', reason: 'native_client_required' });
      expect(capabilities.has('nativeWindow')).toBe(true);
      await request(app).post('/api/workbench/windows').set('Origin', 'https://other.example').send({}).expect(403);
      await request(app).post('/api/workbench/windows').send({ instanceId: '1:2', sessionId: '$1', requestId: 'request-5678', cols: 80, rows: 24 }).expect(409);
    } finally { dispose(); }
    expect(capabilities.size).toBe(0);
    expect(nativeDispose).toHaveBeenCalledOnce();
    expect(rawDispose).toHaveBeenCalledOnce();
  });
});
