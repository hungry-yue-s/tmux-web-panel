/**
 * Per-server NodeLink cache.
 *
 * One object per remote server, because two things must be shared across
 * requests: the open port forward (every API call and terminal reuses it) and
 * the host-key scan candidates (scan and trust are two requests).
 *
 * A cached link is dropped as soon as the connection fields change, which also
 * closes its forward and invalidates any pending host-key scan.
 */

import { AppError, ErrorCode } from '../servers/errors.js';
import { SshConnection, connectionKey } from '../transport/ssh-connection.js';
import { NodeLink } from './node-link.js';

export class LinkPool {
  constructor({ registry, configDir, createConnection = null, createLink = null }) {
    if (!registry) throw new Error('LinkPool requires a registry');
    if (!configDir) throw new Error('LinkPool requires configDir');
    this.registry = registry;
    this.configDir = configDir;
    this._createConnection = createConnection || ((server) => new SshConnection({ server, configDir }));
    this._createLink = createLink || ((connection) => new NodeLink({ connection }));
    this._entries = new Map();
  }

  _entry(serverId, { allowDisabled = false } = {}) {
    const server = this.registry.require(serverId);
    if (server.kind === 'local') {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'The local server is not reached through a link');
    }
    // Disabled servers are refused here so every path — probe, proxy, terminal — inherits the rule.
    if (!allowDisabled && server.enabled === false) {
      throw new AppError(ErrorCode.SERVER_DISABLED, `Server ${serverId} is disabled`);
    }
    const fingerprint = connectionKey(server);
    const cached = this._entries.get(serverId);
    if (cached && cached.fingerprint === fingerprint) {
      // A rename must not drop the forward or a pending host-key scan.
      cached.connection.server = server;
      return cached;
    }
    if (cached) cached.link.close();
    const connection = this._createConnection(server);
    const entry = { fingerprint, connection, link: this._createLink(connection) };
    this._entries.set(serverId, entry);
    return entry;
  }

  link(serverId, options) {
    return this._entry(serverId, options).link;
  }

  /** The SSH side alone, for host-key scan/trust on a server that may be offline. */
  connection(serverId, options) {
    return this._entry(serverId, options).connection;
  }

  invalidate(serverId) {
    const entry = this._entries.get(serverId);
    if (entry) entry.link.close();
    this._entries.delete(serverId);
  }

  closeAll() {
    for (const entry of this._entries.values()) entry.link.close();
    this._entries.clear();
  }
}
