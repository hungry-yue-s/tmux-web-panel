/**
 * SSH to another machine, always through the system client so ~/.ssh/config,
 * the SSH agent, ProxyJump and hardware keys keep working.
 *
 * With the panel installed there (a node), SSH is only a pipe:
 *   1. SFTP-read the node's pairing file (port, token, TLS fingerprint).
 *      SFTP is a subsystem, so it does not depend on the login shell.
 *   2. Hold one `ssh -N -L` port forward to the node's own HTTP(S) listener.
 *
 * Without it (basic mode) the hub also needs to drive tmux remotely. The login
 * shell may be cmd, PowerShell, fish or bash, and Windows OpenSSH pastes a pty
 * command into the shell's command line unquoted, so nothing here relies on how
 * a login shell parses arguments:
 *   - commands run as `sh -s` with a POSIX script on stdin (two plain words);
 *   - an interactive command is a single word: the path of a script uploaded
 *     over SFTP beforehand.
 *
 * Local processes are always started with an argv array.
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AppError, ErrorCode } from '../servers/errors.js';
import { PAIRING_RELATIVE_PATH, parsePairing } from '../node/identity.js';

const SSH_BIN = 'ssh';

/**
 * The ssh binary for a pty. node-pty does not search PATH on Windows, so the
 * system OpenSSH client is named explicitly there.
 */
