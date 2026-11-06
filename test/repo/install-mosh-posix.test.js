import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve('scripts/install-mosh.sh');
const source = readFileSync(script, 'utf8');
const work = [];
afterEach(() => work.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
const plans = {
  'apt-get': '0 upgraded, 2 newly installed, 0 to remove and 0 not upgraded.\nInst libprotobuf32 (3.21.0 repo [amd64])\nInst mosh (1.4.0-1 repo [amd64])',
  brew: '==> Would install 1 formula:\nmosh\n==> Would install 1 dependency for mosh:\nprotobuf',
  dnf: 'Installing:\n mosh x86_64 1.4.0 repo\nTransaction Summary\nInstall  1 Package\nOperation aborted.',
  yum: 'Installing:\n mosh x86_64 1.4.0 repo\nTransaction Summary\nInstall  1 Package\nExiting on user command',
  pacman: 'protobuf\nmosh',
  apk: '(1/2) Installing protobuf (3.21.0)\n(2/2) Installing mosh (1.4.0)\nOK: 2 packages',
  zypper: 'The following NEW package is going to be installed:\n  mosh\n1 new package to install.',
};

function fixture(manager = 'apt-get', values = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'twp-mosh-posix-')); work.push(dir);
  const bin = join(dir, 'bin'); mkdirSync(bin);
  const put = (name, body) => { writeFileSync(join(bin, name), '#!/bin/sh\n' + body); chmodSync(join(bin, name), 0o755); };
  put('uname', 'printf "%s\\n" "$FIX_OS"\n');
  put('id', 'printf "%s\\n" "$FIX_UID"\n');
  for (const name of ['mosh-client', 'mosh-server']) put(name, `
if [ "$1" != --version ]; then exit 97; fi
if [ ! -f "$FIX_READY" ] && [ "\${FIX_${name === 'mosh-client' ? 'CLIENT' : 'SERVER'}_READY:-0}" != 1 ]; then exit 1; fi
if [ "\${FIX_BAD_VERSION:-0}" = 1 ]; then echo 'wrong executable'; else echo '${name} (mosh 1.4.0)'; fi
`);
  // Every platform test has a fake brew before any host search path: no real package command may run.
  put('brew', manager === 'brew' ? packageShim : 'echo unexpected_brew >> "$FIX_CALLS"; exit 97\n');
  if (manager && manager !== 'brew') put(manager, packageShim);
  put('sudo', `
printf 'sudo:%s\\n' "$*" >> "$FIX_CALLS"
if [ "$1" = -S ]; then
  IFS= read -r supplied
  [ "$supplied" = 'test-only-pass' ] || exit 1
  : > "$FIX_AUTH"
  exit 0
fi
[ "$1" = -n ] || exit 98
shift
if [ "\${FIX_SUDO_ZERO:-0}" = 1 ] || { [ "\${FIX_SUDO_N:-0}" != 1 ] && [ ! -f "$FIX_AUTH" ]; }; then echo 'sudo: a password is required' >&2; exit 1; fi
[ "$1" = true ] && exit 0
exec "$@"
`);
  const env = { ...process.env, PATH: bin + ':/usr/bin:/bin', HOME: dir, FIX_OS: manager === 'brew' ? 'Darwin' : 'Linux',
    FIX_UID: manager === 'brew' ? '1000' : '0', FIX_READY: join(dir, 'ready'), FIX_AUTH: join(dir, 'auth'),
    FIX_CALLS: join(dir, 'calls'), FIX_LEAK: join(dir, 'leak'), FIX_PLAN: plans[manager] || '', ...values };
  delete env.TMUX_PANEL_MOSH_CLIENT; delete env.TMUX_PANEL_MOSH_SERVER;
  const run = (extra = {}, stdin = false) => spawnSync('/bin/sh', stdin ? ['-s'] : [script], {
    input: stdin ? source : undefined, env: { ...env, ...extra }, encoding: 'utf8', timeout: 5000,
  });
  return { run, env, dir, calls: () => existsSync(env.FIX_CALLS) ? readFileSync(env.FIX_CALLS, 'utf8') : '' };
}

