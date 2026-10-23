#!/usr/bin/env node
// The desktop app calls this helper with JSON on stdin. Only launchd starts
// background services; this process configures and inspects its own installation.
import { access, appendFile, chmod, copyFile, cp, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import { constants } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import https from 'node:https';
import { hashPassword } from '../server/auth.js';
import { ensureDesktopCertificates, inspectDesktopCertificates } from './desktop-certificates.mjs';

const exec = promisify(execFile);
const DEFAULT_DATA = join(homedir(), 'Library/Application Support/Tmux Panel');
const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const TMUX_CONFIG = 'set -g exit-empty off\nset -g mouse on\nset -g history-limit 50000\nset -g default-terminal "tmux-256color"\n';
const delay = ms => new Promise(done => setTimeout(done, ms));
class SetupError extends Error {
  constructor(code, message, action = '请查看运行日志后重试。') { super(message); this.code = code; this.action = action; }
}
async function jsonFile(path, fallback = null) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw new SetupError('CONFIG_INVALID', '配置文件无法读取或格式不正确。', '请保留现有文件，在设置中打开配置目录检查；不要直接删除会话数据。'); }
}
async function exists(path) { try { await access(path); return true; } catch { return false; } }
async function atomicJSON(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const staged = path + '.' + randomUUID() + '.tmp';
  await writeFile(staged, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(staged, path); await chmod(path, 0o600);
}
function xml(value) { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]); }
function plist(value) {
  function encode(v) {
    if (typeof v === 'boolean') return v ? '<true/>' : '<false/>';
    if (typeof v === 'number') return '<integer>' + v + '</integer>';
    if (Array.isArray(v)) return '<array>' + v.map(encode).join('') + '</array>';
    if (v && typeof v === 'object') return '<dict>' + Object.entries(v).map(([k, x]) => '<key>' + xml(k) + '</key>' + encode(x)).join('') + '</dict>';
    return '<string>' + xml(v) + '</string>';
  }
  return '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0">' + encode(value) + '</plist>\n';
}
function lanIPs() { return [...new Set(Object.values(networkInterfaces()).flat().filter(a => a && !a.internal && a.family === 'IPv4' && !a.address.startsWith('169.254.')).map(a => a.address))]; }
function endpoint(config, host = '127.0.0.1') { return (config.tls ? 'https://' : 'http://') + host + ':' + config.port + '/'; }
function fingerprint(config) {
  return createHash('sha256').update(JSON.stringify([config.port, config.listenOnLAN, config.launchAtLogin, config.auth, config.tls, config.runtimePath, config.relay?.pagesURL, config.relay?.enabled])).digest('hex');
}
function publicConfig(config) {
  return { schemaVersion: 1, initialized: !!config.initialized && config.setupComplete !== false, port: config.port || 17681, listenOnLAN: !!config.listenOnLAN,
    launchAtLogin: config.launchAtLogin !== false, username: config.auth?.username || 'admin',
    relay: { enabled: !!config.relay?.enabled, domain: config.relay?.domain || '', pagesURL: config.relay?.pagesURL || '', hasToken: !!config.relay?.duckdnsToken } };
}
export function validateSettings(input, previous = {}) {
  const port = Number(input.port ?? previous.port ?? 17681);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new SetupError('PORT_INVALID', '端口请填写 1024–65535 之间的整数。', '通常保留默认端口 17681 即可。');
  const username = String(input.username ?? previous.auth?.username ?? 'admin').trim();
  if (!/^[^\s:\x00-\x1f]{1,64}$/u.test(username)) throw new SetupError('USERNAME_INVALID', '账号不能为空，也不能包含空格或冒号。');
  let auth = previous.auth;
  if (input.password) {
    if (typeof input.password !== 'string' || input.password.length < 8 || input.password.length > 1024) throw new SetupError('PASSWORD_INVALID', '请设置至少 8 个字符的密码。', '此电脑只保存不可逆的密码校验值，请自行记住原始密码。');
    auth = { username, ...hashPassword(input.password) };
  } else if (!auth?.hash) throw new SetupError('PASSWORD_REQUIRED', '首次初始化需要设置登录密码。');
  else auth = { ...auth, username };
  const relayInput = input.relay || {};
  const relay = { enabled: relayInput.enabled ?? previous.relay?.enabled ?? false,
    domain: String(relayInput.domain ?? previous.relay?.domain ?? '').trim().toLowerCase().replace(/\.duckdns\.org\.?$/, ''),
    pagesURL: String(relayInput.pagesURL ?? previous.relay?.pagesURL ?? '').trim(),
    duckdnsToken: relayInput.duckdnsToken || previous.relay?.duckdnsToken || '' };
  if (relay.domain && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(relay.domain)) throw new SetupError('DOMAIN_INVALID', 'DuckDNS 子域名格式不正确。', '例如只填写 my-workstation，不要填写网址或 IP。');
  if (relay.pagesURL) {
    let u; try { u = new URL(relay.pagesURL); } catch { /* handled below */ }
    if (!u || u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || !/^[a-z0-9-]+\.github\.io$/i.test(u.hostname)) throw new SetupError('PAGES_URL_INVALID', '请填写 GitHub Pages 的 HTTPS 页面地址。', '示例：https://你的用户名.github.io/仓库名/');
    if (!u.pathname.endsWith('/')) u.pathname += '/'; relay.pagesURL = u.href;
  }
  if (typeof relay.duckdnsToken !== 'string' || relay.duckdnsToken.length > 2048 || /[\r\n]/.test(relay.duckdnsToken)) throw new SetupError('TOKEN_INVALID', 'DuckDNS Token 格式不正确。');
  return { ...previous, schemaVersion: 1, initialized: true, port, listenOnLAN: input.listenOnLAN ?? previous.listenOnLAN ?? false,
    launchAtLogin: input.launchAtLogin ?? previous.launchAtLogin ?? true, auth, relay };
}
export async function isPortAvailable(port, host = '127.0.0.1') {
  return new Promise(done => { const s = createServer(); s.unref(); s.once('error', () => done(false)); s.listen(port, host, () => s.close(() => done(true))); });
}

