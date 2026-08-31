/**
 * WorkspaceService: the single place that decides how a server's terminal work
 * is represented, and the only thing the API and WebSocket layers talk to.
 *
 * Callers never ask "does this host have tmux?" — they ask for a workspace and
 * get a uniform tree plus an `actions` map describing what is possible. That
 * keeps provider conditionals out of the routers and out of the frontend.
 */

import { AppError, ErrorCode } from '../servers/errors.js';
import { ServerState } from '../servers/health-service.js';
import { SshProvider } from './ssh-provider.js';
import { TmuxProvider } from './tmux-provider.js';

export class WorkspaceService {
  /**
   * @param {object} deps
   * @param {import('../servers/registry.js').ServerRegistry} deps.registry
   * @param {import('../transport/executor-pool.js').ExecutorPool} deps.pool
   * @param {import('../servers/health-service.js').HealthService} deps.health
   * @param {(ctx: object) => object} deps.spawnSshPty creates a PTY for an SSH pane
   */
  constructor({ registry, pool, health, spawnSshPty, onChange = null, now = () => Date.now() }) {
    if (!registry) throw new Error('WorkspaceService requires a registry');
    if (!pool) throw new Error('WorkspaceService requires an executor pool');
    if (!health) throw new Error('WorkspaceService requires a health service');
    this.registry = registry;
    this.pool = pool;
    this.health = health;
    this._spawnSshPty = spawnSshPty;
    this._onChange = onChange;
    this._now = now;
    /** serverId -> SshProvider. Stateful, so it must outlive a request. */
    this._sshProviders = new Map();
    /** serverId -> monotonic revision, bumped on every mutation. */
    this._revisions = new Map();
    /** serverId -> provider we will adopt once live SSH panes are gone. */
    this._pendingSwitch = new Map();
    /**
     * Servers with a service-level mutation in flight. Provider callbacks are
     * ignored for these so one user action yields one workspace-changed event.
     */
    this._mutating = new Set();
  }

  revision(serverId) {
    return this._revisions.get(serverId) || 0;
  }

  _bump(serverId) {
    const next = this.revision(serverId) + 1;
    this._revisions.set(serverId, next);
    if (typeof this._onChange === 'function') this._onChange(serverId, next);
    return next;
  }

  /** Provider-internal notification: only meaningful outside a service mutation. */
  _providerChanged(serverId) {
    if (this._mutating.has(serverId)) return;
    this._bump(serverId);
  }

  /**
   * Runs one mutation and bumps the revision exactly once. A failed mutation
   * bumps nothing: providers roll their own state back.
   */
  async _mutate(serverId, fn) {
    this._mutating.add(serverId);
    let result;
    try {
      result = await fn();
    } finally {
      this._mutating.delete(serverId);
    }
    this._bump(serverId);
    return result;
  }

  /**
   * Returns the provider that serves this server's workspace right now.
   *
   * Capabilities are probed only when unknown: re-probing a known-offline server
   * on every request would sidestep the health backoff and let page polling
   * become an SSH storm. An explicit probe request is what forces a fresh check.
   *
   * Live SSH panes outrank whatever the latest probe recommends. They exist only
   * in this process, so a transient offline blip or a newly appeared tmux must
   * not take them away from the user; the recommendation is recorded as a
   * pending switch instead.
   */
  async getProvider(serverId) {
    const server = this.registry.require(serverId);
    if (server.enabled === false) {
      throw new AppError(ErrorCode.SERVER_DISABLED, `Server ${serverId} is disabled`);
    }

    let status = this.health.getStatus(serverId);
    const neverChecked = !status.checkedAt;
    const invalidated = status.state === ServerState.UNKNOWN || status.state === ServerState.CHECKING;
    if (neverChecked || invalidated) {
      // probe() collapses onto an in-flight request, so this cannot fan out.
      status = await this.health.probe(serverId);
    }

    const recommended = status.workspace.provider;
    const transport = status.workspace.transport;
    const ssh = this._sshProviders.get(serverId);

    if (ssh && ssh.hasActivePanes() && recommended !== 'ssh') {
      this._pendingSwitch.set(serverId, recommended);
      return ssh;
    }

    if (recommended === 'tmux') {
      // Nothing is running, so adopting tmux costs the user nothing.
      if (ssh) this._retireSshProvider(serverId, 'provider_switched');
      this._pendingSwitch.delete(serverId);
      return new TmuxProvider({
        serverId,
        tmux: this.pool.tmuxFor(serverId),
        transport,
      });
    }

    if (recommended === 'ssh') {
      this._pendingSwitch.delete(serverId);
      return this._sshProviderFor(serverId);
    }

    // Unreachable and nothing live to protect. The cached SSH provider is kept
    // rather than destroyed: a blip must not erase the structure it holds.
    throw new AppError(
      ErrorCode.WORKSPACE_UNAVAILABLE,
      status.error ? status.error.message : 'No usable tmux or SSH connection',
      { retryable: true, action: status.error ? status.error.action : 'retry_probe' },
    );
  }

