import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const EVENTS = ['Stop', 'PermissionRequest', 'Notification', 'StopFailure', 'SessionEnd', 'SubagentStop'];

async function runInstaller(home, ...args) {
  return execFileAsync('node', ['scripts/install-agent-hooks.js', ...args], {
    cwd: process.cwd(),
    // os.homedir() reads USERPROFILE on Windows: with HOME alone, the
    // installer would write the real ~/.qoder and ~/.codex there.
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

describe('install-agent-hooks', () => {
  it('installs Qoder and Codex hooks without writing panel tokens', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agent-hooks-'));
    try {
      await runInstaller(home, 'all');
      const qoder = await readJson(join(home, '.qoder', 'settings.json'));
      const codex = await readJson(join(home, '.codex', 'hooks.json'));

      for (const [agent, config] of [['qoder', qoder], ['codex', codex]]) {
        for (const event of EVENTS) {
          const found = (config.hooks[event] || []).some((entry) =>
            (entry.hooks || []).some((hook) => hook.name === `tmux-web-panel-${agent}-${event}`),
          );
          expect(found).toBe(true);
        }
        expect(JSON.stringify(config)).not.toContain('--panel-token');
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('leaves the files, and no backups, when everything is already installed or removed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agent-hooks-'));
    try {
      await runInstaller(home, 'all');
      const before = await readFile(join(home, '.codex', 'hooks.json'), 'utf8');
      await runInstaller(home, 'all');
      expect(await readdir(join(home, '.qoder'))).toEqual(['settings.json']);
      expect(await readdir(join(home, '.codex'))).toEqual(['hooks.json']);
      expect(await readFile(join(home, '.codex', 'hooks.json'), 'utf8')).toBe(before);

      await runInstaller(home, 'all', '--uninstall');
      await runInstaller(home, 'all', '--uninstall');
      expect((await readdir(join(home, '.codex'))).filter((name) => name.includes('.bak-'))).toHaveLength(1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('does not duplicate earlier manually-installed Qoder hook names', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agent-hooks-'));
    try {
      const qoderDir = join(home, '.qoder');
      await mkdir(qoderDir, { recursive: true });
      await writeFile(join(qoderDir, 'settings.json'),
        '{"hooks":{"Stop":[{"matcher":"*","hooks":[{"name":"tmux-web-panel-Stop","type":"command","command":"old"}]}]}}\n');

      await runInstaller(home, 'qoder');
      const qoder = await readJson(join(home, '.qoder', 'settings.json'));
      const stopHooks = (qoder.hooks.Stop || []).flatMap((entry) => entry.hooks || [])
        .filter((hook) => /^tmux-web-panel-(qoder-)?Stop$/.test(hook.name));
      expect(stopHooks).toHaveLength(1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
