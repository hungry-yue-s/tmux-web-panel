import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';
import { ServerRegistry } from '../server/servers/registry.js';

import {
  SshConnection,
  baseSshOptions,
  buildSshArgs,
  classifySshError,
  connectionKey,
  forwardSpec,
  sshPtyBinary,
  fingerprintFromBase64Key,
  keyBlobAlgorithm,
  knownHostsEntryName,
  normalizeHostForCompare,
  parseKeyscanOutput,
  parseSshConfigDump,
  targetIdentity,
} from '../server/transport/ssh-connection.js';
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

describe('baseSshOptions', () => {
  it('always fails closed on host keys and never prompts', () => {
    const options = baseSshOptions({ knownHostsPath: '/cfg/known_hosts' });
    expect(options).toContain('BatchMode=yes');
    expect(options).toContain('StrictHostKeyChecking=yes');
    expect(options).toContain('UserKnownHostsFile=/cfg/known_hosts');
    expect(options).toContain('ConnectTimeout=5');
    expect(options).toContain('ServerAliveInterval=15');
    expect(options).toContain('ServerAliveCountMax=2');
    // One forward per server replaces multiplexing.
    expect(options.join(' ')).not.toContain('ControlMaster');
    expect(options.join(' ')).not.toMatch(/StrictHostKeyChecking=(no|accept-new)/);
  });
});

describe('connectionKey', () => {
  it('changes when the connection target changes', () => {
    const base = connectionKey(REMOTE);
    const otherHost = connectionKey({ ...REMOTE, address: { ...REMOTE.address, host: '10.0.0.22' } });
    const otherPort = connectionKey({ ...REMOTE, address: { ...REMOTE.address, port: 2222 } });
    const otherUser = connectionKey({ ...REMOTE, address: { ...REMOTE.address, user: 'root' } });
    const otherJump = connectionKey({ ...REMOTE, ssh: { ...REMOTE.ssh, proxyJump: 'bastion' } });

    expect(new Set([base, otherHost, otherPort, otherUser, otherJump]).size).toBe(5);
  });

  it('is unchanged by a rename, so an open forward survives it', () => {
    expect(connectionKey({ ...REMOTE, name: 'Renamed', id: 'renamed' })).toBe(connectionKey(REMOTE));
  });
});

describe('buildSshArgs', () => {
  const opts = { knownHostsPath: '/cfg/known_hosts' };

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

  it('spells the port the sftp way and keeps the user in the destination', () => {
    const server = { ...REMOTE, address: { ...REMOTE.address, port: 2222 } };
    const args = buildSshArgs(server, { ...opts, tool: 'sftp', trailing: ['-b', '-'] });
    expect(args.slice(-4)).toEqual(['-b', '-', '--', 'deploy@10.0.0.21']);
    expect(args).toEqual(expect.arrayContaining(['-P', '2222']));
    expect(args).not.toContain('-p');
    expect(args).not.toContain('-T');
    expect(args.at(-1)).toBe('deploy@10.0.0.21');
  });

  it('passes a password user for a config alias as -o User for sftp and -l for ssh', () => {
    const server = { ...REMOTE, ssh: { ...REMOTE.ssh, configHost: 'win-box', authMethod: 'password' } };
    expect(buildSshArgs(server, { ...opts, tool: 'sftp' })).toEqual(expect.arrayContaining(['-o', 'User=deploy']));
    expect(buildSshArgs(server, opts)).toEqual(expect.arrayContaining(['-l', 'deploy']));
  });

  it('puts leading flags such as -N -L before every option', () => {
    const args = buildSshArgs(REMOTE, { ...opts, leading: ['-N', '-L', forwardSpec(41000, '127.0.0.1', 7681)] });
    expect(args.slice(0, 3)).toEqual(['-N', '-L', '127.0.0.1:41000:127.0.0.1:7681']);
    expect(args.at(-1)).toBe('deploy@10.0.0.21');
  });

  it('refuses the local record', () => {
    expect(() => buildSshArgs({ kind: 'local' }, opts)).toThrow(/remote server/);
  });
});

