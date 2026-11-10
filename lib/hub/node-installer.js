/**
 * Explicit panel installation and fixed Mosh component maintenance, from the Hub.
 *
 * Installing is the one place the hub runs a program remotely, and it is an
 * explicit user action. The code that gets installed is this panel's own
 * (packed from projectDir and uploaded over SFTP), so the node matches the hub.
 * The remote half is scripts/remote/install-node.{sh,ps1}: it installs missing
 * build packages (sudo when needed), an official Node.js build if none is
 * recent enough, runs npm ci and the platform service installer in node-only
 * mode on 127.0.0.1. Component maintenance streams only its narrow script, locally
 * or over SSH, without packing, replacing the app, or restarting a service.
 * Progress lines stream into the same per-server job log the UI polls.
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AppError, ErrorCode } from '../servers/errors.js';
import { shellQuote } from '../transport/ssh-connection.js';

export const REMOTE_ARCHIVE = '.cache/anymux/panel.tgz';
export const PORT_CANDIDATES = '7681 7781 7881 7981';
const COMPONENT_RESULTS = new Set(['ready', 'failed', 'needs_password', 'maintenance_required', 'unsupported', 'skipped']);
const LOG_LINES = 400;
const PACKED = ['package.json', 'package-lock.json', 'bin', 'kernel', 'plugins', 'lib', 'client', 'profiles', 'scripts', 'relay',
  'catalog/tmux-agent', 'skills', 'vendor/cordis', 'vendor/cosmokit', 'vendor/plugin-timer', 'vendor/tmux-plugins'];
const EXCLUDES = ['node_modules', '.git', '*.pem', '*.key', '*.crt', '.env', 'relay-config.js', '*.o', '*.a'];

/** The POSIX script with its inputs prepended; secrets travel on stdin only. */
export function posixInstallScript(template, { sudoPassword = '', skipMosh = false } = {}) {
  return [
    'set +x',
    `ANYMUX_ARCHIVE=${shellQuote(REMOTE_ARCHIVE)}`,
    `ANYMUX_PORT_CANDIDATES=${shellQuote(PORT_CANDIDATES)}`,
    `ANYMUX_SUDO_PASSWORD=${shellQuote(sudoPassword || '')}`,
    ...(skipMosh ? ['ANYMUX_SKIP_MOSH=1'] : []),
    template,
  ].join('\n');
}

