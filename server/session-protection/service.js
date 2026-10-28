/**
 * Session protection: keeps tmux sessions across tmux restarts and reboots.
 *
 * The node drives it, so nothing has to be added to ~/.tmux.conf:
 * - every few minutes it runs tmux-resurrect's save.sh (standard snapshots, so
 *   prefix + Ctrl-s / Ctrl-r keep working in a terminal);
 * - the first time it sees a tmux server instance that has no sessions, it
 *   restores the latest snapshot with the panel's own restore (restore.js) and
 *   records that on the server, so the page can say it happened;
 * - a snapshot never replaces the latest one while tmux has no sessions,
 *   because that empty save is what would be restored after the next reboot.
 *
 * When the user's own tmux config already loads tmux-resurrect (often with
 * tmux-continuum through TPM), that setup stays in charge: the panel only
 * reports, saves on request and restores single sessions from history.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import { AppError, ErrorCode } from '../servers/errors.js';
import { IS_WINDOWS, MSYS_ROOT, TMUX_BIN, msysExecArgs, tmuxUserHome, toNativePath, toPosixPath } from '../msys.js';
import { shellQuote } from '../transport/ssh-connection.js';
import { DEFAULT_PROGRAMS, choiceList, isValidChoice, programName, resurrectProcessOptions } from './catalog.js';
import { freeName, restoreSession } from './restore.js';
import { listSnapshots, readLatest, readSnapshot, summarize } from './snapshot.js';

const execFileAsync = promisify(execFile);

export const SAVE_INTERVAL_MS = 5 * 60 * 1000;
const TICK_MS = 20 * 1000;
const SEP = '=:=';
const SETTINGS_FILE = 'session-protection.json';
const MAX_PROGRAMS = 64;

// Server-scoped tmux options: they vanish with the server, which is the point.
const OPT_SEEN = '@twp-protect-seen';
const OPT_RESTORED_AT = '@twp-restored-at';
const OPT_RESTORED_FROM = '@twp-restored-from';
const OPT_RESTORED_SESSIONS = '@twp-restored-sessions';

const INFO_FORMAT = [
  '#{pid}', '#{start_time}', '#{default-shell}', `#{${OPT_SEEN}}`,
  `#{${OPT_RESTORED_AT}}`, `#{${OPT_RESTORED_FROM}}`, `#{${OPT_RESTORED_SESSIONS}}`,
  '#{@resurrect-save-script-path}', '#{@resurrect-dir}', '#{@continuum-restore}',
].join(SEP);

function isNoServer(err) {
  const text = `${err && err.stderr ? err.stderr : ''} ${err && err.message ? err.message : ''}`;
  return /no server running|error connecting to|server exited unexpectedly|No such file or directory \(/i.test(text);
}

export class SessionProtection {
  /**
   * @param {object} deps
   * @param {string} deps.configDir
   * @param {string} deps.projectDir
   * @param {import('../managed-resources.js').ManagedResources} [deps.baseConfig] the panel's tmux.conf fragment
   */
  constructor({
    configDir, projectDir, baseConfig = null, tmuxBin = TMUX_BIN, windows = IS_WINDOWS,
    exec = (file, args, options) => execFileAsync(file, ...msysExecArgs(args, options)), now = () => Date.now(),
    home = null, userConfigPath = null, intervalMs = SAVE_INTERVAL_MS, tickMs = TICK_MS,
  }) {
    this.configDir = configDir;
    this.baseConfig = baseConfig;
    this.tmuxBin = tmuxBin;
    this.windows = windows;
    this._exec = exec;
    this._now = now;
    this._fallbackHome = home;
    this.userConfigPath = userConfigPath;
    this.intervalMs = intervalMs;
    this.tickMs = tickMs;
    this.pluginDir = join(projectDir, 'vendor', 'tmux-plugins', 'tmux-resurrect');
    this.settings = { enabled: true, programs: [...DEFAULT_PROGRAMS] };
    this.lastSave = null;
    this._lastSaveAt = 0;
    this._timer = null;
    this._queue = Promise.resolve();
  }

  // --- paths as tmux and as Node see them ---

  /** A native path as the tmux side (bash under MSYS2 on Windows) spells it. */
  _tmuxPath(nativePath) {
    return this.windows ? toPosixPath(nativePath, MSYS_ROOT) : nativePath;
  }

  _nativePath(tmuxPath) {
    return this.windows ? toNativePath(tmuxPath, MSYS_ROOT) : tmuxPath;
  }

  /** Where ~ is for tmux while no server tells us: see tmuxUserHome. */
  defaultHome() {
    return this._fallbackHome || tmuxUserHome({ windows: this.windows });
  }

  /** resurrect's own rule: ~/.tmux/resurrect if it exists, else the XDG data dir. */
  snapshotDir(home, option = '') {
    if (option) {
      const expanded = option.replace(/^~(?=\/|$)/, '$HOME').replace(/\$HOME/g, this._tmuxPath(home));
      return this._nativePath(expanded);
    }
    const legacy = join(home, '.tmux', 'resurrect');
    return existsSync(legacy) ? legacy : join(home, '.local', 'share', 'tmux', 'resurrect');
  }

  // --- settings ---

  async load() {
    try {
      const saved = JSON.parse(await readFile(join(this.configDir, SETTINGS_FILE), 'utf8'));
      if (typeof saved.enabled === 'boolean') this.settings.enabled = saved.enabled;
      if (Array.isArray(saved.programs)) this.settings.programs = saved.programs.filter(isValidChoice);
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('[session-protection] settings unreadable, using defaults:', err.message);
    }
  }

  async _persist() {
    await mkdir(this.configDir, { recursive: true, mode: 0o700 });
    const file = join(this.configDir, SETTINGS_FILE);
    await writeFile(file + '.tmp', JSON.stringify(this.settings, null, 2), { mode: 0o600 });
    await rename(file + '.tmp', file);
  }

  async update(patch = {}) {
    const next = { ...this.settings };
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== 'boolean') throw new AppError(ErrorCode.VALIDATION_ERROR, 'enabled must be a boolean');
      next.enabled = patch.enabled;
    }
    if (patch.programs !== undefined) {
      if (!Array.isArray(patch.programs) || patch.programs.length > MAX_PROGRAMS || !patch.programs.every(isValidChoice)) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 'programs must be a list of known program choices');
      }
      next.programs = [...new Set(patch.programs)];
    }
    this.settings = next;
    await this._persist();
    // Options are re-applied to a running server at once, not at the next tick.
    await this._serial(async () => {
      const env = await this._inspect();
      if (env.running && env.mode === 'managed') await this._applyOptions(env);
    });
    return this.status();
  }

  // --- tmux ---

  async _tmux(args, { timeout = 10000 } = {}) {
    const { stdout } = await this._exec(this.tmuxBin, args, { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    return String(stdout);
  }

  /** One round trip for everything a decision needs. */
  async _inspect() {
    const env = { available: true, running: false, mode: 'managed', home: this.defaultHome() };
    let out;
    try {
      out = await this._tmux(['display-message', '-p', INFO_FORMAT, ';', 'show-environment', '-g', 'HOME', ';', 'show-options', '-gqv', 'status-right']);
    } catch (err) {
      if (err && err.code === 'ENOENT') env.available = false;
      else if (!isNoServer(err)) throw err;
      env.mode = !env.available ? 'unavailable' : (await this._userConfigLoadsPlugins()) ? 'external' : 'managed';
      env.dir = this.snapshotDir(env.home);
      return env;
    }
    const lines = out.split(/\r?\n/);
    const [pid, startTime, defaultShell, seen, restoredAt, restoredFrom, restoredSessions, scriptPath, dirOption, continuumRestore] = lines[0].split(SEP);
    const homeLine = lines.find((line) => line.startsWith('HOME='));
    if (homeLine) env.home = this._nativePath(homeLine.slice(5));
    Object.assign(env, {
      running: true,
      pid,
      startedAt: Number(startTime) ? new Date(Number(startTime) * 1000).toISOString() : null,
      defaultShell: programName(defaultShell),
      seen: seen || '',
      restored: restoredAt ? { at: restoredAt, from: restoredFrom || null, sessions: Number(restoredSessions) || 0 } : null,
    });
    const ours = this._tmuxPath(this.pluginDir);
    const theirs = Boolean(scriptPath) && !scriptPath.startsWith(ours);
    env.mode = theirs ? 'external' : 'managed';
    env.scriptPath = scriptPath || '';
    env.external = theirs ? {
      scriptPath,
      continuum: continuumRestore !== '' || lines.slice(1).some((line) => line.includes('continuum_save')),
    } : null;
    env.dir = this.snapshotDir(env.home, theirs ? dirOption : '');
    return env;
  }

  async _userConfigLoadsPlugins() {
    if (!this.userConfigPath) return false;
    try {
      const text = await readFile(this.userConfigPath, 'utf8');
      return text.split(/\r?\n/).some((line) => /^[^#]*tmux-(resurrect|continuum)/.test(line));
    } catch {
      return false;
    }
  }

  async _sessions() {
    try {
      return (await this._tmux(['list-sessions', '-F', '#{session_name}'])).split(/\r?\n/).filter(Boolean);
    } catch (err) {
      if (isNoServer(err)) return [];
      throw err;
    }
  }

  async _applyOptions(env) {
    const processes = resurrectProcessOptions(this.settings.programs);
    const args = [
      'set-option', '-g', '@resurrect-dir', this._tmuxPath(env.dir), ';',
      'set-option', '-g', '@resurrect-default-processes', processes.defaultProcesses, ';',
      'set-option', '-g', '@resurrect-processes', processes.processes,
    ];
    if (this.windows) args.push(';', 'set-option', '-g', '@resurrect-save-command-strategy', 'msys_procfs');
    await this._tmux(args);
  }

  _script(name) {
    return 'bash ' + shellQuote(this._tmuxPath(join(this.pluginDir, name)));
  }

  /** Runs one task at a time: a save must never see a restore half done. */
  _serial(fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.catch(() => {});
    return run;
  }

  // --- the periodic decision ---

  start() {
    if (this._timer) return;
    const tick = () => this.tick().catch((err) => console.error('[session-protection]', err.message));
    this._timer = setInterval(tick, this.tickMs);
    if (this._timer.unref) this._timer.unref();
    tick();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  tick() {
    return this._serial(async () => {
      const env = await this._inspect();
      if (!env.running || env.mode !== 'managed') return;
      await this._prepare(env);
      if (!env.seen) await this._firstSight(env);
      if (this.settings.enabled && this._now() - this._lastSaveAt >= this.intervalMs) {
        if ((await this._sessions()).length > 0) await this._save(env);
      }
    });
  }

  /**
   * Options and key bindings, once per server instance and per run of this
   * process; retried on the next tick if tmux refused them.
   */
  async _prepare(env) {
    if (this._preparedFor === env.pid) return;
    await this._applyOptions(env);
    // Key bindings (prefix + Ctrl-s / Ctrl-r) for people working in a terminal.
    if (!env.scriptPath) await this._tmux(['run-shell', '-b', this._script('resurrect.tmux')]).catch(() => {});
    this._preparedFor = env.pid;
  }

  /**
   * The first look at a tmux server instance decides, once, whether to
   * restore. It is marked before restoring: a restore that fails half way is
   * better left alone than repeated into duplicate sessions.
   */
  async _firstSight(env) {
    await this._tmux(['set-option', '-g', OPT_SEEN, String(env.pid || 1)]);
    if (!this.settings.enabled) return;
    if ((await this._sessions()).length > 0) return;
    const latest = await readLatest(env.dir);
    if (!latest || latest.snapshot.sessions.length === 0) return;
    const restored = await this._restoreAll(latest.snapshot, env);
    await this._tmux([
      'set-option', '-g', OPT_RESTORED_AT, new Date(this._now()).toISOString(), ';',
      'set-option', '-g', OPT_RESTORED_FROM, latest.at, ';',
      'set-option', '-g', OPT_RESTORED_SESSIONS, String(restored),
    ]);
    // Programs just reopened may not be running yet; a save now would forget them.
    this._lastSaveAt = this._now();
  }

  async _restoreAll(snapshot, env) {
    const taken = new Set(await this._sessions());
    let count = 0;
    for (const session of snapshot.sessions) {
      const name = freeName(session.name, taken);
      try {
        await restoreSession((args) => this._tmux(args), session, { name, programs: this.settings.programs, defaultShell: env.defaultShell });
        taken.add(name);
        count += 1;
      } catch (err) {
        console.error(`[session-protection] could not restore session ${session.name}:`, err.message);
      }
    }
    return count;
  }

  async _save(env) {
    const script = env.mode === 'external' ? shellQuote(env.external.scriptPath) : this._script('scripts/save.sh');
    try {
      await this._tmux(['run-shell', `${script} quiet`], { timeout: 120000 });
      this.lastSave = { at: new Date(this._now()).toISOString(), ok: true };
    } catch (err) {
      this.lastSave = { at: new Date(this._now()).toISOString(), ok: false, error: String(err.stderr || err.message).trim().slice(0, 300) };
    }
    this._lastSaveAt = this._now();
    return this.lastSave;
  }

  // --- what the page asks for ---

  saveNow() {
    return this._serial(async () => {
      const env = await this._inspect();
      if (!env.running) throw new AppError(ErrorCode.UNSUPPORTED, 'tmux is not running on this machine');
      if ((await this._sessions()).length === 0) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 'There are no sessions to save; the previous save is kept');
      }
      if (env.mode === 'managed') {
        await this._prepare(env);
        if (!env.seen) await this._firstSight(env);
      }
      const result = await this._save(env);
      if (!result.ok) throw new AppError(ErrorCode.INTERNAL, `Saving failed: ${result.error}`);
      return this.status();
    });
  }

  async snapshots() {
    const env = await this._inspect();
    const entries = await listSnapshots(env.dir);
    const out = [];
    for (const entry of entries.slice(0, 50)) {
      const snapshot = await readSnapshot(env.dir, entry.id);
      if (!snapshot || snapshot.sessions.length === 0) continue;
      out.push({
        ...entry,
        ...summarize(snapshot),
        list: snapshot.sessions.map((session) => ({
          name: session.name,
          windows: session.windows.map((window) => window.name),
          panes: session.windows.reduce((sum, window) => sum + window.panes.length, 0),
        })),
      });
    }
    return { snapshots: out };
  }

  restore(id, sessionName) {
    return this._serial(async () => {
      const env = await this._inspect();
      if (!env.available) throw new AppError(ErrorCode.UNSUPPORTED, 'tmux is not available on this machine');
      const snapshot = await readSnapshot(env.dir, String(id || ''));
      if (!snapshot) throw new AppError(ErrorCode.SESSION_NOT_FOUND, 'Snapshot not found');
      const session = snapshot.sessions.find((entry) => entry.name === sessionName);
      if (!session) throw new AppError(ErrorCode.SESSION_NOT_FOUND, 'That session is not in this snapshot');
      const name = freeName(session.name, new Set(await this._sessions()));
      const shell = env.defaultShell || null;
      return restoreSession((args) => this._tmux(args), session, { name, programs: this.settings.programs, defaultShell: shell });
    });
  }

  async status() {
    const env = await this._inspect();
    const latest = await readLatest(env.dir).catch(() => null);
    const seen = new Map();
    if (latest) {
      for (const session of latest.snapshot.sessions) {
        for (const window of session.windows) {
          for (const pane of window.panes) {
            const name = programName(pane.fullCommand) || programName(pane.command);
            if (name && !seen.has(name)) seen.set(name, pane.fullCommand || name);
          }
        }
      }
    }
    if (env.running) {
      const out = await this._tmux(['list-panes', '-a', '-F', '#{pane_current_command}']).catch(() => '');
      for (const command of out.split(/\r?\n/)) {
        const name = programName(command);
        if (name && !seen.has(name)) seen.set(name, '');
      }
    }
    return {
      mode: env.mode,
      enabled: this.settings.enabled,
      intervalMinutes: Math.round(this.intervalMs / 60000),
      programs: choiceList(this.settings.programs, seen, env.defaultShell || null),
      tmux: { running: env.running, startedAt: env.startedAt || null },
      lastSave: this.lastSave,
      latest: latest && latest.snapshot.sessions.length ? { at: latest.at, ...summarize(latest.snapshot) } : null,
      autoRestore: env.restored || null,
      external: env.external ? { continuum: env.external.continuum } : null,
      snapshotDir: env.dir,
      base: await this._baseStatus(),
    };
  }

  // --- the settings the panel itself needs (the managed tmux.conf fragment) ---

  async _baseStatus() {
    if (!this.baseConfig) return null;
    const { tmuxConfig } = await this.baseConfig.status();
    return {
      linked: Boolean(tmuxConfig.linked),
      packaged: tmuxConfig.linkSupported === false,
      userPath: tmuxConfig.userPath,
      path: tmuxConfig.path,
      extraLines: tmuxConfig.extraLines || 0,
      file: tmuxConfig.userPath ? basename(tmuxConfig.userPath) : null,
    };
  }

  async linkBase() {
    if (!this.baseConfig) throw new AppError(ErrorCode.UNSUPPORTED, 'Not available here');
    await this.baseConfig.linkConfig(true);
    const env = await this._inspect();
    // Takes effect now when tmux runs; otherwise on its next start.
    if (env.running) await this.baseConfig.applyConfig();
    return this.status();
  }
}
