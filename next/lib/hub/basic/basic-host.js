/**
 * Basic mode: a machine reachable over SSH that does not run the panel.
 *
 * The hub answers that machine's workspace API and terminal sockets itself, in
 * the same shape a node would, so the browser addresses it exactly like any
 * other server (/n/:serverId/...). Everything else a node offers — files,
 * uploads, metrics, notifications, agents — needs the panel installed there.
 *
 * Two flavours, picked by one detection script:
 *   - remote tmux: sessions live in tmux on that machine and survive the hub.
 *     tmux commands run as `sh -s` scripts; attaching runs a one-word script
 *     uploaded over SFTP (see ssh-connection.js for why).
 *   - no POSIX shell or no tmux: the hub hosts login-shell PTYs itself
 *     (SshProvider). They survive a browser refresh, not a hub restart.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTmuxApi, validatePaneId } from '../../tmux.js';
import { TmuxProvider } from '../../workspace/tmux-provider.js';
import { quoteArgv } from '../../transport/ssh-connection.js';
import { AppError, ErrorCode } from '../../servers/errors.js';
import { SshProvider } from './ssh-provider.js';

/**
 * Non-login `sh` gets the sshd default PATH, which misses Homebrew and
 * per-user installs; tmux formats need a UTF-8 locale or they mangle names.
 */
export const PRELUDE = [
  'export LC_ALL=C.UTF-8 LANG=C.UTF-8',
  'PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin:$HOME/.local/share/tmux-web-panel/bin"',
  'export PATH',
].join('\n') + '\n';

export const DETECT_SCRIPT = PRELUDE + [
  'printf "kernel=%s\\n" "$(uname -s 2>/dev/null || echo unknown)"',
  'printf "arch=%s\\n" "$(uname -m 2>/dev/null || echo unknown)"',
  'printf "hostname=%s\\n" "$(hostname 2>/dev/null || echo unknown)"',
  'if command -v tmux >/dev/null 2>&1; then printf "tmux=%s\\n" "$(tmux -V 2>&1 | head -n 1)"; fi',
].join('\n') + '\n';

const ATTACH_DIR = '.cache/tmux-web-panel';
const DETECT_TTL_MS = 60_000;

