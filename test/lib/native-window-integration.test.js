/** Opt-in native window integration: every command uses this test's private socket. */
import { describe, it, expect } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import headless from '@xterm/headless';
import { NativeWindowPool } from '../../lib/terminal/native-window-pool.js';
import { NativeWindowProcess } from '../../lib/terminal/native-window-process.js';
import { ControlProcess } from '../../lib/terminal/control-process.js';
import { cleanupPrivateTmux, parsePrivateTmuxIdentity, PRIVATE_TMUX_IDENTITY_FORMAT } from '../helpers/private-tmux.js';

const binary = process.env.TMUX_NATIVE_CLIENT_TEST_BIN;
const exec = promisify(execFile), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, accept = Boolean) { const end = Date.now() + 10_000; while (Date.now() < end) { const value = await read(); if (accept(value)) return value; await sleep(10); } throw new Error('Native window condition timed out'); }
function visible(term) { const b = term.buffer.active; return { x: b.cursorX, y: b.cursorY, type: b.type, lines: Array.from({ length: term.rows }, (_, y) => b.getLine(b.baseY + y)?.translateToString(true)) }; }
async function fixture() {
  const env = { ...process.env, TERM: 'xterm-256color', LC_ALL: 'en_US.UTF-8' }; delete env.TMUX; delete env.TMUX_PANE;
  const dir = await realpath(await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'twp-native-window-'))), socket = join(dir, 'socket');
  const run = async args => (await exec(binary, ['-S', socket, ...args], { env, encoding: 'utf8', timeout: 15_000, maxBuffer: 16 * 1024 * 1024 })).stdout;
  const config = join(dir, 'tmux.conf'), worker = join(dir, 'worker.cjs');
  await writeFile(config, "set -g status-left NATIVE-STATUS\nset -g status-left-length 40\nset -g status-right ''\nset -g pane-border-status top\nset -g pane-border-format 'NATIVE-BORDER #{pane_id}'\nset -g mouse on\nbind x split-window -h\n");
  await writeFile(worker, "process.stdout.write(Array.from({length:70},(_,i)=>'LINE'+i).join('\\r\\n')+'\\r\\nREADY');setInterval(()=>{},1000);");
  await run(['-f', config, 'new-session', '-d', '-s', 'native-window-test', '-x', '80', '-y', '24', process.execPath, worker]);
  const readIdentity = async () => parsePrivateTmuxIdentity(await run(['display-message', '-p', PRIVATE_TMUX_IDENTITY_FORMAT]), socket), identity = await readIdentity();
  const [instanceId, sessionId, windowId, paneId] = (await run(['display-message', '-p', '#{pid}:#{start_time}|#{session_id}|#{window_id}|#{pane_id}'])).trim().split('|');
  await until(() => run(['capture-pane', '-p', '-t', paneId]), text => text.includes('READY'));
  const pool = new NativeWindowPool({ tmux: { run }, args: ['-S', socket], env, pollMs: 30,
    createNative: options => new NativeWindowProcess({ ...options, binary }),
    createControl: options => new ControlProcess({ ...options, spawn: (_file, args, opts) => spawn(binary, args, opts) }) });
  const terms = [];
  async function connect(clientId = 'integration-native-client', extra = {}) {
    const term = new headless.Terminal({ cols: 80, rows: 24, allowProposedApi: true }); terms.push(term);
    const frames = [], errors = [], early = []; let lease, render = Promise.resolve();
    term.onData(data => { if (lease) lease.response(Buffer.from(data)); else early.push(Buffer.from(data)); });
    const send = frame => {
      frames.push(frame);
      if (['bootstrap', 'snapshot', 'output'].includes(frame.type)) render = render.then(() => new Promise(resolve => {
        if (frame.type === 'snapshot') { term.resize(frame.cols, frame.rows); term.reset(); }
        term.write(Buffer.from(frame.data, 'base64'), resolve);
      }));
    };
    lease = await pool.subscribe({ instanceId, sessionId, windowId, clientId, cols: 80, rows: 24, ...extra }, send, { end: error => errors.push(error) });
    for (const bytes of early) lease.response(bytes);
    await until(() => { if (errors.length) throw errors[0]; return frames.some(frame => frame.type === 'snapshot'); });
    await render;
    return { term, lease, frames, render: () => render, errors };
  }
  return { run, pool, identity, instanceId, sessionId, windowId, paneId, connect,
    cleanup: async error => { pool.dispose(); for (const term of terms) term.dispose(); await sleep(100); await cleanupPrivateTmux({ dir, socket, identity, readIdentity, killServer: () => run(['kill-server']), primaryError: error }); } };
}

