import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { AppError, ErrorCode } from '../servers/errors.js';

const execFileAsync = promisify(execFile);
const ORIGIN = 'https://token-hub.alibaba-inc.com';
const APPS = {
  claude: 'Claude Code', 'claude-desktop': 'claude-desktop', codex: 'Codex', gemini: 'gemini',
  opencode: 'OpenCode', openclaw: 'OpenClaw Enterprise', hermes: 'Hermes', 'qwen-code': 'qwencode',
};
const STORE_KEYS = ['token_switch_auth_install_id', 'token_switch_auth_session_secret_v1',
  'token_switch_auth_session_meta', 'managed_catalog_device_id'];
const MODEL_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function unavailable(message = '无法读取 Token Switch 集团登录态，请重新登录') {
  return new AppError(ErrorCode.UNSUPPORTED, message);
}

function app(value) {
  const entry = Object.entries(APPS).find(([id, name]) => value === id || value === name);
  if (!entry) throw unavailable('该应用不在 Token Switch 已知应用列表中');
  return { id: entry[0], code: entry[1] };
}

function decode64(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw unavailable();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw unavailable();
  return bytes;
}

function decrypt(store) {
  try {
    const blob = JSON.parse(store.token_switch_auth_session_secret_v1);
    const installId = store.token_switch_auth_install_id?.trim();
    if (blob.version !== 1 || blob.algorithm !== 'sha256-stream-xor' || !installId || installId.length > 128) throw unavailable();
    const nonce = decode64(blob.nonce);
    const ciphertext = decode64(blob.ciphertext);
    if (nonce.length !== 16 || ciphertext.length < 2 || ciphertext.length > 65536) throw unavailable();
    // Token Switch 0.1.7: derive@0x100716280, XOR stream@0x1007165f8.
    const key = createHash('sha256').update('token-switch-auth-session-v1').update(installId).update(nonce).digest();
    const plaintext = Buffer.alloc(ciphertext.length);
    for (let offset = 0, counter = 0n; offset < ciphertext.length; offset += 32, counter++) {
      const block = Buffer.alloc(8);
      block.writeBigUInt64LE(counter);
      const stream = createHash('sha256').update(key).update(nonce).update(block).digest();
      for (let index = 0; index < Math.min(32, ciphertext.length - offset); index++) plaintext[offset + index] = ciphertext[offset + index] ^ stream[index];
    }
    const token = JSON.parse(plaintext.toString('utf8')).accessToken;
    plaintext.fill(0);
    key.fill(0);
    if (typeof token !== 'string' || !token || token.length > 16384 || /[\r\n]/.test(token)) throw unavailable();
    return token;
  } catch { throw unavailable(); }
}

function baseUrl(value) {
  try {
    const url = new URL(value);
    if (url.origin !== ORIGIN || !url.pathname.startsWith('/portal/llm-api/')
      || url.username || url.password || url.search || url.hash) return null;
    return url.href.replace(/\/+$/, '');
  } catch { return null; }
}

