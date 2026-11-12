import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { NativeWindowPool } from '../../lib/terminal/native-window-pool.js';

const target = { instanceId: '99:100', sessionId: '$1', windowId: '@2', clientId: 'c-browser-tab-1', cols: 80, rows: 24 };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(read) { for (let i = 0; i < 30; i++) { const value = read(); if (value) return value; await tick(); } throw new Error('state did not settle'); }
function fixture(options = {}) {
  const natives = [], controls = [];
  const state = { failQueryOnce: options.failQueryOnce, context: '99:100|42|/dev/pts/9|$1|@2|%3|80|24', meta: { protocol: 1, instanceId: '99:100', clientPid: 42, sessionId: '$1', windowId: '@2', paneId: '%3', cols: 80, rows: 24 } };
  class Native extends EventEmitter {
    constructor(args) { super(); this.args = args; this.ready = Promise.resolve({ protocol: 1, pid: 42, tty: '/dev/pts/9' }); this.inputs = []; this.resizes = []; this.disposed = false; this.captures = 0; }
    input(data) { this.inputs.push(Buffer.from(data)); return true; }
    resize(cols, rows) { this.resizes.push([cols, rows]); return true; }
    capture(nonce, onSnapshot) { this.captures++; return new Promise((resolve, reject) => { this.pending = { nonce, onSnapshot, resolve, reject }; }); }
    complete() { const p = this.pending; this.pending = null; if (!p) throw new Error('capture was not registered first'); const snapshot = { meta: { ...state.meta }, data: Buffer.from('NATIVE SCREEN') }; try { p.onSnapshot(snapshot); p.resolve(snapshot); this.emit('output', Buffer.from('LIVE')); } catch (error) { p.reject(error); } }
    cancelCapture(error) { if (this.pending) { this.pending.reject(error); this.pending = null; } }
    dispose() { this.disposed = true; if (this.pending) { this.pending.reject(new Error('disposed')); this.pending = null; } }
  }
  class Control extends EventEmitter {
    constructor(args) { super(); this.args = args; this.commands = []; this.disposed = false; }
    async command(line) { this.commands.push(line); await options.beforeCommand?.(line); if (line.startsWith('display-message')) return Buffer.from('99:100|' + this.args.sessionId); if (line.startsWith('list-clients')) { if (state.failQueryOnce) { state.failQueryOnce = false; throw new Error('temporary query failure'); } return Buffer.from(state.context); } if (line.includes(' -Q ')) { options.onRefresh?.({ natives, state }); if (!options.holdCapture) natives[0].complete(); } return Buffer.from(''); }
    dispose() { this.disposed = true; }
  }
  const tmux = { run: vi.fn(async args => args[0] === 'list-windows' ? '99:100|$1|@2\n' : args[0] === 'list-clients' ? state.context : '1') };
  const pool = new NativeWindowPool({ tmux, args: ['-S', '/private/test-socket'], createNative: args => { const native = new Native(args); natives.push(native); return native; }, createControl: args => { const control = new Control(args); controls.push(control); return control; }, pollMs: 60_000, ...options });
  return { pool, tmux, state, natives, controls };
}
const pools = [];
function tracked(options) { const f = fixture(options); pools.push(f.pool); return f; }
afterEach(() => { for (const pool of pools.splice(0)) pool.dispose(); vi.useRealTimers(); });

