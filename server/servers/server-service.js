/**
 * ServerService: the one place that mutates a server declaration and keeps every
 * derived cache in step.
 *
 * Editing or removing a server touches four things — the registry, the executor
 * pool (which holds ControlMaster state and pending host-key scans), the health
 * cache, and any live SSH workspace. Doing that from the router would guarantee
 * one of them eventually gets forgotten.
 */

import { AppError, ErrorCode } from './errors.js';
import { LOCAL_SERVER_ID } from './registry.js';

export class ServerService {
  constructor({ registry, pool, health, workspace = null, metrics = null }) {
    if (!registry) throw new Error('ServerService requires a registry');
    if (!pool) throw new Error('ServerService requires an executor pool');
    if (!health) throw new Error('ServerService requires a health service');
    this.registry = registry;
    this.pool = pool;
    this.health = health;
    this.workspace = workspace;
    this.metrics = metrics;
  }

  /** Drops every cache derived from a server's connection details. */
  _invalidate(serverId, { releaseWorkspace = false, forgetMetrics = false, reason = 'server_changed' } = {}) {
    this.pool.invalidate(serverId);
    this.health.invalidate(serverId);
    // Samples and history describe the old host, so they must not survive.
    if (forgetMetrics && this.metrics) this.metrics.forget(serverId);
    if (releaseWorkspace && this.workspace) this.workspace.releaseServer(serverId, reason);
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
    return {
      ...this.registry.toPublic(server),
      status: this.health.getStatus(serverId),
      workspace: {
        activePanes: this.workspace ? this.workspace.activeRuntimeCount(serverId) : 0,
        pendingProvider: this.workspace ? this.workspace.pendingProvider(serverId) : null,
      },
    };
  }

  /**
   * Registers a server. The response deliberately reports `checking`: a saved
   * record is not a working connection, and the UI must not imply otherwise.
   */
  async create(input) {
    const server = await this.registry.create(input);
    // A recycled id must not inherit a previous machine's samples.
    this._invalidate(server.id, { forgetMetrics: true });
    // Detection runs in the background so the request returns immediately.
    this.probe(server.id).catch(() => {});
    return {
      ...this.registry.toPublic(server),
      status: this.health.getStatus(server.id),
    };
  }

  async update(serverId, patch, { force = false } = {}) {
    const connectionChanged = Boolean(patch && (patch.address || patch.ssh || patch.enabled !== undefined));

    // Rewiring a server points its panes at a different host, so the existing
    // shells cannot be reused. That is data loss, and it needs confirmation.
    if (connectionChanged && !force && this.workspace && this.workspace.hasActiveRuntimes(serverId)) {
      throw new AppError(
        ErrorCode.SERVER_IN_USE,
        'This server still has active SSH panes; changing the connection will end those shells',
        { details: { activePanes: this.workspace.activeRuntimeCount(serverId) } },
      );
    }

    const server = await this.registry.update(serverId, patch);
    this._invalidate(serverId, {
      releaseWorkspace: connectionChanged,
      forgetMetrics: connectionChanged,
      reason: 'server_reconfigured',
    });
    if (server.enabled !== false) this.probe(serverId).catch(() => {});
    return {
      ...this.registry.toPublic(server),
      status: this.health.getStatus(serverId),
    };
  }

  /**
   * Removes a server. Refuses while it still owns live SSH panes unless the
   * caller confirms, because those panes are unsaved work that only exists here.
   */
  async remove(serverId, { force = false } = {}) {
    if (serverId === LOCAL_SERVER_ID) {
      throw new AppError(ErrorCode.SERVER_IMMUTABLE, 'The local server cannot be removed');
    }
    this.registry.require(serverId);

    if (!force && this.workspace && this.workspace.hasActiveRuntimes(serverId)) {
      throw new AppError(
        ErrorCode.SERVER_IN_USE,
        'This server still has active SSH panes; closing them will end those shells',
        { details: { activePanes: this.workspace.activeRuntimeCount(serverId) } },
      );
    }

    // Persist first: if the write fails the server still exists, and tearing
    // down its PTYs beforehand would have destroyed live shells for nothing.
    await this.registry.remove(serverId);

    if (this.workspace) this.workspace.releaseServer(serverId, 'server_removed');
    this.pool.invalidate(serverId);
    this.health.forget(serverId);
    if (this.metrics) this.metrics.forget(serverId);
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
    const executor = this.pool.requireRemote(serverId, { allowDisabled: true });
    return executor.scanHostKeys();
  }

  /** Writes the one host key whose fingerprint the user confirmed. */
  async trustHostKey(serverId, fingerprint) {
    const executor = this.pool.requireRemote(serverId, { allowDisabled: true });
    const result = await executor.trustHostKey(fingerprint);
    // The blocker is gone; re-check immediately so the UI updates itself.
    this.health.invalidate(serverId);
    this.probe(serverId).catch(() => {});
    return result;
  }
}
