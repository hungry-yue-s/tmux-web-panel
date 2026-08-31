/**
 * OpenSSH transport.
 *
 * Everything runs through the system ssh client so the user's existing
 * ~/.ssh/config, SSH agent, ProxyJump and hardware keys keep working, and the
 * panel never has to hold key material. Local processes are always started with
 * an argv array; the only place a shell is involved is the remote side, where
 * commands come from fixed templates with every argument POSIX-quoted.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AppError, ErrorCode } from '../servers/errors.js';

const SSH_BIN = 'ssh';
const KEYSCAN_BIN = 'ssh-keyscan';
const DEFAULT_TIMEOUT_MS = 10_000;
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

/** Wraps a value in POSIX single quotes so a remote shell treats it as one word. */
export function shellQuote(value) {
  const str = String(value);
  if (str === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(str)) return str;
  return `'${str.replace(/'/g, `'\\''`)}'`;
}

/** Serializes an argv array into a single remote command string. */
export function quoteArgv(argv) {
  return argv.map(shellQuote).join(' ');
}

/**
 * Builds the ssh option list shared by every invocation.
 * StrictHostKeyChecking stays on: an unknown or changed key must fail closed.
 */
export function baseSshOptions({ knownHostsPath, controlPath, connectTimeout = 5, controlPersist = 60 }) {
  const options = [
    'BatchMode=yes',
    `ConnectTimeout=${connectTimeout}`,
    'ServerAliveInterval=15',
    'ServerAliveCountMax=2',
    'StrictHostKeyChecking=yes',
    `UserKnownHostsFile=${knownHostsPath}`,
  ];
  if (controlPath) {
    options.push('ControlMaster=auto', `ControlPersist=${controlPersist}`, `ControlPath=${controlPath}`);
  }
  return options;
}

/**
 * Turns a registry record into ssh argv. When the record names a ~/.ssh/config
 * Host, only that alias is passed — the alias already carries hostname/user/port.
 */
export function buildSshArgs(server, { knownHostsPath, controlPath, tty = false, connectTimeout = 5, extraOptions = [] } = {}) {
  if (!server || server.kind === 'local') throw new Error('buildSshArgs requires a remote server');
  const args = [];
  if (tty) args.push('-tt');
  else args.push('-T'); // no pty for command execution: keeps stdout clean

  for (const option of baseSshOptions({ knownHostsPath, controlPath, connectTimeout })) {
    args.push('-o', option);
  }

  const ssh = server.ssh || {};
  const address = server.address || {};

  // The alias must reach ssh itself, otherwise known_hosts is keyed by hostname
  // while we verified and stored the key under the alias.
  if (ssh.knownHostAlias) args.push('-o', `HostKeyAlias=${ssh.knownHostAlias}`);

  for (const option of extraOptions) args.push('-o', option);

  if (ssh.configHost) {
    if (ssh.identityFile) args.push('-i', ssh.identityFile);
    if (ssh.proxyJump) args.push('-J', ssh.proxyJump);
    // Terminates ssh's option parsing. It must come *before* the destination:
    // anything after the destination is sent to the remote shell verbatim.
    args.push('--', ssh.configHost);
    return args;
  }

  if (address.port && Number(address.port) !== 22) args.push('-p', String(address.port));
  if (ssh.identityFile) args.push('-i', ssh.identityFile);
  if (ssh.proxyJump) args.push('-J', ssh.proxyJump);
  args.push('--', address.user ? `${address.user}@${address.host}` : String(address.host));
  return args;
}

/**
 * The name OpenSSH uses as the known_hosts key: HostKeyAlias verbatim when set,
 * otherwise the hostname, bracketed with the port when it is not 22.
 */
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

/** Bounds how many ssh processes one server may run at a time. */
class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.waiters = [];
  }

  async run(fn) {
    if (this.active >= this.limit) {
      await new Promise((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      const next = this.waiters.shift();
      if (next) next();
    }
  }
}

export class OpenSSHExecutor {
  /**
   * @param {object} options
   * @param {object} options.server registry record (kind: 'remote')
   * @param {string} options.configDir panel config dir holding known_hosts and ssh-control
   */
  constructor({ server, configDir, maxConcurrent = 4, execFileImpl = execFile, now = () => Date.now() } = {}) {
    if (!server) throw new Error('OpenSSHExecutor requires a server');
    if (!configDir) throw new Error('OpenSSHExecutor requires configDir');
    this.server = server;
    this.id = server.id;
    this.transport = 'ssh';
    this.configDir = configDir;
    this.knownHostsPath = join(configDir, 'known_hosts');
    this.controlDir = join(configDir, 'ssh-control');
    this.controlPath = join(this.controlDir, '%C');
    this._semaphore = new Semaphore(maxConcurrent);
    this._execFile = execFileImpl;
    this._now = now;
    this._controlDirReady = false;
    /** Candidates from the most recent scan; the only keys trust() will accept. */
    this._pendingScan = null;
  }

  async _ensureControlDir() {
    if (this._controlDirReady) return;
    await mkdir(this.controlDir, { recursive: true, mode: 0o700 });
    // mkdir's mode only applies on creation, so tighten an existing directory too.
    await chmod(this.controlDir, 0o700).catch(() => {});
    this._controlDirReady = true;
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

  sshArgs({ tty = false, connectTimeout = 5, extraOptions = [] } = {}) {
    return buildSshArgs(this.server, {
      knownHostsPath: this.knownHostsPath,
      controlPath: this.controlPath,
      tty,
      connectTimeout,
      extraOptions,
    });
  }

  /**
   * Runs one command on the remote host. `command` and `args` are quoted
   * individually — the caller supplies a fixed template, never user prose.
   */
  async exec(command, args = [], options = {}) {
    const remoteCommand = quoteArgv([command, ...args]);
    return this.execRemoteCommand(remoteCommand, options);
  }

  async execRemoteCommand(remoteCommand, options = {}) {
    await this._ensureControlDir();
    // Everything after the destination is the remote command, so nothing else
    // may be appended here.
    const argv = [...this.sshArgs({ connectTimeout: options.connectTimeout }), remoteCommand];
    return this._semaphore.run(
      () => new Promise((resolve, reject) => {
        const child = this._execFile(
          SSH_BIN,
          argv,
          {
            timeout: options.timeout || DEFAULT_TIMEOUT_MS,
            maxBuffer: options.maxBuffer || DEFAULT_MAX_BUFFER,
            killSignal: 'SIGTERM',
          },
          async (err, stdout, stderr) => {
            if (err) {
              err.stderr = typeof stderr === 'string' ? stderr : (err.stderr || '');
              const knownHostEntryExists = await this.hasKnownHostEntry().catch(() => false);
              const appError = classifySshError(err, { knownHostEntryExists });
              appError.exitCode = typeof err.code === 'number' ? err.code : null;
              reject(appError);
              return;
            }
            resolve({ stdout: stdout || '', stderr: stderr || '' });
          },
        );
        if (child.stdin) {
          // Always close stdin: a remote command left waiting on input would
          // hang until the timeout fires.
          child.stdin.end(options.input === undefined ? '' : options.input);
        }
      }),
    );
  }

  /**
   * Feeds a built-in read-only script to a remote POSIX shell over stdin.
   * Nothing is written to the remote filesystem and no agent is installed.
   */
  async runScript(script, options = {}) {
    return this.execRemoteCommand('/bin/sh -s', { ...options, input: script });
  }

  /** argv for node-pty: an interactive remote command over a tty. */
  ptyArgs(remoteCommand) {
    return [...this.sshArgs({ tty: true }), remoteCommand];
  }

  /**
   * Fetches candidate host keys for the trust-on-first-use flow. The scan always
   * targets a real hostname/port; an alias is never used as a network address.
   * Candidates are remembered so trustHostKey can only accept what was shown.
   */
  async scanHostKeys({ timeout = 8000 } = {}) {
    const target = await this.resolveTarget();
    const entryName = knownHostsEntryName(target);
    const scanHost = target.host.startsWith('[') && target.host.endsWith(']')
      ? target.host.slice(1, -1)
      : target.host;

    const argv = ['-T', '5'];
    if (target.port && target.port !== 22) argv.push('-p', String(target.port));
    argv.push(scanHost);

    const { stdout } = await new Promise((resolve, reject) => {
      this._execFile(
        KEYSCAN_BIN,
        argv,
        { timeout, maxBuffer: DEFAULT_MAX_BUFFER },
        (err, out, stderrOut) => {
          // ssh-keyscan reports progress on stderr and may exit non-zero even
          // when it printed usable keys.
          if (err && !out) {
            reject(classifySshError(Object.assign(err, { stderr: stderrOut })));
            return;
          }
          resolve({ stdout: out || '' });
        },
      );
    });

    const scanned = parseKeyscanOutput(stdout);
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
