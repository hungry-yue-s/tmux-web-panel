import { it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pty from 'node-pty';
import { buildTmuxAttachCommand } from '../server/terminal.js';

let tmux;
try { tmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim(); } catch { /* optional local integration */ }

it.skipIf(!tmux).each([false, true])('preserves Chinese and prompt icons with a C-locale client (nozoom=%s)', async (nozoom) => {
  const dir = mkdtempSync(join(tmpdir(), 'tmux-utf8-test-'));
  const socket = 'utf8-test-' + process.pid + '-' + Date.now();
  const run = (...args) => execFileSync(tmux, ['-L', socket, ...args], {
    encoding: 'utf8', env: { ...process.env, TMUX: '', LC_ALL: 'C.UTF-8' },
  }).trim();
  const sample = '中文目录  yuebiao   branch  Go  11:51 ';
  let term;
  let listener;
  let output = '';
  const clientEnv = { ...process.env, LC_ALL: 'C', LANG: 'C', LC_CTYPE: 'C', PATH: dir + ':' + process.env.PATH };
  // Even an empty TMUX variable makes tmux assume the client supports UTF-8.
  delete clientEnv.TMUX;
  try {
    writeFileSync(join(dir, 'tmux'), '#!/bin/sh\nexec "' + tmux + '" -L ' + socket + ' "$@"\n', { mode: 0o755 });
    run('-f', '/dev/null', 'new-session', '-d', '-s', 'test', '-x', '100', '-y', '24',
      "printf '%s\\n' '" + sample + "'; exec sleep 30");
    const pane = run('list-panes', '-t', 'test:0', '-F', '#{pane_id}');
    // Wait for the pane to contain the sample before testing its attached output.
    for (let i = 0; i < 100; i++) {
      if (run('capture-pane', '-p', '-t', pane).includes(sample)) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(run('capture-pane', '-p', '-t', pane)).toContain(sample);
    term = pty.spawn('sh', ['-c', buildTmuxAttachCommand(pane, { nozoom })], {
      name: 'xterm-256color', cols: 100, rows: 24,
      // SSH need not forward LANG/LC_*; reproduce that non-UTF-8 environment.
      env: clientEnv,
    });
    listener = term.onData(data => { output += data; });
    for (let i = 0; i < 100 && !output.includes(sample); i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(output).toContain(sample);
  } finally {
    if (listener) listener.dispose();
    if (term) try { term.kill(); } catch { /* already exited */ }
    try { run('kill-server'); } catch { /* already stopped */ }
    rmSync(dir, { recursive: true, force: true });
  }
}, 10000);
