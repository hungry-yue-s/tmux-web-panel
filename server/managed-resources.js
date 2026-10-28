import { lstat, mkdir, readFile, readlink, realpath, rename, symlink, unlink, writeFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { AppError, ErrorCode } from './servers/errors.js';
import { toPosixPath } from './msys.js';

const exec = promisify(execFile);
const BEGIN = '# >>> tmux-web-panel managed config >>>';
const END = '# <<< tmux-web-panel managed config <<<';
const DEFAULT_CONFIG = '# Managed by Tmux Web Panel\nset -g exit-empty off\nset -g mouse on\nset -g history-limit 50000\n';
const SKILLS = {
  'tmux-agent': 'plugins/tmux-agent/skills/tmux-agent',
  'tmux-panel': 'skills/tmux-panel',
};

async function readOptional(file) {
  try { return await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Lines of the fragment beyond the defaults: what someone added by hand earlier. */
function extraLines(content) {
  const defaults = new Set(DEFAULT_CONFIG.split('\n'));
  return content.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith('#') && !defaults.has(line)).length;
}

export class ManagedResources {
  /**
   * @param {object} options
   * @param {string} [options.userConfigPath] the ~/.tmux.conf tmux reads, when it is not under userHome (MSYS2 on Windows)
   * @param {string} [options.serverTmuxBin] the tmux that runs the server, for applying the fragment
   */
  constructor({ projectDir, configDir, userHome = homedir(), spawnProcess = spawn, execProcess = exec, packaged = false, runtimePath,
    userConfigPath = null, serverTmuxBin = null }) {
    this.projectDir = projectDir;
    this.configDir = configDir;
    this.home = userHome;
    this.spawn = spawnProcess;
    this.exec = execProcess;
    this.packaged = packaged;
    if (packaged && !runtimePath) throw new Error('Packaged runtime path is required');
    this.binary = packaged ? join(runtimePath, 'bin/tmux') : join(userHome, '.local/share/tmux-web-panel/bin/tmux');
    this.serverBinary = serverTmuxBin || this.binary;
    this.config = join(configDir, 'tmux.conf');
    this.userConfig = packaged ? null : userConfigPath || join(userHome, '.tmux.conf');
    this.busy = false;
    this.build = null;
  }

  async load() {
    await mkdir(this.configDir, { recursive: true, mode: 0o700 });
    const saved = await readOptional(join(this.configDir, 'tmux-build.json'));
    if (saved) {
      this.build = JSON.parse(saved);
      if (this.build.status === 'running') {
        this.build = { ...this.build, status: 'interrupted', message: 'Panel restarted before build completion was recorded; inspect the binary before rebuilding.' };
        await this.saveBuild();
      }
    }
  }

  async exclusive(fn) {
    if (this.busy) throw new AppError(ErrorCode.SERVER_IN_USE, 'Another resource change is in progress');
    this.busy = true;
    try { return await fn(); } finally { this.busy = false; }
  }

  async status() {
    let version = null;
    try { version = (await this.exec(this.binary, ['-V'], { timeout: 3000 })).stdout.trim(); } catch { /* Missing/broken binary is shown explicitly. */ }
    const config = await readOptional(this.config);
    const userConfig = this.userConfig ? await readOptional(this.userConfig) || '' : '';
    const skills = [];
    for (const [name, relative] of Object.entries(SKILLS)) {
      for (const target of ['codex', 'claude']) {
        const path = this.skillPath(name, target);
        let status = 'not_installed';
        try {
          const info = await lstat(path);
          status = info.isSymbolicLink() && await readlink(path) === join(this.projectDir, relative) ? 'managed' : 'conflict';
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        skills.push({ name, target, path, status });
      }
    }
    return { runtime: { path: this.binary, version, available: !!version, build: this.build, packaged: this.packaged,
      buildSupported: !this.packaged, rollbackSupported: !this.packaged },
      tmuxConfig: { path: this.config, exists: config !== null, extraLines: extraLines(config ?? DEFAULT_CONFIG),
        userPath: this.userConfig, linked: this.packaged ? config !== null : userConfig.includes(BEGIN), linkSupported: !this.packaged,
        backupDirectory: join(this.configDir, 'backups') }, skills };
  }

  async backupWrite(file, content) {
    // Preserve symlink-based dotfile setups by replacing their actual target.
    let destination = file;
    try { destination = await realpath(file); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const info = await lstat(file).catch((e) => { if (e.code !== 'ENOENT') throw e; return null; });
      if (info?.isSymbolicLink()) throw new AppError(ErrorCode.SERVER_IN_USE, 'Config is a dangling symlink; repair its target first');
    }
    const previous = await readOptional(destination);
    let backup = null;
    if (previous !== null) {
      await mkdir(join(this.configDir, 'backups'), { recursive: true, mode: 0o700 });
      backup = join(this.configDir, 'backups', randomUUID() + '.conf');
      await writeFile(backup, previous, { mode: 0o600 });
    }
    await mkdir(join(destination, '..'), { recursive: true });
    const staged = destination + '.' + randomUUID() + '.tmp';
    await writeFile(staged, content, { mode: 0o600 });
    await rename(staged, destination);
    return backup;
  }

  // The fragment holds only what the panel needs (DEFAULT_CONFIG); it is no
  // longer edited as raw text. Earlier hand edits stay in place and are counted
  // in status() as extraLines.

  async linkConfig(enable) {
    if (this.packaged) throw new AppError(ErrorCode.UNSUPPORTED, 'Desktop installations use a separate tmux configuration; personal ~/.tmux.conf is unchanged');
    return this.exclusive(async () => {
      let text = await readOptional(this.userConfig) || '';
      const start = text.indexOf(BEGIN);
      const end = text.indexOf(END);
      if ((start < 0) !== (end < 0) || (start >= 0 && (end < start || text.indexOf(BEGIN, start + BEGIN.length) >= 0 || text.indexOf(END, end + END.length) >= 0))) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 'Managed config markers are malformed; inspect ~/.tmux.conf');
      }
      if (start >= 0) text = text.slice(0, start) + text.slice(end + END.length).replace(/^\r?\n/, '');
      if (enable) {
        if (await readOptional(this.config) === null) await this.backupWrite(this.config, DEFAULT_CONFIG);
        const target = process.platform === 'win32' ? toPosixPath(this.config) : this.config;
        const escaped = target.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$');
        text += (text && !text.endsWith('\n') ? '\n' : '') + BEGIN + '\nsource-file "' + escaped + '"\n' + END + '\n';
      }
      return { linked: enable, backup: await this.backupWrite(this.userConfig, text), applied: false };
    });
  }

  async applyConfig() {
    return this.exclusive(async () => {
      if (await readOptional(this.config) === null) throw new AppError(ErrorCode.VALIDATION_ERROR, 'Save the managed configuration first');
      // tmux reads the file itself, so it needs the path in its own (MSYS) form.
      const file = process.platform === 'win32' ? toPosixPath(this.config) : this.config;
      // Syntax-only parse first. Do not start/restart the tmux server.
      await this.exec(this.serverBinary, ['source-file', '-n', file], { timeout: 5000 });
      await this.exec(this.serverBinary, ['source-file', file], { timeout: 5000 });
      return { applied: true };
    });
  }

  skillPath(name, target) {
    if (!SKILLS[name] || !['codex', 'claude'].includes(target)) throw new AppError(ErrorCode.VALIDATION_ERROR, 'Unknown skill or agent');
    return join(this.home, target === 'codex' ? '.codex' : '.claude', 'skills', name);
  }

  async changeSkill(name, target, install) {
    return this.exclusive(async () => {
      const path = this.skillPath(name, target);
      const source = join(this.projectDir, SKILLS[name]);
      await readFile(join(source, 'SKILL.md'), 'utf8');
      let exists = false;
      try {
        const info = await lstat(path);
        exists = true;
        if (!info.isSymbolicLink() || await readlink(path) !== source) throw new AppError(ErrorCode.SERVER_IN_USE, 'This skill path is not managed by the panel; it will not be overwritten');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (install && !exists) {
        await mkdir(join(path, '..'), { recursive: true });
        await symlink(source, path, 'dir');
      }
      if (!install && exists) await unlink(path);
      return { name, target, path, installed: install };
    });
  }

  async saveBuild() {
    const file = join(this.configDir, 'tmux-build.json');
    await writeFile(file + '.tmp', JSON.stringify(this.build), { mode: 0o600 });
    await rename(file + '.tmp', file);
  }

  async buildTmux() {
    if (this.packaged) throw new AppError(ErrorCode.UNSUPPORTED, 'Update the desktop app to update its bundled tmux; local source builds are unavailable');
    return this.exclusive(async () => {
      if (this.build?.status === 'running' || this.finishingBuild) throw new AppError(ErrorCode.SERVER_IN_USE, 'A tmux build is already running');
      this.build = { id: randomUUID(), status: 'running', startedAt: new Date().toISOString(), output: '' };
      await this.saveBuild();
      let child;
      try {
        child = this.spawn('bash', [join(this.projectDir, 'scripts/build-tmux.sh')], {
          env: { ...process.env, TMUX_INSTALL_PREFIX: join(this.home, '.local/share/tmux-web-panel'), TMUX_SOURCE_DIR: join(this.projectDir, 'vendor/tmux') },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        this.build = { ...this.build, status: 'failed', message: error.message };
        await this.saveBuild();
        throw error;
      }
      const append = (data) => { this.build.output = (this.build.output + data).slice(-65536); };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      let finished = false;
      const finish = async (code, error) => {
        if (finished) return;
        finished = true;
        this.finishingBuild = true;
        this.build = { ...this.build, status: code === 0 && !error ? 'completed' : 'failed', exitCode: code, message: error?.message, finishedAt: new Date().toISOString() };
        try { await this.saveBuild(); } catch (e) { console.error('[tmux build] Could not save result:', e.message); }
        finally { this.finishingBuild = false; }
      };
      child.once('error', (error) => { void finish(null, error); });
      child.once('close', (code) => { void finish(code); });
      return this.build;
    });
  }

  async rollbackTmux() {
    if (this.packaged) throw new AppError(ErrorCode.UNSUPPORTED, 'Use a desktop runtime version rollback; bundled binaries cannot be replaced here');
    return this.exclusive(async () => {
      if (this.build?.status === 'running' || this.finishingBuild) throw new AppError(ErrorCode.SERVER_IN_USE, 'Wait for the current build');
      const previous = this.binary + '.previous';
      const version = (await this.exec(previous, ['-V'], { timeout: 3000 })).stdout.trim();
      await copyFile(previous, this.binary + '.rollback');
      await rename(this.binary + '.rollback', this.binary);
      return { version, restored: true, runningServerRestarted: false };
    });
  }
}