describe.skipIf(!binary || !existsSync(binary) || process.platform === 'win32')('persistent native window pool integration', () => {
  it('routes native prefix bindings and resizes one existing client without additional snapshots', async () => {
    const f = await fixture(); let error;
    try {
      const view = await f.connect();
      const nativeClients = async () => (await f.run(['list-clients', '-F', '#{client_pid}|#{client_tty}|#{client_width}|#{client_height}'])).trim().split('\n').filter(line => line.includes('|/dev/'));
      const before = await nativeClients(); expect(before).toHaveLength(1); const pid = before[0].split('|')[0];
      expect(view.lease.input(Buffer.from('\x02x'))).toBe(true);
      await until(() => f.run(['list-panes', '-t', f.windowId, '-F', '#{pane_id}']), text => text.trim().split('\n').length === 2);
      expect(view.lease.resize(100, 30)).toBe(true); expect(view.lease.resize(100, 30)).toBe(false);
      await until(nativeClients, clients => clients.length === 1 && clients[0] === `${pid}|${before[0].split('|')[1]}|100|30`);
      expect(view.frames.filter(frame => frame.type === 'snapshot')).toHaveLength(1);
      expect(Number((await f.run(['display-message', '-p', '#{pid}'])).trim())).toBe(f.identity.pid);
      view.lease.close();
    } catch (caught) { error = caught; throw caught; } finally { await f.cleanup(error); }
  }, 20_000);

  it('reconnects to the same copy-mode client and restores borders, status and mode state', async () => {
    const f = await fixture(); let error;
    try {
      const first = await f.connect(); first.lease.input(Buffer.from('\x02['));
      await until(() => f.run(['display-message', '-p', '-t', f.paneId, '#{pane_in_mode}']), text => text.trim() === '1');
      await sleep(100); await first.render(); const previous = visible(first.term);
      const clients = await f.run(['list-clients', '-F', '#{client_pid}|#{client_tty}']);
      first.lease.close(); await sleep(50);
      expect(await f.run(['list-clients', '-F', '#{client_pid}|#{client_tty}'])).toBe(clients);
      const resumed = await f.connect();
      expect(visible(resumed.term)).toEqual(previous);
      expect(visible(resumed.term).lines.join('\n')).toContain('NATIVE-STATUS');
      expect(visible(resumed.term).lines.join('\n')).toContain('NATIVE-BORDER');
      expect(resumed.term.modes.bracketedPasteMode).toBe(true);
      expect(resumed.frames.find(frame => frame.type === 'snapshot').seq).toBe(0);
      expect(await f.run(['list-clients', '-F', '#{client_pid}|#{client_tty}'])).toBe(clients);
      resumed.lease.close();
    } catch (caught) { error = caught; throw caught; } finally { await f.cleanup(error); }
  }, 20_000);

  it('survives switching session and immediately destroying the sidecar original session', async () => {
    const f = await fixture(); let error;
    try {
      const first = await f.connect(), pid = f.pool.entries.get('integration-native-client').hello.pid;
      const other = (await f.run(['new-session', '-d', '-P', '-F', '#{session_id}', '-s', 'sibling'])).trim();
      await f.run(['bind-key', 'n', 'switch-client', '-t', other]); first.lease.input(Buffer.from('\x02n'));
      await until(() => f.run(['list-clients', '-F', '#{client_pid}|#{session_id}']), text => text.includes(`${pid}|${other}`));
      await f.run(['kill-session', '-t', f.sessionId]);
      await until(() => f.pool.entries.get('integration-native-client')?.control);
      expect((await first.lease.context('after-session-destroy')).sessionId).toBe(other);
      expect(f.pool.entries.get('integration-native-client').hello.pid).toBe(pid);
      first.lease.close(); const resumed = await f.connect();
      expect(resumed.frames.find(frame => frame.type === 'ready').sessionId).toBe(other);
      expect(f.pool.entries.get('integration-native-client').hello.pid).toBe(pid); resumed.lease.close();
    } catch (caught) { error = caught; throw caught; } finally { await f.cleanup(error); }
  }, 20_000);

  it('keeps native linked-window support and reports the active pane after native focus changes', async () => {
    const f = await fixture(); let error;
    try {
      await f.run(['new-session', '-d', '-s', 'linked-session']);
      await f.run(['link-window', '-s', `${f.sessionId}:${f.windowId}`, '-t', 'linked-session:1']);
      const view = await f.connect(); view.lease.input(Buffer.from('\x02x'));
      const panes = await until(() => f.run(['list-panes', '-t', f.windowId, '-F', '#{pane_id}|#{pane_active}']), text => text.trim().split('\n').length === 2);
      const active = panes.trim().split('\n').find(line => line.endsWith('|1')).split('|')[0];
      await until(() => view.frames.find(frame => frame.type === 'context' && frame.paneId === active));
      expect(view.frames.filter(frame => frame.type === 'snapshot')).toHaveLength(1); view.lease.close();
    } catch (caught) { error = caught; throw caught; } finally { await f.cleanup(error); }
  }, 20_000);
});
