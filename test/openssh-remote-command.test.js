import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { OpenSSHExecutor, buildSshArgs } from '../server/transport/openssh-executor.js';

/**
 * These tests execute a real fake `ssh` script so the remote command is observed
 * exactly as OpenSSH would hand it to the remote shell: everything after the
 * destination is the command, which is why an option terminator must not be
 * appended there.
 */

const REMOTE = {
  id: 'api-linux',
  kind: 'remote',
  name: 'API Linux',
  address: { host: '10.0.0.21', port: 22, user: 'deploy' },
  ssh: { configHost: null, identityFile: null, proxyJump: null, knownHostAlias: null },
};

describe('ssh argv shape', () => {
  const opts = { knownHostsPath: '/cfg/known_hosts', controlPath: '/cfg/ssh-control/%C' };

  it('places the option terminator before the destination', () => {
    const args = buildSshArgs(REMOTE, opts);
    const terminator = args.indexOf('--');
    const destination = args.indexOf('deploy@10.0.0.21');

    expect(terminator).toBeGreaterThan(-1);
    expect(terminator).toBe(destination - 1);
    // Nothing may follow the destination in the base argv.
    expect(args[args.length - 1]).toBe('deploy@10.0.0.21');
  });

  it('places it before a ssh config alias too', () => {
    const args = buildSshArgs({ ...REMOTE, ssh: { ...REMOTE.ssh, configHost: 'build-mac' } }, opts);
    expect(args.slice(-2)).toEqual(['--', 'build-mac']);
  });

  it('never repeats the terminator after the destination', () => {
    const args = buildSshArgs(REMOTE, opts);
    expect(args.filter((a) => a === '--')).toHaveLength(1);
  });
});

describe('remote command as a real ssh binary would receive it', () => {
  let dir;
  let fakeSsh;
  let capture;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-ssh-'));
    capture = path.join(dir, 'capture.txt');
    fakeSsh = path.join(dir, 'ssh');

    // Mimics OpenSSH argument handling: skip options, take the destination, then
    // treat every remaining argument as the remote command joined by spaces.
    await fs.writeFile(fakeSsh, `#!/bin/sh
CAPTURE="${capture}"
: > "$CAPTURE"
DEST=""
CMD=""
while [ $# -gt 0 ]; do
  case "$1" in
    --) shift; DEST="$1"; shift; break ;;
    -o|-i|-J|-p) shift 2 ;;
    -*) shift ;;
    *) DEST="$1"; shift; break ;;
  esac
done
while [ $# -gt 0 ]; do
  if [ -z "$CMD" ]; then CMD="$1"; else CMD="$CMD $1"; fi
  shift
done
printf 'DEST=%s\\n' "$DEST" >> "$CAPTURE"
printf 'CMD=%s\\n' "$CMD" >> "$CAPTURE"
printf 'STDIN=' >> "$CAPTURE"
cat >> "$CAPTURE"
printf '\\n' >> "$CAPTURE"
echo ok
`, { mode: 0o755 });
    await fs.chmod(fakeSsh, 0o755);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** Runs the executor against the fake ssh via a real child process. */
  function makeExecutor(server = REMOTE) {
    return new OpenSSHExecutor({
      server,
      configDir: dir,
      execFileImpl: (bin, argv, options, callback) => execFile(fakeSsh, argv, options, callback),
    });
  }

  async function captured() {
    const text = await fs.readFile(capture, 'utf8');
    const dest = /^DEST=(.*)$/m.exec(text);
    const cmd = /^CMD=(.*)$/m.exec(text);
    const stdin = /^STDIN=([\s\S]*)$/m.exec(text);
    return {
      dest: dest ? dest[1] : null,
      cmd: cmd ? cmd[1] : null,
      stdin: stdin ? stdin[1] : '',
    };
  }

  it('sends the tmux command itself, not a literal --', async () => {
    const executor = makeExecutor();

    await executor.exec('tmux', ['list-sessions', '-F', '#{session_id}']);
    const seen = await captured();

    expect(seen.dest).toBe('deploy@10.0.0.21');
    // The bug this guards: the remote shell used to receive "-- tmux ...".
    expect(seen.cmd).toBe("tmux list-sessions -F '#{session_id}'");
    expect(seen.cmd.startsWith('--')).toBe(false);
  });

  it('sends the probe shell command without a stray terminator', async () => {
    const executor = makeExecutor();

    await executor.runScript('echo hello');
    const seen = await captured();

    expect(seen.cmd).toBe('/bin/sh -s');
    // The fake captures stdin verbatim; a real remote shell would run it.
    expect(seen.stdin.trim()).toBe('echo hello');
  });

  it('reaches the destination through a config alias', async () => {
    const executor = makeExecutor({
      ...REMOTE,
      address: { host: null, port: null, user: null },
      ssh: { ...REMOTE.ssh, configHost: 'build-mac' },
    });

    await executor.exec('tmux', ['-V']);
    const seen = await captured();

    expect(seen.dest).toBe('build-mac');
    expect(seen.cmd).toBe('tmux -V');
  });

  it('keeps an injected pane id inert on the remote side', async () => {
    const executor = makeExecutor();

    await executor.exec('tmux', ['kill-pane', '-t', '%1; rm -rf /']);
    const seen = await captured();

    expect(seen.cmd).toBe("tmux kill-pane -t '%1; rm -rf /'");
  });

  it('pty argv also carries no terminator after the destination', () => {
    const executor = makeExecutor();
    const argv = executor.ptyArgs("tmux attach-session -d -t '%3'");

    expect(argv[0]).toBe('-tt');
    const terminator = argv.indexOf('--');
    expect(argv[terminator + 1]).toBe('deploy@10.0.0.21');
    expect(argv[argv.length - 1]).toBe("tmux attach-session -d -t '%3'");
    expect(argv.filter((a) => a === '--')).toHaveLength(1);
  });
});
