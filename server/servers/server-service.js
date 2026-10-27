/**
 * ServerService: the one place that mutates a server declaration and keeps every
 * derived cache in step.
 *
 * Editing or removing a server touches three things — the registry, the link
 * pool (which holds the open port forward and pending host-key scans) and the
 * health cache. Panes always live in tmux on the node itself, so rewiring or
 * removing a server never destroys anyone's shell.
 */

import { AppError, ErrorCode } from './errors.js';
import { LOCAL_SERVER_ID } from './registry.js';

export class ServerService {
  constructor({ registry, links, health }) {
    if (!registry) throw new Error('ServerService requires a registry');
    if (!links) throw new Error('ServerService requires a link pool');
    if (!health) throw new Error('ServerService requires a health service');
    this.registry = registry;
    this.links = links;
    this.health = health;
  }

  /** Drops every cache derived from a server's connection details. */
  _invalidate(serverId) {
    this.links.invalidate(serverId);
    this.health.invalidate(serverId);
  }

  list() {
    const servers = this.registry.list().map((server) => ({
      ...this.registry.toPublic(server),
      status: this.health.getStatus(server.id),
    }));
    return {
      servers,
      // Surfaced so a partly unreadable registry is visible instead of silent.
      loadErrors: this.registry.loadErrors,
      writable: !this.registry.writesBlocked,
    };
  }

  get(serverId) {
    const server = this.registry.require(serverId);
    return { ...this.registry.toPublic(server), status: this.health.getStatus(serverId) };
  }

  /**
   * Registers a server. The response deliberately reports `checking`: a saved
   * record is not a working connection, and the UI must not imply otherwise.
   */
  async create(input) {
    const server = await this.registry.create(input);
    this._invalidate(server.id);
    // Detection runs in the background so the request returns immediately.
    this.probe(server.id).catch(() => {});
    return { ...this.registry.toPublic(server), status: this.health.getStatus(server.id) };
  }

  async update(serverId, patch) {
    const server = await this.registry.update(serverId, patch);
    if (patch && (patch.address || patch.ssh || patch.enabled !== undefined)) this._invalidate(serverId);
    if (server.enabled !== false) this.probe(serverId).catch(() => {});
    return { ...this.registry.toPublic(server), status: this.health.getStatus(serverId) };
  }

  async remove(serverId) {
    if (serverId === LOCAL_SERVER_ID) {
      throw new AppError(ErrorCode.SERVER_IMMUTABLE, 'The local server cannot be removed');
    }
    this.registry.require(serverId);
    await this.registry.remove(serverId);
    this.links.invalidate(serverId);
    this.health.forget(serverId);
  }

  probe(serverId, { force = true } = {}) {
    this.registry.require(serverId);
    return this.health.probe(serverId, { force });
  }

  /**
   * Fetches candidate host keys for confirmation. Returns fingerprints only —
   * the key material stays server-side until the user approves one.
   */
  async scanHostKey(serverId) {
    return this.links.connection(serverId, { allowDisabled: true }).scanHostKeys();
  }

  /** Writes the one host key whose fingerprint the user confirmed. */
  async trustHostKey(serverId, fingerprint) {
    const result = await this.links.connection(serverId, { allowDisabled: true }).trustHostKey(fingerprint);
    // The blocker is gone; re-check immediately so the UI updates itself.
    this.health.invalidate(serverId);
    this.probe(serverId).catch(() => {});
    return result;
  }
}
