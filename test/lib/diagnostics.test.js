import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import express from 'express';
import compression from 'compression';
import request from 'supertest';
import { DiagnosticsCapture, normalizeDiagnosticPath, sanitizeDiagnosticFields, CAPTURE_DURATION_MS } from '../../lib/diagnostics.js';
import { createDiagnosticsRouter } from '../../lib/api/diagnostics.js';

const folders = [], captures = [];
async function capture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'anymux-diagnostics-'));
  folders.push(directory);
  const diagnostics = new DiagnosticsCapture(options).configure({ configDir: directory });
  captures.push(diagnostics);
  return { diagnostics, directory };
}
async function events(diagnostics) {
  const text = await readFile(diagnostics.capturePath(diagnostics.status().id), 'utf8');
  return text.trim().split('\n').filter(Boolean).map(JSON.parse);
}
afterEach(async () => {
  for (const diagnostics of captures.splice(0)) await diagnostics.stop();
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

describe('bounded diagnostic capture', () => {
  it('is off without disk activity, then stores only safe typed fields and the chosen target', async () => {
    const { diagnostics, directory } = await capture();
    expect(diagnostics.record('api', { durationMs: 1 })).toBe(false);
    expect(await readdir(directory)).toEqual([]);
    const status = await diagnostics.start({ targetServerId: 'cc-windows', groupId: 'capture_group_123' });
    expect(status).toMatchObject({ active: true, targetServerId: 'cc-windows', sampleIntervalMs: 5000 });
    expect(Date.parse(status.expiresAt) - Date.parse(status.startedAt)).toBe(CAPTURE_DURATION_MS);
    expect(() => diagnostics.acceptClient({ id: status.id, clientId: 12345678, events: [] })).toThrow('invalid_client_batch');
    diagnostics.record('api', { serverId: 'cc-windows', path: '/n/cc-windows/api/git/status?path=SECRET_FILE',
      durationMs: 12, message: 'SECRET_MESSAGE', headers: { authorization: 'SECRET_TOKEN' }, data: 'SECRET_TERMINAL' });
    expect(diagnostics.record('api', { serverId: 'another-server', durationMs: 100 })).toBe(false);
    expect(diagnostics.acceptClient({ id: status.id, clientId: 'client_123456', events: [
      { kind: 'git', code: 'GIT_LOAD_OK', durationMs: 14, path: '/api/git/status?token=SECRET_QUERY', payload: 'SECRET_BODY' },
      { kind: 'terminal', code: 'SECRET_MESSAGE', inputBytes: 3 },
    ] })).toEqual({ accepted: 2, dropped: 0 });
    await diagnostics.stop();
    const rows = await events(diagnostics);
    expect(rows.find((row) => row.kind === 'api')).toMatchObject({ durationMs: 12, path: '/api/git/status' });
    expect(rows.find((row) => row.kind === 'git')).toMatchObject({ code: 'GIT_LOAD_OK' });
    expect(rows.find((row) => row.kind === 'terminal')).not.toHaveProperty('code');
    expect(JSON.stringify(rows)).not.toContain('SECRET');
  });

  it('expires automatically and stops a platform sampler once, including a throwing stop', async () => {
    const { diagnostics, directory } = await capture();
    const stop = vi.fn(() => { throw new Error('secret stop detail'); });
    diagnostics.configure({ configDir: directory, platformSampler: () => stop });
    await diagnostics.start({ durationMs: 30 });
    await vi.waitFor(() => expect(diagnostics.status()).toMatchObject({ active: false, reason: 'expired' }));
    await diagnostics.stop();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('bounds the asynchronous queue including its in-flight write and preserves accepted order', async () => {
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    const lines = [];
    const file = { writeFile: vi.fn(async (line) => { await blocked; lines.push(line); }), close: vi.fn(async () => {}) };
    const { diagnostics } = await capture({ openFile: async () => file, maxQueueBytes: 1024 });
    await diagnostics.start();
    let count = 0;
    while (diagnostics.record('command', { count })) count += 1;
    expect(diagnostics.status()).toMatchObject({ active: false, reason: 'queue_limit', dropped: 1 });
    expect(diagnostics.status().queuedBytes).toBeLessThanOrEqual(1024);
    release();
    await diagnostics.stop();
    expect(lines.map(JSON.parse).filter((row) => row.kind === 'command').map((row) => row.count)).toEqual(Array.from({ length: count }, (_, i) => i));
    expect(file.close).toHaveBeenCalledOnce();
  });

  it('never exceeds its file budget and closes cleanly on disk failure', async () => {
    const { diagnostics } = await capture({ maxBytes: 1500 });
    await diagnostics.start();
    while (diagnostics.record('command', { durationMs: 1 })) { /* fill this small test budget */ }
    await diagnostics.stop();
    const data = await readFile(diagnostics.capturePath(diagnostics.status().id));
    expect(data.length).toBeLessThanOrEqual(1500);
    expect(diagnostics.status().reason).toBe('byte_limit');

    const close = vi.fn(async () => {});
    const failure = await capture({ openFile: async () => ({ writeFile: async () => { throw new Error('secret filesystem detail'); }, close }) });
    await failure.diagnostics.start();
    await vi.waitFor(() => expect(failure.diagnostics.status()).toMatchObject({ active: false, reason: 'write_error' }));
    await failure.diagnostics.stop();
    expect(close).toHaveBeenCalledOnce();
    expect(JSON.stringify(failure.diagnostics.status())).not.toContain('secret');
  });

  it('starts a new capture only after the prior file has drained', async () => {
    const { diagnostics } = await capture();
    const first = await diagnostics.start();
    await expect(diagnostics.start()).rejects.toMatchObject({ status: 409 });
    await diagnostics.stop();
    const second = await diagnostics.start();
    expect(second.id).not.toBe(first.id);
    await expect(diagnostics.start({ durationMs: CAPTURE_DURATION_MS + 1 })).rejects.toMatchObject({ status: 409 });
    await diagnostics.stop();
    await expect(diagnostics.start({ durationMs: CAPTURE_DURATION_MS + 1 })).rejects.toMatchObject({ status: 400 });
  });

  it('honors stop requested while the capture file is still opening', async () => {
    let opened;
    const ready = new Promise((resolve) => { opened = resolve; });
    const file = { writeFile: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    const { diagnostics } = await capture({ openFile: async () => { await ready; return file; } });
    const starting = diagnostics.start();
    const stopping = diagnostics.stop();
    opened();
    await Promise.all([starting, stopping]);
    expect(diagnostics.status()).toMatchObject({ active: false, reason: 'manual' });
    expect(file.close).toHaveBeenCalledOnce();
  });

  it('samples sockets registered before start without adding data listeners', async () => {
    const { diagnostics } = await capture();
    const socket = Object.assign(new EventEmitter(), { bytesRead: 10, bytesWritten: 20, writableLength: 0, readableLength: 0 });
    diagnostics.trackSocket(socket, { serverId: 'local', side: 'browser', connectionId: 'connection_123' });
    expect(socket.listenerCount('data')).toBe(0);
    await diagnostics.start();
    socket.bytesRead += 15; socket.bytesWritten += 40; socket.writableLength = 200;
    diagnostics._sample(diagnostics._session);
    socket.bytesWritten += 20; socket.emit('close', false);
    await diagnostics.stop();
    const rows = (await events(diagnostics)).filter((row) => row.kind === 'terminal');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ bytesRead: 15, bytesWritten: 40, writableLength: 200 });
    expect(rows[1]).toMatchObject({ phase: 'socket_close', bytesRead: 0, bytesWritten: 20 });
    expect(diagnostics._sockets.size).toBe(0);
  });
});

describe('HTTP and client boundaries', () => {
  it('counts compressed bytes and correlates across awaits without trusting an incoming request id', async () => {
    const { diagnostics } = await capture();
    await diagnostics.start();
    const app = express();
    app.use(diagnostics.middleware());
    app.use(compression());
    let context;
    app.get('/api/git/status', async (req, res) => {
      await new Promise((resolve) => setImmediate(resolve));
      context = diagnostics.currentContext();
      diagnostics.record('git', { operation: 'git:status' });
      res.json({ content: 'SECRET_RESPONSE'.repeat(10000) });
    });
    const response = await request(app).get('/api/git/status?path=SECRET_FILE')
      .set('X-Anymux-Diagnostic-Id', 'client_request_123').set('Accept-Encoding', 'gzip');
    expect(response.status).toBe(200);
    expect(response.headers['content-encoding']).toBe('gzip');
    expect(response.headers['x-anymux-diagnostic-id']).toBe(context.requestId);
    expect(context.requestId).not.toBe('client_request_123');
    expect(context.parentRequestId).toBe('client_request_123');
    await diagnostics.stop();
    const rows = await events(diagnostics);
    const http = rows.find((row) => row.kind === 'http');
    expect(http).toMatchObject({ requestId: context.requestId, parentRequestId: 'client_request_123', status: 200, aborted: false, path: '/api/git/status' });
    expect(http.responseBytes).toBeGreaterThan(0);
    expect(http.responseBytes).toBeLessThan(1000);
    expect(rows.find((row) => row.kind === 'git').requestId).toBe(context.requestId);
    expect(JSON.stringify(rows)).not.toContain('SECRET');
  });

  it('records a real client abort once without retaining the partially sent body', async () => {
    const { diagnostics } = await capture();
    await diagnostics.start();
    const app = express();
    app.use(diagnostics.middleware());
    let closed;
    const disconnected = new Promise((resolve) => { closed = resolve; });
    app.get('/api/git/status', (req, res) => {
      res.once('close', closed);
      res.write('SECRET_CHUNK');
    });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const client = http.get(`http://127.0.0.1:${server.address().port}/api/git/status`, (res) => {
        res.once('data', () => client.destroy());
      });
      client.on('error', () => {});
      await disconnected;
      await diagnostics.stop();
      const rows = (await events(diagnostics)).filter((row) => row.kind === 'http');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 200, aborted: true, responseBytes: 12 });
      expect(JSON.stringify(rows)).not.toContain('SECRET');
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('rejects oversized client batches, uses strict download ids and keeps control endpoints uncached', async () => {
    const { diagnostics, directory } = await capture();
    diagnostics.configure({ configDir: join(directory, '.config', 'anymux') });
    const app = express();
    app.use(express.json({ limit: '200kb' }));
    app.use('/api/diagnostics', createDiagnosticsRouter({ diagnostics }));
    const start = await request(app).post('/api/diagnostics/start').send({ durationMs: 10000 });
    expect(start.status).toBe(200);
    const id = start.body.data.id;
    const status = await request(app).get('/api/diagnostics/status');
    expect(status.headers['cache-control']).toBe('no-store');
    expect((await request(app).post('/api/diagnostics/client').send({ id, clientId: 'client_123', events: Array.from({ length: 101 }, () => ({ kind: 'api' })) })).status).toBe(400);
    expect((await request(app).post('/api/diagnostics/client').send({ id, clientId: 'client_123', events: [{ kind: 'api', payload: 'x'.repeat(103000) }] })).status).toBe(413);
    expect((await request(app).post('/api/diagnostics/stop').set('Origin', 'https://untrusted.invalid').send({})).status).toBe(403);
    expect((await request(app).get('/api/diagnostics/captures/not-a-capture')).status).toBe(400);
    await diagnostics.stop();
    const download = await request(app).get('/api/diagnostics/captures/' + id);
    expect(download.status).toBe(200);
    expect(download.headers['content-disposition']).toContain(id + '.jsonl');
  });

  it('keeps only recognized process basenames and stable opaque adapter identities', () => {
    const first = sanitizeDiagnosticFields({ interfaces: [{ name: 'SECRET_ADAPTER', receivedBytes: 123 }],
      processes: [{ name: 'node', pid: 10, rssBytes: 100, CommandLine: 'SECRET_TOKEN' }, { name: '/private/user/application', pid: 11 }],
      processGroups: [{ name: 'conhost', count: 100 }], errors: ['cpu_unavailable'] });
    const second = sanitizeDiagnosticFields({ interfaces: [{ name: 'other' }, { name: 'SECRET_ADAPTER', receivedBytes: 456 }] });
    expect(first.interfaces[0].id).toBe(second.interfaces[1].id);
    expect(first.processes).toEqual([{ name: 'node', pid: 10, rssBytes: 100 }]);
    expect(JSON.stringify(first)).not.toContain('SECRET');
    expect(normalizeDiagnosticPath('/n/cc-windows/api/workspace/sessions/SECRET/windows')).toBe('/api/workspace/sessions/:session/windows');
    expect(normalizeDiagnosticPath('/n/cc-windows/api/workspace/sessions/SECRET')).toBe('/api/workspace/sessions');
    expect(normalizeDiagnosticPath('/n/cc-windows/api/workspace/windows/@8/layout')).toBe('/api/workspace/windows/:window/layout');
    expect(normalizeDiagnosticPath('/n/cc-windows/api/workspace/panes/%253/capture')).toBe('/api/workspace/panes/:pane/:operation');
    expect(normalizeDiagnosticPath('/n/cc-windows/api/node/info')).toBe('/api/node/info');
  });
});