export class DesktopRuntime {
  constructor(input = {}, { run = exec, home = homedir() } = {}) {
    this.input = input; this.home = home; this.run = run;
    this.root = resolve(input.dataDir || process.env.TMUX_PANEL_DATA_DIR || DEFAULT_DATA);
    this.bundle = input.runtimePath ? resolve(input.runtimePath) : null;
    const suffix = this.root === DEFAULT_DATA ? '' : '.' + createHash('sha256').update(this.root).digest('hex').slice(0, 10);
    this.label = 'com.tmux-web-panel.desktop' + suffix; this.tmuxLabel = this.label + '.tmux';
    this.uid = process.getuid?.() ?? 0;
    // Darwin's per-user TMPDIR can exceed the Unix-domain socket path limit.
    this.socketRoot = join('/tmp', 'tmux-panel-' + this.uid + '-' + createHash('sha256').update(this.root).digest('hex').slice(0, 10));
    this.paths = { configuration: join(this.root, 'settings.json'), logs: join(this.root, 'logs'), events: join(this.root, 'setup-events.jsonl'),
      relaySite: join(this.root, 'relay-site'), tlsCertificate: join(this.root, 'tls/cert.pem'), caCertificate: join(this.root, 'tls/ca.crt') };
  }
  async event(id, title, status, message = '') {
    if (status === 'running') this.phase = id;
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await appendFile(this.paths.events, JSON.stringify({ id, title, status, message, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  }
  async events() {
    try { return (await readFile(this.paths.events, 'utf8')).slice(-65536).split('\n').filter(Boolean).flatMap(s => { try { return [JSON.parse(s)]; } catch { return []; } }); }
    catch { return []; }
  }
  async serviceState(label) {
    if (process.platform !== 'darwin') return 'unavailable';
    try { const { stdout } = await this.run('/bin/launchctl', ['print', 'gui/' + this.uid + '/' + label], { timeout: 5000 }); return /state = (running|active)/.test(stdout) ? 'running' : 'stopped'; }
    catch { return 'stopped'; }
  }
  async serviceLoaded(label) {
    try { await this.run('/bin/launchctl', ['print', 'gui/' + this.uid + '/' + label], { timeout: 5000 }); return true; }
    catch { return false; }
  }
  async stopPanel() {
    try { await this.run('/bin/launchctl', ['bootout', 'gui/' + this.uid + '/' + this.label], { timeout: 10000 }); }
    catch {
      if (await this.serviceLoaded(this.label)) throw new SetupError('SERVICE_STOP_FAILED', '系统未能停止面板服务。', '请检查后台运行权限与日志后重试；tmux 会话未受影响。');
      return;
    }
    // bootout can return before launchd has removed the old job. Re-registering
    // during that interval can skip startup or retain the previous arguments.
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (!await this.serviceLoaded(this.label)) return;
      await delay(100);
    }
    throw new SetupError('SERVICE_STOP_FAILED', '面板服务仍在退出，尚未重新启动。', '请稍后重试；tmux 会话仍保持运行。');
  }
  async manifest(path) {
    const m = path && await jsonFile(join(path, 'manifest.json'));
    if (!m || !/^[a-zA-Z0-9_.-]{1,128}$/.test(m.buildId || '')) throw new SetupError('RUNTIME_MISSING', '客户端内置组件不完整。', '请重新下载与你电脑芯片对应的完整客户端；开发薄壳不包含后台组件。');
    const arch = m.arch === 'x86_64' ? 'x64' : m.arch;
    if (arch && arch !== process.arch) throw new SetupError('ARCH_MISMATCH', '安装包与此电脑运行架构不符。', 'Apple Silicon 下载 arm64，Intel 下载 x64 版本。');
    for (const part of ['bin/node', 'bin/tmux', 'app/server/index.js']) await access(join(path, part), part.startsWith('bin/') ? constants.X_OK : constants.R_OK).catch(() => { throw new SetupError('RUNTIME_MISSING', '客户端缺少可执行的必要组件。'); });
    if (m.minimumMacOS && process.platform === 'darwin') {
      const { stdout } = await this.run('/usr/bin/sw_vers', ['-productVersion'], { timeout: 5000 });
      const actual = stdout.trim().split('.').map(Number), needed = m.minimumMacOS.split('.').map(Number);
      if ((actual[0] || 0) * 10000 + (actual[1] || 0) * 100 + (actual[2] || 0) < (needed[0] || 0) * 10000 + (needed[1] || 0) * 100 + (needed[2] || 0)) throw new SetupError('MACOS_TOO_OLD', '此安装包需要 macOS ' + m.minimumMacOS + ' 或更高版本。');
    }
    return m;
  }
  async inspect() {
    const config = await jsonFile(this.paths.configuration, {});
    const active = await jsonFile(join(this.root, 'service-state.json'), {});
    const [panelState, tmuxState] = await Promise.all([this.serviceState(this.label), this.serviceState(this.tmuxLabel)]);
    let m = null, runtimeError = null;
    try { m = await this.manifest(config.runtimePath || this.bundle); } catch (e) { runtimeError = e.message; }
    let bundled = null;
    try { bundled = await this.manifest(this.bundle); } catch { /* Report the installed environment independently of an incomplete update. */ }
    const current = panelState === 'running' && active.endpoint ? active.endpoint : endpoint(config.port ? config : { port: 17681 });
    const portAvailable = await isPortAvailable(config.port || Number(this.input.port) || 17681);
    let suggestedPort = config.port || Number(this.input.port) || 17681;
    if (!config.initialized && !portAvailable) {
      for (let candidate = 17682; candidate < 17702; candidate++) {
        if (await isPortAvailable(candidate)) { suggestedPort = candidate; break; }
      }
    }
    const certificate = await this.certificateStatus(config);
    const certificateNeedsRenewal = !!config.initialized && (!certificate.valid || (config.listenOnLAN && !certificate.addressesCurrent));
    const paths = { ...this.paths,
      tlsCertificate: (panelState === 'running' && active.tlsCertificate) || config.tls?.cert || this.paths.tlsCertificate,
      caCertificate: config.tls?.ca || this.paths.caCertificate };
    const requiresRestart = !!config.initialized && (fingerprint(config) !== active.fingerprint || certificateNeedsRenewal);
    return { ok: true, configuration: publicConfig(config), paths, events: await this.events(),
      requiresRestart,
      status: { managedInstalled: publicConfig(config).initialized, runtimeAvailable: !!m, runtimeError,
        legacyInstalled: await exists(join(this.home, 'Library/LaunchAgents/com.tmux-web-panel.plist')),
        portAvailable, suggestedPort, endpoint: current,
        lanEndpoint: panelState === 'running' && !requiresRestart && config.listenOnLAN && lanIPs()[0] ? endpoint(config, lanIPs()[0]) : null,
        nodeVersion: m?.nodeVersion || null, tmuxVersion: m?.tmuxVersion || null, panelState, tmuxState, certificateNeedsRenewal,
        runtimeBuildId: m?.buildId || null, bundledBuildId: bundled?.buildId || null,
        runtimeUpdateAvailable: !!config.initialized && !!bundled && bundled.buildId !== m?.buildId,
        panelLabel: this.label, tmuxLabel: this.tmuxLabel } };
  }
  async installRuntime({ repair = false } = {}) {
    const m = await this.manifest(this.bundle);
    const parent = join(this.root, 'runtime'), destination = join(parent, m.buildId + (repair ? '-repair-' + randomUUID().slice(0, 8) : ''));
    await mkdir(parent, { recursive: true, mode: 0o700 });
    if (!await exists(destination)) {
      const stage = join(parent, '.install-' + randomUUID());
      try { await cp(this.bundle, stage, { recursive: true, dereference: false, errorOnExist: true }); await this.manifest(stage); await rename(stage, destination); }
      catch (e) { await rm(stage, { force: true, recursive: true }); throw e; }
    }
    await this.manifest(destination);
    return destination;
  }
  async certificates() {
    return ensureDesktopCertificates(this.root, { run: this.run, ips: lanIPs() });
  }
  async certificateStatus(config) {
    return inspectDesktopCertificates(config.tls, lanIPs());
  }
  async serviceFiles(config) {
    const directory = join(this.root, 'launchd'); await mkdir(directory, { recursive: true, mode: 0o700 });
    await mkdir(this.paths.logs, { recursive: true, mode: 0o700 }); await mkdir(this.socketRoot, { recursive: true, mode: 0o700 });
    const socketInfo = await lstat(this.socketRoot);
    if (!socketInfo.isDirectory() || socketInfo.isSymbolicLink() || socketInfo.uid !== this.uid) throw new SetupError('SOCKET_UNSAFE', '临时会话目录的所有权不正确，未使用该目录。');
    await chmod(this.socketRoot, 0o700);
    const runtime = config.runtimePath;
    const env = { PATH: [join(runtime, 'bin'), join(this.home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', SYSTEM_PATH].join(':'),
      TMUX_PANEL_CONFIG_DIR: this.root, TMUX_PANEL_MANAGED_RUNTIME: '1', TMUX_TMPDIR: this.socketRoot,
      TERMINFO_DIRS: join(runtime, 'share/terminfo') + ':/usr/share/terminfo', LANG: 'en_US.UTF-8', LC_CTYPE: 'en_US.UTF-8' };
    const files = {};
    for (const [name, label, args] of [
      ['panel', this.label, [join(runtime, 'bin/node'), join(runtime, 'app/server/index.js'), '--config', this.paths.configuration]],
      ['tmux', this.tmuxLabel, [join(runtime, 'bin/tmux'), '-f', join(this.root, 'tmux.conf'), '-D']],
    ]) {
      const path = join(directory, label + '.plist');
      await writeFile(path, plist({ Label: label, ProgramArguments: args, WorkingDirectory: this.home, EnvironmentVariables: env,
        RunAtLoad: true, KeepAlive: true, ThrottleInterval: 5, ProcessType: 'Background',
        StandardOutPath: join(this.paths.logs, name + '.stdout.log'), StandardErrorPath: join(this.paths.logs, name + '.stderr.log') }), { mode: 0o600 });
      const loginPath = join(this.home, 'Library/LaunchAgents', label + '.plist');
      if (await exists(loginPath)) {
        const previous = await readFile(loginPath, 'utf8');
        if (!previous.includes(xml(this.paths.configuration)) && !previous.includes(xml(join(this.root, 'tmux.conf')))) throw new SetupError('SERVICE_CONFLICT', '此服务名称已被其他安装使用，未覆盖原文件。');
      }
      if (config.launchAtLogin) { await mkdir(dirname(loginPath), { recursive: true }); await copyFile(path, loginPath); await chmod(loginPath, 0o600); }
      else await rm(loginPath, { force: true });
      files[name] = path;
    }
    return files;
  }
  async bootstrap(label, path) {
    if (await this.serviceState(label) !== 'running') {
      try { await this.run('/bin/launchctl', ['bootstrap', 'gui/' + this.uid, path], { timeout: 10000 }); }
      catch {
        try { await this.run('/bin/launchctl', ['kickstart', 'gui/' + this.uid + '/' + label], { timeout: 10000 }); }
        catch { throw new SetupError('SERVICE_START_FAILED', '后台服务未能启动。', '请检查“登录项与扩展”中是否允许后台运行，并打开日志目录查看错误。'); }
      }
    }
  }
  async request(config, path, body) {
    const ca = await readFile(config.tls.ca);
    return new Promise((done, reject) => {
      const req = https.request(new URL(path, endpoint(config)), { ca, timeout: 3000, method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {} }, res => {
        let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => { try { done({ status: res.statusCode, data: JSON.parse(text) }); } catch { done({ status: res.statusCode }); } });
      });
      req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout'))); req.end(body ? JSON.stringify(body) : undefined);
    });
  }
  async waitForPanel(config) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try { const result = await this.request(config, '/login.html'); if (result.status === 200) return; } catch { /* startup can take a moment */ }
      await delay(500);
    }
    throw new SetupError('HEALTH_TIMEOUT', '后台服务尚未通过连接检查。', '请查看日志；端口冲突或系统拦截可在设置中修复，然后重新启动面板服务。');
  }
  async waitForTmux(config) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try {
        const { stdout } = await this.run(join(config.runtimePath, 'bin/tmux'), ['show-options', '-gqv', 'exit-empty'], {
          timeout: 1500, env: { ...process.env, TMUX: '', TMUX_TMPDIR: this.socketRoot, PATH: join(config.runtimePath, 'bin') + ':' + SYSTEM_PATH },
        });
        if (stdout.trim() === 'off') return;
      } catch { /* A read-only command never creates a replacement server. */ }
      await delay(200);
    }
    throw new SetupError('TMUX_NOT_READY', '内置 tmux 未通过会话服务检查。', '请查看 tmux.stderr.log，确认内置组件未被系统隔离；没有创建占位会话或停止现有会话。');
  }
  async start(config, restart = false) {
    await this.manifest(config.runtimePath);
    const running = await this.serviceState(this.label) === 'running';
    if (running && !restart) return; // A saved change needs an explicit restart.
    const active = await jsonFile(join(this.root, 'service-state.json'), {});
    const activePort = active.port || (active.endpoint ? Number(new URL(active.endpoint).port) : null);
    const checkPort = !running || activePort !== config.port;
    if (checkPort && !await isPortAvailable(config.port, config.listenOnLAN ? '0.0.0.0' : '127.0.0.1')) throw new SetupError('PORT_IN_USE', '此端口已被其他程序占用，未停止任何进程。', '请选择其他端口，或继续使用已存在的面板服务。');
    if (running && config.listenOnLAN && active.listenOnLAN === false && !checkPort) {
      for (const ip of lanIPs()) if (!await isPortAvailable(config.port, ip)) throw new SetupError('PORT_IN_USE', '此端口已被其他局域网服务使用，未重启现有面板。', '请选择其他端口再应用设置。');
    }
    config.tls = await this.certificates();
    await atomicJSON(this.paths.configuration, config);
    const files = await this.serviceFiles(config);
    await this.bootstrap(this.tmuxLabel, files.tmux);
    await this.waitForTmux(config);
    if (restart || await this.serviceLoaded(this.label)) await this.stopPanel();
    await this.bootstrap(this.label, files.panel);
    await atomicJSON(join(this.root, 'service-state.json'), { endpoint: endpoint(config), port: config.port, listenOnLAN: config.listenOnLAN, tlsCertificate: config.tls.cert, ready: false });
    await this.waitForPanel(config);
    await atomicJSON(join(this.root, 'service-state.json'), { fingerprint: fingerprint(config), endpoint: endpoint(config), port: config.port, listenOnLAN: config.listenOnLAN, tlsCertificate: config.tls.cert });
  }
  async execute(command) {
    if (command === 'inspect') return this.inspect();
    if (process.platform !== 'darwin') throw new SetupError('PLATFORM_UNSUPPORTED', '此初始化器仅支持 macOS。');
    await mkdir(this.root, { recursive: true, mode: 0o700 }); await chmod(this.root, 0o700);
    const lock = join(this.root, '.setup-lock');
    try { await mkdir(lock, { mode: 0o700 }); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const info = await lstat(lock);
      const owner = await jsonFile(join(lock, 'owner.json'), {});
      let alive = false;
      if (Number.isInteger(owner.pid)) { try { process.kill(owner.pid, 0); alive = true; } catch (e) { alive = e.code !== 'ESRCH'; } }
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== this.uid || alive || (!owner.pid && Date.now() - info.mtimeMs < 60000)) throw new SetupError('SETUP_BUSY', '另一个初始化或配置操作正在进行。', '请等待该操作完成，再返回此处重试。');
      await rm(lock, { recursive: true }); await mkdir(lock, { mode: 0o700 });
    }
    await atomicJSON(join(lock, 'owner.json'), { pid: process.pid });
    try {
      let config = await jsonFile(this.paths.configuration);
      if (command === 'initialize') {
        await writeFile(this.paths.events, '', { mode: 0o600 });
        const incomplete = config?.setupComplete === false;
        if (!config?.initialized || incomplete) {
          config = { ...validateSettings(this.input, config || {}), setupComplete: false };
          await this.event('check', '检查系统与端口', 'running');
          await this.manifest(this.bundle);
          const priorState = await jsonFile(join(this.root, 'service-state.json'), {});
          const ownsPort = incomplete && priorState.port === config.port && await this.serviceState(this.label) === 'running';
          if (!ownsPort && !await isPortAvailable(config.port, config.listenOnLAN ? '0.0.0.0' : '127.0.0.1')) throw new SetupError('PORT_IN_USE', '此端口已被其他程序占用，未停止任何进程。', '请修改端口后重试。');
          await this.event('check', '检查系统与端口', 'complete');
          await this.event('runtime', '安装内置组件', 'running');
          config.runtimePath = config.runtimePath || await this.installRuntime();
          await this.event('runtime', '安装内置组件', 'complete');
          await this.event('identity', '创建登录与连接凭据', 'running');
          config.tls = await this.certificates();
          await atomicJSON(this.paths.configuration, config);
          if (!await exists(join(this.root, 'tmux.conf'))) await writeFile(join(this.root, 'tmux.conf'), TMUX_CONFIG, { mode: 0o600 });
          await this.event('identity', '创建登录与连接凭据', 'complete');
        }
        await this.event('services', '注册并启动后台组件', 'running');
        await this.start(config, incomplete);
        config.setupComplete = true;
        await atomicJSON(this.paths.configuration, config);
        await this.event('services', '注册并启动后台组件', 'complete');
        await this.event('health', '验证工作台连接', 'complete');
        const result = await this.inspect();
        if (this.input.password) {
          const response = await this.request(config, '/api/auth/login', { username: config.auth.username, password: this.input.password, trusted: true });
          if (response.data?.success) result.sessionToken = response.data.data?.token || response.data.token;
        }
        return result;
      }
      if (!config?.initialized) throw new SetupError('NOT_INITIALIZED', '请先完成本机工作台初始化。');
      if (command === 'repair') {
        const bundled = await this.manifest(this.bundle);
        const previous = await jsonFile(join(config.runtimePath, 'manifest.json'));
        const sameSource = previous?.tmuxSourceCommit && previous.tmuxSourceCommit === bundled.tmuxSourceCommit && previous.tmuxVersion === bundled.tmuxVersion;
        const sameBinary = previous?.files?.['bin/tmux'] && previous.files['bin/tmux'] === bundled.files?.['bin/tmux'];
        if (!sameSource && !sameBinary) throw new SetupError('TMUX_MIGRATION_REQUIRED', '新版本的会话引擎与当前环境不同，未自动替换。', '当前任务会继续运行。请保留现有版本；会话引擎升级需要单独规划迁移，不能在有运行任务时强制重启。');
        await this.event('update', '准备更新内置组件', 'running');
        const next = { ...config, runtimePath: await this.installRuntime({ repair: true }) };
        try {
          await atomicJSON(this.paths.configuration, next);
          await this.start(next, true);
          await this.event('update', '内置组件已更新', 'complete');
          return { ...await this.inspect(), message: '内置组件已更新，原 tmux 会话保持运行。' };
        } catch {
          await atomicJSON(this.paths.configuration, config);
          let restored = false;
          try { await this.start(config, true); restored = true; } catch { /* Keep the original configuration and both runtimes for recovery. */ }
          throw new SetupError('RUNTIME_UPDATE_FAILED', '新组件未通过检查，已恢复原配置。', restored ? '原面板服务已恢复，tmux 会话未停止。请查看日志后重试。' : '原组件和配置仍保留。请查看日志或重新下载原版本进行修复；tmux 会话未被停止。');
        }
      }
      if (command === 'save') {
        const next = validateSettings(this.input, config);
        await atomicJSON(this.paths.configuration, next);
        return this.inspect();
      }
      if (command === 'start' || command === 'restart') { await this.start(config, command === 'restart'); return this.inspect(); }
      if (command === 'stop') {
        await this.stopPanel();
        return this.inspect(); // tmux and its sessions deliberately stay alive.
      }
      if (command === 'export-relay') {
        if (!config.listenOnLAN) throw new SetupError('LAN_DISABLED', '请先允许局域网连接并应用配置。', '仅本机模式不能供手机通过引导网页连接。');
        if (!config.relay?.domain || !config.relay?.pagesURL) throw new SetupError('RELAY_INCOMPLETE', '请先填写 DuckDNS 子域名和 GitHub Pages 地址。');
        if ((await this.inspect()).requiresRestart) throw new SetupError('APPLY_REQUIRED', '连接配置尚未应用到后台服务。', '请先重启面板服务应用设置，再导出引导站点。');
        const source = join(config.runtimePath, 'app'), site = this.paths.relaySite;
        await mkdir(site, { recursive: true, mode: 0o700 });
        let html = await readFile(join(source, 'relay/index.template.html'), 'utf8');
        html = html.replaceAll('__DUCKDNS_FQDN__', config.relay.domain + '.duckdns.org').replaceAll('__PANEL_PORT__', String(config.port));
        await writeFile(join(site, 'index.html'), html);
        const preview = html.split('\n').filter(line => !line.includes('window.PANEL_RELAY_CONFIG')).join('\n')
          .replace('<script src="relay.js"></script>', '<script>document.getElementById("theme-name").textContent=Theme.getName(document.documentElement.dataset.theme);</script>')
          .replaceAll('正在定位工作台…', '外观预览，不会发起连接');
        await writeFile(join(site, 'preview.html'), preview);
        for (const [from, to] of [['relay/relay.js', 'relay.js'], ['relay/themes.html', 'themes.html'], ['relay/robots.txt', 'robots.txt'], ['public/js/theme.js', 'theme.js']]) await copyFile(join(source, from), join(site, to));
        await copyFile(config.tls.ca, join(site, 'ca.crt'));
        return { ...await this.inspect(), message: '引导站点已导出。请把目录中的文件上传至你自己的 GitHub Pages 仓库根目录；不要上传 settings.json 或私钥。' };
      }
      if (command === 'update-dns') {
        if (!config.listenOnLAN || !config.relay?.enabled || !config.relay.domain || !config.relay.duckdnsToken) throw new SetupError('DNS_INCOMPLETE', '请启用局域网和稳定入口，并填写 DuckDNS 子域名及 Token。');
        const ip = lanIPs()[0]; if (!ip) throw new SetupError('LAN_UNAVAILABLE', '没有找到可用的局域网 IPv4 地址。', '请连接 Wi-Fi 或有线网络后重试。');
        if ((await this.inspect()).requiresRestart) throw new SetupError('APPLY_REQUIRED', '连接配置尚未应用到后台服务。', '请先重启面板服务应用设置，再更新 DNS；tmux 会话会保留。');
        if ((await this.inspect()).status.certificateNeedsRenewal) throw new SetupError('CERTIFICATE_STALE', '电脑的网络地址已改变，需要更新连接证书。', '请先点击“重启面板服务”应用连接设置，再更新 DNS；tmux 会话会保留。');
        const url = new URL('https://www.duckdns.org/update');
        url.search = new URLSearchParams({ domains: config.relay.domain, token: config.relay.duckdnsToken, ip }).toString();
        let response;
        try { response = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: 'error' }); }
        catch { throw new SetupError('DNS_NETWORK_ERROR', '无法连接 DuckDNS，未完成更新。', '请检查互联网连接或代理设置后重试。'); }
        if (!response.ok || (await response.text()).trim() !== 'OK') throw new SetupError('DNS_REJECTED', 'DuckDNS 未接受本次更新。', '请核对账户中的子域名和 Token；不要把 Token 发到公开仓库。');
        return { ...await this.inspect(), message: 'DuckDNS 已更新为当前局域网地址；这不会创建公网隧道。' };
      }
      throw new SetupError('COMMAND_INVALID', '未知的客户端管理操作。');
    } catch (error) {
      const messages = { EACCES: '没有权限写入客户端的数据目录。', EPERM: '系统拒绝了这次配置操作。', EROFS: '目标目录为只读，无法保存工作台数据。', ENOSPC: '磁盘空间不足，安装尚未完成。', ENOENT: '必要的组件或文件不存在，请重新下载完整安装包。' };
      const mapped = error instanceof SetupError ? error : /^TLS_[A-Z_]+$/.test(error.code || '') && typeof error.action === 'string' ? new SetupError(error.code, error.message, error.action) : new SetupError('SETUP_FAILED', messages[error.code] || '初始化操作未完成。',
        '操作阶段：' + (this.phase || command) + '；错误代码：' + (/^[A-Z_0-9-]{1,40}$/.test(String(error.code || '')) ? error.code : 'unknown') + '。请检查目录权限、磁盘空间和内置组件后重试。');
      await this.event('error', '操作未完成', 'failed', mapped.message).catch(() => {});
      throw mapped;
    } finally { await rm(lock, { recursive: true, force: true }); }
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  try {
    const raw = readFileSync(0, 'utf8');
    if (Buffer.byteLength(raw) > 262144) throw new SetupError('INPUT_TOO_LARGE', '初始化请求过大。');
    const input = raw.trim() ? JSON.parse(raw) : {};
    const result = await new DesktopRuntime(input).execute(process.argv[2] || 'inspect');
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    const known = error instanceof SetupError;
    process.stdout.write(JSON.stringify({ ok: false, error: { code: known ? error.code : 'SETUP_FAILED', message: known ? error.message : '初始化操作未完成。', action: known ? error.action : '请检查目录权限、剩余磁盘空间和运行日志后重试。' } }) + '\n');
    process.exitCode = 1;
  }
}
