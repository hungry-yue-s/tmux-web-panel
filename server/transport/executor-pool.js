/**
 * Per-server executor cache.
 *
 * Two reasons this exists rather than constructing executors ad hoc:
 *   1. Host-key trust is a two-request flow (scan, then confirm a fingerprint).
 *      The candidate list lives on the executor, so both requests must reach the
 *      same instance.
 *   2. OpenSSH ControlMaster reuse and the per-server concurrency limit are only
 *      meaningful if one object represents one server.
 *
 * A cached executor is dropped as soon as the connection fields change, which
 * also invalidates any pending host-key scan — exactly what we want, because the
 * scanned key no longer describes the configured target.
 */

import { createTmuxApi, localExecutor } from '../tmux.js';
import { AppError, ErrorCode } from '../servers/errors.js';
import { OpenSSHExecutor } from './openssh-executor.js';

/** Fields that make a connection a different connection. */
function connectionFingerprint(server) {
  const address = server.address || {};
  const ssh = server.ssh || {};
  return JSON.stringify([
    server.kind,
    address.host || null,
    address.port || null,
    address.user || null,
    ssh.configHost || null,
    ssh.identityFile || null,
    ssh.proxyJump || null,
    ssh.knownHostAlias || null,
  ]);
}

export class ExecutorPool {
  constructor({ registry, configDir, maxConcurrentPerServer = 4 }) {
    if (!registry) throw new Error('ExecutorPool requires a registry');
    if (!configDir) throw new Error('ExecutorPool requires configDir');
    this.registry = registry;
    this.configDir = configDir;
    this.maxConcurrentPerServer = maxConcurrentPerServer;
    this._entries = new Map();
  }

  /**
   * Returns the executor for a server, creating it on first use and replacing it
   * when the stored connection details have changed.
   *
   * Disabled servers are refused here so every execution path — probe, workspace
   * and terminal — inherits the same rule.
   */
  get(serverId, { allowDisabled = false } = {}) {
    const server = this.registry.require(serverId);
    if (!allowDisabled && server.enabled === false) {
      throw new AppError(ErrorCode.SERVER_DISABLED, `Server ${serverId} is disabled`);
    }
    const fingerprint = connectionFingerprint(server);
    const cached = this._entries.get(serverId);
    if (cached && cached.fingerprint === fingerprint) {
      // Remote executors carry the record so a rename is picked up without
      // dropping a pending host-key scan. The shared local executor is frozen
      // and stateless, so it is reused as-is.
      if (server.kind !== 'local') cached.executor.server = server;
      return cached.executor;
    }

    const executor = server.kind === 'local'
      ? localExecutor
      : new OpenSSHExecutor({
        server,
        configDir: this.configDir,
        maxConcurrent: this.maxConcurrentPerServer,
      });

    this._entries.set(serverId, { fingerprint, executor, tmux: createTmuxApi(executor) });
    return executor;
  }

  /** tmux API bound to this server's executor. */
  tmuxFor(serverId, options) {
    this.get(serverId, options);
    return this._entries.get(serverId).tmux;
  }

  requireRemote(serverId, options) {
    const server = this.registry.require(serverId);
    if (server.kind === 'local') {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'This action only applies to remote servers');
    }
    return this.get(serverId, options);
  }

  invalidate(serverId) {
    this._entries.delete(serverId);
  }

  clear() {
    this._entries.clear();
  }
}