export function sshPtyBinary({ platform = process.platform, env = process.env, exists = existsSync } = {}) {
  if (platform !== 'win32') return SSH_BIN;
  const system = join(env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
  return exists(system) ? system : 'ssh.exe';
}
const SFTP_BIN = 'sftp';
const KEYSCAN_BIN = 'ssh-keyscan';
const DEFAULT_MAX_BUFFER = 1024 * 1024;
const STDERR_KEEP = 2048;
/** A confirmed fingerprint only counts for the scan the user was shown. */
const SCAN_TTL_MS = 10 * 60 * 1000;

const ALLOWED_KEY_ALGORITHMS = new Set([
  'ssh-ed25519',
  'ssh-rsa',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'sk-ssh-ed25519@openssh.com',
  'sk-ecdsa-sha2-nistp256@openssh.com',
]);

/**
 * Builds the ssh option list shared by every invocation.
 * StrictHostKeyChecking stays on: an unknown or changed key must fail closed.
 * The keepalives bound how long a dead forward goes unnoticed (~30 s).
 */
export function baseSshOptions({ knownHostsPath, connectTimeout = 5, passwordAuth = false }) {
  const options = [
    `BatchMode=${passwordAuth ? 'no' : 'yes'}`,
    `ConnectTimeout=${connectTimeout}`,
    'ServerAliveInterval=15',
    'ServerAliveCountMax=2',
    'StrictHostKeyChecking=yes',
    `UserKnownHostsFile=${knownHostsPath}`,
  ];
  if (passwordAuth) {
    options.push('PreferredAuthentications=password,keyboard-interactive', 'PasswordAuthentication=yes',
      'KbdInteractiveAuthentication=yes', 'PubkeyAuthentication=no', 'NumberOfPasswordPrompts=1');
  }
  return options;
}

/**
 * A short, stable identity for a connection's settings. It changes whenever
 * the target or credentials change, so the askpass helper can refuse to hand
 * a new password to a process started for the old settings.
 */
export function connectionKey(server) {
  const address = server.address || {};
  const ssh = server.ssh || {};
  const identity = JSON.stringify([
    address.host || null,
    Number(address.port) || 22,
    address.user || null,
    ssh.configHost || null,
    ssh.identityFile || null,
    ssh.proxyJump || null,
    ssh.knownHostAlias || null,
    ssh.authMethod || 'agent',
    ssh.passwordRevision || null,
  ]);
  return createHash('sha256').update(identity).digest('hex').slice(0, 12);
}

/**
 * Turns a registry record into ssh (or sftp) argv, ending with the
 * destination. When the record names a ~/.ssh/config Host, only that alias is
 * passed — the alias already carries hostname/user/port.
 *
 * sftp spells two flags differently (-P for the port, no -l), which is the
 * only reason `tool` exists.
 *
 * `trailing` flags go after every -o option. sftp's -b injects its own
 * "-oBatchMode yes" where it appears, and ssh keeps the first value it sees,
 * so -b must follow our BatchMode=no or password logins are refused.
 */
export function buildSshArgs(server, { knownHostsPath, tool = 'ssh', connectTimeout = 5, extraOptions = [], leading = null, trailing = [] } = {}) {
  if (!server || server.kind === 'local') throw new Error('buildSshArgs requires a remote server');
  const sftp = tool === 'sftp';
  const args = leading ? [...leading] : (sftp ? [] : ['-T']);

  for (const option of baseSshOptions({ knownHostsPath, connectTimeout, passwordAuth: server.ssh?.authMethod === 'password' })) {
    args.push('-o', option);
  }

  const ssh = server.ssh || {};
  const address = server.address || {};

  // The alias must reach ssh itself, otherwise known_hosts is keyed by hostname
  // while we verified and stored the key under the alias.
  if (ssh.knownHostAlias) args.push('-o', `HostKeyAlias=${ssh.knownHostAlias}`);

  for (const option of extraOptions) args.push('-o', option);

  const user = (flagUser) => {
    if (!flagUser) return;
    if (sftp) args.push('-o', `User=${flagUser}`);
    else args.push('-l', flagUser);
  };

  if (ssh.configHost) {
    if (ssh.authMethod === 'password') user(address.user);
    if (ssh.identityFile) args.push('-i', ssh.identityFile);
    if (ssh.proxyJump) args.push('-J', ssh.proxyJump);
    args.push(...trailing);
    // Terminates option parsing. It must come *before* the destination.
    args.push('--', ssh.configHost);
    return args;
  }

  if (address.port && Number(address.port) !== 22) args.push(sftp ? '-P' : '-p', String(address.port));
  if (ssh.identityFile) args.push('-i', ssh.identityFile);
  if (ssh.proxyJump) args.push('-J', ssh.proxyJump);
  args.push(...trailing);
  args.push('--', address.user ? `${address.user}@${address.host}` : String(address.host));
  return args;
}

/** POSIX single-quoting for scripts that `sh` parses (never the login shell). */
export function shellQuote(value) {
  const str = String(value);
  if (str === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(str)) return str;
  return `'${str.replace(/'/g, `'\\''`)}'`;
}

export function quoteArgv(argv) {
  return argv.map(shellQuote).join(' ');
}

/** `-L` spec: an IPv6 remote host must be bracketed. */
export function forwardSpec(localPort, remoteHost, remotePort) {
  const host = String(remoteHost).includes(':') ? `[${remoteHost}]` : String(remoteHost);
  return `127.0.0.1:${localPort}:${host}:${remotePort}`;
}

export function knownHostsEntryName({ host, port, hostKeyAlias }) {
  if (hostKeyAlias) return hostKeyAlias;
  const bare = host && host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (port && Number(port) !== 22) return `[${bare}]:${Number(port)}`;
  return bare;
}

/** Hostnames are case-insensitive and IPv6 literals may or may not be bracketed. */
export function normalizeHostForCompare(host) {
  if (typeof host !== 'string') return '';
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return bare.toLowerCase();
}

/**
 * Collapses a resolved target into one comparable identity. Trusting a key must
 * fail if *anything* about the target moved since the scan — comparing only the
 * known_hosts entry name would let a HostKeyAlias hide a swapped host or port.
 * The entry name itself is derived from these three fields, so it is not repeated.
 */
export function targetIdentity(target) {
  return [
    normalizeHostForCompare(target.host),
    String(Number(target.port) || 22),
    target.hostKeyAlias || '',
  ].join('|');
}

function tail(text) {
  const str = typeof text === 'string' ? text : '';
  return str.length > STDERR_KEEP ? str.slice(-STDERR_KEEP) : str;
}

/**
 * Maps ssh failure output onto a stable error code. The distinction matters:
 * an auth failure and a changed host key need different repair actions, and
 * neither should be reported as plain "offline".
 */
export function classifySshError(err, { knownHostEntryExists = false } = {}) {
  const stderr = tail(err && err.stderr) + ' ' + ((err && err.message) || '');

  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|host key for .* has changed|key for .* changed/i.test(stderr)) {
    return new AppError(ErrorCode.SSH_HOST_KEY_CHANGED, 'Remote host key does not match the trusted key');
  }
  if (/Host key verification failed|No (?:\w+ )?host key is known|no matching host key|not found in known_hosts/i.test(stderr)) {
    return knownHostEntryExists
      ? new AppError(ErrorCode.SSH_HOST_KEY_CHANGED, 'Remote host key does not match the trusted key')
      : new AppError(ErrorCode.SSH_HOST_KEY_UNKNOWN, 'Host key is not trusted yet');
  }
  if (/Permission denied|Too many authentication failures|no such identity|Authentication failed|publickey/i.test(stderr)) {
    return new AppError(ErrorCode.SSH_AUTH_REQUIRED, 'SSH authentication failed');
  }
  if (err && err.killed && err.signal === 'SIGTERM') {
    return new AppError(ErrorCode.SSH_TIMEOUT, 'SSH command timed out');
  }
  if (/Connection timed out|Operation timed out|timed out|ETIMEDOUT/i.test(stderr)) {
    return new AppError(ErrorCode.SSH_TIMEOUT, 'SSH connection timed out');
  }
  if (/Connection refused|No route to host|Network is unreachable|Could not resolve hostname|Name or service not known|nodename nor servname/i.test(stderr)) {
    return new AppError(ErrorCode.SERVER_OFFLINE, 'Server is unreachable');
  }
  if (err && err.code === 'ENOENT') {
    return new AppError(ErrorCode.INTERNAL, 'ssh client not found on this machine');
  }
  return new AppError(ErrorCode.SERVER_OFFLINE, 'SSH connection failed');
}

/** OpenSSH's fingerprint format: base64(sha256(keyblob)) without padding. */
export function fingerprintFromBase64Key(base64Key) {
  const digest = createHash('sha256').update(Buffer.from(base64Key, 'base64')).digest('base64');
  return 'SHA256:' + digest.replace(/=+$/, '');
}

/**
 * Reads the algorithm name embedded in an SSH key blob (length-prefixed string).
 * Used to prove the blob really is the algorithm the line claims.
 */
export function keyBlobAlgorithm(base64Key) {
  let buf;
  try {
    buf = Buffer.from(base64Key, 'base64');
  } catch {
    return null;
  }
  if (buf.length < 8) return null;
  const length = buf.readUInt32BE(0);
  if (length < 1 || length > 64 || buf.length < 4 + length) return null;
  const name = buf.slice(4, 4 + length).toString('ascii');
  return /^[\x20-\x7e]+$/.test(name) ? name : null;
}

/**
 * Parses ssh-keyscan output lines: "host keytype base64" (comment lines start with #).
 */
export function parseKeyscanOutput(output) {
  const keys = [];
  for (const line of String(output || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) continue;
    const [scannedHost, algorithm, base64Key] = parts;
    if (!/^[A-Za-z0-9+/=]+$/.test(base64Key)) continue;
    if (!ALLOWED_KEY_ALGORITHMS.has(algorithm)) continue;
    // The blob must actually carry the advertised algorithm.
    if (keyBlobAlgorithm(base64Key) !== algorithm) continue;
    keys.push({
      scannedHost,
      algorithm,
      base64Key,
      fingerprint: fingerprintFromBase64Key(base64Key),
    });
  }
  return keys;
}

/** Parses `ssh -G host` output into a lowercase keyword map. */
export function parseSshConfigDump(output) {
  const config = {};
  for (const line of String(output || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const spaceAt = trimmed.indexOf(' ');
    if (spaceAt <= 0) continue;
    const key = trimmed.slice(0, spaceAt).toLowerCase();
    const value = trimmed.slice(spaceAt + 1).trim();
    if (!(key in config)) config[key] = value;
  }
  return config;
}


export class SshConnection {
  /**
   * @param {object} options
   * @param {object} options.server registry record (kind: 'remote')
   * @param {string} options.configDir panel config dir holding known_hosts
   */
  constructor({ server, configDir, execFileImpl = execFile, spawnImpl = spawn, now = () => Date.now() } = {}) {
    if (!server) throw new Error('SshConnection requires a server');
    if (!configDir) throw new Error('SshConnection requires configDir');
    this.server = server;
    this.id = server.id;
    this.configDir = configDir;
    this.knownHostsPath = join(configDir, 'known_hosts');
    this._execFile = execFileImpl;
    this._spawn = spawnImpl;
    this._now = now;
    /** Candidates from the most recent scan; the only keys trust() will accept. */
    this._pendingScan = null;
  }

  /** Askpass delivers a stored password without it entering argv or env. */
  sshEnv() {
    if (this.server.ssh?.authMethod !== 'password') return {};
    return {
      SSH_ASKPASS: fileURLToPath(new URL('./ssh-askpass.sh', import.meta.url)),
      SSH_ASKPASS_REQUIRE: 'force',
      TMUX_PANEL_NODE: process.execPath,
      TMUX_PANEL_SSH_ASKPASS: fileURLToPath(new URL('./ssh-askpass.js', import.meta.url)),
      TMUX_PANEL_SSH_CONFIG_DIR: this.configDir,
      TMUX_PANEL_SSH_SERVER_ID: this.server.id,
      TMUX_PANEL_SSH_CONNECTION: connectionKey(this.server),
    };
  }

  _run(bin, argv, { input = '', timeout = 15_000 } = {}) {
    return new Promise((resolve, reject) => {
      const child = this._execFile(bin, argv, {
        timeout,
        maxBuffer: DEFAULT_MAX_BUFFER,
        killSignal: 'SIGTERM',
        env: { ...process.env, ...this.sshEnv() },
      }, (err, stdout, stderr) => {
        if (err) {
          err.stderr = typeof stderr === 'string' ? stderr : (err.stderr || '');
          reject(err);
          return;
        }
        resolve({ stdout: stdout || '', stderr: stderr || '' });
      });
      // Always close stdin: a client left waiting on input would hang until the timeout.
      if (child && child.stdin) child.stdin.end(input);
    });
  }

  async _classify(err) {
    const knownHostEntryExists = await this.hasKnownHostEntry().catch(() => false);
    return classifySshError(err, { knownHostEntryExists });
  }

  /**
   * Runs a POSIX script on the host as `sh -s`, the script on stdin. ssh's own
   * failures (exit 255) are classified; any other failure keeps its stderr so
   * callers can tell "no such pane" from "no POSIX shell".
   */
  async runScript(script, { timeout = 15_000 } = {}) {
    const argv = [...buildSshArgs(this.server, { knownHostsPath: this.knownHostsPath }), 'sh', '-s'];
    try {
      return await this._run(SSH_BIN, argv, { input: script, timeout });
    } catch (err) {
      if (err && err.code === 255) throw await this._classify(err);
      if (err && err.killed) throw classifySshError(err);
      throw err;
    }
  }

  /**
   * Uploads one file over SFTP to a path relative to the login directory,
   * creating its parent directories and setting its mode.
   */
  async uploadFile(localPath, remotePath, { mode = '644', timeout = 120_000 } = {}) {
    if (/["\n]/.test(localPath + remotePath)) throw new AppError(ErrorCode.VALIDATION_ERROR, 'Unsupported path');
    const parts = remotePath.split('/').slice(0, -1);
    const lines = [];
    for (let i = 1; i <= parts.length; i += 1) lines.push(`-mkdir "${parts.slice(0, i).join('/')}"`);
    lines.push(`put "${localPath.replace(/\\/g, '/')}" "${remotePath}"`, `chmod ${mode} "${remotePath}"`);
    const argv = buildSshArgs(this.server, { knownHostsPath: this.knownHostsPath, tool: 'sftp', trailing: ['-b', '-'] });
    try {
      await this._run(SFTP_BIN, argv, { input: lines.join('\n') + '\n', timeout });
    } catch (err) {
      throw await this._classify(err);
    }
  }

  /**
   * Runs a long remote command and streams its output, for installation. The
   * remote words must be plain (no quoting needed in any login shell); data the
   * command needs goes on stdin. Resolves with the exit code.
   */
  stream(remoteWords, { input = '', onOutput = () => {}, timeout = 45 * 60_000 } = {}) {
    for (const word of remoteWords) {
      if (!/^[A-Za-z0-9_./=+-]+$/.test(word)) throw new AppError(ErrorCode.VALIDATION_ERROR, 'Remote words must be plain');
    }
    const argv = [...buildSshArgs(this.server, { knownHostsPath: this.knownHostsPath }), ...remoteWords];
    return new Promise((resolve, reject) => {
      const child = this._spawn(SSH_BIN, argv, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...this.sshEnv() },
        windowsHide: true,
      });
      let stderrTail = '';
      const timer = setTimeout(() => child.kill(), timeout);
      child.stdout.on('data', (chunk) => onOutput(String(chunk)));
      child.stderr.on('data', (chunk) => {
        stderrTail = (stderrTail + chunk).slice(-STDERR_KEEP);
        onOutput(String(chunk));
      });
      child.once('error', (err) => { clearTimeout(timer); reject(classifySshError(err)); });
      child.once('close', async (code) => {
        clearTimeout(timer);
        if (code === 255) {
          reject(await this._classify(Object.assign(new Error('ssh exited 255'), { stderr: stderrTail })));
          return;
        }
        resolve(code);
      });
      child.stdin.end(input);
    });
  }

  /** argv for an interactive pty; `command` must be one word (see top of file). */
  ptyArgs(command = null) {
    if (command !== null && !/^[A-Za-z0-9_./%-]+$/.test(command)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'A pty command must be a single plain word');
    }
    const argv = buildSshArgs(this.server, { knownHostsPath: this.knownHostsPath, leading: ['-tt'] });
    return command === null ? argv : [...argv, command];
  }

  /**
   * Reads and validates the node's pairing file over SFTP. A missing file means
   * the panel service has never run on that host for this user.
   */
  async fetchPairing({ timeout = 20_000 } = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'tmux-pair-'));
    const localPath = join(dir, 'node.json').replace(/\\/g, '/');
    try {
      if (localPath.includes('"')) throw new AppError(ErrorCode.INTERNAL, 'Unsupported temporary directory');
      const argv = buildSshArgs(this.server, { knownHostsPath: this.knownHostsPath, tool: 'sftp', trailing: ['-b', '-'] });
      try {
        await this._run(SFTP_BIN, argv, { input: `get "${PAIRING_RELATIVE_PATH}" "${localPath}"\n`, timeout });
      } catch (err) {
        if (/not found|No such file/i.test(String(err.stderr || ''))) {
          throw new AppError(ErrorCode.NODE_NOT_INSTALLED, 'tmux-web-panel is not running on this host');
        }
        throw await this._classify(err);
      }
      const pairing = parsePairing(await readFile(localPath, 'utf8'));
      if (!pairing) throw new AppError(ErrorCode.NODE_INCOMPATIBLE, 'The node pairing file is invalid');
      return pairing;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * Starts the long-lived port forward. The caller owns the child: it must
   * watch for exit and kill it on close. Errors before the forward is usable
   * are reported through `whenFailed`.
   */
  openForward({ localPort, remoteHost, remotePort }) {
    const argv = buildSshArgs(this.server, {
      knownHostsPath: this.knownHostsPath,
      leading: ['-N', '-L', forwardSpec(localPort, remoteHost, remotePort)],
      extraOptions: ['ExitOnForwardFailure=yes'],
    });
    const child = this._spawn(SSH_BIN, argv, {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, ...this.sshEnv() },
      windowsHide: true,
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-STDERR_KEEP); });
    const whenFailed = new Promise((resolve) => {
      child.once('error', (err) => resolve(classifySshError(err)));
      child.once('exit', (code, signal) => {
        this._classify(Object.assign(new Error(`ssh exited (${code ?? signal})`), { stderr })).then(resolve);
      });
    });
    return { child, whenFailed, stderr: () => stderr };
  }

  /**
   * Resolves the real network target. A ~/.ssh/config alias is meaningless to
   * ssh-keyscan, so ask ssh itself what the alias expands to.
   */
  async resolveTarget({ timeout = 5000 } = {}) {
    const ssh = this.server.ssh || {};
    const address = this.server.address || {};

    if (!ssh.configHost) {
      if (!address.host) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 'Server has no host to connect to', {
          details: { field: 'address.host' },
        });
      }
      return {
        host: address.host,
        port: address.port ? Number(address.port) : 22,
        hostKeyAlias: ssh.knownHostAlias || null,
        source: 'record',
      };
    }

    const { stdout } = await new Promise((resolve, reject) => {
      this._execFile(SSH_BIN, ['-G', ssh.configHost], { timeout, maxBuffer: DEFAULT_MAX_BUFFER }, (err, out, stderrOut) => {
        if (err && !out) {
          reject(classifySshError(Object.assign(err, { stderr: stderrOut })));
          return;
        }
        resolve({ stdout: out || '' });
      });
    });

    const config = parseSshConfigDump(stdout);
    const host = config.hostname || address.host;
    if (!host) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `Could not resolve hostname for ssh alias ${ssh.configHost}`, {
        details: { field: 'ssh.configHost' },
      });
    }
    return {
      host,
      port: Number(config.port || address.port || 22),
      // An explicit record alias wins; otherwise honor the one from ssh config.
      hostKeyAlias: ssh.knownHostAlias || config.hostkeyalias || null,
      source: 'ssh-config',
    };
  }

  /** The known_hosts key for this server, resolving a config alias if needed. */
  async knownHostsEntryName() {
    const target = await this.resolveTarget();
    return knownHostsEntryName(target);
  }

  /** True when known_hosts already contains an entry for this server's key name. */
  async hasKnownHostEntry(entryName = null) {
    let needle = entryName;
    if (!needle) {
      try {
        needle = await this.knownHostsEntryName();
      } catch {
        return false;
      }
    }
    if (!needle) return false;
    try {
      const content = await readFile(this.knownHostsPath, 'utf8');
      return content.split('\n').some((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return false;
        const hosts = trimmed.split(/\s+/)[0] || '';
        return hosts.split(',').some((h) => h === needle);
      });
    } catch {
      return false;
    }
  }

  /**
   * Fetches candidate host keys for the trust-on-first-use flow. The scan always
   * targets a real hostname/port; an alias is never used as a network address.
   * Candidates are remembered so trustHostKey can only accept what was shown.
   */
  async scanHostKeys({ timeout = 8000 } = {}) {
    this._pendingScan = null;
    const target = await this.resolveTarget();
    const entryName = knownHostsEntryName(target);
    const scanHost = target.host.startsWith('[') && target.host.endsWith(']')
      ? target.host.slice(1, -1)
      : target.host;

    const argv = ['-T', '5'];
    if (target.port && target.port !== 22) argv.push('-p', String(target.port));
    argv.push(scanHost);

    const stdout = await new Promise((resolve) => {
      this._execFile(
        KEYSCAN_BIN,
        argv,
        { timeout, maxBuffer: DEFAULT_MAX_BUFFER },
        (_err, out) => {
          // ssh-keyscan reports progress on stderr and may exit non-zero even
          // when it printed usable keys. An empty result gets a full SSH scan.
          resolve(out || '');
        },
      );
    });

    let scanned = parseKeyscanOutput(stdout);
    if (scanned.length === 0) scanned = parseKeyscanOutput(await this._scanHostKeyWithSsh({ timeout }));
    if (scanned.length === 0) {
      throw new AppError(ErrorCode.SERVER_OFFLINE, 'No host keys returned; the host may be unreachable');
    }

    const candidates = scanned.map((key) => ({
      algorithm: key.algorithm,
      fingerprint: key.fingerprint,
      base64Key: key.base64Key,
    }));

    this._pendingScan = {
      at: this._now(),
      entryName,
      host: scanHost,
      port: target.port,
      hostKeyAlias: target.hostKeyAlias || null,
      identity: targetIdentity(target),
      candidates,
    };

    return {
      host: scanHost,
      port: target.port,
      entryName,
      // Only the algorithm and fingerprint are meant for display/confirmation.
      keys: candidates.map(({ algorithm, fingerprint }) => ({ algorithm, fingerprint })),
    };
  }

  /** Some endpoints reject ssh-keyscan while accepting the full SSH client. */
  async _scanHostKeyWithSsh({ timeout }) {
    const dir = await mkdtemp(join(tmpdir(), 'tmux-hostkey-'));
    const candidatePath = join(dir, 'candidate');
    try {
      // accept-new is confined to this disposable candidate file. Real
      // connections still require explicit trust and strict checking.
      const server = { ...this.server, ssh: { ...this.server.ssh, authMethod: 'agent' } };
      const argv = ['-N', ...buildSshArgs(server, {
        knownHostsPath: candidatePath,
        extraOptions: ['PreferredAuthentications=none', 'PubkeyAuthentication=no',
          'PasswordAuthentication=no', 'KbdInteractiveAuthentication=no',
          'GlobalKnownHostsFile=/dev/null', 'KnownHostsCommand=none', 'VerifyHostKeyDNS=no',
          'HashKnownHosts=no', 'UpdateHostKeys=no',
          'ControlMaster=no', 'ControlPersist=no', 'ControlPath=none',
          'ClearAllForwardings=yes', 'PermitLocalCommand=no'],
      }).map((arg) => arg === 'StrictHostKeyChecking=yes' ? 'StrictHostKeyChecking=accept-new' : arg)];
      const failure = await new Promise((resolve) => {
        const child = this._execFile(SSH_BIN, argv, { timeout, maxBuffer: DEFAULT_MAX_BUFFER }, (err, _out, stderr) => {
          resolve(err ? Object.assign(err, { stderr }) : null);
        });
        if (child.stdin) child.stdin.end('');
      });
      // Authentication is deliberately refused; the candidate is collected
      // during key exchange, before any credentials or remote commands.
      try {
        return await readFile(candidatePath, 'utf8');
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        if (failure) throw classifySshError(failure);
        return '';
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * Writes the single host key whose fingerprint the user confirmed.
   * Only candidates from the most recent scan of the current target qualify —
   * a client cannot hand us an arbitrary known_hosts line, and a key that
   * changed since the last trust decision stays a hard failure.
   */
  async trustHostKey(fingerprint) {
    if (typeof fingerprint !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint.trim())) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'Expected a SHA256 host key fingerprint', {
        details: { field: 'fingerprint' },
      });
    }
    const wanted = fingerprint.trim();

    const pending = this._pendingScan;
    if (!pending) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'Scan the host key before trusting it', {
        details: { field: 'fingerprint' },
      });
    }
    if (this._now() - pending.at > SCAN_TTL_MS) {
      this._pendingScan = null;
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'Host key scan expired; scan again', {
        details: { field: 'fingerprint' },
      });
    }

    // The target must not have moved between scan and trust. Comparing the full
    // identity matters: a HostKeyAlias keeps entryName stable even if the host
    // or port was repointed at a different machine.
    const currentTarget = await this.resolveTarget();
    if (targetIdentity(currentTarget) !== pending.identity) {
      this._pendingScan = null;
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'Connection changed since the scan; scan again', {
        details: { field: 'fingerprint' },
      });
    }

    const candidate = pending.candidates.find((key) => key.fingerprint === wanted);
    if (!candidate) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'Fingerprint does not match any scanned host key', {
        details: { field: 'fingerprint' },
      });
    }
    if (!ALLOWED_KEY_ALGORITHMS.has(candidate.algorithm)
      || keyBlobAlgorithm(candidate.base64Key) !== candidate.algorithm
      || fingerprintFromBase64Key(candidate.base64Key) !== wanted) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'Scanned host key failed verification');
    }

    if (await this.hasKnownHostEntry(pending.entryName)) {
      throw new AppError(
        ErrorCode.SSH_HOST_KEY_CHANGED,
        'A host key is already trusted for this host; remove the old known_hosts entry after verifying the change',
      );
    }

    await mkdir(this.configDir, { recursive: true, mode: 0o700 });
    await chmod(this.configDir, 0o700).catch(() => {});
    const line = `${pending.entryName} ${candidate.algorithm} ${candidate.base64Key}\n`;
    await appendFile(this.knownHostsPath, line, { mode: 0o600 });
    // appendFile's mode is ignored for an existing file; enforce 0600 either way.
    await chmod(this.knownHostsPath, 0o600).catch(() => {});
    this._pendingScan = null;

    return { entryName: pending.entryName, algorithm: candidate.algorithm, fingerprint: wanted };
  }
}