describe('forwardSpec', () => {
  it('binds the local end to loopback and brackets an IPv6 target', () => {
    expect(forwardSpec(41000, '127.0.0.1', 7681)).toBe('127.0.0.1:41000:127.0.0.1:7681');
    expect(forwardSpec(41000, '::1', 7681)).toBe('127.0.0.1:41000:[::1]:7681');
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

describe('SshConnection', () => {
  let dir;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openssh-exec-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function make(server = REMOTE, handlers = {}, extra = {}) {
    const { impl, calls } = stubExecFile(handlers);
    const executor = new SshConnection({ server, configDir: dir, execFileImpl: impl, ...extra });
    return { executor, calls };
  }

  it('requires a server and a configDir', () => {
    expect(() => new SshConnection({ configDir: dir })).toThrow(/requires a server/);
    expect(() => new SshConnection({ server: REMOTE })).toThrow(/configDir/);
  });

  const PAIRING = {
    protocol: 1,
    host: '127.0.0.1',
    port: 7681,
    tls: false,
    tlsFingerprint: null,
    token: 'a'.repeat(64),
  };

  /** sftp stub: writes the pairing file to the local path named in the batch. */
  function sftpServing(content) {
    return (_argv, input) => {
      const local = /get "[^"]+" "([^"]+)"/.exec(input)[1];
      return { write: { path: local, content } };
    };
  }

  /** execFile stub that answers once stdin is closed, like sftp -b - does. */
  function makeWithStdin(server, handler) {
    const calls = [];
    const impl = (bin, argv, options, callback) => {
      const call = { bin, argv, options, input: null };
      calls.push(call);
      return {
        stdin: {
          end: (input) => {
            call.input = input;
            const result = handler(argv, input) || {};
            const done = () => callback(result.error || null, result.stdout || '', result.stderr || '');
            if (result.write) fs.writeFile(result.write.path, result.write.content).then(done);
            else process.nextTick(done);
          },
        },
      };
    };
    return { connection: new SshConnection({ server, configDir: dir, execFileImpl: impl }), calls };
  }

  it('reads the pairing file over sftp, never with a remote command', async () => {
    const { connection, calls } = makeWithStdin(REMOTE, sftpServing(JSON.stringify(PAIRING)));

    await expect(connection.fetchPairing()).resolves.toEqual(PAIRING);

    expect(calls).toHaveLength(1);
    expect(calls[0].bin).toBe('sftp');
    expect(calls[0].argv.slice(-4, -2)).toEqual(['-b', '-']);
    expect(calls[0].argv.at(-1)).toBe('deploy@10.0.0.21');
    // The relative path resolves against the login directory on any shell or OS.
    expect(calls[0].input).toMatch(/^get "\.config\/tmux-web-panel\/node\.json" "[^"]+"\n$/);
  });

  it('reports a host without the pairing file as not installed', async () => {
    const missing = Object.assign(new Error('exit 1'), { code: 1 });
    const { connection } = makeWithStdin(REMOTE, () => ({
      error: missing,
      stderr: 'File "/home/deploy/.config/tmux-web-panel/node.json" not found.',
    }));

    await expect(connection.fetchPairing()).rejects.toMatchObject({ code: ErrorCode.NODE_NOT_INSTALLED });
  });

  it('classifies an ssh failure during pairing', async () => {
    const { connection } = makeWithStdin(REMOTE, () => ({
      error: Object.assign(new Error('exit 255'), { code: 255 }),
      stderr: 'Host key verification failed.',
    }));

    await expect(connection.fetchPairing()).rejects.toMatchObject({ code: ErrorCode.SSH_HOST_KEY_UNKNOWN });
  });

  it('refuses a pairing file that does not validate', async () => {
    const { connection } = makeWithStdin(REMOTE, sftpServing(JSON.stringify({ ...PAIRING, token: 'short' })));

    await expect(connection.fetchPairing()).rejects.toMatchObject({ code: ErrorCode.NODE_INCOMPATIBLE });
  });

  it('runs a script as `sh -s` with the script on stdin', async () => {
    const { connection, calls } = makeWithStdin(REMOTE, () => ({ stdout: 'ok' }));
    await expect(connection.runScript('echo "$HOME"\n')).resolves.toMatchObject({ stdout: 'ok' });
    expect(calls[0].bin).toBe('ssh');
    // Two plain words: nothing for cmd, PowerShell or fish to reinterpret.
    expect(calls[0].argv.slice(-3)).toEqual(['deploy@10.0.0.21', 'sh', '-s']);
    expect(calls[0].input).toBe('echo "$HOME"\n');
  });

  it('keeps stderr for a script failure but classifies an ssh failure', async () => {
    const scriptFailure = Object.assign(new Error('exit 1'), { code: 1 });
    const { connection } = makeWithStdin(REMOTE, () => ({ error: scriptFailure, stderr: "can't find pane: %9" }));
    await expect(connection.runScript('x')).rejects.toMatchObject({ code: 1, stderr: "can't find pane: %9" });

    const sshFailure = Object.assign(new Error('exit 255'), { code: 255 });
    const second = makeWithStdin(REMOTE, () => ({ error: sshFailure, stderr: 'Permission denied (publickey).' }));
    await expect(second.connection.runScript('x')).rejects.toMatchObject({ code: ErrorCode.SSH_AUTH_REQUIRED });
  });

  it('uploads a file with parent directories and a mode in one sftp batch', async () => {
    const { connection, calls } = makeWithStdin(REMOTE, () => ({}));
    await connection.uploadFile('C:\\tmp\\a.sh', '.cache/tmux-web-panel/attach-3-0', { mode: '755' });
    expect(calls[0].bin).toBe('sftp');
    expect(calls[0].input.split('\n')).toEqual([
      '-mkdir ".cache"',
      '-mkdir ".cache/tmux-web-panel"',
      'put "C:/tmp/a.sh" ".cache/tmux-web-panel/attach-3-0"',
      'chmod 755 ".cache/tmux-web-panel/attach-3-0"',
      '',
    ]);
  });

  it('builds a pty with no remote command, or exactly one plain word', () => {
    const connection = new SshConnection({ server: REMOTE, configDir: dir });
    expect(connection.ptyArgs()[0]).toBe('-tt');
    expect(connection.ptyArgs().at(-1)).toBe('deploy@10.0.0.21');
    expect(connection.ptyArgs('.cache/tmux-web-panel/attach-3-0').at(-1)).toBe('.cache/tmux-web-panel/attach-3-0');
    for (const bad of ['sh -c x', 'a;b', "x'y", 'a"b']) expect(() => connection.ptyArgs(bad)).toThrow();
  });

  it('streams only plain remote words', () => {
    const connection = new SshConnection({ server: REMOTE, configDir: dir, spawnImpl: vi.fn() });
    expect(() => connection.stream(['sh', '-c', 'rm -rf ~'])).toThrow();
    expect(() => connection.stream(['sh;id'])).toThrow();
  });

  it('names the system OpenSSH client for a pty on Windows', () => {
    expect(sshPtyBinary({ platform: 'darwin' })).toBe('ssh');
    expect(sshPtyBinary({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, exists: () => true }))
      .toBe(path.join('C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe'));
    expect(sshPtyBinary({ platform: 'win32', env: {}, exists: () => false })).toBe('ssh.exe');
  });

  it('starts the forward as ssh -N -L with ExitOnForwardFailure and no remote command', () => {
    const spawned = [];
    const connection = new SshConnection({
      server: REMOTE,
      configDir: dir,
      spawnImpl: (bin, argv, options) => {
        spawned.push({ bin, argv, options });
        const child = new EventEmitter();
        child.stderr = new EventEmitter();
        return child;
      },
    });

    connection.openForward({ localPort: 41000, remoteHost: '127.0.0.1', remotePort: 7681 });

    expect(spawned[0].bin).toBe('ssh');
    expect(spawned[0].argv.slice(0, 3)).toEqual(['-N', '-L', '127.0.0.1:41000:127.0.0.1:7681']);
    expect(spawned[0].argv).toEqual(expect.arrayContaining(['ExitOnForwardFailure=yes', 'StrictHostKeyChecking=yes']));
    expect(spawned[0].argv.at(-1)).toBe('deploy@10.0.0.21');
  });

  it('puts sftp -b after BatchMode=no so a password login is not refused', async () => {
    // sftp -b injects "-oBatchMode yes" where it appears and ssh keeps the
    // first value, which silently disabled password logins during pairing.
    const server = { ...REMOTE, ssh: { ...REMOTE.ssh, authMethod: 'password' } };
    const { connection, calls } = makeWithStdin(server, sftpServing(JSON.stringify(PAIRING)));
    await connection.fetchPairing();

    const argv = calls[0].argv;
    expect(argv.indexOf('BatchMode=no')).toBeGreaterThan(-1);
    expect(argv.indexOf('-b')).toBeGreaterThan(argv.indexOf('BatchMode=no'));
    expect(argv).not.toContain('BatchMode=yes');
  });

  it('uses password auth and local askpass for pairing and the forward without leaking the password', async () => {
    const password = '  密码 $()`\\"  ';
    const registry = await new ServerRegistry({ configDir: dir }).load();
    const server = await registry.create({ ...REMOTE, ssh: { authMethod: 'password', password } });
    const { connection: executor, calls } = makeWithStdin(server, sftpServing(JSON.stringify(PAIRING)));
    await executor.fetchPairing();
    const forwardArgv = buildSshArgs(server, { knownHostsPath: executor.knownHostsPath, leading: ['-N'] });
    for (const argv of [calls[0].argv, forwardArgv]) {
      expect(argv).toContain('BatchMode=no');
      expect(argv).toContain('PreferredAuthentications=password,keyboard-interactive');
      expect(argv).toContain('NumberOfPasswordPrompts=1');
      expect(argv).toContain('StrictHostKeyChecking=yes');
      expect(argv.join(' ')).not.toContain(password);
    }
    expect(calls[0].options.env.SSH_ASKPASS_REQUIRE).toBe('force');
    expect(JSON.stringify(executor.sshEnv())).not.toContain(password);
    const env = { ...process.env, ...executor.sshEnv() };
    const invoke = () => promisify(execFileCallback)(env.SSH_ASKPASS, [], { env });
    expect((await invoke()).stdout).toBe(password + '\n');
    await registry.update(server.id, { ssh: { password: 'replacement' } });
    // An in-flight old connection cannot obtain credentials from a later edit.
    await expect(invoke()).rejects.toMatchObject({ code: 1, stdout: '', stderr: '' });
    expect(connectionKey(registry.require(server.id))).not.toBe(connectionKey(server));
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
    it('falls back to an unauthenticated SSH handshake without trusting the candidate', async () => {
      const blob = makeKeyBlob('ssh-ed25519');
      let candidatePath;
      const server = { ...REMOTE, ssh: { ...REMOTE.ssh, authMethod: 'password', password: 'unused-password' } };
      const { executor, calls } = make(server, {
        'ssh-keyscan': { error: new Error('Broken pipe') },
        ssh: (argv) => {
          candidatePath = argv.find((arg) => arg.startsWith('UserKnownHostsFile=')).split('=')[1];
          return { error: Object.assign(new Error('auth deliberately refused'), { code: 255 }), stderr: 'Permission denied' };
        },
      });
      const original = executor._execFile;
      executor._execFile = (bin, argv, options, callback) => original(bin, argv, options, (err, out, stderr) => {
        if (bin === 'ssh') fs.writeFile(candidatePath, `10.0.0.21 ssh-ed25519 ${blob}\n`).then(() => callback(err, out, stderr));
        else callback(err, out, stderr);
      });
      const scan = await executor.scanHostKeys();
      expect(scan.keys).toEqual([{ algorithm: 'ssh-ed25519', fingerprint: fingerprintFromBase64Key(blob) }]);
      const fallback = calls.find((call) => call.bin === 'ssh');
      expect(fallback.argv).toEqual(expect.arrayContaining(['-N', 'BatchMode=yes',
        'PreferredAuthentications=none', 'PasswordAuthentication=no', 'PubkeyAuthentication=no',
        'KbdInteractiveAuthentication=no', 'StrictHostKeyChecking=accept-new', 'ControlPath=none', 'ClearAllForwardings=yes']));
      expect(fallback.argv.at(-1)).toBe('deploy@10.0.0.21'); // no remote command
      expect(fallback.options.env?.TMUX_PANEL_SSH_SERVER_ID).toBeUndefined();
      expect(JSON.stringify(fallback)).not.toContain('unused-password');
      await expect(fs.access(candidatePath)).rejects.toThrow();
      await expect(fs.access(path.join(dir, 'known_hosts'))).rejects.toThrow();
      // Permanent trust is still a separate, explicitly confirmed operation.
      await executor.trustHostKey(scan.keys[0].fingerprint);
      expect(await fs.readFile(path.join(dir, 'known_hosts'), 'utf8')).toContain(blob);
    });

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
      const executor = new SshConnection({ server: viaConfig, configDir: dir, execFileImpl: impl });
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
});
