/**
 * Installs this panel on a basic-mode machine, from the hub, over SSH.
 *
 * Installing is the one place the hub runs a program remotely, and it is an
 * explicit user action. The code that gets installed is this panel's own
 * (packed from projectDir and uploaded over SFTP), so the node matches the hub.
 * The remote half is scripts/remote/install-node.{sh,ps1}: it installs missing
 * build packages (sudo when needed), an official Node.js build if none is
 * recent enough, runs npm ci and the platform service installer in node-only
 * mode on 127.0.0.1. Progress lines stream into the job log the UI polls.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AppError, ErrorCode } from '../servers/errors.js';
import { shellQuote } from '../transport/ssh-connection.js';

export const REMOTE_ARCHIVE = '.cache/tmux-web-panel/panel.tgz';
export const PORT_CANDIDATES = '7681 7781 7881 7981';
const LOG_LINES = 400;
const PACKED = ['package.json', 'package-lock.json', 'server', 'public', 'scripts', 'relay', 'plugins/tmux-agent', 'skills/tmux-panel'];
const EXCLUDES = ['node_modules', '.git', '*.pem', '*.key', '*.crt', '.env', 'relay-config.js', '*.o', '*.a'];

/** The POSIX script with its inputs prepended; secrets travel on stdin only. */
export function posixInstallScript(template, { sudoPassword = '' } = {}) {
  return [
    `TWP_ARCHIVE=${shellQuote(REMOTE_ARCHIVE)}`,
    `TWP_PORT_CANDIDATES=${shellQuote(PORT_CANDIDATES)}`,
    `TWP_SUDO_PASSWORD=${shellQuote(sudoPassword || '')}`,
    template,
  ].join('\n');
}

/** PowerShell's -EncodedCommand: base64 of UTF-16LE, plain characters in any shell. */
export function windowsInstallWords(template) {
  const script = `$TwpArchive = '${REMOTE_ARCHIVE}'\n$TwpPorts = '${PORT_CANDIDATES}'\n${template}`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return ['powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
}

/** Splits streamed output into lines and reads progress and the final result. */
export class InstallLog {
  constructor(limit = LOG_LINES) {
    this.limit = limit;
    this.lines = [];
    this.pending = '';
    this.step = null;
    this.result = null;
  }

  write(chunk) {
    const text = this.pending + String(chunk).replace(/\r\n?/g, '\n');
    const parts = text.split('\n');
    this.pending = parts.pop();
    for (const line of parts) this._line(line);
  }

  end() {
    if (this.pending) this._line(this.pending);
    this.pending = '';
  }

  _line(line) {
    const match = /^TWP_RESULT=(\w+)/.exec(line.trim());
    if (match) { this.result = match[1]; return; }
    if (line.startsWith('>> ')) this.step = line.slice(3);
    this.lines.push(line);
    if (this.lines.length > this.limit) this.lines.splice(0, this.lines.length - this.limit);
  }
}

function packArchive(projectDir, target, { includeTmux }) {
  const entries = PACKED.filter((entry) => existsSync(join(projectDir, entry)));
  if (includeTmux) entries.push('vendor/tmux');
  const args = ['-czf', target, ...EXCLUDES.map((pattern) => `--exclude=${pattern}`), '-C', projectDir, ...entries];
  return new Promise((resolve, reject) => {
    execFile('tar', args, { windowsHide: true, maxBuffer: 1024 * 1024 }, (err, _out, stderr) => {
      if (err) reject(new AppError(ErrorCode.INTERNAL, `Packing the panel failed: ${String(stderr || err.message).slice(0, 300)}`));
      else resolve();
    });
  });
}

export class NodeInstaller {
  /**
   * @param {object} deps
   * @param {import('./link-pool.js').LinkPool} deps.links
   * @param {string} deps.projectDir this panel's own source tree
   * @param {(serverId: string) => void} [deps.onInstalled] re-probe once it works
   */
  constructor({ links, projectDir, onInstalled = null, now = () => Date.now(), pack = packArchive }) {
    this.links = links;
    this.projectDir = projectDir;
    this._onInstalled = onInstalled;
    this._now = now;
    this._pack = pack;
    this._jobs = new Map();
  }

  status(serverId) {
    const job = this._jobs.get(serverId);
    if (!job) return { serverId, state: 'idle', step: null, log: [], startedAt: null, finishedAt: null, error: null };
    return {
      serverId,
      state: job.state,
      step: job.log.step,
      log: job.log.lines.slice(),
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      error: job.error,
    };
  }

  start(serverId, { sudoPassword = '' } = {}) {
    const running = this._jobs.get(serverId);
    if (running && running.state === 'running') {
      throw new AppError(ErrorCode.SERVER_IN_USE, 'An installation is already running for this server');
    }
    // Throws for an unknown, local or disabled server before anything starts.
    this.links.connection(serverId);
    const job = {
      state: 'running',
      log: new InstallLog(),
      startedAt: new Date(this._now()).toISOString(),
      finishedAt: null,
      error: null,
    };
    this._jobs.set(serverId, job);
    this._run(serverId, job, sudoPassword).catch((err) => {
      job.state = 'failed';
      job.error = err instanceof AppError ? err.toJSON() : { code: ErrorCode.INTERNAL, message: err.message };
      job.log.lines.push('!! ' + (err && err.message ? err.message : 'installation failed'));
    }).finally(() => {
      job.finishedAt = new Date(this._now()).toISOString();
    });
    return this.status(serverId);
  }

  async _run(serverId, job, sudoPassword) {
    const connection = this.links.connection(serverId);
    const say = (text) => job.log.write(`>> ${text}\n`);

    say('detect platform');
    const facts = await this.links.basic(serverId).detect({ force: true });
    // An MSYS2 shell on Windows still reports a POSIX kernel name; Windows is
    // installed through PowerShell either way.
    const windows = facts.platform === 'windows' || !facts.posix;
    const includeTmux = !windows;
    if (includeTmux && !existsSync(join(this.projectDir, 'vendor/tmux/tmux.c'))) {
      throw new AppError(ErrorCode.UNSUPPORTED, 'This panel has no tmux source (vendor/tmux) to install on another machine');
    }

    say('pack the panel');
    const dir = await mkdtemp(join(tmpdir(), 'tmux-node-install-'));
    try {
      const archive = join(dir, 'panel.tgz');
      await this._pack(this.projectDir, archive, { includeTmux });
      say('upload over sftp');
      await connection.uploadFile(archive, REMOTE_ARCHIVE, { mode: '600' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    say(windows ? 'run the Windows installer' : 'run the installer');
    const onOutput = (chunk) => job.log.write(chunk);
    let code;
    if (windows) {
      const template = await readFile(join(this.projectDir, 'scripts/remote/install-node.ps1'), 'utf8');
      code = await connection.stream(windowsInstallWords(template), { onOutput });
    } else {
      const template = await readFile(join(this.projectDir, 'scripts/remote/install-node.sh'), 'utf8');
      code = await connection.stream(['sh', '-s'], { input: posixInstallScript(template, { sudoPassword }), onOutput });
    }
    job.log.end();

    if (job.log.result === 'needs_password') {
      job.state = 'needs_password';
      return;
    }
    if (job.log.result !== 'succeeded' || code !== 0) {
      job.state = 'failed';
      job.error = { code: ErrorCode.INTERNAL, message: `The installer exited with ${code}` };
      return;
    }
    job.state = 'succeeded';
    this.links.recheck(serverId);
    if (typeof this._onInstalled === 'function') this._onInstalled(serverId);
  }
}
