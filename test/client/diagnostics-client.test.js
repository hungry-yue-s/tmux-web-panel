import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { BLOCKS, WORKSPACE_BLOCKS } from '../helpers/blocks.js';

const source = readFileSync('plugins/diagnostics/client/js/diagnostics.js', 'utf8');
const apiSource = readFileSync('plugins/ui/client/js/api.js', 'utf8');
const traceSource = readFileSync('plugins/terminal/client/js/terminal-trace.js', 'utf8');
const blocksSource = BLOCKS;
const gitSource = WORKSPACE_BLOCKS;
const TARGET = 'cc-windows';
let dom;
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { dom?.window.close(); vi.clearAllTimers(); vi.useRealTimers(); });

async function setup({ active = true, lifetime = 60000, traceEnabled = false } = {}) {
  dom = new JSDOM('<!doctype html><body></body>', { url: 'https://panel.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  win.Date = Date;
  const began = Date.now();
  Object.defineProperty(win, 'performance', { value: { now: () => Date.now() - began } });
  let currentServer = TARGET;
  win.Auth = { headers: () => ({ Authorization: 'Bearer PRIVATE_TOKEN' }) };
  win.Api = { activeServerId: () => currentServer };
  win.TerminalTarget = { serverId: TARGET };
  win.eval(traceSource);
  if (traceEnabled) win.TerminalTrace.enable();
  const enable = vi.spyOn(win.TerminalTrace, 'enable');
  const disable = vi.spyOn(win.TerminalTrace, 'disable');
  const config = { active, id: 'capture-123', targetServerId: TARGET, expiresAt: new Date(Date.now() + lifetime).toISOString(), sampleIntervalMs: 5000 };
  const fetch = vi.fn(async (path) => {
    if (path === '/api/diagnostics/status') return { ok: true, json: async () => ({ success: true, data: config }) };
    return { ok: true, status: 200, json: async () => ({ success: true, data: {} }) };
  });
  win.fetch = fetch;
  win.eval(source);
  win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
  await vi.advanceTimersByTimeAsync(0);
  const batches = () => fetch.mock.calls.filter(([path]) => path === '/api/diagnostics/client').map(([, init]) => JSON.parse(init.body));
  const events = () => batches().flatMap((batch) => batch.events);
  return { win, diagnostic: win.Diagnostics, fetch, batches, events, enable, disable, config, setServer: value => { currentServer = value; } };
}

function terminal(win) {
  let render;
  const dispose = vi.fn();
  return {
    cols: 100, rows: 30,
    write: vi.fn((text, callback) => { if (callback) win.setTimeout(callback, 20); }),
    onRender: vi.fn(fn => { render = fn; return { dispose }; }),
    render: () => render?.(), dispose,
  };
}

describe('opt-in client diagnostics', () => {
  it('does no collection while off and leaves writes and tracing unchanged', async () => {
    const ctx = await setup({ active: false });
    const term = terminal(ctx.win);
    ctx.diagnostic.writeTerminal(term, 'PRIVATE_TERMINAL_TEXT', TARGET);
    ctx.diagnostic.record('client', { code: 'CLIENT_ERROR', count: 1 });
    expect(ctx.diagnostic.beginApi('GET', '/n/cc-windows/api/git/status?token=PRIVATE_TOKEN')).toBeNull();
    await vi.advanceTimersByTimeAsync(5000);
    expect(ctx.batches()).toEqual([]);
    expect(term.write.mock.calls).toEqual([['PRIVATE_TERMINAL_TEXT']]);
    expect(term.onRender).not.toHaveBeenCalled();
    expect(ctx.enable).not.toHaveBeenCalled();
  });

  it('measures API body time without retaining the path query, body, error text or auth', async () => {
    const ctx = await setup();
    ctx.fetch.mockImplementation(async path => {
      if (path === '/api/diagnostics/client') return { ok: true };
      await new Promise(resolve => ctx.win.setTimeout(resolve, 40));
      return {
        ok: true, status: 200,
        headers: { get: key => ({ 'Content-Length': '123', 'X-Anymux-Diagnostic-Id': 'node-id-123', 'X-Anymux-Hub-Diagnostic-Id': 'hub-id-123' })[key] ?? null },
        json: () => new Promise(resolve => ctx.win.setTimeout(() => resolve({ success: true, data: { root: '/PRIVATE_DIRECTORY', files: [] } }), 80)),
      };
    });
    ctx.win.eval(apiSource);
    const pending = ctx.win.Api.post('/n/cc-windows/api/git/status?path=/PRIVATE_DIRECTORY&token=PRIVATE_TOKEN', { secret: 'PRIVATE_BODY' });
    await vi.advanceTimersByTimeAsync(120);
    expect(await pending).toEqual({ root: '/PRIVATE_DIRECTORY', files: [] });
    await vi.advanceTimersByTimeAsync(4880);
    const api = ctx.events().find(event => event.kind === 'api');
    expect(api).toMatchObject({ path: '/api/git/status', method: 'POST', status: 200, code: 'OK', durationMs: 120, ttfbMs: 40, responseBytes: 123, requestId: 'node-id-123', parentRequestId: 'hub-id-123' });
    expect(ctx.fetch.mock.calls[1][1].headers['X-Anymux-Diagnostic-Id']).toBe(api.traceId);
    expect(JSON.stringify(ctx.batches())).not.toMatch(/PRIVATE_/);
  });

  it('distinguishes abort, timeout and server failure and excludes other targets/self requests', async () => {
    const ctx = await setup();
    for (const error of [
      { code: 'ABORTED', message: 'PRIVATE_ABORT' },
      { code: 'TIMEOUT' },
      { code: 'NETWORK_ERROR' },
      { status: 503, message: '/PRIVATE_PATH' },
      { message: 'not_a_git_repository' },
    ]) {
      ctx.diagnostic.beginApi('GET', '/n/cc-windows/api/git/status').finish(error);
    }
    expect(ctx.diagnostic.beginApi('GET', '/api/git/status')).toBeNull();
    expect(ctx.diagnostic.beginApi('GET', '/n/other/api/git/status')).toBeNull();
    expect(ctx.diagnostic.beginApi('POST', '/api/diagnostics/client')).toBeNull();
    await vi.advanceTimersByTimeAsync(5000);
    expect(ctx.events().filter(event => event.kind === 'api').map(event => event.code)).toEqual(['ABORTED', 'TIMEOUT', 'NETWORK_ERROR', 'SERVER_ERROR', 'NOT_REPO']);
    expect(JSON.stringify(ctx.batches())).not.toContain('PRIVATE');
  });

  it('keeps fixed Git and pane route attribution while removing every identifier and query', async () => {
    const ctx = await setup();
    const paths = ['git/file', 'git/raw', 'git/commit-files', 'git/commit-message', 'git/sync', 'windows/PRIVATE_WINDOW/panes', 'workspace/windows/PRIVATE_WINDOW/panes'];
    paths.forEach(path => ctx.diagnostic.beginApi('GET', '/n/cc-windows/api/' + path + '?file=PRIVATE_FILE&token=PRIVATE_TOKEN').finish());
    await vi.advanceTimersByTimeAsync(5000);
    expect(ctx.events().filter(event => event.kind === 'api').map(event => event.path)).toEqual([
      '/api/git/file', '/api/git/raw', '/api/git/commit-files', '/api/git/commit-message', '/api/git/sync', '/api/windows/:window/panes', '/api/workspace/windows/:window/panes',
    ]);
    expect(JSON.stringify(ctx.batches())).not.toContain('PRIVATE');
    const upload = ctx.fetch.mock.calls.find(([path]) => path === '/api/diagnostics/client');
    expect(upload[1].keepalive).toBe(false);
  });

  it('separates a Git API failure from an exception while rendering its successful response', async () => {
    const ctx = await setup();
    ctx.win.eval(blocksSource);
    const definitions = {};
    ctx.win.BlockHost = { register: (kind, definition) => { definitions[kind] = definition; }, render() {} };
    let fail = true;
    ctx.win.Blocks.ui.client = () => ({
      get: () => fail ? Promise.reject(Object.assign(new Error('PRIVATE_ERROR'), { status: 503 })) : Promise.resolve({ root: '/PRIVATE_REPO', branch: 'main', files: null }),
    });
    ctx.win.eval(gitSource);
    const api = new Proxy({ restored: false, params: { path: '/PRIVATE_REPO' }, serverId: TARGET }, { get: (target, key) => key in target ? target[key] : () => undefined });
    const failed = definitions.git.create(api);
    await vi.advanceTimersByTimeAsync(0);
    failed.dispose();
    fail = false;
    const brokenRender = definitions.git.create(api);
    await vi.advanceTimersByTimeAsync(0);
    brokenRender.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(ctx.events().filter(event => event.kind === 'git').map(event => event.code)).toEqual(['GIT_API_ERROR', 'GIT_RENDER_ERROR']);
    expect(JSON.stringify(ctx.batches())).not.toContain('PRIVATE');
  });

  it('bounds the queue and each upload, and drops failed uploads instead of retrying them', async () => {
    const ctx = await setup();
    for (let i = 0; i < 1000; i++) ctx.diagnostic.record('client', { code: 'CLIENT_ERROR', count: i, message: 'PRIVATE_ERROR', headers: { token: 'PRIVATE_TOKEN' } });
    ctx.fetch.mockImplementation(async () => { throw new Error('offline'); });
    await vi.advanceTimersByTimeAsync(5000);
    const first = ctx.batches()[0];
    expect(first.events).toHaveLength(100);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(100000);
    expect(first.events[0].count).toBeGreaterThan(600);
    await vi.advanceTimersByTimeAsync(10000);
    expect(ctx.batches().slice(1).flatMap(batch => batch.events).some(event => event.ts === first.events[0].ts && event.count === first.events[0].count)).toBe(false);
    expect(JSON.stringify(ctx.batches())).not.toContain('PRIVATE');
  });

  it('keeps the pagehide batch below the shared keepalive budget', async () => {
    const ctx = await setup();
    for (let i = 0; i < 100; i++) ctx.diagnostic.record('api', {
      path: '/api/workspace/windows/:window/panes', method: 'GET', code: 'OK',
      requestId: 'r'.repeat(64), parentRequestId: 'p'.repeat(64), traceId: 't'.repeat(64),
      durationMs: 1000000000000, ttfbMs: 1000000000000, responseBytes: 1000000000000,
      requestBytes: 1000000000000, frameCount: 1000000000000, inputBytes: 1000000000000,
      outputBytes: 1000000000000, bufferedAmount: 1000000000000, count: 1000000000000,
      queueMs: 1000000000000, parseMs: 1000000000000, renderMs: 1000000000000,
    });
    ctx.win.dispatchEvent(new ctx.win.Event('pagehide'));
    await vi.advanceTimersByTimeAsync(0);
    const upload = ctx.fetch.mock.calls.find(([path]) => path === '/api/diagnostics/client');
    expect(upload[1].keepalive).toBe(true);
    expect(Buffer.byteLength(upload[1].body)).toBeLessThanOrEqual(48000);
  });

  it.each([false, true])('expires and restores the prior trace state (previously enabled=%s)', async previous => {
    const ctx = await setup({ lifetime: 2000, traceEnabled: previous });
    const storage = ctx.win.localStorage.getItem('anymux_terminal_trace');
    expect(storage).toBe(previous ? '1' : null);
    if (!previous) expect(ctx.enable).toHaveBeenCalledWith({ persist: false });
    const span = ctx.diagnostic.beginGit(TARGET);
    await vi.advanceTimersByTimeAsync(2100);
    span({ code: 'GIT_RENDER_ERROR', message: 'PRIVATE_ERROR' });
    expect(ctx.diagnostic.enabled(TARGET)).toBe(false);
    expect(ctx.win.TerminalTrace.enabled()).toBe(previous);
    expect(ctx.win.localStorage.getItem('anymux_terminal_trace')).toBe(storage);
    expect(ctx.batches()).toEqual([]);
  });

  it('counts WS application bytes, preserves input, and uses one marker for a write burst', async () => {
    const ctx = await setup();
    const term = terminal(ctx.win);
    class Socket extends ctx.win.EventTarget {
      bufferedAmount = 7;
      sent = [];
      send(data) { this.sent.push(data); return 'sent'; }
    }
    const ws = new Socket();
    ctx.diagnostic.watchSocket(ws, term, TARGET);
    const input = JSON.stringify({ type: 'input', data: 'PRIVATE_INPUT中文' });
    expect(ws.send(input)).toBe('sent');
    const output = JSON.stringify({ type: 'output', data: 'PRIVATE_OUTPUT中文' });
    ws.dispatchEvent(new ctx.win.MessageEvent('message', { data: output }));
    for (let i = 0; i < 3; i++) ctx.diagnostic.writeTerminal(term, 'PRIVATE_OUTPUT中文', TARGET);
    expect(term.write.mock.calls).toEqual(Array.from({ length: 3 }, () => ['PRIVATE_OUTPUT中文']));
    await vi.advanceTimersByTimeAsync(30); term.render();
    await vi.advanceTimersByTimeAsync(4970);
    expect(term.write.mock.calls.filter(([text]) => text === '')).toHaveLength(1);
    const event = ctx.events().find(item => item.code === 'TERM_SAMPLE');
    expect(event).toMatchObject({ inputBytes: Buffer.byteLength(input), outputBytes: Buffer.byteLength(output), frameCount: 2, bufferedAmount: 7, cols: 100, rows: 30, renderMs: 30, parseMs: 20 });
    expect(ws.sent).toEqual([input]);
    expect(JSON.stringify(ctx.batches())).not.toMatch(/PRIVATE_/);
    ctx.diagnostic.releaseTerminal(term);
    ws.dispatchEvent(new ctx.win.MessageEvent('message', { data: output }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(term.onRender).toHaveBeenCalledOnce();
    expect(term.dispose).toHaveBeenCalledOnce();
  });

  it('the actual vendored parser produces no extra protocol reply from a batch marker', async () => {
    const ctx = await setup();
    ctx.win.HTMLCanvasElement.prototype.getContext = () => null;
    ctx.win.eval(readFileSync('plugins/terminal/client/vendor/xterm/xterm.js', 'utf8'));
    const term = new ctx.win.Terminal({ cols: 80, rows: 24 });
    const replies = [];
    term.onData(data => replies.push(data));
    ctx.diagnostic.writeTerminal(term, '\x1b[c', TARGET);
    await vi.advanceTimersByTimeAsync(200);
    expect(replies).toEqual(['\x1b[?1;2c']);
    ctx.diagnostic.releaseTerminal(term);
    term.dispose();
  });

  it('exports only navigation marks, with their occurrence time rather than upload time', async () => {
    const ctx = await setup();
    const began = Date.now();
    ctx.win.TerminalTrace.begin(TARGET + ' PRIVATE_WINDOW');
    ctx.win.TerminalTrace.mark('workspace', { secret: 'PRIVATE_DETAIL' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(ctx.events().find(event => event.kind === 'navigation')).toMatchObject({ code: 'NAV_WORKSPACE', durationMs: 0, ts: new Date(began).toISOString() });
    expect(JSON.stringify(ctx.batches())).not.toContain('PRIVATE');
  });

  it('records a visible-page event-loop delay without the Long Tasks API', async () => {
    const ctx = await setup();
    vi.setSystemTime(Date.now() + 400);
    await vi.advanceTimersByTimeAsync(5000);
    expect(ctx.events().find(event => event.code === 'CLIENT_STALL')).toMatchObject({ lagMs: 400 });
  });

  it('does not report hidden/resume timer throttling as a main-thread stall', async () => {
    const ctx = await setup();
    Object.defineProperty(ctx.win.document, 'visibilityState', { configurable: true, value: 'hidden' });
    ctx.win.document.dispatchEvent(new ctx.win.Event('visibilitychange'));
    vi.setSystemTime(Date.now() + 20000);
    Object.defineProperty(ctx.win.document, 'visibilityState', { configurable: true, value: 'visible' });
    ctx.win.document.dispatchEvent(new ctx.win.Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(ctx.events().some(event => event.code === 'CLIENT_STALL')).toBe(false);
  });
});
