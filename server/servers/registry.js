/**
 * Server registry: declaration store for the panel's servers.
 *
 * Holds no live connection state and no secrets — identity material is kept as
 * a path reference so SSH agent / ~/.ssh/config keep owning authentication.
 */

import { constants as fsConstants } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { isIPv6 } from 'node:net';
import { dirname, join } from 'node:path';

import { AppError, ErrorCode } from './errors.js';

export const LOCAL_SERVER_ID = 'local';
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const HOSTNAME_RE = /^[A-Za-z0-9._-]{1,253}$/;
const USER_RE = /^[A-Za-z0-9._-]{1,32}$/;
// A leading dash would look like an ssh flag rather than a value.
const SSH_CONFIG_HOST_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,252}$/;
const PROXY_JUMP_RE = /^[A-Za-z0-9._@[][A-Za-z0-9._\-@:,[\]]{0,252}$/;
const NAME_MAX = 64;

/**
 * Accepts DNS names, IPv4 literals and IPv6 literals (bracketed or bare,
 * optionally with a `%zone` suffix). Everything reaches ssh as an argv element,
 * never a shell string.
 */
export function isValidHost(value) {
  if (typeof value !== 'string' || !value) return false;
  // A leading dash would look like an ssh flag rather than a destination.
  if (value.startsWith('-')) return false;
  const bare = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  const withoutZone = bare.includes('%') ? bare.slice(0, bare.indexOf('%')) : bare;
  const zone = bare.includes('%') ? bare.slice(bare.indexOf('%') + 1) : '';
  if (isIPv6(withoutZone)) {
    return zone === '' || /^[A-Za-z0-9._-]{1,32}$/.test(zone);
  }
  if (bare.includes(':')) return false;
  return HOSTNAME_RE.test(bare);
}

function fieldError(message, field) {
  return new AppError(ErrorCode.VALIDATION_ERROR, message, { details: { field } });
}

function requireCleanString(value, field, { max = 255, pattern = null, validate = null, required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw fieldError(`${field} is required`, field);
    return null;
  }
  if (typeof value !== 'string') throw fieldError(`${field} must be a string`, field);
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) throw fieldError(`${field} is required`, field);
    return null;
  }
  if (trimmed.length > max) throw fieldError(`${field} exceeds ${max} characters`, field);
  // Control characters would let a value break out of an argv slot or a log line.
  if (/[\x00-\x1f\x7f]/.test(trimmed)) throw fieldError(`${field} contains control characters`, field);
  if (pattern && !pattern.test(trimmed)) throw fieldError(`${field} has an unsupported format`, field);
  if (validate && !validate(trimmed)) throw fieldError(`${field} has an unsupported format`, field);
  return trimmed;
}

function normalizePort(value) {
  if (value === undefined || value === null || value === '') return 22;
  const port = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw fieldError('port must be an integer between 1 and 65535', 'address.port');
  }
  return port;
}

export function slugify(name) {
  const base = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 48);
  return base || 'server';
}

/**
 * Validates and normalizes a client-supplied server declaration. Throws
 * AppError(VALIDATION_ERROR) with the offending field so the UI can highlight it.
 */
export function normalizeServerInput(input, { existing = null } = {}) {
  if (!input || typeof input !== 'object') throw fieldError('body must be an object', 'body');

  const name = requireCleanString(input.name, 'name', { max: NAME_MAX, required: !existing })
    || (existing && existing.name);

  const addressInput = input.address || {};
  const sshInput = input.ssh || {};
  const previousAddress = (existing && existing.address) || {};
  const previousSsh = (existing && existing.ssh) || {};

  const configHost = requireCleanString(
    sshInput.configHost === undefined ? previousSsh.configHost : sshInput.configHost,
    'ssh.configHost',
    { max: 253, pattern: SSH_CONFIG_HOST_RE, required: false },
  );

  const hostRaw = addressInput.host === undefined ? previousAddress.host : addressInput.host;
  // A ~/.ssh/config alias already carries hostname/user/port, so host is optional then.
  const host = requireCleanString(hostRaw, 'address.host', {
    max: 253,
    validate: isValidHost,
    required: !configHost,
  });

  const portSource = addressInput.port === undefined ? previousAddress.port : addressInput.port;
  const user = requireCleanString(
    addressInput.user === undefined ? previousAddress.user : addressInput.user,
    'address.user',
    { max: 32, pattern: USER_RE, required: false },
  );

  // Paths may legitimately contain spaces; they are passed as argv elements.
  const identityFile = requireCleanString(
    sshInput.identityFile === undefined ? previousSsh.identityFile : sshInput.identityFile,
    'ssh.identityFile',
    { max: 512, required: false },
  );
  const proxyJump = requireCleanString(
    sshInput.proxyJump === undefined ? previousSsh.proxyJump : sshInput.proxyJump,
    'ssh.proxyJump',
    { max: 253, pattern: PROXY_JUMP_RE, required: false },
  );
  const knownHostAlias = requireCleanString(
    sshInput.knownHostAlias === undefined ? previousSsh.knownHostAlias : sshInput.knownHostAlias,
    'ssh.knownHostAlias',
    { max: 253, pattern: SSH_CONFIG_HOST_RE, required: false },
  );

  for (const secretField of ['password', 'passphrase', 'privateKey', 'token']) {
    if (sshInput[secretField] !== undefined || input[secretField] !== undefined) {
      throw fieldError(`${secretField} is not accepted; use SSH agent or an identity file path`, secretField);
    }
  }

  let enabled = existing ? existing.enabled !== false : true;
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw fieldError('enabled must be a boolean', 'enabled');
    enabled = input.enabled;
  }

  return {
    name,
    kind: 'remote',
    address: { host, port: normalizePort(portSource), user },
    ssh: { configHost, identityFile, proxyJump, knownHostAlias },
    enabled,
  };
}

