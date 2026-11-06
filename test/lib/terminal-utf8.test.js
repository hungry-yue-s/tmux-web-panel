import { it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pty from 'node-pty';
import { buildTmuxAttachCommand } from '../../lib/terminal.js';
import { PRIVATE_TMUX_IDENTITY_FORMAT, parsePrivateTmuxIdentity, cleanupPrivateTmux } from '../helpers/private-tmux.js';

let tmux;
// POSIX shell/PTY coverage only. Native Windows uses a different spawn path;
// it must have its own isolated harness, not a PATH shim that tmux.exe can bypass.
if (process.platform !== 'win32') {
  try { tmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim(); } catch { /* optional local integration */ }
}

it.skipIf(process.platform === 'win32' || !tmux).each([false, true])('preserves Chinese and prompt icons with a C-locale client (nozoom=%s)', async (nozoom) => {
  const dir = mkdtempSync(join(tmpdir(), 'tmux-utf8-test-'));
  const socket = join(dir, 'tmux.sock');
  const env = { ...process.env };
  delete env.TMUX;
  delete env.TMUX_PANE;
  const run = (...args) => execFileSync(tmux, ['-S', socket, ...args], {
    timeout: 5000, encoding: 'utf8', env: { ...env, LC_ALL: 'C.UTF-8' },
  }).trim();
  const readIdentity = () => parsePrivateTmuxIdentity(run('display-message', '-p', PRIVATE_TMUX_IDENTITY_FORMAT), socket);
  const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
  const sample = '中文目录  yuebiao   branch  Go  11:51 ';
  let term;
  let listener;
  let output = '';
  let identity, primaryError;
  const clientEnv = { ...env, LC_ALL: 'C', LANG: 'C', LC_CTYPE: 'C' };
  // Even an empty TMUX variable makes tmux assume the client supports UTF-8.
  try {
    run('-f', '/dev/null', 'new-session', '-d', '-s', 'test', '-x', '100', '-y', '24',
      "printf '%s\\n' '" + sample + "'; exec sleep 30");
    identity = readIdentity();
    const pane = run('list-panes', '-t', 'test:0', '-F', '#{pane_id}');
    // Wait for the pane to contain the sample before testing its attached output.
    for (let i = 0; i < 100; i++) {
      if (run('capture-pane', '-p', '-t', pane).includes(sample)) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(run('capture-pane', '-p', '-t', pane)).toContain(sample);
    const command = buildTmuxAttachCommand(pane, { nozoom });
    expect(command).toMatch(/^tmux /);
    const isolated = quote(tmux) + ' -S ' + quote(socket) + ' ' + command.slice('tmux '.length);
    term = pty.spawn('/bin/sh', ['-c', isolated], {
      name: 'xterm-256color', cols: 100, rows: 24,
      // SSH need not forward LANG/LC_*; reproduce that non-UTF-8 environment.
      env: clientEnv,
    });
    listener = term.onData(data => { output += data; });
    for (let i = 0; i < 100 && !output.includes(sample); i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(output).toContain(sample);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (listener) listener.dispose();
    if (term) try { term.kill(); } catch { /* already exited */ }
    await cleanupPrivateTmux({ dir, socket, identity, readIdentity, killServer: () => run('kill-server'), primaryError });
  }
}, 10000);