const packageShim = `
printf 'pkg:%s:%s\\n' "\${0##*/}" "$*" >> "$FIX_CALLS"
[ "\${TWP_SUDO_PASSWORD+x}" != x ] || : > "$FIX_LEAK"
case "\${0##*/}:$*" in
  pacman:-Qu) [ "\${FIX_PENDING:-0}" != 1 ] || echo 'openssl 3.0 -> 3.1'; exit 0 ;;
  'pacman:-Q '*) [ "\${FIX_INSTALLED_DEP:-0}" != 1 ] || exit 0; exit 1 ;;
  'pacman:-Si '*)
    if [ "\${FIX_CONFLICT:-0}" = 1 ]; then printf 'Conflicts With : old-library\\nReplaces : old-library\\n'
    else printf 'Conflicts With : None\\nReplaces : None\\n'; fi
    exit 0 ;;
esac
case " $* " in
  *' --dry-run '*|*' --simulate '*|*' -s '*|*' --assumeno '*|*' -Sp '*)
    printf '%s\\n' "$FIX_PLAN"
    exit "\${FIX_PLAN_EXIT:-0}"
    ;;
esac
if [ "\${FIX_INSTALL_FAIL:-0}" = 1 ]; then echo 'Failed to fetch: network is unreachable' >&2; exit 1; fi
: > "$FIX_READY"
`;