function localServer(name) {
  return {
    id: LOCAL_SERVER_ID,
    name: name || '本机',
    kind: 'local',
    address: { host: '127.0.0.1', port: null, user: null },
    ssh: { configHost: null, identityFile: null, proxyJump: null, knownHostAlias: null },
    enabled: true,
    immutable: true,
  };
}

export class ServerRegistry {
  /**
   * @param {object} options
   * @param {string} options.configDir directory holding servers.json / known_hosts
   */
  constructor({ configDir } = {}) {
    if (!configDir) throw new Error('ServerRegistry requires configDir');
    this.configDir = configDir;
    this.filePath = join(configDir, 'servers.json');
    this.knownHostsPath = join(configDir, 'known_hosts');
    this.controlDir = join(configDir, 'ssh-control');
    this._servers = new Map();
    this._localName = null;
    this._writeQueue = Promise.resolve();
    /** Entries that failed validation on load; kept so the UI can report them. */
    this.loadErrors = [];
    /** Latched when the on-disk file could not be understood; blocks writes. */
    this.writesBlocked = false;
    this.writeBlockReason = null;
  }

  async load() {
    // A reload must reflect the file exactly: stale records from a previous
    // load would otherwise survive as phantom servers.
    this._servers = new Map();
    this._localName = null;
    this.loadErrors = [];
    this.writesBlocked = false;
    this.writeBlockReason = null;
    let raw;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return this;
      // Unreadable but present: refuse to overwrite what we could not inspect.
      this.writesBlocked = true;
      this.writeBlockReason = 'file_unreadable';
      this.loadErrors.push({ id: null, reason: 'file_unreadable' });
      return this;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_err) {
      // A corrupt file must not silently erase the user's declarations, so the
      // registry stays read-only until a human repairs or removes the file.
      this.writesBlocked = true;
      this.writeBlockReason = 'file_unparseable';
      this.loadErrors.push({ id: null, reason: 'file_unparseable' });
      return this;
    }

