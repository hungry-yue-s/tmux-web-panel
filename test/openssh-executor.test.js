import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  OpenSSHExecutor,
  baseSshOptions,
  buildSshArgs,
  classifySshError,
  controlSocketName,
  fingerprintFromBase64Key,
  keyBlobAlgorithm,
  knownHostsEntryName,
  normalizeHostForCompare,
  parseKeyscanOutput,
  parseSshConfigDump,
  powerShellCommand,
  quoteArgv,
  shellQuote,
  targetIdentity,
} from '../server/transport/openssh-executor.js';
import { ErrorCode } from '../server/servers/errors.js';

const REMOTE = {
  id: 'api-linux',
  kind: 'remote',
  name: 'API Linux',
  address: { host: '10.0.0.21', port: 22, user: 'deploy' },
  ssh: { configHost: null, identityFile: null, proxyJump: null, knownHostAlias: null },
};

/** A real ed25519 public key blob, so fingerprints and blob types are genuine. */
const ED25519_KEY = 'AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyBytesForTesting012345678=';
const RSA_KEY_HEADER = Buffer.concat([
  Buffer.from([0, 0, 0, 7]),
  Buffer.from('ssh-rsa'),
  Buffer.from([0, 0, 0, 1, 35]),
]).toString('base64');

function makeKeyBlob(algorithm) {
  const name = Buffer.from(algorithm);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(name.length, 0);
  return Buffer.concat([len, name, Buffer.from('payload-bytes')]).toString('base64');
}

/** execFile stub that dispatches on the binary and records argv. */
function stubExecFile(handlers = {}) {
  const calls = [];
  const impl = (bin, argv, options, callback) => {
    calls.push({ bin, argv, options });
    const handler = handlers[bin];
    const result = typeof handler === 'function' ? handler(argv) : handler;
    const stdout = result && result.stdout !== undefined ? result.stdout : '';
    const stderr = result && result.stderr !== undefined ? result.stderr : '';
    const err = result && result.error ? result.error : null;
    process.nextTick(() => callback(err, stdout, stderr));
    return { stdin: { end: vi.fn() } };
  };
  return { impl, calls };
}