/** PowerShell's -EncodedCommand: base64 of UTF-16LE, plain characters in any shell. */
export function windowsInstallWords(template, { skipMosh = false } = {}) {
  const script = `$AnymuxArchive = '${REMOTE_ARCHIVE}'\n$AnymuxPorts = '${PORT_CANDIDATES}'\n${skipMosh ? "$env:ANYMUX_SKIP_MOSH = '1'\n" : ''}${template}`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return ['powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
}

/** Keep the SSH command small enough for Windows' default cmd.exe shell. */
function windowsInvocation(template, { skipMosh = false } = {}) {
  const bootstrap = "$ProgressPreference = 'SilentlyContinue'; $utf8 = New-Object System.Text.UTF8Encoding($false); [Console]::InputEncoding = $utf8; [Console]::OutputEncoding = $utf8; & ([ScriptBlock]::Create([Console]::In.ReadToEnd()))";
  const words = windowsInstallWords(bootstrap);
  // PowerShell otherwise interprets redirected input/output as CLIXML in some login shells.
  words.splice(1, 0, '-InputFormat', 'Text', '-OutputFormat', 'Text');
  return { words,
    input: `$AnymuxArchive = '${REMOTE_ARCHIVE}'\n$AnymuxPorts = '${PORT_CANDIDATES}'\n${skipMosh ? "$env:ANYMUX_SKIP_MOSH = '1'\n" : ''}${template}` };
}

/** Splits streamed output into lines and reads progress and the final result. */
export class InstallLog {
  constructor(limit = LOG_LINES) {
    this.limit = limit;
    this.lines = [];
    this.pending = '';
    this.step = null;
    this.result = null;
    this.component = null;
  }

  write(chunk, secret = '') {
    const text = this.pending + String(chunk).replace(/\r\n?/g, '\n');
    const parts = text.split('\n');
    this.pending = parts.pop();
    for (const line of parts) this._line(line, secret);
  }

  end(secret = '') {
    if (this.pending) this._line(this.pending, secret);
    this.pending = '';
  }

  _line(line, secret = '') {
    // These values are public protocol enums, even if a short password happens
    // to contain the same letters. Parse them before redacting free-form output.
    const primary = /^ANYMUX_RESULT=(succeeded|failed|needs_password)$/.exec(line.trim());
    if (primary) { this.result = primary[1]; return; }
    const result = /^ANYMUX_COMPONENT_RESULT=([a-z_]+)$/.exec(line.trim());
    if (result && COMPONENT_RESULTS.has(result[1])) {
      this.component = { ...this.component, result: result[1] };
      return;
    }
    if (secret) line = line.split(secret).join('[redacted]');
    const component = /^ANYMUX_COMPONENT_(RESULT|REASON)=([a-z0-9_]+)$/.exec(line.trim());
    if (component) {
      if (component[1] === 'RESULT' && COMPONENT_RESULTS.has(component[2])) {
        this.component = { ...this.component, result: component[2] };
      } else if (component[1] === 'REASON') this.component = { ...this.component, reason: component[2] };
      return;
    }
    if (line.startsWith('>> ')) this.step = line.slice(3);
    this.lines.push(line);
    if (this.lines.length > this.limit) this.lines.splice(0, this.lines.length - this.limit);
  }
}

/** Runs the same fixed component script locally, with secrets on stdin only. */
function streamLocal(words, { input = '', onOutput }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.TMUX;
    delete env.TMUX_PANE;
    delete env.ANYMUX_SUDO_PASSWORD;
    const child = spawn(words[0], words.slice(1), { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => onOutput(String(chunk)));
    child.stderr.on('data', (chunk) => onOutput(String(chunk)));
    child.stdin.on('error', () => {}); // An early script exit must not become an unhandled EPIPE.
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
    child.stdin.end(input);
  });
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
  constructor({ links, projectDir, registry = null, onInstalled = null, onComponentInstalled = null,
    now = () => Date.now(), pack = packArchive, localStream = streamLocal, platform = process.platform }) {
    this.links = links;
    this.projectDir = projectDir;
    this._onInstalled = onInstalled;
    this.registry = registry;
    this._onComponentInstalled = onComponentInstalled;
    this._localStream = localStream;
    this._platform = platform;
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
      operation: job.operation,
      skipMosh: job.skipMosh,
      result: job.operation === 'mosh' ? job.log.component?.result || null : null,
      component: job.log.component,
    };
  }

  start(serverId, { sudoPassword = '', skipMosh = false } = {}) {
    return this._start(serverId, { sudoPassword, skipMosh, operation: 'node' });
  }

  startComponent(serverId, { sudoPassword = '' } = {}) {
    return this._start(serverId, { sudoPassword, skipMosh: false, operation: 'mosh' });
  }

  _assertCurrent(serverId, connection) {
    let current;
    try { current = this.links.connection(serverId); } catch { /* removed or disabled */ }
    if (current !== connection) throw new AppError(ErrorCode.SERVER_OFFLINE, '服务器配置已变化；旧目标的安装结果未应用，请重新检查当前服务器');
  }

  _start(serverId, { sudoPassword, skipMosh, operation }) {
    const running = this._jobs.get(serverId);
    if (running && running.state === 'running') {
      throw new AppError(ErrorCode.SERVER_IN_USE, 'An installation is already running for this server');
    }
    // A component repair is allowed on this Hub too; full Node installation is remote-only.
    if (operation === 'mosh' && serverId === 'local') {
      if (!this.registry) throw new AppError(ErrorCode.UNSUPPORTED, 'Local component installation is unavailable');
      this.registry.require(serverId);
    } else this.links.connection(serverId);
    const job = {
      state: 'running',
      log: new InstallLog(),
      startedAt: new Date(this._now()).toISOString(),
      finishedAt: null,
      error: null,
      operation,
      skipMosh,
    };
    this._jobs.set(serverId, job);
    const run = operation === 'mosh' ? this._runComponent(serverId, job, sudoPassword) : this._run(serverId, job, sudoPassword);
    run.catch((err) => {
      job.state = 'failed';
      const message = (err?.message || 'installation failed').split(sudoPassword || '\0').join('[redacted]');
      job.error = { code: err instanceof AppError ? err.code : ErrorCode.INTERNAL, message };
      job.log.write('!! ' + message + '\n', sudoPassword);
    }).finally(() => {
      job.log.end(sudoPassword);
      job.finishedAt = new Date(this._now()).toISOString();
    });
    return this.status(serverId);
  }

  async _run(serverId, job, sudoPassword) {
    const connection = this.links.connection(serverId);
    const say = (text) => job.log.write(`>> ${text}\n`);

    say('detect platform');
    const facts = await this.links.detect(serverId);
    this._assertCurrent(serverId, connection);
    // An MSYS2 shell on Windows still reports a POSIX kernel name; Windows is
    // installed through PowerShell either way.
    const windows = facts.platform === 'windows' || !facts.posix;
    const includeTmux = true;
    if (includeTmux && !existsSync(join(this.projectDir, 'vendor/tmux/tmux.c'))) {
      throw new AppError(ErrorCode.UNSUPPORTED, 'This panel has no tmux source (vendor/tmux) to install on another machine');
    }

    say('pack the panel');
    const dir = await mkdtemp(join(tmpdir(), 'tmux-node-install-'));
    try {
      const archive = join(dir, 'panel.tgz');
      await this._pack(this.projectDir, archive, { includeTmux });
      this._assertCurrent(serverId, connection);
      say('upload over sftp');
      await connection.uploadFile(archive, REMOTE_ARCHIVE, { mode: '600' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    say(windows ? 'run the Windows installer' : 'run the installer');
    const onOutput = (chunk) => job.log.write(chunk, sudoPassword);
    let code;
    if (windows) {
      const template = await readFile(join(this.projectDir, 'scripts/remote/install-node.ps1'), 'utf8');
      this._assertCurrent(serverId, connection);
      const invocation = windowsInvocation(template, { skipMosh: job.skipMosh });
      code = await connection.stream(invocation.words, { input: invocation.input, onOutput });
    } else {
      // A Windows checkout may have CRLF endings, which sh would read as part of each line.
      const template = (await readFile(join(this.projectDir, 'scripts/remote/install-node.sh'), 'utf8')).replace(/\r\n/g, '\n');
      this._assertCurrent(serverId, connection);
      code = await connection.stream(['sh', '-s'], { input: posixInstallScript(template, { sudoPassword, skipMosh: job.skipMosh }), onOutput });
    }
    job.log.end(sudoPassword);
    this._assertCurrent(serverId, connection);

    if (job.log.result === 'needs_password') {
      job.state = 'needs_password';
      return;
    }
    if (job.log.result !== 'succeeded' || code !== 0) {
      job.state = 'failed';
      job.error = { code: ErrorCode.INTERNAL, message: `The installer exited with ${code}` };
      return;
    }
    this.links.recheck(serverId);
    if (job.log.component?.result === 'ready' && typeof this._onComponentInstalled === 'function') {
      try { await this._onComponentInstalled(serverId); }
      catch { job.log.write('!! Mosh 组件已准备，能力状态将在后续检测中更新\n'); }
    }
    if (typeof this._onInstalled === 'function') this._onInstalled(serverId);
    job.state = 'succeeded';
  }

  async _runComponent(serverId, job, sudoPassword) {
    const local = serverId === 'local';
    let connection;
    let platform = this._platform;
    if (!local) {
      connection = this.links.connection(serverId);
      const facts = await this.links.detect(serverId);
      this._assertCurrent(serverId, connection);
      platform = facts.platform === 'windows' || !facts.posix ? 'win32' : facts.platform;
    }
    const windows = platform === 'win32';
    const template = (await readFile(join(this.projectDir, 'scripts', windows ? 'install-mosh.ps1' : 'install-mosh.sh'), 'utf8')).replace(/\r\n/g, '\n');
    const role = local && !windows ? 'both' : 'server';
    let input = windows ? '' : `set +x\nANYMUX_MOSH_ROLE=${role}\nANYMUX_SKIP_MOSH=0\nANYMUX_SUDO_PASSWORD=${shellQuote(sudoPassword)}\n${template}`;
    // A PowerShell param block must stay first inside its own script scope.
    const invocation = windows ? windowsInvocation(`$env:ANYMUX_SKIP_MOSH = '0'\n& {\n${template}\n} -Role server`) : null;
    const words = invocation ? invocation.words : ['sh', '-s'];
    if (invocation) input = invocation.input;
    job.log.write('>> 检查并准备 Mosh 组件\n');
    const options = { input, onOutput: (chunk) => job.log.write(chunk, sudoPassword) };
    if (!local) this._assertCurrent(serverId, connection);
    const code = await (local ? this._localStream(words, options) : connection.stream(words, options));
    job.log.end(sudoPassword);
    if (!local) this._assertCurrent(serverId, connection);
    const result = job.log.component?.result;
    let state;
    if ((result === 'ready' || result === 'skipped') && code === 0) state = 'succeeded';
    else if (['needs_password', 'maintenance_required', 'unsupported'].includes(result)) state = result;
    else {
      state = 'failed';
      job.error = { code: ErrorCode.INTERNAL, message: 'Mosh 组件准备失败，请查看安装日志后重试' };
    }
    // A component check never re-pairs, restarts, or drops a healthy link.
    if (state === 'succeeded' && typeof this._onComponentInstalled === 'function') {
      try { await this._onComponentInstalled(serverId); }
      catch { job.log.write('!! Mosh 组件已准备，能力状态将在后续检测中更新\n'); }
    }
    job.state = state;
  }
}
