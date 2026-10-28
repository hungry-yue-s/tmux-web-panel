// Run against a built binary: node scripts/test-tmux-startup.mjs /path/to/tmux
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { test } from 'node:test';

assert(process.argv[2], 'Usage: node scripts/test-tmux-startup.mjs TMUX_BINARY');
const binary = resolve(process.argv[2]);
const exec = promisify(execFile);
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;

async function until(check, message) {
  const deadline = Date.now() + 5000;
  do {
    if (await check()) return;
    await delay(25);
  } while (Date.now() < deadline);
  assert.fail(message);
}

for (const [foreground, disconnect] of [[true, false], [true, true], [false, true]]) {
  test(`${foreground ? 'foreground' : 'daemon'} startup, initial client ${disconnect ? 'disconnects' : 'stays'}`, { timeout: 20000 }, async () => {
    // Short socket paths also work within macOS's Unix socket path limit.
    const dir = mkdtempSync('/tmp/twp-startup-');
    const socket = join(dir, 'socket');
    const ready = join(dir, 'ready');
    const release = join(dir, 'release');
    const loads = join(dir, 'loads');
    const plugin = join(dir, 'plugin.sh');
    const config = join(dir, 'tmux.conf');
    const env = { HOME: dir, PATH: `${dirname(binary)}:/usr/bin:/bin:/usr/sbin:/sbin`, LANG: 'C' };
    const query = async (...args) => (await exec(binary, ['-S', socket, ...args], { env, timeout: 2000 })).stdout.trim();
    let server;
    let first;
    writeFileSync(plugin, `#!/bin/sh
touch ${quote(ready)}
while [ ! -f ${quote(release)} ]; do sleep 0.02; done
exec ${quote(binary)} -S ${quote(socket)} set-option -g @plugin-done yes
`, { mode: 0o700 });
    writeFileSync(config, `set -g exit-empty off
run-shell "printf x >> ${loads}"
run-shell "${plugin}"
set -g @config-done yes
`);
    try {
      if (foreground) {
        server = spawn(binary, ['-S', socket, '-f', config, '-D'], { env, stdio: 'ignore' });
        await until(() => existsSync(socket), 'server socket was not created');
        await delay(100);
      }
      first = spawn(binary, ['-S', socket, '-f', config, 'start-server', ';',
        'set-option', '-g', '@initial-client-ran', 'yes'], { env, stdio: 'ignore' });
      await until(() => existsSync(ready), 'synchronous plugin was not started');
      assert.equal(await query('show-options', '-gqv', '@initial-client-ran'), '',
        'the initial client ran before configuration finished');
      if (disconnect) {
        const exited = once(first, 'exit');
        first.kill('SIGTERM');
        await exited;
        await delay(150);
      }
      writeFileSync(release, '');
      await delay(100);
      await until(async () => await query('show-options', '-gqv', '@config-done') === 'yes',
        'configuration stalled after the initial client disconnected');
      assert.equal(await query('show-options', '-gqv', '@plugin-done'), 'yes');
      assert.equal(readFileSync(loads, 'utf8'), 'x', 'configuration loaded more than once');
      assert.equal(await query('show-messages', '-J'), '', 'synchronous plugin is still blocked');
    } finally {
      writeFileSync(release, '');
      await query('kill-server').catch(() => {});
      for (const child of [first, server]) {
        if (child && child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit');
          child.kill('SIGKILL');
          await exited;
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
