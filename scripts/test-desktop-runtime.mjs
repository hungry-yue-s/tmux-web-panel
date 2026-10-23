#!/usr/bin/env node
// Invoke with RUNTIME/bin/node scripts/test-desktop-runtime.mjs RUNTIME.
// The helper is the only service entry point; it registers isolated launchd jobs.
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import https from 'node:https';

const exec = promisify(execFile);
const pause = ms => new Promise(done => setTimeout(done, ms));
const productionLabels = ['com.tmux-web-panel', 'com.tmux-web-panel.tmux-server'];
let phase = 'preflight', dataDir, socketRoot, labels, runtime, productionBefore;
let cleanupAllowed = false, primaryError;
const cleanupErrors = [];

function check(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}
function safeCode(error) {
  return /^[A-Z_0-9-]{1,80}$/.test(String(error?.code || '')) ? String(error.code) : 'CHECK_FAILED';
}
async function job(label) {
  try {
    const { stdout } = await exec('/bin/launchctl', ['print', 'gui/' + process.getuid() + '/' + label], { timeout: 5000, maxBuffer: 1024 * 1024 });
    return { loaded: true, pid: Number(/\bpid = (\d+)/.exec(stdout)?.[1]) || null, output: stdout };
  } catch (error) {
    if (/Could not find (?:specified )?service/.test(error.stderr || '')) return { loaded: false, pid: null, output: '' };
    throw Object.assign(new Error('Cannot inspect launchd user domain'), { code: 'LAUNCHD_QUERY_FAILED' });
  }
}
async function productionSnapshot() {
  const entries = await Promise.all(productionLabels.map(async label => {
    const { loaded, pid } = await job(label);
    return [label, { loaded, pid }];
  }));
  return Object.fromEntries(entries);
}
async function freePort() {
  return new Promise((done, reject) => {
    const socket = createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const port = socket.address().port;
      socket.close(error => error ? reject(error) : done(port));
    });
  });
}
function helperEnvironment() {
  const env = { ...process.env, PATH: join(runtime, 'bin') + ':/usr/bin:/bin:/usr/sbin:/sbin', TMUX: '' };
  for (const key of Object.keys(env)) {
    if (key.startsWith('TMUX_PANEL_') || ['AUTH', 'PORT', 'HOST', 'HTTP_PORT', 'TLS_CERT', 'TLS_KEY', 'TLS_AUTO', 'TMUX_TMPDIR'].includes(key)) delete env[key];
  }
  return env;
}
async function helper(command, input = {}) {
  return new Promise((done, reject) => {
    const child = spawn(join(runtime, 'bin/node'), [join(runtime, 'app/scripts/desktop-runtime.mjs'), command], {
      env: helperEnvironment(), stdio: ['pipe', 'pipe', 'pipe'], timeout: 180000,
    });
    let output = '', overflow = false;
    child.stdout.on('data', chunk => {
      if (output.length + chunk.length < 1024 * 1024) output += chunk;
      else overflow = true;
    });
    // Helper output may contain the initial token. Never forward stdout/stderr.
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => reject(Object.assign(new Error('Helper failed to launch'), { code: 'HELPER_LAUNCH_FAILED' })));
    child.on('close', code => {
      let result;
      try { if (!overflow) result = JSON.parse(output); } catch { /* Report a fixed, redacted code below. */ }
      if (code !== 0 || result?.ok !== true) {
        reject(Object.assign(new Error('Helper command failed'), { code: result?.error?.code || 'HELPER_FAILED' }));
      } else done(result);
    });
    child.stdin.end(JSON.stringify({ ...input, dataDir, runtimePath: runtime, launchAtLogin: false }));
  });
}
async function configuration() {
  return JSON.parse(await readFile(join(dataDir, 'settings.json'), 'utf8'));
}
async function api(path, { method = 'GET', body, token } = {}) {
  const config = await configuration();
  const ca = await readFile(config.tls.ca);
  return new Promise((done, reject) => {
    const request = https.request(new URL(path, 'https://127.0.0.1:' + config.port), {
      ca, method, timeout: 5000,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        try { done({ status: response.statusCode, body: JSON.parse(text) }); }
        catch { reject(Object.assign(new Error('Unexpected API response'), { code: 'API_RESPONSE_INVALID' })); }
      });
    });
    request.on('error', () => reject(Object.assign(new Error('HTTPS request failed'), { code: 'HTTPS_REQUEST_FAILED' })));
    request.on('timeout', () => request.destroy());
    request.end(body ? JSON.stringify(body) : undefined);
  });
}
async function login(username, password) {
  const response = await api('/api/auth/login', { method: 'POST', body: { username, password, trusted: true } });
  check(response.status === 200 && response.body.success && typeof response.body.data?.token === 'string', 'HTTPS_LOGIN_FAILED');
  return response.body.data.token;
}
async function verifySession(token, name, tmuxPID) {
  const status = await api('/api/status', { token });
  check(status.status === 200 && status.body.success && typeof status.body.data?.sessions === 'number' && status.body.data.sessions >= 1, 'STATUS_OR_TRUSTED_TOKEN_FAILED');
  const sessions = await api('/api/sessions', { token });
  check(sessions.status === 200 && sessions.body.success && Array.isArray(sessions.body.data) && sessions.body.data.some(session => session.name === name), 'SESSION_NOT_PRESERVED');
  check((await job(labels.tmux)).pid === tmuxPID, 'TMUX_PID_CHANGED');
}
async function removeTestJob(label) {
  const state = await job(label);
  if (!state.loaded) return;
  check(state.output.includes(dataDir), 'CLEANUP_OWNERSHIP_MISMATCH');
  try { await exec('/bin/launchctl', ['bootout', 'gui/' + process.getuid() + '/' + label], { timeout: 15000 }); }
  catch { if ((await job(label)).loaded) throw Object.assign(new Error('Test job remains loaded'), { code: 'CLEANUP_BOOTOUT_FAILED' }); }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (!(await job(label)).loaded) return;
    await pause(100);
  }
  throw Object.assign(new Error('Test job did not unload'), { code: 'CLEANUP_UNLOAD_TIMEOUT' });
}

