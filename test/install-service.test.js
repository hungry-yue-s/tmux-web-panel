import { afterAll, describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve(import.meta.dirname, '../scripts/install-service.sh');
const tmuxServerScript = resolve(import.meta.dirname, '../scripts/run-tmux-server.sh');
const tmuxBuildScript = resolve(import.meta.dirname, '../scripts/build-tmux.sh');
const workDir = mkdtempSync(join(tmpdir(), 'tmux-web-panel-cert-test-'));

afterAll(() => rmSync(workDir, { recursive: true, force: true }));

describe('install-service TLS automation', () => {
  it('generates and then reuses a protected certificate pair', () => {
    const env = { ...process.env, TLS_DIR: workDir, TLS_DAYS: '60' };
    const first = spawnSync('bash', [script, 'cert'], { env, encoding: 'utf8' });
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain('Generated TLS certificate');

    const cert = join(workDir, 'cert.pem');
    const key = join(workDir, 'key.pem');
    expect(readFileSync(cert, 'utf8')).toContain('BEGIN CERTIFICATE');
    expect(readFileSync(key, 'utf8')).toContain('PRIVATE KEY');
    expect(statSync(key).mode & 0o777).toBe(0o600);

    const details = execFileSync('openssl', ['x509', '-in', cert, '-text', '-noout'], { encoding: 'utf8' });
    expect(details).toContain('DNS:localhost');
    expect(details).toContain('IP Address:127.0.0.1');

    const second = spawnSync('bash', [script, 'cert'], { env, encoding: 'utf8' });
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain('Reusing TLS certificate');
  });
});

describe('macOS tmux server launcher', () => {
  it('starts the companion server with a UTF-8 locale', () => {
    const installer = readFileSync(script, 'utf8');
    const launcherStart = installer.indexOf('install_tmux_server_launchd()');
    const launcherEnd = installer.indexOf('uninstall_tmux_server_launchd()');
    const launcher = installer.slice(launcherStart, launcherEnd);

    expect(launcher).toContain('<key>EnvironmentVariables</key>');
    expect(launcher).toContain('<key>LANG</key>\n        <string>C.UTF-8</string>');
    expect(launcher).toContain('<key>LC_CTYPE</key>\n        <string>C.UTF-8</string>');
  });

  it('deploys tmux from the tracked submodule instead of PATH discovery', () => {
    const installer = readFileSync(script, 'utf8');
    const builder = readFileSync(tmuxBuildScript, 'utf8');

    expect(installer).toContain('build_project_tmux');
    expect(installer).toContain('"$SCRIPT_DIR/build-tmux.sh"');
    expect(installer).not.toContain('command -v tmux 2>/dev/null');
    expect(builder).toContain('$PROJECT_DIR/vendor/tmux');
    expect(builder).toContain('--enable-jemalloc');

    const syntax = spawnSync('bash', ['-n', tmuxBuildScript], { encoding: 'utf8' });
    expect(syntax.status, syntax.stderr).toBe(0);
  });

  it('runs tmux in foreground mode without an incompatible command', () => {
    const fakeTmux = join(workDir, 'fake-tmux');
    writeFileSync(fakeTmux, `#!/bin/sh
if [ "$1" = "show-options" ]; then
  exit 1
fi
printf '%s\\n' "$@"
printf 'PATH=%s\\n' "$PATH"
`);
    chmodSync(fakeTmux, 0o755);

    const result = spawnSync('bash', [tmuxServerScript, fakeTmux], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.split('\n')[0]).toBe('-D');
    expect(result.stdout).toContain(`PATH=${workDir}:`);
  });
});
