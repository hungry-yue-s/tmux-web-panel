/** Opt-in native tests. Every command names an owned private socket, never the user's server. */
import { describe, it, expect } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTmuxApi } from '../../lib/tmux.js';
import { WorkspaceService } from '../../lib/workspace/service.js';
import { ControlProcess } from '../../lib/terminal/control-process.js';
import { ControlPool } from '../../lib/terminal/control-pool.js';
import { WorkbenchService } from '../../lib/terminal/control-service.js';
import { cleanupPrivateTmux, parsePrivateTmuxIdentity, PRIVATE_TMUX_IDENTITY_FORMAT } from '../helpers/private-tmux.js';

const binary = process.env.TWP_CONTROL_TEST_TMUX;
const exec = promisify(execFile);
const env = { ...process.env };
delete env.TMUX; delete env.TMUX_PANE;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, predicate, limit = 8000) {
  const began = Date.now();
  while (Date.now() - began < limit) { const value = await read(); if (predicate(value)) return value; await sleep(10); }
  throw Error('Private control integration condition timed out');
}
async function fixture(program, { border = 'off' } = {}) {
  const dir = await realpath(await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'twp-control-')));
  const socket = join(dir, 'sock');
  const run = async args => (await exec(binary, ['-S', socket, ...args], { env, timeout: 8000, maxBuffer: 16 * 1024 * 1024 })).stdout;
  const script = join(dir, 'program.cjs');
  await writeFile(script, program);
  const config = join(dir, 'tmux.conf');
  await writeFile(config, `set -g history-limit 6000\nset -g pane-border-status ${border}\n`);
  await run(['-f', config, 'new-session', '-d', '-s', 'control-integration', '-x', '80', '-y', '24', process.execPath, script]);
  const readIdentity = async () => parsePrivateTmuxIdentity(await run(['display-message', '-p', PRIVATE_TMUX_IDENTITY_FORMAT]), socket);
  const identity = await readIdentity();
  const tmux = createTmuxApi({ id: 'private-control-test', tmuxBin: binary, transport: 'local', exec: async (file, args) => ({ stdout: await run(args), stderr: '' }) });
  const workspace = new WorkspaceService({ tmux });
  const instanceId = (await run(['display-message', '-p', '#{pid}:#{start_time}'])).trim();
  const [sessionId, windowId, paneId] = (await run(['display-message', '-p', '#{session_id}|#{window_id}|#{pane_id}'])).trim().split('|');
  const pool = new ControlPool({ tmux, workspace, args: ['-S', socket], env, createControl: options => new ControlProcess({ ...options, spawn: (file, args, opts) => spawn(binary, args, opts) }) });
  return { dir, run, pool, tmux, workspace, target: { instanceId, sessionId, windowId, paneId },
    cleanup: async primaryError => { pool.dispose(); await cleanupPrivateTmux({ dir, socket, identity, readIdentity, killServer: () => run(['kill-server']), primaryError }); } };
}

