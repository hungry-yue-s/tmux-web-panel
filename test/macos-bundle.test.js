import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('macOS distribution build guards', () => {
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
