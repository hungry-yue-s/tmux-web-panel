/**
 * Per-server connection cache: the node link, and the basic-mode host used when
 * that machine does not run the panel.
 *
 * One object per remote server, because state must be shared across requests:
 * the open port forward, the host-key scan candidates (scan and trust are two
 * requests), and a basic host's hub-hosted shells.
 *
 * A cached entry is dropped as soon as the connection fields change, which also
 * closes its forward, ends its hosted shells and invalidates any pending scan.
 */

import { AppError, ErrorCode } from '../servers/errors.js';
import { SshConnection, connectionKey } from '../transport/ssh-connection.js';
import { NodeLink } from './node-link.js';

/** How long "no panel there" is trusted before pairing is tried again. */
export const NOT_INSTALLED_TTL_MS = 30_000;

export class LinkPool {
  constructor({ registry, configDir, createConnection = null, createLink = null, createBasicHost = null, now = () => Date.now() }) {
    if (!registry) throw new Error('LinkPool requires a registry');
    if (!configDir) throw new Error('LinkPool requires configDir');
    this.registry = registry;
    this.configDir = configDir;
    this._createConnection = createConnection || ((server) => new SshConnection({ server, configDir }));
    this._createLink = createLink || ((connection) => new NodeLink({ connection }));
    this._createBasicHost = createBasicHost;
    this._now = now;
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
      // A rename must not drop the forward, hosted shells or a pending host-key scan.
      cached.connection.server = server;
      return cached;
    }
    if (cached) this._close(cached, 'server_reconfigured');
    const connection = this._createConnection(server);
    const entry = { fingerprint, connection, link: this._createLink(connection), basic: null, notInstalledAt: null };
    this._entries.set(serverId, entry);
    return entry;
  }

  _close(entry, reason) {
    entry.link.close();
    if (entry.basic) entry.basic.destroy(reason);
  }

  link(serverId, options) {
    return this._entry(serverId, options).link;
  }

  /** The SSH side alone, for host-key scan/trust on a server that may be offline. */
  connection(serverId, options) {
    return this._entry(serverId, options).connection;
  }

  /** The basic-mode host for a server, created on first use. */
  basic(serverId, options) {
    const entry = this._entry(serverId, options);
    if (!entry.basic) {
      if (typeof this._createBasicHost !== 'function') throw new AppError(ErrorCode.UNSUPPORTED, 'Basic mode is not available');
      entry.basic = this._createBasicHost(entry.connection, serverId);
    }
    return entry.basic;
  }

  /**
   * 'node' when the panel answers there, 'basic' when the machine is reachable
   * over SSH without it. Any other failure (unreachable, auth, host key) throws.
   */
  async mode(serverId, { force = false } = {}) {
    const entry = this._entry(serverId);
    if (entry.link.ready) return 'node';
    if (!force && entry.notInstalledAt !== null && this._now() - entry.notInstalledAt < NOT_INSTALLED_TTL_MS) return 'basic';
    try {
      await entry.link.ensure();
      entry.notInstalledAt = null;
      return 'node';
    } catch (err) {
      if (err && err.code === ErrorCode.NODE_NOT_INSTALLED) {
        entry.notInstalledAt = this._now();
        return 'basic';
      }
      throw err;
    }
  }

  /** Forget a cached "not installed", e.g. right after installing the panel there. */
  recheck(serverId) {
    const entry = this._entries.get(serverId);
    if (entry) entry.notInstalledAt = null;
  }

  invalidate(serverId) {
    const entry = this._entries.get(serverId);
    if (entry) this._close(entry, 'server_reconfigured');
    this._entries.delete(serverId);
  }

  /** Ends hosted shells whose detached TTL has passed. */
  reapBasic() {
    for (const entry of this._entries.values()) if (entry.basic) entry.basic.reap();
  }

  closeAll() {
    for (const entry of this._entries.values()) this._close(entry, 'server_shutdown');
    this._entries.clear();
  }
}
