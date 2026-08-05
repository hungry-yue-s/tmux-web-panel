import { afterAll, describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve(import.meta.dirname, '../scripts/install-service.sh');
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