  /** The provider the latest probe recommends, when it differs from the live one. */
  pendingProvider(serverId) {
    return this._pendingSwitch.get(serverId) || null;
  }

  _retireSshProvider(serverId, reason) {
    const provider = this._sshProviders.get(serverId);
    if (!provider) return false;
    provider.destroyAll(reason);
    this._sshProviders.delete(serverId);
    this._pendingSwitch.delete(serverId);
    this._providerChanged(serverId);
    return true;
  }

  /**
   * Explicit user action: abandon the SSH workspace now and adopt tmux, even
   * though panes are live. Refused unless tmux is actually the pending target,
   * so this cannot be used to kill panes on a server that has nowhere to switch.
   */
  forceProviderSwitch(serverId) {
    if (this.pendingProvider(serverId) !== 'tmux') {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'There is no pending tmux provider to switch to', {
        details: { pendingProvider: this.pendingProvider(serverId) },
      });
    }
    return this._retireSshProvider(serverId, 'provider_switch_forced');
  }

  _sshProviderFor(serverId) {
    let provider = this._sshProviders.get(serverId);
    if (!provider) {
      provider = new SshProvider({
        serverId,
        now: this._now,
        onChange: (id) => this._providerChanged(id),
        spawnPty: (ctx) => {
          if (typeof this._spawnSshPty !== 'function') {
            throw new AppError(ErrorCode.INTERNAL, 'No SSH PTY factory configured');
          }
          return this._spawnSshPty({ ...ctx, server: this.registry.require(serverId) });
        },
      });
      this._sshProviders.set(serverId, provider);
    }
    return provider;
  }

  /**
   * Full workspace payload. `actions` is what the UI renders from, so a
   * capability change never requires a frontend release.
   */
  async getWorkspace(serverId) {
    const provider = await this.getProvider(serverId);
    const sessions = await provider.getTree();
    const status = this.health.getStatus(serverId);
    return {
      serverId,
      provider: provider.provider,
      transport: provider.transport,
      persistence: provider.persistence,
      // Set when a better provider is available but live panes hold us here.
      pendingProvider: this.pendingProvider(serverId),
      revision: this.revision(serverId),
      actions: provider.actions,
      state: status.state,
      capabilities: status.capabilities,
      sessions,
    };
  }

  /** Read one window by stable id so opening it never walks the whole tree. */
  async getWindowPanes(serverId, windowId) {
    const provider = await this.getProvider(serverId);
    if (typeof provider.getWindowPanes === 'function') {
      return {
        provider: provider.provider,
        revision: this.revision(serverId),
        panes: await provider.getWindowPanes(windowId),
      };
    }
    const sessions = await provider.getTree();
    for (const session of sessions) {
      const win = (session.windows || []).find((candidate) => candidate.id === windowId);
      if (win) {
        return { provider: provider.provider, revision: this.revision(serverId), panes: win.panes || [] };
      }
    }
    throw new AppError(ErrorCode.WINDOW_NOT_FOUND, `Window ${windowId} not found on ${serverId}`);
  }

  /**
   * Guards a mutation against the provider having changed since the page loaded.
   * Without this, a create issued against a tmux tree could land on an SSH
   * workspace that just replaced it.
   */
  async _providerFor(serverId, expectedProvider) {
    const provider = await this.getProvider(serverId);
    if (expectedProvider && expectedProvider !== provider.provider) {
      throw new AppError(
        ErrorCode.PROVIDER_CHANGED,
        `This server now uses the ${provider.provider} provider; refresh the workspace`,
        { details: { provider: provider.provider, expected: expectedProvider } },
      );
    }
    return provider;
  }

  _requireAction(provider, action) {
    if (!provider.actions[action]) {
      throw new AppError(ErrorCode.UNSUPPORTED, `${action} is not available on the ${provider.provider} provider`, {
        details: { action, provider: provider.provider },
      });
    }
  }

  async createSession(serverId, body = {}, expectedProvider = null) {
    const provider = await this._providerFor(serverId, expectedProvider);
    this._requireAction(provider, 'createSession');
    return this._mutate(serverId, () => provider.createSession(body));
  }

  async renameSession(serverId, sessionId, body = {}, expectedProvider = null) {
    const provider = await this._providerFor(serverId, expectedProvider);
    this._requireAction(provider, 'renameSession');
    return this._mutate(serverId, () => provider.renameSession(sessionId, body));
  }

  async closeSession(serverId, sessionId, expectedProvider = null) {
    const provider = await this._providerFor(serverId, expectedProvider);
    this._requireAction(provider, 'closeSession');
    await this._mutate(serverId, () => provider.closeSession(sessionId));
  }

  async createWindow(serverId, sessionId, body = {}, expectedProvider = null) {
    const provider = await this._providerFor(serverId, expectedProvider);
    this._requireAction(provider, 'createWindow');
    return this._mutate(serverId, () => provider.createWindow(sessionId, body));
  }

  async renameWindow(serverId, windowId, body = {}, expectedProvider = null) {
    const provider = await this._providerFor(serverId, expectedProvider);
    this._requireAction(provider, 'renameWindow');
    return this._mutate(serverId, () => provider.renameWindow(windowId, body));
  }

  async closeWindow(serverId, windowId, expectedProvider = null) {
    const provider = await this._providerFor(serverId, expectedProvider);
    this._requireAction(provider, 'closeWindow');
    await this._mutate(serverId, () => provider.closeWindow(windowId));
  }

  async splitPane(serverId, windowId, body = {}, expectedProvider = null) {
    const provider = await this._providerFor(serverId, expectedProvider);
    this._requireAction(provider, 'splitPane');
    return this._mutate(serverId, () => provider.splitPane(windowId, body));
  }

  async updatePane(serverId, paneId, body = {}, expectedProvider = null) {
    const provider = await this._providerFor(serverId, expectedProvider);
    return this._mutate(serverId, () => provider.updatePane(paneId, body));
  }

  async closePane(serverId, paneId, expectedProvider = null) {
    const provider = await this._providerFor(serverId, expectedProvider);
    this._requireAction(provider, 'closePane');
    await this._mutate(serverId, () => provider.closePane(paneId));
  }

  /**
   * Verifies a pane really exists on that server before the terminal layer
   * attaches. The WebSocket layer must never trust a client-supplied pane id.
   */
  async resolvePane(serverId, paneId) {
    const provider = await this.getProvider(serverId);
    return provider.resolvePane(paneId);
  }

  /** The SSH runtime for a pane, when that server uses the SSH provider. */
  sshRuntime(serverId, paneId) {
    const provider = this._sshProviders.get(serverId);
    return provider ? provider.getRuntime(paneId) : null;
  }

  /** True when a server still holds live SSH panes; blocks deletion. */
  hasActiveRuntimes(serverId) {
    const provider = this._sshProviders.get(serverId);
    return Boolean(provider && provider.hasActivePanes());
  }

  activeRuntimeCount(serverId) {
    const provider = this._sshProviders.get(serverId);
    return provider ? provider.paneCount : 0;
  }

  /** Called when a server is deleted or its connection was rewired. */
  releaseServer(serverId, reason = 'server_removed') {
    const provider = this._sshProviders.get(serverId);
    if (provider) {
      provider.destroyAll(reason);
      this._sshProviders.delete(serverId);
    }
    this._revisions.delete(serverId);
    // A server recreated under the same id must not inherit this.
    this._pendingSwitch.delete(serverId);
    this._mutating.delete(serverId);
  }

  reapIdlePanes() {
    const reaped = {};
    for (const [serverId, provider] of this._sshProviders.entries()) {
      const removed = provider.reap(this._now());
      if (removed.length > 0) reaped[serverId] = removed;
    }
    return reaped;
  }

  destroyAll(reason = 'server_shutdown') {
    for (const provider of this._sshProviders.values()) provider.destroyAll(reason);
    this._sshProviders.clear();
    this._pendingSwitch.clear();
    this._revisions.clear();
    this._mutating.clear();
  }
}
