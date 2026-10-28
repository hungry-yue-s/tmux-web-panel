import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('macOS distribution build guards', () => {
  it('uses only credential-free public npm HTTPS tarballs in the lockfile', () => {
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
    const tarballs = Object.values(lock.packages).filter(value => value.resolved);
    expect(tarballs.length).toBeGreaterThan(0);
    const unsafeCount = tarballs.filter(value => {
      try {
        const url = new URL(value.resolved);
        return url.origin !== 'https://registry.npmjs.org' || !!(url.username || url.password || url.search || url.hash);
      } catch { return true; }
    }).length;
    // Report a count, never a resolved URL that might contain credentials.
    expect(unsafeCount, 'Lockfile tarballs must use credential-free public npm HTTPS URLs').toBe(0);
  });

  it('rejects an unsupported runtime architecture before writing output or downloading', () => {
    const temp = mkdtempSync(join(tmpdir(), 'tmux-bundle-guard-'));
    try {
      const output = join(temp, 'runtime');
      const result = spawnSync('bash', ['scripts/bundle-macos-runtime.sh', output], {
        encoding: 'utf8', env: { ...process.env, TMUX_PANEL_ARCH: 'riscv64' },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Unsupported macOS architecture');
      expect(existsSync(output)).toBe(false);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform === 'win32')('replaces signed runtime code with a fresh inode while preserving signing arguments and permissions', () => {
    const source = readFileSync('scripts/build-macos-app.sh', 'utf8');
    const helper = source.match(/^sign_runtime_binary\(\) \{[\s\S]*?^\}/m);
    expect(helper, 'The builder must define sign_runtime_binary').not.toBeNull();
    const temp = mkdtempSync(join(tmpdir(), 'tmux-sign-runtime-'));
    try {
      const binary = join(temp, 'helper binary');
      const entitlements = join(temp, 'node entitlements.plist');
      const argv = join(temp, 'signing-arguments');
      writeFileSync(binary, 'unsigned fixture\n', { mode: 0o751 });
      writeFileSync(entitlements, '<plist/>');
      const originalInode = statSync(binary).ino;
      const result = spawnSync('bash', ['-c', `set -euo pipefail
SIGN_FLAGS=(--force --sign 'Test Signing Identity' --timestamp --options runtime)
codesign() {
  printf '%s\\n' "$@" > "$TWP_TEST_SIGN_ARGS"
  printf 'signed fixture\\n' > "\${!#}"
}
${helper[0]}
sign_runtime_binary "$1" --entitlements "$2"
`, 'runtime-signing-test', binary, entitlements], {
        encoding: 'utf8', env: { ...process.env, TWP_TEST_SIGN_ARGS: argv }, timeout: 5000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(binary, 'utf8')).toBe('signed fixture\n');
      expect(statSync(binary).ino).not.toBe(originalInode);
      expect(statSync(binary).mode & 0o777).toBe(0o751);
      expect(readFileSync(argv, 'utf8').trimEnd().split('\n')).toEqual([
        '--force', '--sign', 'Test Signing Identity', '--timestamp', '--options', 'runtime', '--entitlements', entitlements, binary,
      ]);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'darwin')('refuses an unsigned public-distribution artifact before building', () => {
    const temp = mkdtempSync(join(tmpdir(), 'tmux-public-build-guard-'));
    try {
      const result = spawnSync('bash', ['scripts/build-macos-app.sh'], {
        encoding: 'utf8', env: { ...process.env, TMUX_PANEL_DIST_DIR: join(temp, 'output'),
          TMUX_PANEL_DISTRIBUTION: '1', TMUX_PANEL_CODESIGN_IDENTITY: '-', TMUX_PANEL_NOTARY_PROFILE: '', TMUX_PANEL_ARCH: process.arch },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Public distribution requires');
      expect(existsSync(join(temp, 'output'))).toBe(false);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
});
