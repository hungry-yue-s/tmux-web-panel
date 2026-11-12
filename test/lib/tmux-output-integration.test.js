import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pty from 'node-pty';
import headless from '@xterm/headless';
import { TmuxOutput } from '../../lib/terminal/tmux-output.js';
import { cleanupPrivateTmux, parsePrivateTmuxIdentity, PRIVATE_TMUX_IDENTITY_FORMAT } from '../helpers/private-tmux.js';

let binary;
if (process.platform !== 'win32') {
  try { binary = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim(); } catch { /* optional local integration */ }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read) {
  for (let i = 0; i < 200; i++) { if (await read()) return; await sleep(10); }
  throw new Error('Private tmux client did not settle');
}

it.skipIf(!binary)('retains the real screen across takeover and reclaim while the private pane keeps running', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'anymux-takeover-'))), socket = join(dir, 'socket');
  const env = { ...process.env, TERM: 'xterm-256color', LC_ALL: 'en_US.UTF-8' }; delete env.TMUX; delete env.TMUX_PANE;
  const run = (...args) => execFileSync(binary, ['-S', socket, ...args], { env, encoding: 'utf8', timeout: 5000 }).trim();
  const readIdentity = () => parsePrivateTmuxIdentity(run('display-message', '-p', PRIVATE_TMUX_IDENTITY_FORMAT), socket);
  let identity, primaryError;
  const clients = [];
  function attach() {
    const filter = new TmuxOutput(), term = new headless.Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const child = pty.spawn(binary, ['-S', socket, '-u', 'attach-session', '-d', '-t', 'takeover-test'], { env, name: 'xterm-256color', cols: 80, rows: 24 });
    const view = { child, filter, term, exited: false, output: '', render: Promise.resolve() }; clients.push(view);
    term.onData(data => { if (!view.exited) child.write(data); });
    child.onData(data => {
      const bytes = filter.push(Buffer.from(data)); view.output += bytes.toString();
      view.render = view.render.then(() => new Promise(resolve => term.write(bytes, resolve)));
    });
    child.onExit(() => { view.exited = true; });
    return view;
  }
  const screen = term => Array.from({ length: term.rows }, (_, row) => term.buffer.active.getLine(row)?.translateToString(true)).join('\n');
  try {
    run('-f', '/dev/null', 'new-session', '-d', '-s', 'takeover-test', '-x', '80', '-y', '24', "printf 'TAKEOVER-任务继续运行\\n'; exec sleep 120");
    identity = readIdentity(); run('set-option', '-g', 'exit-empty', 'off');
    const panePid = run('display-message', '-p', '-t', 'takeover-test', '#{pane_pid}');
    await until(() => run('capture-pane', '-p', '-t', 'takeover-test').includes('TAKEOVER-任务继续运行'));
    const first = attach(); await until(() => first.output.includes('TAKEOVER-'));
    const second = attach(); await until(() => first.exited && second.output.includes('TAKEOVER-'));
    await first.render;
    expect(first.filter.reason).toBe('detached');
    expect(screen(first.term)).toContain('TAKEOVER-任务继续运行');
    expect(first.output).not.toContain('[detached');
    const reclaimed = attach(); await until(() => second.exited && reclaimed.output.includes('TAKEOVER-'));
    expect(second.filter.reason).toBe('detached');
    expect(run('display-message', '-p', '-t', 'takeover-test', '#{pane_pid}')).toBe(panePid);
    run('kill-session', '-t', 'takeover-test'); await until(() => reclaimed.exited); await reclaimed.render;
    expect(reclaimed.filter.reason).toBe('session_ended');
    expect(screen(reclaimed.term)).toContain('TAKEOVER-任务继续运行');
  } catch (error) { primaryError = error; throw error; }
  finally {
    for (const view of clients) { if (!view.exited) try { view.child.kill(); } catch { /* owned attach already gone */ } view.term.dispose(); }
    await cleanupPrivateTmux({ dir, socket, identity, readIdentity, killServer: () => run('kill-server'), primaryError });
  }
}, 10_000);