describe.skipIf(!binary || !existsSync(binary) || process.platform === 'win32')('native control pane stream integration', () => {
  it('cuts a continuously running pane into an exact snapshot/live sequence and reconnects without stopping it', async () => {
    const f = await fixture("let i=0; setInterval(()=>process.stdout.write('TICK:'+String(++i).padStart(6,'0')+'\\r\\n'),3);");
    let error;
    try {
      await until(() => f.run(['capture-pane', '-p', '-t', f.target.paneId]), text => text.includes('TICK:000010'));
      const first = [];
      const lease = await f.pool.subscribe(f.target, frame => first.push(frame));
      await until(() => first.filter(frame => frame.type === 'output').map(frame => Buffer.from(frame.data, 'base64').toString()).join(''), text => (text.match(/TICK:\d{6}/g) || []).length >= 20);
      const snapshot = first.find(frame => frame.type === 'snapshot');
      const snapshotText = Buffer.from(snapshot.data, 'base64').toString();
      const snapshotTicks = [...snapshotText.matchAll(/TICK:(\d{6})/g)].map(match => Number(match[1]));
      expect(snapshotTicks.length).toBeGreaterThan(0);
      const live = Buffer.concat(first.filter(frame => frame.type === 'output').map(frame => Buffer.from(frame.data, 'base64'))).toString();
      const ticks = [...live.matchAll(/TICK:(\d{6})/g)].map(match => Number(match[1]));
      expect(ticks[0]).toBe(Math.max(...snapshotTicks) + 1);
      for (let i = 1; i < ticks.length; i++) expect(ticks[i]).toBe(ticks[i - 1] + 1);
      lease.close();
      await sleep(50);
      const second = [];
      const resumed = await f.pool.subscribe(f.target, frame => second.push(frame));
      expect(second[0]).toMatchObject({ type: 'ready', paneId: f.target.paneId });
      expect(second[1]).toMatchObject({ type: 'snapshot', seq: 0 });
      const resumedTicks = [...Buffer.from(second[1].data, 'base64').toString().matchAll(/TICK:(\d{6})/g)].map(match => Number(match[1]));
      expect(Math.max(...resumedTicks)).toBeGreaterThan(ticks.at(-1));
      resumed.close();
      expect((await f.run(['list-panes', '-t', f.target.paneId, '-F', '#{pane_dead}'])).trim()).toBe('0');
    } catch (failure) { error = failure; throw failure; } finally { await f.cleanup(error); }
  }, 20_000);

  it('restores alternate buffer, cursor and input modes on a new view and leaves existing layout unchanged', async () => {
    const f = await fixture("process.stdout.write('NORMAL\\x1b[?1049h\\x1b[?25l\\x1b[?1002h\\x1b[?1006h\\x1b[?2004h\\x1b[?1h\\x1b[3;5H\\x1b[31mHELLO中'); setInterval(()=>{},1000);");
    let error;
    try {
      await until(() => f.run(['capture-pane', '-p', '-t', f.target.paneId]), text => text.includes('HELLO中'));
      const before = await f.run(['display-message', '-p', '-t', f.target.paneId, '#{window_layout}|#{window_zoomed_flag}']);
      const frames = [];
      const lease = await f.pool.subscribe(f.target, frame => frames.push(frame));
      const { Terminal } = (await import('@xterm/headless')).default;
      const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
      const snapshot = frames.find(frame => frame.type === 'snapshot');
      await new Promise(resolve => term.write(Buffer.from(snapshot.data, 'base64'), resolve));
      expect(term.buffer.active.type).toBe('alternate');
      expect(term.buffer.active.getLine(2).translateToString(true).trimEnd()).toBe('    HELLO中');
      expect(term.buffer.active.cursorX).toBe(11);
      expect(term.buffer.active.cursorY).toBe(2);
      expect(term.modes.applicationCursorKeysMode).toBe(true);
      expect(term.modes.bracketedPasteMode).toBe(true);
      expect(term.modes.mouseTrackingMode).toBe('drag');
      await new Promise(resolve => term.write('\x1b[?1049l', resolve));
      expect(term.buffer.active.type).toBe('normal');
      expect(term.buffer.active.getLine(0).translateToString(true).trimEnd()).toBe('NORMAL');
      expect(await f.run(['display-message', '-p', '-t', f.target.paneId, '#{window_layout}|#{window_zoomed_flag}'])).toBe(before);
      term.dispose(); lease.close();
    } catch (failure) { error = failure; throw failure; } finally { await f.cleanup(error); }
  }, 20_000);

  it.each(['top', 'bottom'])('converges to the requested pane grid with pane-border-status %s and never resnapshots an identical resize', async border => {
    const f = await fixture("process.stdout.write('READY');setInterval(()=>{},1000);", { border });
    let error;
    try {
      const frames = [];
      const lease = await f.pool.subscribe(f.target, frame => frames.push(frame));
      await lease.resize(69, 67);
      await sleep(100);
      expect((await f.run(['display-message', '-p', '-t', f.target.paneId, '#{pane_width}|#{pane_height}|#{window_height}'])).trim()).toBe('69|67|68');
      const snapshots = frames.filter(frame => frame.type === 'snapshot').length;
      for (let i = 0; i < 8; i++) { await lease.visibility(true); await lease.resize(69, 67); }
      await sleep(100);
      expect(frames.filter(frame => frame.type === 'snapshot')).toHaveLength(snapshots);
      lease.close();
    } catch (failure) { error = failure; throw failure; } finally { await f.cleanup(error); }
  }, 20_000);

  it('reads older bounded history beyond the native checkpoint without altering the live terminal', async () => {
    const f = await fixture("for(let i=0;i<3000;i++)process.stdout.write('HISTORY:'+String(i).padStart(4,'0')+'\\r\\n');setInterval(()=>{},1000);");
    let error;
    try {
      await until(() => f.run(['capture-pane', '-p', '-t', f.target.paneId]), text => text.includes('HISTORY:2999'));
      const before = await f.run(['capture-pane', '-p', '-t', f.target.paneId]);
      const page = await f.pool.history(f.target, { before: 600, limit: 3 });
      expect(page.lines).toEqual(['HISTORY:0597', 'HISTORY:0598', 'HISTORY:0599']);
      expect(page.nextBefore).toBe(597);
      expect(page.total).toBeGreaterThan(2900);
      expect(await f.run(['capture-pane', '-p', '-t', f.target.paneId])).toBe(before);
    } catch (failure) { error = failure; throw failure; } finally { await f.cleanup(error); }
  }, 20_000);

  it('creates exactly one detached single-pane window for retries while retaining the original running pane', async () => {
    const f = await fixture('setInterval(()=>{},1000);', { border: 'top' });
    let error;
    try {
      const before = await f.run(['display-message', '-p', '-t', f.target.paneId, '#{window_layout}']);
      const service = new WorkbenchService({ pool: f.pool, tmux: f.tmux, workspace: f.workspace, configDir: f.dir });
      const cwd = join(f.dir, "work ' $; #{pid} directory");
      await mkdir(cwd);
      const request = { instanceId: f.target.instanceId, sessionId: f.target.sessionId, requestId: 'integration-creation-1234', cols: 90, rows: 28, cwd };
      const created = await service.createPane(request);
      expect(await service.createPane(request)).toEqual(created);
      expect(created.windowId).not.toBe(f.target.windowId);
      expect((await f.run(['display-message', '-p', '-t', created.paneId, '#{pane_width}|#{pane_height}'])).trim()).toBe('90|28');
      expect((await f.run(['display-message', '-p', '-t', created.paneId, '#{pane_current_path}'])).trim()).toBe(cwd);
      expect((await f.run(['list-panes', '-t', created.windowId, '-F', '#{pane_id}'])).trim()).toBe(created.paneId);
      expect((await f.run(['list-windows', '-t', f.target.sessionId, '-F', '#{window_id}'])).trim().split('\n')).toHaveLength(2);
      expect(await f.run(['display-message', '-p', '-t', f.target.paneId, '#{window_layout}'])).toBe(before);
      await service.terminate(created);
      expect((await f.run(['list-panes', '-t', f.target.paneId, '-F', '#{pane_dead}'])).trim()).toBe('0');
    } catch (failure) { error = failure; throw failure; } finally { await f.cleanup(error); }
  }, 20_000);
});
