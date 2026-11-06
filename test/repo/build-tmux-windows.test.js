import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const builder = resolve(import.meta.dirname, '../../scripts/build-tmux-windows.sh');
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'twp-windows-builder-'));
  const source = join(dir, "source with ' spaces"), output = join(dir, 'managed version with spaces'), tools = join(dir, 'tools');
  await mkdir(source); await mkdir(tools);
  await writeFile(join(source, 'tmux.c'), 'fixture source');
  await writeFile(join(source, 'autogen.sh'), `#!/bin/sh
cat > configure <<'CONFIGURE'
#!/bin/sh
for arg do
  case "$arg" in --prefix=*) printf '%s' "\${arg#--prefix=}" > .prefix;; esac
done
CONFIGURE
chmod +x configure
`);
  const patcher = join(dir, 'patcher with spaces.sh');
  await writeFile(patcher, '#!/bin/sh\nset -eu\ntest -f "$1/tmux.c"\nprintf patched > "$1/.patched"\n');
  await writeFile(join(tools, 'make'), `#!/bin/sh
set -eu
if [ "\${TWP_FIXTURE_BUILD_FAIL:-0}" = 1 ]; then exit 9; fi
test "$(cat .patched)" = patched
case "$*" in *install*) prefix="$(cat .prefix)"; mkdir -p "$prefix/bin"; printf '#!/bin/sh\\nprintf "tmux fixture\\\\n"\\n' > "$prefix/bin/tmux.exe";; esac
`, { mode: 0o755 });
  return { dir, source, output, patcher, env: { ...process.env, PATH: tools + ':' + process.env.PATH } };
}

describe.skipIf(process.platform === 'win32')('Windows native builder staging (isolated build tools)', () => {
  it('builds a copied patched source in spaced paths and refuses to overwrite a published executable', async () => {
    const f = await fixture();
    try {
      const built = spawnSync('bash', [builder, f.source, f.output, f.patcher, '2'], { env: f.env, encoding: 'utf8' });
      expect(built.status, built.stderr).toBe(0);
      expect((await readFile(join(f.output, 'tmux.exe'), 'utf8'))).toContain('tmux fixture');
      const again = spawnSync('bash', [builder, f.source, f.output, f.patcher, '2'], { env: f.env, encoding: 'utf8' });
      expect(again.status).toBe(1);
      expect(again.stderr).toContain('refusing to overwrite');
      expect((await readFile(join(f.output, 'tmux.exe'), 'utf8'))).toContain('tmux fixture');
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  });
  it('never publishes a binary from a failed build', async () => {
    const f = await fixture();
    try {
      const result = spawnSync('bash', [builder, f.source, f.output, f.patcher, '2'], { env: { ...f.env, TWP_FIXTURE_BUILD_FAIL: '1' }, encoding: 'utf8' });
      expect(result.status).not.toBe(0);
      await expect(readFile(join(f.output, 'tmux.exe'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  });
});