export function createTokenSwitchClient(options = {}) {
  const databasePath = join(options.home || homedir(), '.token-switch', 'token-switch.db');
  const now = options.now || Date.now;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const catalog = new Map();
  const runSQLite = options.runSQLite || (async (path, query) => {
    const result = await execFileAsync('sqlite3', ['-readonly', '-json', path, query], { timeout: 5000, maxBuffer: 1024 * 1024 });
    return result.stdout;
  });

  async function store() {
    try {
      if (!(await stat(databasePath)).isFile()) throw unavailable();
      const rows = JSON.parse(await runSQLite(databasePath,
        `select key,value from settings where key in (${STORE_KEYS.map((key) => `'${key}'`).join(',')})`) || '[]');
      if (!Array.isArray(rows)) throw unavailable();
      return Object.fromEntries(rows.filter((row) => row && STORE_KEYS.includes(row.key)).map((row) => [row.key, row.value]));
    } catch (error) {
      if (error?.code === 'ENOENT') throw error;
      throw unavailable();
    }
  }

  // Credentials stay inside the backend closure; getStatus/getCatalog/checkQuota never return them.
  function session(values) {
    let expiresAt;
    try { expiresAt = JSON.parse(values.token_switch_auth_session_meta).accessTokenExpiresAt; } catch { throw unavailable(); }
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now()) throw unavailable('Token Switch 集团登录态已过期，请重新登录');
    const deviceId = values.managed_catalog_device_id;
    if (typeof deviceId !== 'string' || !deviceId || deviceId.length > 256 || /[\r\n]/.test(deviceId)) throw unavailable();
    const token = decrypt(values);
    const identity = createHash('sha256').update(JSON.stringify([token, deviceId])).digest('hex');
    return { token, deviceId, expiresAt, identity };
  }

  function requireValidSession(current) {
    if (current.expiresAt <= now()) throw unavailable('Token Switch 集团登录态已过期，请重新登录');
  }

  async function request(path, body, current) {
    requireValidSession(current);
    let response, result;
    try {
      response = await fetchImpl(`${ORIGIN}/portal/token-switch/providers/${path}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
        headers: { 'Content-Type': 'application/json', 'X-Client-Version': '0.1.7',
          'X-Device-Id': current.deviceId, 'X-Switch-Token': current.token },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw unavailable();
      const text = await response.text();
      if (text.length > 2 * 1024 * 1024) throw unavailable();
      result = JSON.parse(text);
    } catch { throw unavailable('Token Switch 集团接口查询失败，请检查登录态与网络'); }
    requireValidSession(current);
    if (!result || result.error_code !== 0 || !Object.hasOwn(result, 'data')) throw unavailable('Token Switch 集团接口未返回有效数据');
    return result.data;
  }

  async function loadCatalog(appCodes, current) {
    if (!Array.isArray(appCodes) || !appCodes.length || appCodes.length > 8) throw unavailable('请选择有效的集团应用');
    const selected = [...new Map(appCodes.map((value) => { const item = app(value); return [item.code, item]; })).values()];
    const data = await request('available', { appCodes: selected.map((item) => item.code) }, current);
    if (!data || !Array.isArray(data.apps) || !Array.isArray(data.protocol)) throw unavailable('集团模型目录格式无效');
    const protocols = new Map(data.protocol.filter((entry) => entry && typeof entry.name === 'string')
      .map((entry) => [entry.name, baseUrl(entry.base_url)]));
    const models = [];
    const permissions = new Map();
    for (const target of selected) {
      const entries = data.apps.filter((entry) => entry && entry.appCode === target.code);
      if (entries.length !== 1 || !Array.isArray(entries[0].modes)) throw unavailable('集团模型目录缺少请求应用');
      // Native Codex uses the OpenAI endpoint even when a mode's backend protocolList is Anthropic.
      const protocol = target.id === 'gemini' ? 'gemini_native'
        : ['claude', 'claude-desktop'].includes(target.id) ? 'anthropic' : 'openai_chat';
      const endpoint = protocols.get(protocol);
      const allowed = new Set();
      for (const mode of entries[0].modes) {
        if (!mode || typeof mode.modeCode !== 'string' || !MODEL_ID.test(mode.modeCode)
          || typeof mode.modeName !== 'string' || !endpoint || allowed.has(mode.modeCode)) continue;
        allowed.add(mode.modeCode);
        models.push({
          id: mode.modeCode, name: mode.modeName, app: target.id, appCode: target.code, baseUrl: endpoint,
          description: typeof mode.description === 'string' ? mode.description : '',
          multiplier: typeof mode.multiplier === 'number' && Number.isFinite(mode.multiplier) && mode.multiplier >= 0 ? mode.multiplier : null,
          contextWindow: Number.isSafeInteger(mode.contextWindow) && mode.contextWindow > 0 ? mode.contextWindow : null,
          multimodal: mode.multimodal === true,
          protocolList: Array.isArray(mode.protocolList) ? mode.protocolList.filter((value) => typeof value === 'string' && /^[a-z_]{1,32}$/.test(value)) : [],
        });
      }
      const entry = { until: Math.min(now() + 60000, current.expiresAt), identity: current.identity, allowed };
      permissions.set(target.code, entry);
      catalog.set(target.code, entry);
    }
    return { models, observedAt: now(), permissions };
  }

  async function getCatalog(appCodes = ['Codex']) {
    const current = session(await store());
    const { models, observedAt } = await loadCatalog(appCodes, current);
    return { models, observedAt };
  }

  async function authorize(appCode, modelId, current) {
    const target = app(appCode);
    if (typeof modelId !== 'string' || !MODEL_ID.test(modelId)) throw unavailable('集团模型 ID 无效');
    let entry = catalog.get(target.code);
    if (!entry || entry.until <= now() || entry.identity !== current.identity) {
      entry = (await loadCatalog([target.code], current)).permissions.get(target.code);
    }
    if (!entry.allowed.has(modelId)) throw unavailable('该模型未在当前应用的集团目录中下发');
    return target;
  }

  return {
    async getStatus() {
      let installed = false, expiresAt = null;
      try {
        const values = await store();
        installed = true;
        try { expiresAt = JSON.parse(values.token_switch_auth_session_meta).accessTokenExpiresAt; } catch { /* invalid session */ }
        const current = session(values);
        return { installed: true, loggedIn: true, expiresAt: current.expiresAt };
      } catch (error) {
        if (error?.code !== 'ENOENT') installed = true;
        return { installed, loggedIn: false, expiresAt: Number.isSafeInteger(expiresAt) ? expiresAt : null };
      }
    },
    getCatalog,
    async checkQuota(appCode, modeCode) {
      const current = session(await store());
      const target = await authorize(appCode, modeCode, current);
      const data = await request('quota/check', { appCode: target.code, modeCode }, current);
      if (typeof data !== 'boolean') throw unavailable('集团额度检查格式无效');
      return { app: target.id, appCode: target.code, modelId: modeCode, available: data, observedAt: now() };
    },
    // Backend-only: never serialize these headers into an API response or logs.
    async gatewayHeaders(appCode, modelId) {
      const current = session(await store());
      const target = await authorize(appCode, modelId, current);
      requireValidSession(current);
      return { 'X-Switch-Token': current.token, 'X-CC-Model-ID': modelId, 'X-App-Tag': target.code };
    },
  };
}
