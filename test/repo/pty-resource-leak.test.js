import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);

describe.skipIf(process.platform !== 'darwin')('native macOS PTY resources', () => {
  it('releases PTY descriptors after repeated spawn/exit cycles', async () => {
    // Use a fresh process and the real native addon: mocked PTYs cannot detect
    // the node-pty 1.1.0 leak that exhausts the system-wide PTY limit.
    const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { spawnSync } from 'node:child_process';
      import pty from 'node-pty';

      function descriptors() {
        const result = spawnSync('/usr/sbin/lsof', [
          '-nP', '-a', '-p', String(process.pid), '-Fn',
        ], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.split('\\n').filter(line =>
          line === 'n/dev/ptmx' || /^n\\/dev\\/ttys\\d+$/.test(line)
        ).length;
      }

      const before = descriptors();
      for (let i = 0; i < 100; i++) {
        await new Promise((resolve, reject) => {
          const term = pty.spawn('/bin/sh', ['-c', 'printf pty-ok'], {
            cols: 80, rows: 24, env: { PATH: '/usr/bin:/bin', TERM: 'xterm' },
          });
          let output = '';
          term.onData(data => { output += data; });
          term.onExit(({ exitCode }) => {
            try {
              assert.equal(exitCode, 0);
              assert.equal(output, 'pty-ok');
              resolve();
            } catch (error) { reject(error); }
          });
        });
      }
      console.log(JSON.stringify({ cycles: 100, before, after: descriptors() }));
    `], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      timeout: 20_000,
    });

    const result = JSON.parse(stdout.trim());
    expect(result.cycles).toBe(100);
    expect(result.after).toBe(result.before);
  }, 25_000);
});