try {
  check(process.platform === 'darwin' && typeof process.getuid === 'function', 'MACOS_REQUIRED');
  check(process.argv[2], 'USAGE_TARGET_RUNTIME_REQUIRED');
  runtime = await realpath(resolve(process.argv[2]));
  check(await realpath(process.execPath) === await realpath(join(runtime, 'bin/node')), 'USE_TARGET_RUNTIME_NODE');
  await readFile(join(runtime, 'manifest.json'));
  await readFile(join(runtime, 'app/scripts/desktop-runtime.mjs'));
  productionBefore = await productionSnapshot();
  dataDir = resolve(await mkdtemp(join(tmpdir(), 'tmux-desktop-用户 & data-')));
  const suffix = createHash('sha256').update(dataDir).digest('hex').slice(0, 10);
  labels = { panel: 'com.tmux-web-panel.desktop.' + suffix, tmux: 'com.tmux-web-panel.desktop.' + suffix + '.tmux' };
  socketRoot = join('/tmp', 'tmux-panel-' + process.getuid() + '-' + suffix);
  check(!(await job(labels.panel)).loaded && !(await job(labels.tmux)).loaded, 'TEST_LABEL_ALREADY_EXISTS');
  // Reserve only a new socket directory; never reuse a leftover server socket.
  await mkdir(socketRoot, { mode: 0o700 });
  cleanupAllowed = true;
  const username = 'desktop-test', password = randomBytes(24).toString('base64url');
  const sessionName = 'desktop-test-' + randomBytes(5).toString('hex');

  phase = 'initialize';
  const initialized = await helper('initialize', { username, password, port: await freePort(), listenOnLAN: false });
  check(initialized.configuration?.initialized && initialized.status?.panelState === 'running' && initialized.status?.tmuxState === 'running', 'INITIALIZATION_NOT_READY');
  check(initialized.status.panelLabel === labels.panel && initialized.status.tmuxLabel === labels.tmux, 'TEST_LABEL_MISMATCH');
  console.log('PASS initialize through isolated launchd jobs');

  phase = 'https-session';
  let token = await login(username, password);
  const created = await api('/api/sessions', { method: 'POST', body: { name: sessionName }, token });
  check(created.status === 201 && created.body.success, 'CREATE_SESSION_FAILED');
  const tmuxPID = (await job(labels.tmux)).pid;
  check(tmuxPID, 'TMUX_PID_MISSING');
  await verifySession(token, sessionName, tmuxPID);
  console.log('PASS CA-verified HTTPS login, session creation and numeric status');

  phase = 'immediate-restart';
  const newPort = await freePort();
  // Issue a fresh token immediately before save/restart: no debounce sleep.
  token = await login(username, password);
  const saved = await helper('save', { port: newPort });
  check(saved.requiresRestart && saved.configuration.port === newPort, 'SAVE_DID_NOT_REQUIRE_APPLY');
  const restarted = await helper('restart');
  check(!restarted.requiresRestart && restarted.configuration.port === newPort, 'RESTART_NOT_APPLIED');
  await verifySession(token, sessionName, tmuxPID);
  console.log('PASS immediate port change/restart preserves trusted login and tmux');

  phase = 'stop-start';
  await helper('stop');
  check(!(await job(labels.panel)).loaded && (await job(labels.tmux)).pid === tmuxPID, 'STOP_CHANGED_TMUX_OR_LEFT_PANEL');
  const config = await configuration();
  const { stdout } = await exec(join(config.runtimePath, 'bin/tmux'), ['list-sessions', '-F', '#{session_name}'], {
    timeout: 5000, env: { ...helperEnvironment(), TMUX_TMPDIR: socketRoot },
  });
  check(stdout.split('\n').includes(sessionName), 'STOP_LOST_SESSION');
  await helper('start');
  await verifySession(token, sessionName, tmuxPID);
  console.log('PASS stop/start preserves trusted login, tmux PID and session');

  phase = 'compatible-repair';
  const oldRuntime = (await configuration()).runtimePath;
  await helper('repair');
  check((await configuration()).runtimePath !== oldRuntime, 'REPAIR_DID_NOT_INSTALL_NEW_DIRECTORY');
  await verifySession(token, sessionName, tmuxPID);
  console.log('PASS compatible repair preserves trusted login, tmux PID and session');
} catch (error) {
  primaryError = { phase, code: safeCode(error) };
} finally {
  if (cleanupAllowed) {
    for (const label of [labels.panel, labels.tmux]) {
      try { await removeTestJob(label); }
      catch (error) { cleanupErrors.push(safeCode(error)); }
    }
  }
  if (dataDir && cleanupErrors.length === 0) {
    try {
      if (cleanupAllowed) await rm(socketRoot, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
    } catch (error) { cleanupErrors.push(safeCode(error)); }
  }
  if (productionBefore) {
    try {
      check(JSON.stringify(await productionSnapshot()) === JSON.stringify(productionBefore), 'PRODUCTION_PID_OR_EXISTENCE_CHANGED');
      console.log('PASS production panel/tmux PIDs and existence unchanged');
    } catch (error) { cleanupErrors.push(safeCode(error)); }
  }
}

if (primaryError) console.error('FAIL ' + primaryError.phase + ': ' + primaryError.code);
for (const code of cleanupErrors) console.error('FAIL cleanup/safety: ' + code);
if (primaryError || cleanupErrors.length) process.exitCode = 1;
else console.log('PASS desktop runtime lifecycle; isolated test services and data removed');