describe.skipIf(process.platform === 'win32')('optional POSIX Mosh component preparation (only package shims)', () => {
  it.each(['client', 'server', 'both'])('verifies an already-ready %s without a package transaction', role => {
    const f = fixture('apt-get', { FIX_CLIENT_READY: '1', FIX_SERVER_READY: '1' });
    const answer = f.run({ TWP_MOSH_ROLE: role });
    expect(answer.status, answer.stderr).toBe(0); expect(answer.stdout).toContain('TWP_COMPONENT_RESULT=ready');
    expect(f.calls()).toBe('');
  });

  it('only requires the requested role and rejects a broken explicit override without installing', () => {
    const f = fixture('apt-get', { FIX_SERVER_READY: '1' });
    expect(f.run({ TWP_MOSH_ROLE: 'server' }).status).toBe(0);
    const answer = f.run({ TWP_MOSH_ROLE: 'client', TMUX_PANEL_MOSH_CLIENT: join(f.dir, 'missing') });
    expect(answer.stdout).toContain('TWP_COMPONENT_RESULT=maintenance_required'); expect(f.calls()).toBe('');
  });

  it.each(['TMUX_PANEL_SKIP_MOSH', 'TWP_SKIP_MOSH'])('honors %s before invoking any component or package command', name => {
    const f = fixture(); const answer = f.run({ [name]: '1' });
    expect(answer.status).toBe(0); expect(answer.stdout).toContain('TWP_COMPONENT_RESULT=skipped'); expect(f.calls()).toBe('');
  });

  it.each(Object.keys(plans))('accepts a recognized install-only %s plan then verifies the installed roles', manager => {
    const f = fixture(manager); const answer = f.run();
    expect(answer.status, answer.stdout + answer.stderr).toBe(0);
    expect(answer.stdout).toContain('TWP_COMPONENT_RESULT=ready'); expect(existsSync(f.env.FIX_READY)).toBe(true);
    expect(f.calls()).not.toMatch(/ -Sy| upgrade | update | dist-upgrade/);
    if (manager === 'apt-get') expect(f.calls()).toContain('libprotobuf32=3.21.0 mosh=1.4.0-1');
  });

  it('accepts DNF5 install-only summary without mistaking its zero-removal size note for an action', () => {
    // DNF5 official issue #620 includes this C-locale table/summary/size-note layout.
    const f = fixture('dnf', { FIX_PLAN: 'Package Arch Version Repository Size\nInstalling:\n mosh x86_64 1.4.0 repo 1 M\nTransaction Summary:\n Installing: 1 packages\nAfter this operation 1 MiB will be used (install 1 MiB, remove 0 B).\nOperation aborted by the user.', FIX_PLAN_EXIT: '1' });
    expect(f.run().status).toBe(0);
  });

  it.each([
    ['apt-get', '1 upgraded, 1 newly installed, 0 to remove\nInst libc6 [2.30] (2.31 repo)\nInst mosh (1.4.0 repo)'],
    ['brew', plans.brew + '\n==> Would upgrade 1 dependency for mosh:\nopenssl 3.0 -> 3.1'],
    ['dnf', plans.dnf + '\nUpgrade  1 Package'],
    ['yum', plans.yum + '\nRemoving dependent packages:\n tmux'],
    ['yum', plans.yum + '\nUpdating:\n openssl x86_64 3.1 repo'],
    ['apk', '(1/2) Upgrading openssl (3.0 -> 3.1)\n(2/2) Installing mosh (1.4.0)'],
    ['zypper', plans.zypper + '\n1 package to upgrade.'],
  ])('refuses the %s shared-package change before installing anything', (manager, plan) => {
    const f = fixture(manager, { FIX_PLAN: plan }); const answer = f.run();
    expect(answer.status).not.toBe(0); expect(answer.stdout).toContain('TWP_COMPONENT_RESULT=maintenance_required');
    expect(existsSync(f.env.FIX_READY)).toBe(false);
  });

  it.each([{ FIX_PENDING: '1' }, { FIX_INSTALLED_DEP: '1' }, { FIX_CONFLICT: '1' }])('never partially upgrades or replaces libraries on a pacman host (%j)', vars => {
    const f = fixture('pacman', vars); const answer = f.run();
    expect(answer.stdout).toContain('TWP_COMPONENT_RESULT=maintenance_required'); expect(existsSync(f.env.FIX_READY)).toBe(false);
    expect(f.calls()).not.toContain('-Sy');
  });

  it.each(Object.keys(plans))('refuses an unknown %s transaction rather than guessing', manager => {
    const f = fixture(manager, { FIX_PLAN: 'unrecognized package transaction' }); const answer = f.run();
    expect(answer.stdout).toContain('TWP_COMPONENT_RESULT=maintenance_required'); expect(existsSync(f.env.FIX_READY)).toBe(false);
  });

  it('refuses new service changes and classifies offline installation without exposing raw output', () => {
    const f = fixture('apt-get', { FIX_PLAN: plans['apt-get'] + '\nInst systemd (260 repo)' });
    expect(f.run().stdout).toContain('TWP_COMPONENT_REASON=service_transaction');
    const offline = fixture('apt-get', { FIX_INSTALL_FAIL: '1' }); const answer = offline.run();
    expect(answer.stdout).toContain('TWP_COMPONENT_REASON=package_network_unavailable');
    expect(answer.stdout + answer.stderr).not.toContain('Failed to fetch');
  });

  it('uses sudo -n or password validation stdin without passing a password to the package process', () => {
    const f = fixture('apt-get', { FIX_UID: '1000' });
    const needs = f.run(); expect(needs.status).toBe(3); expect(needs.stdout).toContain('TWP_COMPONENT_RESULT=needs_password');
    const answer = f.run({ TWP_SUDO_PASSWORD: 'test-only-pass' });
    expect(answer.status, answer.stdout + answer.stderr).toBe(0);
    expect(answer.stdout + answer.stderr + f.calls()).not.toContain('test-only-pass');
    expect(existsSync(f.env.FIX_LEAK)).toBe(false);
    expect(f.calls()).toContain('sudo:-S -p  -v');
    const noPassword = fixture('apt-get', { FIX_UID: '1000', FIX_SUDO_N: '1' });
    expect(noPassword.run().status).toBe(0); expect(noPassword.calls()).not.toContain('sudo:-S');
  }, 10000);

  it('reports maintenance after verified credentials cannot authorize sudo -n, without requesting the password again', () => {
    const f = fixture('apt-get', { FIX_UID: '1000', FIX_SUDO_ZERO: '1' });
    const answer = f.run({ TWP_SUDO_PASSWORD: 'test-only-pass' });
    expect(answer.stdout).toContain('TWP_COMPONENT_RESULT=maintenance_required');
    expect(answer.stdout).toContain('TWP_COMPONENT_REASON=sudo_noninteractive_unavailable');
    expect(answer.stdout).not.toContain('TWP_COMPONENT_RESULT=needs_password');
    expect(answer.stdout + answer.stderr + f.calls()).not.toContain('test-only-pass');
    expect(existsSync(f.env.FIX_READY)).toBe(false);
  });

  it('keeps an incorrect sudo password retryable without starting a package transaction', () => {
    const f = fixture('apt-get', { FIX_UID: '1000' });
    const answer = f.run({ TWP_SUDO_PASSWORD: 'wrong-test-pass' });
    expect(answer.status).toBe(3); expect(answer.stdout).toContain('TWP_COMPONENT_REASON=sudo_auth_failed');
    expect(f.calls()).not.toContain('pkg:');
    expect(answer.stdout + answer.stderr + f.calls()).not.toContain('wrong-test-pass');
  });

  it('rejects root Homebrew and an installed executable with an invalid version', () => {
    const root = fixture('brew', { FIX_UID: '0' }); const denied = root.run();
    expect(denied.stdout).toContain('TWP_COMPONENT_RESULT=unsupported'); expect(root.calls()).toBe('');
    const broken = fixture('apt-get', { FIX_BAD_VERSION: '1' });
    expect(broken.run().stdout).toContain('TWP_COMPONENT_REASON=component_verification_failed');
  });

  it('runs over stdin without relying on a script path', () => {
    const f = fixture('apt-get', { FIX_SERVER_READY: '1' });
    expect(f.run({ TWP_MOSH_ROLE: 'server' }, true).stdout).toContain('TWP_COMPONENT_RESULT=ready');
  });

  it('keeps component failure best-effort on first install and uses server role for NODE_ONLY', () => {
    const service = readFileSync('scripts/install-service.sh', 'utf8');
    const start = service.indexOf('prepare_mosh() {');
    const fn = service.slice(start, service.indexOf('\n}\n', start) + 3);
    const f = fixture(); const helperDir = join(f.dir, 'scripts'); mkdirSync(helperDir);
    writeFileSync(join(helperDir, 'install-mosh.sh'), 'printf "role=%s\\n" "$TWP_MOSH_ROLE"\nprintf "TWP_COMPONENT_RESULT=needs_password\\n"\nexit 3\n');
    const answer = spawnSync('/bin/bash', ['-eu', '-c', fn + '\nprepare_mosh\necho continued'], {
      env: { ...process.env, SCRIPT_DIR: helperDir, mosh_sudo_password: 'fake', NODE_ONLY: '1' }, encoding: 'utf8', timeout: 5000,
    });
    expect(answer.status).toBe(0); expect(answer.stdout).toContain('role=server'); expect(answer.stdout).toContain('continued');
    expect(answer.stderr).toContain('continuing with SSH');
    const main = service.slice(service.indexOf('# ---- Main ----'));
    expect(main.indexOf('prepare_mosh')).toBeGreaterThan(main.indexOf('install_systemd; else install_launchd'));
    const remote = readFileSync('scripts/remote/install-node.sh', 'utf8');
    expect(remote).toContain('TWP_SKIP_MOSH="${TWP_SKIP_MOSH:-${TMUX_PANEL_SKIP_MOSH:-0}}"');
  });
});