    const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed.servers) ? parsed.servers : [];
    if (parsed && !Array.isArray(parsed) && parsed.localName) this._localName = parsed.localName;

    for (const entry of entries) {
      try {
        const id = requireCleanString(entry && entry.id, 'id', { max: 64, pattern: ID_RE });
        if (id === LOCAL_SERVER_ID) throw fieldError('id "local" is reserved', 'id');
        if (this._servers.has(id)) throw fieldError(`duplicate id ${id}`, 'id');
        const normalized = normalizeServerInput(entry, { existing: null });
        this._servers.set(id, {
          id,
          ...normalized,
          createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date().toISOString(),
          updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date().toISOString(),
        });
      } catch (err) {
        this.loadErrors.push({
          id: entry && typeof entry.id === 'string' ? entry.id : null,
          reason: err instanceof AppError ? (err.details && err.details.field) || err.code : 'invalid_entry',
        });
      }
    }
    return this;
  }

  /** Local record first, then remotes in creation order. */
  list() {
    return [localServer(this._localName), ...this._servers.values()];
  }

  listRemote() {
    return [...this._servers.values()];
  }

  has(id) {
    return id === LOCAL_SERVER_ID || this._servers.has(id);
  }

  get(id) {
    if (id === LOCAL_SERVER_ID) return localServer(this._localName);
    return this._servers.get(id) || null;
  }

  require(id) {
    const server = this.get(id);
    if (!server) throw new AppError(ErrorCode.SERVER_NOT_FOUND, `Server ${id} is not registered`);
    return server;
  }

  isLocal(id) {
    return id === LOCAL_SERVER_ID;
  }

  /** Snapshot used to undo an in-memory mutation whose write failed. */
  _snapshot() {
    return { entries: [...this._servers.entries()], localName: this._localName };
  }

  _restore(snapshot) {
    this._servers = new Map(snapshot.entries);
    this._localName = snapshot.localName;
  }

  /**
   * Persists the current state, rolling the in-memory registry back if the
   * write is refused or fails. Memory and disk must never diverge, otherwise a
   * server would appear in the UI and vanish on restart.
   */
  async _commit(snapshot) {
    try {
      await this._persist();
    } catch (err) {
      this._restore(snapshot);
      throw err;
    }
  }

  async create(input) {
    const normalized = normalizeServerInput(input);
    let id = requireCleanString(input.id, 'id', { max: 64, pattern: ID_RE, required: false });
    if (id === LOCAL_SERVER_ID) throw fieldError('id "local" is reserved', 'id');
    if (id && this._servers.has(id)) {
      throw new AppError(ErrorCode.SERVER_EXISTS, `Server ${id} already exists`);
    }
    if (!id) {
      const base = slugify(normalized.name);
      id = base;
      let n = 2;
      while (this._servers.has(id) || id === LOCAL_SERVER_ID) id = `${base}-${n++}`;
    }

    const snapshot = this._snapshot();
    const now = new Date().toISOString();
    const record = { id, ...normalized, createdAt: now, updatedAt: now };
    this._servers.set(id, record);
    await this._commit(snapshot);
    return record;
  }

  async update(id, patch) {
    if (id === LOCAL_SERVER_ID) {
      // The built-in record is synthesized; only its display alias is editable.
      const name = requireCleanString(patch && patch.name, 'name', { max: NAME_MAX });
      if (patch && (patch.address || patch.ssh)) {
        throw new AppError(ErrorCode.SERVER_IMMUTABLE, 'Local server connection info cannot be changed');
      }
      const snapshot = this._snapshot();
      this._localName = name;
      await this._commit(snapshot);
      return localServer(this._localName);
    }

    const existing = this.require(id);
    if (patch && patch.id !== undefined && patch.id !== id) {
      throw new AppError(ErrorCode.SERVER_IMMUTABLE, 'Server id cannot be changed after creation');
    }
    const normalized = normalizeServerInput(patch || {}, { existing });
    const snapshot = this._snapshot();
    const record = {
      ...existing,
      ...normalized,
      id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };
    this._servers.set(id, record);
    await this._commit(snapshot);
    return record;
  }

  async remove(id) {
    if (id === LOCAL_SERVER_ID) {
      throw new AppError(ErrorCode.SERVER_IMMUTABLE, 'The local server cannot be removed');
    }
    this.require(id);
    const snapshot = this._snapshot();
    this._servers.delete(id);
    await this._commit(snapshot);
  }

  /** Strips anything that is a local filesystem or transport detail. */
  toPublic(server) {
    if (!server) return null;
    return {
      id: server.id,
      name: server.name,
      kind: server.kind,
      address: {
        host: server.address ? server.address.host : null,
        port: server.address ? server.address.port : null,
        user: server.address ? server.address.user : null,
      },
      ssh: {
        configHost: server.ssh ? server.ssh.configHost : null,
        // Presence only: the path itself is a local filesystem detail.
        usesIdentityFile: Boolean(server.ssh && server.ssh.identityFile),
        usesProxyJump: Boolean(server.ssh && server.ssh.proxyJump),
      },
      enabled: server.enabled !== false,
      immutable: Boolean(server.immutable),
      createdAt: server.createdAt || null,
      updatedAt: server.updatedAt || null,
    };
  }

  _serialize() {
    return JSON.stringify(
      {
        version: 1,
        localName: this._localName,
        servers: [...this._servers.values()],
      },
      null,
      2,
    );
  }

  _persist() {
    if (this.writesBlocked) {
      throw new AppError(
        ErrorCode.INTERNAL,
        `servers.json could not be read (${this.writeBlockReason}); refusing to overwrite it`,
        { retryable: false, action: 'repair_servers_file' },
      );
    }
    // Serialize writers so concurrent API calls cannot interleave rename races.
    this._writeQueue = this._writeQueue.then(
      () => this._writeUnsafe(),
      () => this._writeUnsafe(),
    );
    return this._writeQueue;
  }

  async _writeUnsafe() {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.filePath), 0o700).catch(() => {});
    const tmpPath = `${this.filePath}.tmp`;
    const handle = await open(tmpPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC, 0o600);
    try {
      await handle.writeFile(this._serialize(), 'utf8');
      // fsync before rename so a crash cannot leave a zero-length servers.json.
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(tmpPath, this.filePath);
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      throw err;
    }
    await chmod(this.filePath, 0o600).catch(() => {});
  }
}