export function parseFacts(stdout) {
  const facts = {};
  for (const line of String(stdout || '').split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) facts[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return facts;
}

export function normalizePlatform(kernel) {
  const value = String(kernel || '').toLowerCase();
  if (value.includes('darwin')) return 'darwin';
  if (value.includes('linux')) return 'linux';
  if (/^(msys|mingw|cygwin)/.test(value)) return 'windows';
  return value && value !== 'unknown' ? value : null;
}

function tmuxVersionOf(text) {
  const match = /tmux\s+(?:next-)?([0-9]+\.[0-9]+[a-z]?)/i.exec(String(text || ''));
  return match ? match[1] : null;
}

/** tmux commands as `sh -s` scripts; arguments are quoted for `sh` only. */
export function sshTmuxExecutor(connection) {
  return {
    id: connection.id,
    transport: 'ssh',
    tmuxBin: 'tmux',
    exec(command, args, options = {}) {
      return connection.runScript(PRELUDE + 'exec ' + quoteArgv([command, ...args]) + '\n', options);
    },
  };
}

/** The script a pty runs to attach to one pane; mirrors buildTmuxAttachCommand. */
export function attachScript(paneId, nozoom) {
  if (!validatePaneId(paneId) || !/^%\d+$/.test(paneId)) throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid pane id');
  const toggle = `resize-pane -Z -t ${paneId}`;
  return '#!/bin/sh\n' + PRELUDE
    + `exec tmux -u select-pane -t '${paneId}' \\; `
    + `if-shell -F -t '${paneId}' '#{window_zoomed_flag}' '${nozoom ? toggle : ''}' '${nozoom ? '' : toggle}' \\; `
    + `attach-session -d -t '${paneId}'\n`;
}

export function attachScriptName(paneId, nozoom) {
  return `${ATTACH_DIR}/attach-${paneId.slice(1)}-${nozoom ? 1 : 0}`;
}

export class BasicHost {
  /**
   * @param {object} deps
   * @param {import('../../transport/ssh-connection.js').SshConnection} deps.connection
   * @param {(argv: string[], env: object, size: {cols: number, rows: number}) => object} deps.spawnPty
   * @param {(revision: number) => void} [deps.onChange]
   */
  constructor({ connection, spawnPty, onChange = null, now = () => Date.now() }) {
    this.connection = connection;
    this._spawnPty = spawnPty;
    this._onChange = onChange;
    this._now = now;
    this._facts = null;
    this._factsAt = 0;
    this._detecting = null;
    this._sshProvider = null;
    this._tmuxProvider = null;
    this._uploaded = new Set();
    this._revision = 0;
  }

  /** One `sh -s` round trip, cached briefly. A failure other than ssh's own means no POSIX shell. */
  async detect({ force = false } = {}) {
    if (!force && this._facts && this._now() - this._factsAt < DETECT_TTL_MS) return this._facts;
    if (!this._detecting) {
      this._detecting = (async () => {
        let facts;
        try {
          const raw = parseFacts((await this.connection.runScript(DETECT_SCRIPT, { timeout: 15_000 })).stdout);
          const version = tmuxVersionOf(raw.tmux);
          facts = {
            posix: true,
            platform: normalizePlatform(raw.kernel),
            arch: raw.arch || null,
            hostname: raw.hostname || null,
            tmux: { available: Boolean(version), version, reason: raw.tmux ? (version ? null : 'version_unparseable') : 'command_not_found' },
          };
        } catch (err) {
          if (err instanceof AppError) throw err;
          facts = {
            posix: false,
            platform: null,
            arch: null,
            hostname: null,
            tmux: { available: false, version: null, reason: 'no_posix_shell' },
          };
        }
        this._facts = facts;
        this._factsAt = this._now();
        return facts;
      })().finally(() => { this._detecting = null; });
    }
    return this._detecting;
  }

  get mode() {
    if (!this._facts) return null;
    return this._facts.tmux.available ? 'tmux' : 'ssh';
  }

  /** The provider in use. Live hosted shells keep the host on the ssh provider. */
  async provider() {
    if (this._sshProvider && this._sshProvider.hasActivePanes()) return this._sshProvider;
    const facts = await this.detect();
    if (facts.tmux.available) {
      if (!this._tmuxProvider) {
        this._tmuxProvider = new TmuxProvider({ tmux: createTmuxApi(sshTmuxExecutor(this.connection)), batched: true });
      }
      return this._tmuxProvider;
    }
    if (!this._sshProvider) {
      this._sshProvider = new SshProvider({
        serverId: this.connection.id,
        spawnPty: ({ cols, rows }) => this._spawnPty(this.connection.ptyArgs(), this.connection.sshEnv(), { cols, rows }),
        onChange: () => this._bump(),
      });
    }
    return this._sshProvider;
  }

  _bump() {
    this._revision += 1;
    if (typeof this._onChange === 'function') this._onChange(this._revision);
  }

  async _mutate(fn) {
    const provider = await this.provider();
    const result = await fn(provider);
    this._bump();
    return result;
  }

  // --- The WorkspaceService interface, so the node workspace router serves it unchanged. ---

  async getWorkspace() {
    const provider = await this.provider();
    return {
      provider: provider.provider,
      persistence: provider.persistence,
      revision: this._revision,
      actions: provider.actions,
      sessions: await provider.getTree(),
    };
  }

  async getWindowPanes(windowId) {
    const provider = await this.provider();
    if (typeof provider.getWindowPanes === 'function') {
      return { revision: this._revision, panes: await provider.getWindowPanes(windowId) };
    }
    for (const session of await provider.getTree()) {
      const win = (session.windows || []).find((candidate) => candidate.id === windowId);
      if (win) return { revision: this._revision, panes: win.panes || [] };
    }
    throw new AppError(ErrorCode.WINDOW_NOT_FOUND, `Window ${windowId} not found`);
  }

  createSession(body = {}) { return this._mutate((p) => p.createSession(body)); }

  renameSession(sessionId, body = {}) { return this._mutate((p) => p.renameSession(sessionId, body)); }

  async closeSession(sessionId) { await this._mutate((p) => p.closeSession(sessionId)); }

  createWindow(sessionId, body = {}) { return this._mutate((p) => p.createWindow(sessionId, body)); }

  renameWindow(windowId, body = {}) { return this._mutate((p) => p.renameWindow(windowId, body)); }

  async closeWindow(windowId) { await this._mutate((p) => p.closeWindow(windowId)); }

  splitPane(windowId, body = {}) { return this._mutate((p) => p.splitPane(windowId, body)); }

  updatePane(paneId, body = {}) { return this._mutate((p) => p.updatePane(paneId, body)); }

  async closePane(paneId) { await this._mutate((p) => p.closePane(paneId)); }

  async resolvePane(paneId) {
    return (await this.provider()).resolvePane(paneId);
  }

  /** The hosted runtime of a pane, when this host uses hub-hosted shells. */
  sshRuntime(paneId) {
    return this._sshProvider ? this._sshProvider.getRuntime(paneId) : null;
  }

  /**
   * pty argv that attaches to a remote tmux pane. The attach script is
   * uploaded once per pane/zoom pair and run as the single remote word.
   */
  async attachArgs(paneId, nozoom) {
    const name = attachScriptName(paneId, nozoom);
    if (!this._uploaded.has(name)) {
      const dir = await mkdtemp(join(tmpdir(), 'tmux-attach-'));
      try {
        const local = join(dir, 'attach.sh');
        await writeFile(local, attachScript(paneId, nozoom), { mode: 0o700 });
        await this.connection.uploadFile(local, name, { mode: '755' });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      this._uploaded.add(name);
    }
    return this.connection.ptyArgs(name);
  }

  reap() {
    return this._sshProvider ? this._sshProvider.reap(this._now()) : [];
  }

  destroy(reason = 'server_removed') {
    if (this._sshProvider) this._sshProvider.destroyAll(reason);
    this._sshProvider = null;
  }
}