describe('persistent native tmux window clients', () => {
  it.each(['detached', 'session_ended'])('waits for the native %s reason when client disappearance is observed first', async reason => {
    const f = tracked(), frames = [];
    await f.pool.subscribe(target, frame => frames.push(frame)); await until(() => frames.some(frame => frame.type === 'snapshot'));
    f.state.context = ''; f.controls[0].emit('notification', '%client-detached /dev/pts/9');
    await tick(); await tick();
    expect(f.natives[0].disposed).toBe(false);
    expect(frames.some(frame => frame.type === 'exit')).toBe(false);
    f.natives[0].emit('exit', { code: 0, signal: null, reason });
    expect(frames.at(-1)).toMatchObject({ type: 'exit', reason });
    expect(f.natives[0].disposed).toBe(true);
  });

  it('bounds the wait for a missing native client without inventing task completion', async () => {
    const f = tracked({ timeoutMs: 40 }), frames = [];
    await f.pool.subscribe(target, frame => frames.push(frame)); await until(() => frames.some(frame => frame.type === 'snapshot'));
    vi.useFakeTimers();
    f.state.context = ''; f.controls[0].emit('notification', '%client-detached /dev/pts/9');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.natives[0].disposed).toBe(false);
    await vi.advanceTimersByTimeAsync(40);
    expect(frames.at(-1)).toMatchObject({ type: 'exit', reason: 'tmux_client_exit' });
    expect(f.natives[0].disposed).toBe(true);
  });
  it('registers the atomic fence before refresh and sequences snapshot/live bytes once', async () => {
    const f = tracked(), frames = [];
    const lease = await f.pool.subscribe(target, frame => frames.push(frame));
    await until(() => frames.some(frame => frame.type === 'output'));
    expect(frames.map(frame => frame.type)).toEqual(['ready', 'snapshot', 'output']);
    expect(frames[1]).toMatchObject({ seq: 0, instanceId: '99:100', windowId: '@2', paneId: '%3', encoding: 'base64' });
    expect(frames[2]).toMatchObject({ seq: 1, data: Buffer.from('LIVE').toString('base64') });
    expect(f.natives[0].args).toMatchObject(target);
    expect(f.controls[0].commands).toContain('refresh-client -f no-output');
    expect(lease.input(Buffer.from([0, 0xff, 0x02, 0x5b]))).toBe(true);
    expect(f.natives[0].inputs).toEqual([Buffer.from([0, 0xff, 0x02, 0x5b])]);
    lease.close();
  });

  it('unsubscribes without killing tasks and reconnects the same native client with a fresh fence', async () => {
    const f = tracked(), first = [], second = [];
    const lease = await f.pool.subscribe(target, frame => first.push(frame)); await until(() => first.some(frame => frame.type === 'snapshot'));
    lease.close(); f.natives[0].emit('output', Buffer.from('WHILE OFFLINE'));
    expect(f.natives[0].disposed).toBe(false); expect(f.controls[0].disposed).toBe(false);
    const resumed = await f.pool.subscribe(target, frame => second.push(frame)); await until(() => second.some(frame => frame.type === 'snapshot'));
    expect(f.natives).toHaveLength(1); expect(f.natives[0].captures).toBe(2);
    expect(second.filter(frame => frame.type === 'snapshot').map(frame => frame.seq)).toEqual([0]);
    expect(second.filter(frame => frame.type === 'output').map(frame => frame.seq)).toEqual([1]);
    expect(first.filter(frame => frame.type === 'output')).toHaveLength(1);
    resumed.close();
  });

  it('finishes an abandoned checkpoint without closing a reconnecting owner', async () => {
    const f = tracked({ holdCapture: true }), oldFrames = [], newFrames = [];
    const first = await f.pool.subscribe(target, frame => oldFrames.push(frame)); await until(() => f.natives[0]?.pending);
    first.close();
    const resumed = await f.pool.subscribe(target, frame => newFrames.push(frame));
    f.natives[0].complete();
    await until(() => f.natives[0].captures === 2);
    f.natives[0].complete(); await until(() => newFrames.some(frame => frame.type === 'snapshot'));
    expect(f.natives).toHaveLength(1); expect(f.natives[0].disposed).toBe(false);
    expect(oldFrames.some(frame => frame.type === 'snapshot')).toBe(false);
    expect(newFrames.find(frame => frame.type === 'snapshot').seq).toBe(0); resumed.close();
  });

  it('reconnects by native client identity after the URL window has been removed', async () => {
    const f = tracked(), firstFrames = [], nextFrames = [];
    const first = await f.pool.subscribe(target, frame => firstFrames.push(frame)); await until(() => firstFrames.some(frame => frame.type === 'snapshot'));
    first.close();
    f.state.context = '99:100|42|/dev/pts/9|$8|@9|%12|80|24';
    Object.assign(f.state.meta, { sessionId: '$8', windowId: '@9', paneId: '%12' });
    f.tmux.run = async () => { throw new Error('the original URL session no longer exists'); };
    const second = await f.pool.subscribe(target, frame => nextFrames.push(frame)); await until(() => nextFrames.some(frame => frame.type === 'snapshot'));
    expect(nextFrames[0]).toMatchObject({ protocol: 1, sessionId: '$8', windowId: '@9' });
    expect(nextFrames.find(frame => frame.type === 'snapshot')).toMatchObject({ protocol: 1, sessionId: '$8', windowId: '@9' });
    expect(f.natives).toHaveLength(1); second.close();
  });

  it('resizes only the existing native PTY and does not snapshot again or repeat an equal grid', async () => {
    const f = tracked(), frames = [];
    const lease = await f.pool.subscribe(target, frame => frames.push(frame)); await until(() => frames.some(frame => frame.type === 'snapshot'));
    expect(lease.resize(100, 30)).toBe(true); expect(lease.resize(100, 30)).toBe(false);
    lease.visibility(false); lease.visibility(true);
    expect(f.natives[0].resizes).toEqual([[100, 30]]); expect(f.natives[0].captures).toBe(1);
    expect(f.natives).toHaveLength(1); lease.close();
  });

  it('sends bootstrap and accepts terminal responses before hydration while user input stays locked', async () => {
    const f = tracked({ holdCapture: true }), frames = [];
    const lease = await f.pool.subscribe(target, frame => frames.push(frame));
    expect(lease.input(Buffer.from('USER'))).toBe(false);
    lease.response(Buffer.from('\x1b[?1;2c'));
    await until(() => f.natives[0]?.pending);
    f.natives[0].emit('output', Buffer.from('\x1b[c'));
    expect(frames.at(-1)).toMatchObject({ type: 'bootstrap', data: Buffer.from('\x1b[c').toString('base64') });
    expect(f.natives[0].inputs).toEqual([Buffer.from('\x1b[?1;2c')]);
    f.natives[0].complete(); await tick();
    expect(lease.input(Buffer.from('NOW'))).toBe(true); lease.close();
  });

  it('rejects duplicate concurrent subscriptions and expires only its own idle attachments', async () => {
    const f = tracked({ idleMs: 10 }), frames = [];
    const lease = await f.pool.subscribe(target, frame => frames.push(frame)); await until(() => frames.some(frame => frame.type === 'snapshot'));
    await expect(f.pool.subscribe(target, () => {})).rejects.toMatchObject({ code: 'TERMINAL_BUSY' });
    lease.close(); await new Promise(resolve => setTimeout(resolve, 25));
    expect(f.natives[0].disposed).toBe(true); expect(f.controls[0].disposed).toBe(true);
    expect(f.tmux.run.mock.calls.flat().some(args => args.includes('kill-pane') || args.includes('kill-session'))).toBe(false);
  });

  it('tracks actual native focus changes without capturing or rebuilding the client', async () => {
    const f = tracked(), frames = [];
    const lease = await f.pool.subscribe(target, frame => frames.push(frame)); await until(() => frames.some(frame => frame.type === 'snapshot'));
    f.state.context = '99:100|42|/dev/pts/9|$1|@8|%12|80|24'; f.controls[0].emit('notification', '%window-pane-changed @8 %12');
    await until(() => frames.some(frame => frame.type === 'context'));
    expect(frames.at(-1)).toMatchObject({ type: 'context', windowId: '@8', paneId: '%12' });
    const count = frames.length; f.controls[0].emit('notification', '%window-pane-changed @8 %12'); await tick(); await tick();
    expect(frames).toHaveLength(count); expect(f.natives[0].captures).toBe(1); lease.close();
  });

  it('answers a fresh context request even when polling has not observed native focus yet', async () => {
    const f = tracked(), frames = [];
    const lease = await f.pool.subscribe(target, frame => frames.push(frame)); await until(() => frames.some(frame => frame.type === 'snapshot'));
    f.state.context = '99:100|42|/dev/pts/9|$8|@9|%12|80|24';
    await expect(lease.context('focus-request-1')).resolves.toMatchObject({ sessionId: '$8', windowId: '@9', paneId: '%12' });
    expect(frames.at(-1)).toMatchObject({ type: 'context', protocol: 1, requestId: 'focus-request-1', windowId: '@9', paneId: '%12' });
    const count = frames.length; lease.close();
    await expect(lease.context('late-request')).rejects.toMatchObject({ code: 'WORKSPACE_UNAVAILABLE' }); expect(frames).toHaveLength(count);
  });

  it('rejects stale instances before spawn and never emits an unverified native snapshot', async () => {
    const f = tracked(), frames = [], ended = [];
    await expect(f.pool.subscribe({ ...target, instanceId: '88:99' }, () => {})).rejects.toMatchObject({ code: 'WORKSPACE_UNAVAILABLE' });
    expect(f.natives).toHaveLength(0);
    f.state.meta.instanceId = '88:99';
    await f.pool.subscribe(target, frame => frames.push(frame), { end: error => ended.push(error) });
    await until(() => ended.length);
    expect(frames.some(frame => frame.type === 'ready' || frame.type === 'snapshot')).toBe(false);
    expect(f.natives[0].disposed).toBe(true); expect(f.controls[0].disposed).toBe(true);
  });

  it('drops a failed subscriber without poisoning the native client or the next checkpoint', async () => {
    const f = tracked({ holdCapture: true }); let failSend = false; const ended = [];
    const lease = await f.pool.subscribe(target, () => { if (failSend) throw new Error('slow socket'); }, { end: (...args) => ended.push(args) });
    await until(() => f.natives[0]?.pending); failSend = true;
    expect(() => f.natives[0].complete()).not.toThrow(); await tick();
    expect(lease.closed).toBe(true); expect(f.natives[0].disposed).toBe(false); expect(ended).toHaveLength(1);
    const frames = [], resumed = await f.pool.subscribe(target, frame => frames.push(frame));
    await until(() => f.natives[0].pending); f.natives[0].complete(); await tick();
    expect(frames.find(frame => frame.type === 'snapshot').seq).toBe(0);
    expect(f.natives).toHaveLength(1); expect(f.natives[0].disposed).toBe(false);
    resumed.close();
  });

  it('settles startup work when disposed while waiting for the native identity to appear', async () => {
    const f = tracked(); f.state.context = '';
    await f.pool.subscribe(target, () => {});
    await until(() => f.pool.entries.get(target.clientId)?.retryTimer);
    const pending = f.pool.entries.get(target.clientId).start.catch(error => error);
    f.pool.dispose();
    const result = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve('unsettled'), 100))]);
    expect(result).not.toBe('unsettled'); expect(result.code).toBe('WORKSPACE_UNAVAILABLE');
  });

  it('recovers a sidecar after its original session dies without ending the native client', async () => {
    const f = tracked(), frames = [];
    const lease = await f.pool.subscribe(target, frame => frames.push(frame)); await until(() => frames.some(frame => frame.type === 'snapshot'));
    f.state.context = '99:100|42|/dev/pts/9|$8|@9|%12|80|24';
    Object.assign(f.state.meta, { sessionId: '$8', windowId: '@9', paneId: '%12' });
    f.controls[0].emit('closed', new Error('original session was destroyed'));
    await until(() => f.controls.length === 2);
    expect(f.natives[0].disposed).toBe(false); expect(lease.closed).toBe(false);
    await expect(lease.context('after-recovery')).resolves.toMatchObject({ sessionId: '$8', windowId: '@9' });
    expect(f.controls[1].args.sessionId).toBe('$8'); expect(f.controls[1].commands).toContain('refresh-client -f no-output');
    lease.close(); const next = [];
    const resumed = await f.pool.subscribe(target, frame => next.push(frame)); await until(() => next.some(frame => frame.type === 'snapshot'));
    expect(f.natives).toHaveLength(1); resumed.close();
  });

  it('retries verification on the same native client after a temporary startup query failure', async () => {
    const f = tracked({ failQueryOnce: true }), ended = [];
    await f.pool.subscribe(target, () => {}, { end: error => ended.push(error) }); await until(() => ended.length);
    expect(f.natives[0].disposed).toBe(false);
    const frames = [], lease = await f.pool.subscribe(target, frame => frames.push(frame)); await until(() => frames.some(frame => frame.type === 'snapshot'));
    expect(f.natives).toHaveLength(1); expect(frames.find(frame => frame.type === 'snapshot').seq).toBe(0); lease.close();
  });

  it('cancels an auxiliary checkpoint failure without disposing the native child', async () => {
    const f = tracked({ holdCapture: true }), ended = [];
    const first = await f.pool.subscribe(target, () => {}, { end: error => ended.push(error) }); await until(() => f.natives[0]?.pending);
    f.controls[0].emit('closed', new Error('sidecar ended'));
    await until(() => first.closed && f.controls.length === 2);
    expect(f.natives[0].disposed).toBe(false); expect(f.natives[0].pending).toBe(null); expect(ended).toHaveLength(1);
    const frames = [], second = await f.pool.subscribe(target, frame => frames.push(frame));
    await until(() => f.natives[0].pending); f.natives[0].complete(); await tick();
    expect(frames.find(frame => frame.type === 'snapshot').seq).toBe(0); expect(f.natives).toHaveLength(1); second.close();
  });

  it('bounds concurrent fresh context requests and discards replies for a disconnected owner', async () => {
    const f = tracked(), frames = [];
    const lease = await f.pool.subscribe(target, frame => frames.push(frame)); await until(() => frames.some(frame => frame.type === 'snapshot'));
    const pending = [], command = f.controls[0].command.bind(f.controls[0]);
    f.controls[0].command = line => line.startsWith('list-clients') ? new Promise(resolve => pending.push(resolve)) : command(line);
    const requests = Array.from({ length: 8 }, (_, i) => lease.context('context-' + i).catch(error => error));
    await until(() => pending.length === 8);
    await expect(lease.context('overflow')).rejects.toMatchObject({ code: 'CONNECTION_LIMIT' });
    const count = frames.length; lease.close(); for (const resolve of pending) resolve(Buffer.from(f.state.context));
    expect((await Promise.all(requests)).every(error => error.code === 'WORKSPACE_UNAVAILABLE')).toBe(true);
    expect(frames).toHaveLength(count);
  });

  it.each(['display-message', 'refresh-client -f no-output'])('does not attach after the subscriber leaves during %s', async command => {
    let release;
    const f = tracked({ beforeCommand: line => line.startsWith(command) ? new Promise(resolve => { release = resolve; }) : undefined });
    const lease = await f.pool.subscribe(target, () => {});
    await until(() => release);
    lease.close(); release(); await tick(); await tick();
    expect(f.natives).toHaveLength(0);
    expect(f.controls[0].disposed).toBe(true);
    expect(f.pool.entries.size).toBe(0);
  });

  it('checks cancellation again before starting the native process', async () => {
    let release, cancelled = false;
    const f = tracked({ beforeCommand: line => line.startsWith('display-message') ? new Promise(resolve => { release = resolve; }) : undefined });
    await f.pool.subscribe(target, () => {}, { cancelled: () => cancelled });
    cancelled = true; release(); await tick(); await tick();
    expect(f.natives).toHaveLength(0);
    expect(f.controls[0].disposed).toBe(true);
  });

  it('allows a new subscriber while an abandoned startup is settling', async () => {
    let release, held = false;
    const f = tracked({ beforeCommand: line => {
      if (!held && line.startsWith('display-message')) { held = true; return new Promise(resolve => { release = resolve; }); }
    } });
    const old = await f.pool.subscribe(target, () => {}); old.close();
    const frames = [], resumed = await f.pool.subscribe(target, frame => frames.push(frame));
    release(); await until(() => frames.some(frame => frame.type === 'snapshot'));
    expect(f.natives).toHaveLength(1); expect(resumed.closed).toBe(false);
  });

  it('guards cancelled or disposed asynchronous preflights before opening attachments', async () => {
    const f = tracked(); let complete; let cancelled = false;
    f.tmux.run = () => new Promise(resolve => { complete = resolve; });
    const connecting = f.pool.subscribe(target, () => {}, { cancelled: () => cancelled });
    cancelled = true; complete('99:100|$1|@2');
    await expect(connecting).rejects.toMatchObject({ code: 'WORKSPACE_UNAVAILABLE' });
    expect(f.natives).toHaveLength(0);
    const pending = f.pool.subscribe(target, () => {}); f.pool.dispose(); complete('99:100|$1|@2');
    await expect(pending).rejects.toMatchObject({ code: 'WORKSPACE_UNAVAILABLE' }); expect(f.controls).toHaveLength(0);
  });

  it('requires native protocol support and bounds the persistent pool', async () => {
    const f = tracked({ maxEntries: 1 }), frames = [];
    expect(await f.pool.capability()).toMatchObject({ available: true, protocol: 1, mode: 'native-window' });
    const lease = await f.pool.subscribe(target, frame => frames.push(frame)); await until(() => frames.some(frame => frame.type === 'snapshot'));
    await expect(f.pool.subscribe({ ...target, clientId: 'second-tab' }, () => {})).rejects.toMatchObject({ code: 'CONNECTION_LIMIT' });
    await expect(f.pool.subscribe({ ...target, clientId: 'bad\nclient' }, () => {})).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    lease.close();
  });
});
