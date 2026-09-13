import { lstat, mkdir, readFile, readlink, realpath, rename, symlink, unlink, writeFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { AppError, ErrorCode } from './servers/errors.js';

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

export class ManagedResources {
  constructor({ projectDir, configDir, userHome = homedir(), spawnProcess = spawn, execProcess = exec }) {
    this.projectDir = projectDir;
    this.configDir = configDir;
    this.home = userHome;
    this.spawn = spawnProcess;
    this.exec = execProcess;
    this.binary = join(userHome, '.local/share/tmux-web-panel/bin/tmux');
    this.config = join(configDir, 'tmux.conf');
    this.userConfig = join(userHome, '.tmux.conf');
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
    const userConfig = await readOptional(this.userConfig) || '';
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
    return { runtime: { path: this.binary, version, available: !!version, build: this.build },
      tmuxConfig: { path: this.config, content: config ?? DEFAULT_CONFIG, exists: config !== null,
        userPath: this.userConfig, linked: userConfig.includes(BEGIN), backupDirectory: join(this.configDir, 'backups') }, skills };
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

  async saveConfig({ content, expectedContent }) {
    if (typeof content !== 'string' || Buffer.byteLength(content) > 65536 || content.includes('\0')) throw new AppError(ErrorCode.VALIDATION_ERROR, 'Config must be text under 64 KiB');
    if (typeof expectedContent !== 'string') throw new AppError(ErrorCode.VALIDATION_ERROR, 'expectedContent is required');
    return this.exclusive(async () => {
      const current = await readOptional(this.config) ?? DEFAULT_CONFIG;
      if (current !== expectedContent) throw new AppError(ErrorCode.SERVER_IN_USE, 'Configuration changed; reload before saving');
      // Keep the project's companion-server invariant explicit in the fragment.
      if (!/^\s*set(?:-option)?\s+-g\s+exit-empty\s+off\s*$/m.test(content)) throw new AppError(ErrorCode.VALIDATION_ERROR, 'Keep set -g exit-empty off for session recovery');
      return { backup: await this.backupWrite(this.config, content), saved: true, applied: false };
    });
  }

  async linkConfig(enable) {
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
        const escaped = this.config.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$');
        text += (text && !text.endsWith('\n') ? '\n' : '') + BEGIN + '\nsource-file "' + escaped + '"\n' + END + '\n';
      }
      return { linked: enable, backup: await this.backupWrite(this.userConfig, text), applied: false };
    });
  }

  async applyConfig() {
    return this.exclusive(async () => {
      if (await readOptional(this.config) === null) throw new AppError(ErrorCode.VALIDATION_ERROR, 'Save the managed configuration first');
      // Syntax-only parse first. Do not start/restart the tmux server.
      await this.exec(this.binary, ['source-file', '-n', this.config], { timeout: 5000 });
      await this.exec(this.binary, ['source-file', this.config], { timeout: 5000 });
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