describe('shellQuote / quoteArgv', () => {
  it('leaves safe words alone', () => {
    expect(shellQuote('tmux')).toBe('tmux');
    expect(shellQuote('list-sessions')).toBe('list-sessions');
    expect(shellQuote('%12')).toBe('%12');
  });

  it('quotes anything a remote shell could reinterpret', () => {
    expect(shellQuote('')).toBe("''");
    expect(shellQuote('a b')).toBe("'a b'");
    expect(shellQuote('$(id)')).toBe("'$(id)'");
    expect(shellQuote('a;rm -rf /')).toBe("'a;rm -rf /'");
    expect(shellQuote('back`tick`')).toBe("'back`tick`'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it('keeps injected metacharacters inert once joined', () => {
    expect(quoteArgv(['tmux', 'rename-session', '-t', 'a; rm -rf /'])).toBe(
      "tmux rename-session -t 'a; rm -rf /'",
    );
  });
});

describe('baseSshOptions', () => {
  it('always fails closed on host keys and never prompts', () => {
    const options = baseSshOptions({ knownHostsPath: '/cfg/known_hosts', controlPath: '/cfg/ssh-control/%C' });
    expect(options).toContain('BatchMode=yes');
    expect(options).toContain('StrictHostKeyChecking=yes');
    expect(options).toContain('UserKnownHostsFile=/cfg/known_hosts');
    expect(options).toContain('ConnectTimeout=5');
    expect(options).toContain('ServerAliveInterval=15');
    expect(options).toContain('ServerAliveCountMax=2');
    expect(options).toContain('ControlMaster=auto');
    expect(options).toContain('ControlPersist=60');
    expect(options).toContain('ControlPath=/cfg/ssh-control/%C');
    expect(options.join(' ')).not.toMatch(/StrictHostKeyChecking=(no|accept-new)/);
  });
});

describe('powerShellCommand', () => {
  it('encodes the script as base64 of UTF-16LE', () => {
    const command = powerShellCommand('Write-Output "hi"');
    const encoded = command.split(' ').pop();

    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe('Write-Output "hi"');
  });

  it('leaves cmd.exe nothing to interpret', () => {
    // The whole point of -EncodedCommand: a Windows host answers with cmd.exe,
    // whose quoting rules share nothing with POSIX.
    const command = powerShellCommand('Write-Output "a b"; $x = 1 | Out-Null & echo %PATH%');

    expect(command).toMatch(/^pwsh (?:-[A-Za-z]+ )+-EncodedCommand [A-Za-z0-9+/=]+$/);
    expect(command).not.toMatch(/["'&|<>%^]/);
  });

  it('keeps an interactive session open but a probe non-interactive', () => {
    expect(powerShellCommand('x', { interactive: true })).toContain('-NoExit');
    expect(powerShellCommand('x', { interactive: true })).not.toContain('-NonInteractive');
    expect(powerShellCommand('x')).toContain('-NonInteractive');
    expect(powerShellCommand('x')).not.toContain('-NoExit');
  });

  it('carries a UTF-8 encoding setup for interactive shells', () => {
    const executor = new OpenSSHExecutor({ server: REMOTE, configDir: '/cfg' });
    const argv = executor.powerShellPtyArgs();
    const script = Buffer.from(argv[argv.length - 1].split(' ').pop(), 'base64').toString('utf16le');

    expect(argv[0]).toBe('-tt');
    // Without this the console keeps the legacy code page and the browser
    // terminal, which decodes UTF-8, shows garbage.
    expect(script).toContain('UTF8Encoding');
  });
});

describe('control socket path', () => {
  /** macOS sun_path limit, minus the temp suffix ssh adds while creating the master. */
  const BINDABLE_MAX = 104 - 17;

  it('stays bindable under a realistic config dir', () => {
    const configDir = path.join(os.homedir(), '.config', 'tmux-web-panel');
    const executor = new OpenSSHExecutor({ server: REMOTE, configDir });

    expect(executor.controlPath).not.toBeNull();
    expect(executor.controlPath.length).toBeLessThanOrEqual(BINDABLE_MAX);
    // %C alone expands to 40 hex chars and was what overran the limit.
    expect(executor.controlPath).not.toContain('%C');
  });

  it('changes when the connection target changes', () => {
    const base = controlSocketName(REMOTE);
    const otherHost = controlSocketName({ ...REMOTE, address: { ...REMOTE.address, host: '10.0.0.22' } });
    const otherPort = controlSocketName({ ...REMOTE, address: { ...REMOTE.address, port: 2222 } });
    const otherUser = controlSocketName({ ...REMOTE, address: { ...REMOTE.address, user: 'root' } });
    const otherJump = controlSocketName({ ...REMOTE, ssh: { ...REMOTE.ssh, proxyJump: 'bastion' } });

    expect(new Set([base, otherHost, otherPort, otherUser, otherJump]).size).toBe(5);
  });

  it('is unchanged by a rename, so multiplexing survives it', () => {
    expect(controlSocketName({ ...REMOTE, name: 'Renamed', id: 'renamed' })).toBe(controlSocketName(REMOTE));
  });

  it('drops multiplexing rather than failing every connection when unbindable', () => {
    const configDir = '/' + 'd'.repeat(120);
    const executor = new OpenSSHExecutor({ server: REMOTE, configDir });

    expect(executor.controlPath).toBeNull();
    expect(executor.sshArgs().join(' ')).not.toContain('ControlMaster');
  });
});

describe('buildSshArgs', () => {
  const opts = { knownHostsPath: '/cfg/known_hosts', controlPath: '/cfg/ssh-control/%C' };

  it('builds a user@host target with structured fields', () => {
    const args = buildSshArgs(REMOTE, opts);
    expect(args[0]).toBe('-T');
    expect(args[args.length - 1]).toBe('deploy@10.0.0.21');
    expect(args).not.toContain('-p'); // port 22 is implicit
  });

  it('passes a non-default port and identity file', () => {
    const args = buildSshArgs(
      { ...REMOTE, address: { ...REMOTE.address, port: 2222 }, ssh: { ...REMOTE.ssh, identityFile: '/keys/id_ed25519' } },
      opts,
    );
    expect(args).toEqual(expect.arrayContaining(['-p', '2222', '-i', '/keys/id_ed25519']));
  });

  it('uses the ssh config alias as the only target', () => {
    const args = buildSshArgs(
      { ...REMOTE, address: { host: 'ignored.example', port: 2222, user: 'ignored' }, ssh: { ...REMOTE.ssh, configHost: 'build-mac' } },
      opts,
    );
    expect(args[args.length - 1]).toBe('build-mac');
    expect(args).not.toContain('-p');
    expect(args.join(' ')).not.toContain('ignored');
  });

  it('passes HostKeyAlias through to ssh so known_hosts keys line up', () => {
    const args = buildSshArgs({ ...REMOTE, ssh: { ...REMOTE.ssh, knownHostAlias: 'api-canonical' } }, opts);
    expect(args).toEqual(expect.arrayContaining(['-o', 'HostKeyAlias=api-canonical']));
  });

  it('requests a tty only when asked', () => {
    expect(buildSshArgs(REMOTE, { ...opts, tty: true })[0]).toBe('-tt');
    expect(buildSshArgs(REMOTE, opts)[0]).toBe('-T');
  });

  it('refuses the local record', () => {
    expect(() => buildSshArgs({ kind: 'local' }, opts)).toThrow(/remote server/);
  });
});

describe('knownHostsEntryName', () => {
  it('brackets the host only for non-default ports', () => {
    expect(knownHostsEntryName({ host: 'example.com', port: 22 })).toBe('example.com');
    expect(knownHostsEntryName({ host: 'example.com', port: 2222 })).toBe('[example.com]:2222');
    expect(knownHostsEntryName({ host: '[2001:db8::1]', port: 2222 })).toBe('[2001:db8::1]:2222');
  });

  it('prefers an explicit HostKeyAlias verbatim', () => {
    expect(knownHostsEntryName({ host: 'example.com', port: 2222, hostKeyAlias: 'canon' })).toBe('canon');
  });
});

describe('targetIdentity', () => {
  const base = { host: '10.0.0.21', port: 22, hostKeyAlias: 'canon' };

  it('changes when the host moves behind a stable alias', () => {
    expect(targetIdentity(base)).not.toBe(targetIdentity({ ...base, host: '10.0.0.99' }));
  });

  it('changes when the port moves behind a stable alias', () => {
    expect(targetIdentity(base)).not.toBe(targetIdentity({ ...base, port: 2222 }));
  });

  it('changes when the alias itself changes', () => {
    expect(targetIdentity(base)).not.toBe(targetIdentity({ ...base, hostKeyAlias: 'other' }));
  });

  it('treats equivalent host spellings as the same target', () => {
    expect(normalizeHostForCompare('[2001:DB8::1]')).toBe('2001:db8::1');
    expect(targetIdentity({ host: '[2001:db8::1]', port: 22 })).toBe(
      targetIdentity({ host: '2001:DB8::1', port: 22 }),
    );
    expect(targetIdentity({ host: 'h' })).toBe(targetIdentity({ host: 'h', port: 22 }));
  });
});

describe('key blob helpers', () => {
  it('reads the algorithm out of the blob', () => {
    expect(keyBlobAlgorithm(makeKeyBlob('ssh-ed25519'))).toBe('ssh-ed25519');
    expect(keyBlobAlgorithm(RSA_KEY_HEADER)).toBe('ssh-rsa');
    expect(keyBlobAlgorithm('bm90LWEta2V5')).toBeNull();
    expect(keyBlobAlgorithm('')).toBeNull();
  });

  it('computes OpenSSH-style SHA256 fingerprints without padding', () => {
    const fp = fingerprintFromBase64Key(makeKeyBlob('ssh-ed25519'));
    expect(fp).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(fp).not.toContain('=');
  });
});

describe('parseKeyscanOutput', () => {
  it('keeps well-formed keys and drops comments', () => {
    const blob = makeKeyBlob('ssh-ed25519');
    const out = ['# comment', `10.0.0.21 ssh-ed25519 ${blob}`, ''].join('\n');
    const keys = parseKeyscanOutput(out);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ scannedHost: '10.0.0.21', algorithm: 'ssh-ed25519', base64Key: blob });
    expect(keys[0].fingerprint).toMatch(/^SHA256:/);
  });

  it('rejects unknown algorithms and blobs that lie about their type', () => {
    const ed = makeKeyBlob('ssh-ed25519');
    const out = [
      `h ssh-dss ${makeKeyBlob('ssh-dss')}`,
      `h ssh-rsa ${ed}`,
      'h ssh-ed25519 not-base64!!',
      'h onlytwofields',
    ].join('\n');
    expect(parseKeyscanOutput(out)).toEqual([]);
  });
});

describe('parseSshConfigDump', () => {
  it('parses ssh -G output and keeps the first value per keyword', () => {
    const config = parseSshConfigDump(['user deploy', 'hostname 10.9.9.9', 'port 2202', 'hostkeyalias canon', 'port 22'].join('\n'));
    expect(config).toMatchObject({ user: 'deploy', hostname: '10.9.9.9', port: '2202', hostkeyalias: 'canon' });
  });
});

describe('classifySshError', () => {
  const cases = [
    ['Permission denied (publickey).', ErrorCode.SSH_AUTH_REQUIRED],
    ['deploy@h: Permission denied (publickey,password).', ErrorCode.SSH_AUTH_REQUIRED],
    ['Too many authentication failures', ErrorCode.SSH_AUTH_REQUIRED],
    ['@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@', ErrorCode.SSH_HOST_KEY_CHANGED],
    ['Host key verification failed.', ErrorCode.SSH_HOST_KEY_UNKNOWN],
    ['No ED25519 host key is known for h and you have requested strict checking.', ErrorCode.SSH_HOST_KEY_UNKNOWN],
    ['ssh: connect to host h port 22: Connection timed out', ErrorCode.SSH_TIMEOUT],
    ['ssh: connect to host h port 22: Connection refused', ErrorCode.SERVER_OFFLINE],
    ['ssh: Could not resolve hostname h: Name or service not known', ErrorCode.SERVER_OFFLINE],
    ['ssh: connect to host h port 22: No route to host', ErrorCode.SERVER_OFFLINE],
  ];

  for (const [stderr, expected] of cases) {
    it(`maps ${JSON.stringify(stderr.slice(0, 42))} to ${expected}`, () => {
      expect(classifySshError({ stderr }).code).toBe(expected);
    });
  }

  it('reports a changed key when an entry already exists', () => {
    const err = classifySshError({ stderr: 'Host key verification failed.' }, { knownHostEntryExists: true });
    expect(err.code).toBe(ErrorCode.SSH_HOST_KEY_CHANGED);
  });

  it('treats a killed process as a timeout', () => {
    expect(classifySshError({ killed: true, signal: 'SIGTERM', stderr: '' }).code).toBe(ErrorCode.SSH_TIMEOUT);
  });

  it('reports a missing ssh client distinctly', () => {
    expect(classifySshError({ code: 'ENOENT', stderr: '' }).code).toBe(ErrorCode.INTERNAL);
  });

  it('never echoes more than a bounded stderr tail', () => {
    const err = classifySshError({ stderr: 'x'.repeat(50_000) });
    expect(err.message.length).toBeLessThan(200);
  });
});

describe('OpenSSHExecutor', () => {
  let dir;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openssh-exec-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function make(server = REMOTE, handlers = {}, extra = {}) {
    const { impl, calls } = stubExecFile(handlers);
    const executor = new OpenSSHExecutor({ server, configDir: dir, execFileImpl: impl, ...extra });
    return { executor, calls };
  }

  it('requires a server and a configDir', () => {
    expect(() => new OpenSSHExecutor({ configDir: dir })).toThrow(/requires a server/);
    expect(() => new OpenSSHExecutor({ server: REMOTE })).toThrow(/configDir/);
  });

  it('runs a remote tmux command with quoted argv and no local shell', async () => {
    const { executor, calls } = make(REMOTE, { ssh: { stdout: 'ok' } });

    const result = await executor.exec('tmux', ['list-sessions', '-F', '#{session_id}']);

    expect(result.stdout).toBe('ok');
    expect(calls).toHaveLength(1);
    expect(calls[0].bin).toBe('ssh');
    expect(Array.isArray(calls[0].argv)).toBe(true);
    // The terminator belongs before the destination; the command is last.
    const argv = calls[0].argv;
    expect(argv[argv.indexOf('--') + 1]).toBe('deploy@10.0.0.21');
    expect(argv[argv.length - 1]).toBe("LC_ALL=C.UTF-8 LANG=C.UTF-8 tmux list-sessions -F '#{session_id}'");
  });

  it('creates the control directory with 0700 and tightens an existing one', async () => {
    const controlDir = path.join(dir, 'ssh-control');
    await fs.mkdir(controlDir, { recursive: true, mode: 0o777 });
    await fs.chmod(controlDir, 0o777);

    const { executor } = make(REMOTE, { ssh: { stdout: '' } });
    await executor.exec('tmux', ['-V']);

    expect((await fs.stat(controlDir)).mode & 0o777).toBe(0o700);
  });

  it('classifies a failed command and keeps the exit code', async () => {
    const err = Object.assign(new Error('exit 255'), { code: 255 });
    const { executor } = make(REMOTE, { ssh: { error: err, stderr: 'Permission denied (publickey).' } });

    await expect(executor.exec('tmux', ['-V'])).rejects.toMatchObject({
      code: ErrorCode.SSH_AUTH_REQUIRED,
      exitCode: 255,
    });
  });

  it('feeds a probe script over stdin instead of writing remote files', async () => {
    const { executor, calls } = make(REMOTE, { ssh: { stdout: '{"schema":1}' } });

    await executor.runScript('echo hi');

    expect(calls[0].argv[calls[0].argv.length - 1]).toBe('LC_ALL=C.UTF-8 LANG=C.UTF-8 /bin/sh -s');
  });

  it('sends a Windows probe without a POSIX locale prefix', async () => {
    const { executor, calls } = make(REMOTE, { ssh: { stdout: 'kernel=Windows' } });

    await executor.execPowerShell('Write-Output "hi"');

    const remoteCommand = calls[0].argv[calls[0].argv.length - 1];
    expect(remoteCommand.startsWith('pwsh ')).toBe(true);
    // cmd.exe would treat LC_ALL=... as the name of a program to run.
    expect(remoteCommand).not.toContain('LC_ALL');
  });

  it('closes stdin even when there is no input to send', async () => {
    const ends = [];
    const impl = (bin, argv, options, callback) => {
      process.nextTick(() => callback(null, 'ok', ''));
      return { stdin: { end: (data) => ends.push(data) } };
    };
    const executor = new OpenSSHExecutor({ server: REMOTE, configDir: dir, execFileImpl: impl });

    await executor.exec('tmux', ['-V']);

    // Without an EOF a remote command reading stdin would wait for the timeout.
    expect(ends).toEqual(['']);
  });

  it('builds pty argv with -tt for interactive attach', () => {
    const { executor } = make();
    const argv = executor.ptyArgs('tmux attach-session -d -t %3');
    expect(argv[0]).toBe('-tt');
    expect(argv[argv.length - 1]).toBe('tmux attach-session -d -t %3');
  });

  describe('resolveTarget', () => {
    it('uses record fields when there is no config alias', async () => {
      const { executor, calls } = make({ ...REMOTE, address: { ...REMOTE.address, port: 2222 } });
      await expect(executor.resolveTarget()).resolves.toMatchObject({
        host: '10.0.0.21',
        port: 2222,
        source: 'record',
      });
      expect(calls).toHaveLength(0); // no ssh invocation needed
    });

    it('expands a ssh config alias via ssh -G', async () => {
      const { executor, calls } = make(
        { ...REMOTE, address: { host: null, port: null, user: null }, ssh: { ...REMOTE.ssh, configHost: 'build-mac' } },
        { ssh: { stdout: ['hostname 30.166.3.252', 'port 2202', 'user yuebiao'].join('\n') } },
      );

      await expect(executor.resolveTarget()).resolves.toMatchObject({
        host: '30.166.3.252',
        port: 2202,
        source: 'ssh-config',
      });
      expect(calls[0].argv).toEqual(['-G', 'build-mac']);
    });

    it('honors hostkeyalias from ssh config', async () => {
      const { executor } = make(
        { ...REMOTE, ssh: { ...REMOTE.ssh, configHost: 'build-mac' } },
        { ssh: { stdout: ['hostname 10.1.1.1', 'port 22', 'hostkeyalias canon'].join('\n') } },
      );
      await expect(executor.resolveTarget()).resolves.toMatchObject({ hostKeyAlias: 'canon' });
    });

    it('lets an explicit record alias win over ssh config', async () => {
      const { executor } = make(
        { ...REMOTE, ssh: { ...REMOTE.ssh, configHost: 'build-mac', knownHostAlias: 'record-canon' } },
        { ssh: { stdout: ['hostname 10.1.1.1', 'hostkeyalias config-canon'].join('\n') } },
      );
      await expect(executor.resolveTarget()).resolves.toMatchObject({ hostKeyAlias: 'record-canon' });
    });

    it('fails when neither a host nor a resolvable alias exists', async () => {
      const { executor } = make({ ...REMOTE, address: { host: null } });
      await expect(executor.resolveTarget()).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    });
  });

  describe('scanHostKeys', () => {
    it('scans the resolved hostname, never the config alias', async () => {
      const blob = makeKeyBlob('ssh-ed25519');
      const { executor, calls } = make(
        { ...REMOTE, address: { host: null, port: null, user: null }, ssh: { ...REMOTE.ssh, configHost: 'build-mac' } },
        {
          ssh: { stdout: ['hostname 30.166.3.252', 'port 2202'].join('\n') },
          'ssh-keyscan': { stdout: `30.166.3.252 ssh-ed25519 ${blob}` },
        },
      );

      const result = await executor.scanHostKeys();

      const keyscanCall = calls.find((c) => c.bin === 'ssh-keyscan');
      expect(keyscanCall.argv).toEqual(['-T', '5', '-p', '2202', '30.166.3.252']);
      expect(keyscanCall.argv).not.toContain('build-mac');
      expect(result).toMatchObject({ host: '30.166.3.252', port: 2202, entryName: '[30.166.3.252]:2202' });
    });

    it('keys the entry by HostKeyAlias but scans the real host', async () => {
      const blob = makeKeyBlob('ssh-ed25519');
      const { executor, calls } = make(
        { ...REMOTE, ssh: { ...REMOTE.ssh, knownHostAlias: 'canon' } },
        { 'ssh-keyscan': { stdout: `10.0.0.21 ssh-ed25519 ${blob}` } },
      );

      const result = await executor.scanHostKeys();

      expect(calls[0].argv).toEqual(['-T', '5', '10.0.0.21']);
      expect(result.entryName).toBe('canon');
    });

    it('returns only algorithm and fingerprint for confirmation', async () => {
      const blob = makeKeyBlob('ssh-ed25519');
      const { executor } = make(REMOTE, { 'ssh-keyscan': { stdout: `10.0.0.21 ssh-ed25519 ${blob}` } });

      const result = await executor.scanHostKeys();

      expect(result.keys).toEqual([{ algorithm: 'ssh-ed25519', fingerprint: fingerprintFromBase64Key(blob) }]);
      expect(JSON.stringify(result.keys)).not.toContain(blob);
    });

    it('reports offline when no keys come back', async () => {
      const { executor } = make(REMOTE, { 'ssh-keyscan': { stdout: '# 10.0.0.21:22 nothing\n' } });
      await expect(executor.scanHostKeys()).rejects.toMatchObject({ code: ErrorCode.SERVER_OFFLINE });
    });
  });

  describe('trustHostKey', () => {
    const blob = makeKeyBlob('ssh-ed25519');
    const fingerprint = fingerprintFromBase64Key(blob);

    async function scanned(server = REMOTE, extra = {}) {
      const made = make(server, { 'ssh-keyscan': { stdout: `10.0.0.21 ssh-ed25519 ${blob}` } }, extra);
      await made.executor.scanHostKeys();
      return made;
    }

    it('writes only the confirmed candidate, with 0600 permissions', async () => {
      const { executor } = await scanned();

      const result = await executor.trustHostKey(fingerprint);

      expect(result).toMatchObject({ entryName: '10.0.0.21', algorithm: 'ssh-ed25519', fingerprint });
      const content = await fs.readFile(path.join(dir, 'known_hosts'), 'utf8');
      expect(content.trim()).toBe(`10.0.0.21 ssh-ed25519 ${blob}`);
      expect((await fs.stat(path.join(dir, 'known_hosts'))).mode & 0o777).toBe(0o600);
      expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    });

    it('tightens permissions on a pre-existing loose known_hosts', async () => {
      const knownHosts = path.join(dir, 'known_hosts');
      await fs.writeFile(knownHosts, '# existing\n', { mode: 0o644 });
      await fs.chmod(knownHosts, 0o644);

      const { executor } = await scanned();
      await executor.trustHostKey(fingerprint);

      expect((await fs.stat(knownHosts)).mode & 0o777).toBe(0o600);
    });

    it('refuses an arbitrary known_hosts line', async () => {
      const { executor } = await scanned();
      for (const bogus of [
        `10.0.0.21 ssh-ed25519 ${blob}`,
        'evil.example ssh-ed25519 AAAA',
        '* ssh-ed25519 AAAA',
        '',
        null,
      ]) {
        await expect(executor.trustHostKey(bogus)).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
      }
      await expect(fs.access(path.join(dir, 'known_hosts'))).rejects.toThrow();
    });

    it('refuses a fingerprint that was never scanned', async () => {
      const { executor } = await scanned();
      const other = fingerprintFromBase64Key(makeKeyBlob('ssh-rsa'));

      await expect(executor.trustHostKey(other)).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
        message: expect.stringMatching(/does not match any scanned/),
      });
    });

    it('requires a scan first', async () => {
      const { executor } = make();
      await expect(executor.trustHostKey(fingerprint)).rejects.toMatchObject({
        message: expect.stringMatching(/Scan the host key before trusting/),
      });
    });

    it('expires a stale scan', async () => {
      let now = 1_000_000;
      const { executor } = await scanned(REMOTE, { now: () => now });
      now += 11 * 60 * 1000;

      await expect(executor.trustHostKey(fingerprint)).rejects.toMatchObject({
        message: expect.stringMatching(/expired/),
      });
    });

    it('refuses when the connection changed after the scan', async () => {
      const { executor } = await scanned();
      executor.server = { ...REMOTE, address: { ...REMOTE.address, port: 2222 } };

      await expect(executor.trustHostKey(fingerprint)).rejects.toMatchObject({
        message: expect.stringMatching(/Connection changed/),
      });
    });

    it('refuses a host swap hidden behind an unchanged HostKeyAlias', async () => {
      const aliased = { ...REMOTE, ssh: { ...REMOTE.ssh, knownHostAlias: 'canon' } };
      const { executor } = make(aliased, { 'ssh-keyscan': { stdout: `10.0.0.21 ssh-ed25519 ${blob}` } });
      const scan = await executor.scanHostKeys();
      expect(scan.entryName).toBe('canon');

      // Same alias, different machine: entryName alone would not notice.
      executor.server = { ...aliased, address: { ...REMOTE.address, host: '10.0.0.99' } };

      await expect(executor.trustHostKey(fingerprint)).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
        message: expect.stringMatching(/Connection changed/),
      });
      await expect(fs.access(path.join(dir, 'known_hosts'))).rejects.toThrow();
    });

    it('refuses a port swap hidden behind an unchanged HostKeyAlias', async () => {
      const aliased = { ...REMOTE, ssh: { ...REMOTE.ssh, knownHostAlias: 'canon' } };
      const { executor } = make(aliased, { 'ssh-keyscan': { stdout: `10.0.0.21 ssh-ed25519 ${blob}` } });
      await executor.scanHostKeys();

      executor.server = { ...aliased, address: { ...REMOTE.address, port: 2222 } };

      await expect(executor.trustHostKey(fingerprint)).rejects.toMatchObject({
        message: expect.stringMatching(/Connection changed/),
      });
    });

    it('refuses when a ssh config alias now resolves elsewhere', async () => {
      const viaConfig = {
        ...REMOTE,
        address: { host: null, port: null, user: null },
        ssh: { ...REMOTE.ssh, configHost: 'build-mac' },
      };
      let hostname = '30.166.3.252';
      const { impl } = stubExecFile({
        ssh: () => ({ stdout: `hostname ${hostname}\nport 22\n` }),
        'ssh-keyscan': { stdout: `30.166.3.252 ssh-ed25519 ${blob}` },
      });
      const executor = new OpenSSHExecutor({ server: viaConfig, configDir: dir, execFileImpl: impl });
      await executor.scanHostKeys();

      hostname = '10.9.9.9'; // ~/.ssh/config edited between the two requests

      await expect(executor.trustHostKey(fingerprint)).rejects.toMatchObject({
        message: expect.stringMatching(/Connection changed/),
      });
    });

    it('accepts an equivalent target that only differs in formatting', async () => {
      const v6 = { ...REMOTE, address: { host: '[2001:db8::1]', port: 22, user: 'deploy' } };
      const { executor } = make(v6, { 'ssh-keyscan': { stdout: `2001:db8::1 ssh-ed25519 ${blob}` } });
      await executor.scanHostKeys();

      executor.server = { ...v6, address: { host: '2001:DB8::1', port: 22, user: 'deploy' } };

      await expect(executor.trustHostKey(fingerprint)).resolves.toMatchObject({ fingerprint });
    });

    it('never silently overwrites an existing entry', async () => {
      const knownHosts = path.join(dir, 'known_hosts');
      await fs.writeFile(knownHosts, `10.0.0.21 ssh-ed25519 ${makeKeyBlob('ssh-ed25519')}other\n`, 'utf8');
      const before = await fs.readFile(knownHosts, 'utf8');

      const { executor } = await scanned();

      await expect(executor.trustHostKey(fingerprint)).rejects.toMatchObject({
        code: ErrorCode.SSH_HOST_KEY_CHANGED,
      });
      expect(await fs.readFile(knownHosts, 'utf8')).toBe(before);
    });

    it('consumes the scan so a fingerprint cannot be replayed', async () => {
      const { executor } = await scanned();
      await executor.trustHostKey(fingerprint);

      await expect(executor.trustHostKey(fingerprint)).rejects.toMatchObject({
        message: expect.stringMatching(/Scan the host key before trusting/),
      });
    });
  });

  describe('hasKnownHostEntry', () => {
    it('matches the entry name including hashed-port form', async () => {
      const blob = makeKeyBlob('ssh-ed25519');
      await fs.writeFile(path.join(dir, 'known_hosts'), `[10.0.0.21]:2222 ssh-ed25519 ${blob}\n`, 'utf8');

      const { executor } = make({ ...REMOTE, address: { ...REMOTE.address, port: 2222 } });
      await expect(executor.hasKnownHostEntry()).resolves.toBe(true);

      const { executor: other } = make(REMOTE);
      await expect(other.hasKnownHostEntry()).resolves.toBe(false);
    });

    it('matches one host inside a comma-separated entry', async () => {
      const blob = makeKeyBlob('ssh-ed25519');
      await fs.writeFile(path.join(dir, 'known_hosts'), `other.example,10.0.0.21 ssh-ed25519 ${blob}\n`, 'utf8');
      const { executor } = make(REMOTE);
      await expect(executor.hasKnownHostEntry()).resolves.toBe(true);
    });

    it('returns false when the file is missing', async () => {
      const { executor } = make(REMOTE);
      await expect(executor.hasKnownHostEntry()).resolves.toBe(false);
    });
  });

  it('bounds concurrent ssh processes per server', async () => {
    let active = 0;
    let peak = 0;
    const impl = (bin, argv, options, callback) => {
      active += 1;
      peak = Math.max(peak, active);
      setTimeout(() => {
        active -= 1;
        callback(null, 'ok', '');
      }, 5);
      return { stdin: { end: () => {} } };
    };
    const executor = new OpenSSHExecutor({ server: REMOTE, configDir: dir, execFileImpl: impl, maxConcurrent: 2 });

    await Promise.all(Array.from({ length: 8 }, () => executor.exec('tmux', ['-V'])));

    expect(peak).toBeLessThanOrEqual(2);
  });
});
