import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { Router } from 'express';

import { AppError, ErrorCode, handle } from '../servers/errors.js';
import { createClaudeProviderSwitcher } from '../agent-providers/claude-provider-switch.js';
import { createCodexProviderSwitcher } from '../agent-providers/codex-provider-switch.js';
import { requireSameOrigin } from './servers.js';

const execFileAsync = promisify(execFile);
const PROFILE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const CHATGPT_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CHATGPT_CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const CODEX_WARMUP_MODEL = 'gpt-5.6-luna';
const USAGE_TTL_MS = 60_000;
const AUTO_WARMUP_CHECK_MS = 30_000;
const AUTO_WARMUP_RETRY_MS = 60_000;
const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;
const AUTO_WARMUP_SLACK_MINUTES = 5;
const MIN_WARMUP_INTERVAL_MS = 60 * 60 * 1000;

function validProfileId(value) {
  return typeof value === 'string' && PROFILE_ID_RE.test(value)
    && !['__proto__', 'prototype', 'constructor'].includes(value);
}

function safeDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function authKind(auth) {
  const type = auth && auth.type;
  if (type === 'chat_g_p_t' || type === 'chatgpt') return 'chatgpt';
  if (type === 'api_key' || (auth && typeof auth.key === 'string')) return 'api_key';
  return 'unknown';
}

function sanitizeWindow(window) {
  if (!window || typeof window !== 'object') return null;
  return {
    usedPercent: Number.isFinite(Number(window.used_percent)) ? Number(window.used_percent) : null,
    windowMinutes: Number.isFinite(Number(window.limit_window_seconds))
      ? Math.ceil(Number(window.limit_window_seconds) / 60)
      : Number.isFinite(Number(window.window_minutes)) ? Number(window.window_minutes) : null,
    resetsAt: Number.isFinite(Number(window.reset_at)) ? Number(window.reset_at) : null,
  };
}

function sanitizeWhamUsage(payload) {
  const rate = payload && payload.rate_limit;
  const credits = payload && payload.credits;
  return {
    planType: payload && payload.plan_type ? String(payload.plan_type) : null,
    primary: sanitizeWindow(rate && rate.primary_window),
    secondary: sanitizeWindow(rate && rate.secondary_window),
    credits: credits && typeof credits === 'object' ? {
      hasCredits: Boolean(credits.has_credits),
      unlimited: Boolean(credits.unlimited),
      balance: Number.isFinite(Number(credits.balance)) ? Number(credits.balance) : null,
    } : null,
    observedAt: new Date().toISOString(),
  };
}

function dueAutoWarmupWindow(usage, history, nowMs = Date.now()) {
  const weekly = [usage && usage.primary, usage && usage.secondary]
    .find((window) => window && Number(window.windowMinutes) === WEEKLY_WINDOW_MINUTES);
  const usedPercent = Number(weekly && weekly.usedPercent);
  if (!weekly || !Number.isFinite(Number(weekly.resetsAt))
    || !Number.isFinite(usedPercent) || usedPercent >= 99.5) return null;
  const remainingMs = Number(weekly.resetsAt) * 1000 - nowMs;
  const minute = 60 * 1000;
  if (remainingMs < (WEEKLY_WINDOW_MINUTES - AUTO_WARMUP_SLACK_MINUTES) * minute
    || remainingMs > (WEEKLY_WINDOW_MINUTES + AUTO_WARMUP_SLACK_MINUTES) * minute) return null;
  const key = `weekly:${WEEKLY_WINDOW_MINUTES}:${weekly.resetsAt}`;
  if (history && history.lastAutoWindowKey === key) return null;
  const lastSuccess = Date.parse(history && history.lastSuccessAt || '');
  if (Number.isFinite(lastSuccess) && nowMs - lastSuccess < MIN_WARMUP_INTERVAL_MS) return null;
  return key;
}

function publicCodexProfile(account, store, usage) {
  return {
    id: String(account.id || ''),
    name: String(account.name || account.email || 'Codex account'),
    email: account.email ? String(account.email) : null,
    planType: account.plan_type ? String(account.plan_type) : null,
    authKind: authKind(account.auth_data),
    active: store.active_account_id === account.id,
    masked: Array.isArray(store.masked_account_ids) && store.masked_account_ids.includes(account.id),
    lastUsedAt: safeDate(account.last_used_at),
    subscriptionExpiresAt: safeDate(account.subscription_expires_at),
    usage: usage || null,
  };
}

async function atomicJSONWrite(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function accountIdentity(auth) {
  if (!auth || typeof auth !== 'object') return null;
  if (typeof auth.account_id === 'string' && auth.account_id) return auth.account_id;
  const token = auth.id_token;
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload.chatgpt_account_id || payload.account_id || payload.sub || null;
  } catch {
    return null;
  }
}

function syncActiveTokens(store, currentAuth) {
  const active = (store.accounts || []).find((account) => account.id === store.active_account_id);
  const current = currentAuth && currentAuth.tokens;
  if (!active || authKind(active.auth_data) !== 'chatgpt' || !current) return false;
  const storedID = accountIdentity(active.auth_data);
  const currentID = accountIdentity(current);
  if (storedID && currentID && storedID !== currentID) return false;
  const fields = ['id_token', 'access_token', 'refresh_token', 'account_id'];
  let changed = false;
  for (const field of fields) {
    if (typeof current[field] === 'string' && current[field] && active.auth_data[field] !== current[field]) {
      active.auth_data[field] = current[field];
      changed = true;
    }
  }
  return changed;
}

function authFileFor(account) {
  const auth = account.auth_data || {};
  if (authKind(auth) === 'api_key') {
    if (!auth.key) throw new AppError(ErrorCode.VALIDATION_ERROR, '该 API 配置没有可用的 Key');
    return { OPENAI_API_KEY: auth.key };
  }
  if (authKind(auth) !== 'chatgpt') {
    throw new AppError(ErrorCode.UNSUPPORTED, '暂不支持该账号类型');
  }
  return {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: auth.id_token,
      access_token: auth.access_token,
      refresh_token: auth.refresh_token,
      account_id: auth.account_id || null,
    },
    last_refresh: new Date().toISOString(),
  };
}

async function readJSON(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function qoderActivity(qoderTasksPath) {
  let entries;
  try {
    entries = await readdir(qoderTasksPath, { withFileTypes: true });
  } catch {
    return { installed: false, taskCount: 0, lastActivityAt: null };
  }
  const taskDirs = entries.filter((entry) => entry.isDirectory());
  let latest = 0;
  await Promise.all(taskDirs.map(async (entry) => {
    try {
      const info = await stat(join(qoderTasksPath, entry.name));
      latest = Math.max(latest, info.mtimeMs || 0);
    } catch { /* a task can disappear while Qoder rotates it */ }
  }));
  return {
    installed: true,
    taskCount: taskDirs.length,
    lastActivityAt: latest ? new Date(latest).toISOString() : null,
  };
}

function qoderProjectPath(directory, record) {
  const direct = record && (record.cwd || record.project_path || record.projectPath || record.workspace_path || record.workspacePath);
  if (typeof direct === 'string' && direct) return direct;
  if (record) return null;
  return `Qoder · ${basename(directory)}`;
}

async function readQoderSession(path, projectDirectory, info) {
  const session = {
    session_id: basename(path, '.jsonl'),
    project_path: qoderProjectPath(projectDirectory),
    start_time: info.birthtimeMs ? new Date(info.birthtimeMs).toISOString() : new Date(info.mtimeMs).toISOString(),
    updated_at: new Date(info.mtimeMs).toISOString(),
    input_tokens: 0,
    output_tokens: 0,
    messages: 0,
    model: null,
    token_usage_recorded: false,
  };
  let first = Number.POSITIVE_INFINITY;
  let last = 0;
  try {
    const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    for await (const line of lines) {
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (!record || typeof record !== 'object') continue;
      session.project_path = qoderProjectPath(projectDirectory, record) || session.project_path;
      session.session_id = String(record.session_id || record.sessionId || session.session_id);
      const message = record.message && typeof record.message === 'object' ? record.message : {};
      const usage = (message.usage && typeof message.usage === 'object' ? message.usage : record.usage) || {};
      if (['input_tokens', 'inputTokens', 'output_tokens', 'outputTokens'].some((key) => Object.hasOwn(usage, key))) {
        session.token_usage_recorded = true;
      }
      session.model ||= record.model || message.model || null;
      session.input_tokens += Number(usage.input_tokens || usage.inputTokens || 0)
        + Number(usage.cache_creation_input_tokens || 0) + Number(usage.cache_read_input_tokens || 0);
      session.output_tokens += Number(usage.output_tokens || usage.outputTokens || 0);
      if (record.type === 'user' || record.type === 'assistant' || message.role === 'user' || message.role === 'assistant') {
        session.messages += 1;
      }
      const timestamp = Date.parse(record.timestamp || record.created_at || record.createdAt || '');
      if (Number.isFinite(timestamp)) {
        first = Math.min(first, timestamp);
        last = Math.max(last, timestamp);
      }
    }
  } catch { /* macOS may deny Qoder history access; file metadata still identifies the session */ }
  if (Number.isFinite(first)) session.start_time = new Date(first).toISOString();
  if (last) session.updated_at = new Date(last).toISOString();
  session.tokens = session.input_tokens + session.output_tokens;
  session.duration_minutes = Math.max(0, Math.round((Date.parse(session.updated_at) - Date.parse(session.start_time)) / 60000));
  return session;
}

async function qoderSessions(qoderProjectsPath) {
  let projectEntries;
  try {
    projectEntries = await readdir(qoderProjectsPath, { withFileTypes: true });
  } catch {
    return { installed: false, recentSessions: [], totalSessions: 0, totalMessages: 0, totalTokens: 0, lastActivityAt: null };
  }
  const files = [];
  await Promise.all(projectEntries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const directory = join(qoderProjectsPath, entry.name);
    try {
      const children = await readdir(directory, { withFileTypes: true });
      await Promise.all(children.filter((child) => child.isFile() && child.name.endsWith('.jsonl')).map(async (child) => {
        const path = join(directory, child.name);
        try { files.push({ path, directory, info: await stat(path) }); } catch { /* history can rotate while scanning */ }
      }));
    } catch { /* inaccessible project history is ignored */ }
  }));
  files.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
  const recentSessions = await Promise.all(files.slice(0, 20).map((file) => readQoderSession(file.path, file.directory, file.info)));
  const recordedTokens = recentSessions.filter((session) => session.token_usage_recorded);
  return {
    installed: true,
    recentSessions,
    totalSessions: files.length,
    totalMessages: recentSessions.reduce((sum, session) => sum + session.messages, 0),
    totalTokens: recordedTokens.length ? recordedTokens.reduce((sum, session) => sum + session.tokens, 0) : null,
    lastActivityAt: files[0] ? new Date(files[0].info.mtimeMs).toISOString() : null,
  };
}

function quotaNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function qoderQuota(payload) {
  const total = payload && (payload.totalQuota || payload.total_quota);
  const shared = payload && (payload.sharedQuota || payload.shared_quota);
  const summary = total && (total.quotaSummary || total.quota_summary);
  const sharedSummary = shared && (shared.quotaSummary || shared.quota_summary);
  if (!summary) throw new Error('missing quota summary');
  const read = (value, camel, snake) => quotaNumber(value && (value[camel] ?? value[snake]));
  const baseUsed = read(summary, 'usedValue', 'used_value');
  const baseLimit = read(summary, 'limitValue', 'limit_value');
  if (baseUsed === null || baseLimit === null) throw new Error('invalid quota summary');
  const sharedUsed = sharedSummary ? read(sharedSummary, 'usedValue', 'used_value') : 0;
  const sharedLimit = sharedSummary ? read(sharedSummary, 'limitValue', 'limit_value') : 0;
  if (sharedUsed === null || sharedLimit === null) throw new Error('invalid shared quota');
  const used = baseUsed + sharedUsed;
  const limit = baseLimit + sharedLimit;
  const resetValue = payload.nextResetAt ?? payload.next_reset_at;
  const resetDate = typeof resetValue === 'number'
    ? new Date(resetValue > 10_000_000_000 ? resetValue : resetValue * 1000)
    : new Date(resetValue || '');
  return {
    usedCredits: used,
    totalCredits: limit,
    remainingCredits: Math.max(0, limit - used),
    usedPercent: limit > 0 ? Math.max(0, Math.min(100, used / limit * 100)) : 100,
    resetsAt: Number.isNaN(resetDate.getTime()) ? null : Math.floor(resetDate.getTime() / 1000),
    observedAt: new Date().toISOString(),
  };
}

function zhipuWindow(limit) {
  if (!limit || !['TOKENS_LIMIT', 'CREDIT_LIMIT', 'TIME_LIMIT'].includes(limit.type)) return null;
  const multipliers = { 1: 1440, 3: 60, 5: 1, 6: 10080 };
  const windowMinutes = Number(limit.number) > 0 && multipliers[limit.unit]
    ? Number(limit.number) * multipliers[limit.unit]
    : null;
  const total = quotaNumber(limit.usage);
  const remaining = quotaNumber(limit.remaining);
  const current = quotaNumber(limit.currentValue);
  let usedPercent = quotaNumber(limit.percentage);
  if (total && (remaining !== null || current !== null)) {
    const used = Math.max(0, Math.min(total, Math.max(remaining === null ? 0 : total - remaining, current || 0)));
    usedPercent = used / total * 100;
  }
  const reset = quotaNumber(limit.nextResetTime);
  return {
    usedPercent: usedPercent === null ? null : Math.max(0, Math.min(100, usedPercent)),
    windowMinutes,
    resetsAt: reset === null ? null : Math.floor(reset / 1000),
  };
}

function providerAuth(settingsConfig) {
  const settings = typeof settingsConfig === 'string' ? JSON.parse(settingsConfig || '{}') : (settingsConfig || {});
  const auth = settings.auth || {};
  return auth.OPENAI_API_KEY || auth.openai_api_key || auth.api_key || null;
}

async function ccSwitchProviders(databasePath, runSQLite, usageForProvider, strict = false, agents = ['claude', 'codex']) {
  const selected = agents.filter((agent) => ['claude', 'codex'].includes(agent));
  if (!selected.length) return [];
  const agentClause = selected.map((agent) => `'${agent}'`).join(',');
  const query = `select id, app_type, name, category, is_current, in_failover_queue,
    provider_type, limit_daily_usd, limit_monthly_usd, settings_config
    from providers where app_type in (${agentClause}) order by app_type, sort_index`;
  try {
    const stdout = await runSQLite(databasePath, query);
    const rows = JSON.parse(stdout || '[]');
    return Promise.all(rows.map(async (row) => ({
      id: String(row.id),
      agent: String(row.app_type),
      name: String(row.name),
      category: row.category ? String(row.category) : null,
      active: Boolean(row.is_current),
      failover: Boolean(row.in_failover_queue),
      providerType: row.provider_type ? String(row.provider_type) : null,
      dailyLimitUsd: row.limit_daily_usd === null ? null : Number(row.limit_daily_usd),
      monthlyLimitUsd: row.limit_monthly_usd === null ? null : Number(row.limit_monthly_usd),
      usage: usageForProvider ? await usageForProvider(row) : null,
    })));
  } catch (error) {
    if (strict) throw error;
    return [];
  }
}

export function createAgentHubService(options = {}) {
  const home = options.home || homedir();
  const accountsPath = options.accountsPath || join(home, '.codex-switcher', 'accounts.json');
  const codexAuthPath = options.codexAuthPath || join(home, '.codex', 'auth.json');
  const ccSwitchDatabase = options.ccSwitchDatabase || join(home, '.cc-switch', 'cc-switch.db');
  const qoderTasksPath = options.qoderTasksPath || join(home, '.qoder', 'tasks');
  const qoderProjectsPath = options.qoderProjectsPath || join(home, '.qoder', 'projects');
  const qoderSessionPath = options.qoderSessionPath || join(home, '.config', 'tmux-web-panel', 'qoder-session.json');
  const profileEventsPath = options.profileEventsPath || join(home, '.config', 'tmux-web-panel', 'agent-profile-events.json');
  const warmupHistoryPath = options.warmupHistoryPath || join(home, '.config', 'tmux-web-panel', 'agent-warmups.json');
  const accountJournalPath = options.accountJournalPath || join(home, '.config', 'tmux-web-panel', 'codex-account-switch.json');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const runSQLite = options.runSQLite || (async (path, sql) => {
    const result = await execFileAsync('sqlite3', ['-json', path, sql], { timeout: 5000 });
    return result.stdout;
  });
  const switchProvider = options.switchProvider || createCodexProviderSwitcher({
    home,
    databasePath: ccSwitchDatabase,
    runSQLite,
  });
  const switchClaudeProvider = options.switchClaudeProvider || createClaudeProviderSwitcher({
    home,
    databasePath: ccSwitchDatabase,
    runSQLite,
  });
  let usageCache = { expiresAt: 0, byId: new Map() };
  let providerUsageCache = { expiresAt: 0, byId: new Map() };
  let qoderUsageCache = { expiresAt: 0, value: null };
  let switchQueue = Promise.resolve();
  let eventQueue = Promise.resolve();
  let autoWarmupTimer = null;
  let autoWarmupRunning = false;
  const autoWarmupRetryAt = new Map();
  const recovery = Promise.all([
    typeof switchProvider.recover === 'function' ? switchProvider.recover() : null,
    typeof switchClaudeProvider.recover === 'function' ? switchClaudeProvider.recover() : null,
  ]).then(() => recoverAccountSwitch());

  async function readWarmupHistory() {
    let history = await readJSON(warmupHistoryPath, { version: 1, accounts: {} });
    if (!history || typeof history !== 'object' || Array.isArray(history)) history = { version: 1, accounts: {} };
    history.version = 1;
    if (!history.accounts || typeof history.accounts !== 'object' || Array.isArray(history.accounts)) history.accounts = {};
    return history;
  }

  async function fetchProfileUsage(account) {
    const auth = account.auth_data || {};
    if (authKind(auth) !== 'chatgpt') return { unavailable: 'API Key 账户由供应商侧计费' };
    if (!auth.access_token) return { error: '缺少访问令牌' };
    try {
      const headers = {
        authorization: `Bearer ${auth.access_token}`,
        accept: 'application/json, text/plain, */*',
        origin: 'https://chatgpt.com',
        referer: 'https://chatgpt.com/',
        'user-agent': 'Mozilla/5.0 tmux-web-panel-agent-hub',
      };
      if (auth.account_id) headers['chatgpt-account-id'] = auth.account_id;
      const response = await fetchImpl(CHATGPT_USAGE_URL, {
        headers,
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) return { error: response.status === 401 ? '登录已过期' : `读取失败 (${response.status})` };
      return sanitizeWhamUsage(await response.json());
    } catch {
      return { error: '暂时无法读取配额' };
    }
  }

  async function usageFor(accounts) {
    if (Date.now() < usageCache.expiresAt) return usageCache.byId;
    const entries = await Promise.all(accounts.map(async (account) => [account.id, await fetchProfileUsage(account)]));
    usageCache = { expiresAt: Date.now() + USAGE_TTL_MS, byId: new Map(entries) };
    return usageCache.byId;
  }

  async function fetchProviderUsage(row) {
    if (row.app_type !== 'codex' || row.category !== 'cn_official') return null;
    let key;
    try { key = providerAuth(row.settings_config); } catch { return { error: '供应商配置无法解析' }; }
    if (!key) return { error: '缺少供应商 API Key' };
    try {
      const headers = { authorization: `Bearer ${key}`, accept: 'application/json' };
      const quotaResponse = await fetchImpl('https://open.bigmodel.cn/api/monitor/usage/quota/limit', {
        headers, signal: AbortSignal.timeout(8000),
      });
      if (!quotaResponse.ok) return { error: `额度读取失败 (${quotaResponse.status})` };
      const quotaBody = await quotaResponse.json();
      if (!quotaBody || quotaBody.success !== true || !Array.isArray(quotaBody.data && quotaBody.data.limits)) {
        return { error: '供应商额度响应无效' };
      }
      const windows = quotaBody.data.limits.map(zhipuWindow).filter(Boolean)
        .filter((window) => window.usedPercent !== null)
        .sort((a, b) => (a.windowMinutes || Number.MAX_SAFE_INTEGER) - (b.windowMinutes || Number.MAX_SAFE_INTEGER));
      const result = {
        primary: windows[0] || null,
        secondary: windows.length > 1 ? windows[windows.length - 1] : null,
        planType: quotaBody.data.planName || quotaBody.data.plan || null,
        observedAt: new Date().toISOString(),
      };
      try {
        const balanceResponse = await fetchImpl('https://www.bigmodel.cn/api/biz/account/query-customer-account-report', {
          headers, signal: AbortSignal.timeout(5000),
        });
        const balanceBody = balanceResponse.ok ? await balanceResponse.json() : null;
        const data = balanceBody && balanceBody.success === true && balanceBody.data;
        const available = data ? quotaNumber(data.availableBalance) : null;
        const balance = data ? quotaNumber(data.balance) : null;
        const spent = data ? quotaNumber(data.totalSpendAmount) : null;
        result.balance = available ?? balance;
        result.spent = spent;
      } catch { /* balance is optional */ }
      return result;
    } catch {
      return { error: '暂时无法读取供应商额度' };
    }
  }

  async function cachedProviderUsage(row) {
    if (Date.now() >= providerUsageCache.expiresAt) {
      providerUsageCache = { expiresAt: Date.now() + USAGE_TTL_MS, byId: new Map() };
    }
    if (providerUsageCache.byId.has(row.id)) return providerUsageCache.byId.get(row.id);
    const usage = await fetchProviderUsage(row);
    providerUsageCache.byId.set(row.id, usage);
    return usage;
  }

  async function fetchQoderUsage() {
    if (Date.now() < qoderUsageCache.expiresAt) return qoderUsageCache.value;
    const session = await readJSON(qoderSessionPath, null);
    const cookieHeader = options.qoderCookie || process.env.QODER_COOKIE || (session && session.cookieHeader);
    const site = options.qoderSite || process.env.QODER_SITE || (session && session.site) || 'international';
    if (!cookieHeader) return null;
    const origin = site === 'china' ? 'https://qoder.com.cn' : 'https://qoder.com';
    let value;
    try {
      const response = await fetchImpl(`${origin}/api/v2/me/usages/big_model_credits`, {
        headers: {
          cookie: cookieHeader,
          accept: 'application/json, text/plain, */*',
          origin,
          referer: `${origin}/account/usage`,
          'x-requested-with': 'XMLHttpRequest',
          'bx-v': '2.5.35',
        },
        signal: AbortSignal.timeout(8000),
      });
      value = response.ok ? qoderQuota(await response.json())
        : { error: response.status === 401 || response.status === 403 ? '网页登录已过期' : `额度读取失败 (${response.status})` };
    } catch {
      value = { error: '暂时无法读取 Qoder 额度' };
    }
    qoderUsageCache = { expiresAt: Date.now() + USAGE_TTL_MS, value };
    return value;
  }

  async function configureQoderSession(input = {}) {
    const cookieHeader = String(input.cookieHeader || '').trim();
    const site = input.site === 'china' ? 'china' : 'international';
    if (!cookieHeader || cookieHeader.length > 32_768 || /[\r\n]/.test(cookieHeader)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'Qoder Cookie 格式无效');
    }
    await atomicJSONWrite(qoderSessionPath, { site, cookieHeader });
    qoderUsageCache.expiresAt = 0;
    return { configured: true, site };
  }

  async function profileEvents() {
    const stored = await readJSON(profileEventsPath, { events: [] });
    return Array.isArray(stored && stored.events) ? stored.events : [];
  }

  async function recordProfile(agent, profile, source = 'switch') {
    if (!profile || !profile.id) return;
    const operation = eventQueue.catch(() => {}).then(async () => {
      const events = await profileEvents();
      const last = [...events].reverse().find((event) => event.agent === agent);
      if (last && last.profileId === profile.id) return;
      events.push({
        agent,
        profileId: profile.id,
        profileName: profile.name || profile.id,
        profileKind: profile.kind || 'api',
        switchedAt: new Date().toISOString(),
        source,
      });
      await atomicJSONWrite(profileEventsPath, { version: 1, events: events.slice(-500) });
    });
    eventQueue = operation;
    await operation;
  }

  async function restoreAccountFiles(journal) {
    if (journal.authExisted) await atomicJSONWrite(codexAuthPath, journal.authSnapshot);
    else await unlink(codexAuthPath).catch(() => {});
    if (journal.storeSnapshot) await atomicJSONWrite(accountsPath, journal.storeSnapshot);
  }

  async function recoverAccountSwitch() {
    const journal = await readJSON(accountJournalPath, null);
    if (!journal) return false;
    if (journal.phase === 'committed') {
      await unlink(accountJournalPath).catch(() => {});
      return false;
    }
    await restoreAccountFiles(journal);
    if (journal.previousProviderId) await switchProvider(journal.previousProviderId);
    await unlink(accountJournalPath).catch(() => {});
    return true;
  }

  async function status(input = {}) {
    await recovery;
    const includeClaude = input.claude !== false;
    const includeCodex = input.codex !== false;
    const store = await readJSON(accountsPath, { accounts: [], active_account_id: null, masked_account_ids: [] });
    const accounts = includeCodex && Array.isArray(store.accounts) ? store.accounts : [];
    const providerAgents = [includeClaude && 'claude', includeCodex && 'codex'].filter(Boolean);
    const [usages, providers, qoderTasks, qoderHistory, qoderUsage, warmups] = await Promise.all([
      includeCodex ? usageFor(accounts) : new Map(),
      ccSwitchProviders(ccSwitchDatabase, runSQLite, cachedProviderUsage, false, providerAgents),
      includeCodex ? qoderActivity(qoderTasksPath) : { installed: false, taskCount: 0, lastActivityAt: null },
      includeCodex ? qoderSessions(qoderProjectsPath) : { installed: false, recentSessions: [], totalSessions: 0, totalMessages: 0, totalTokens: null, lastActivityAt: null },
      includeCodex ? fetchQoderUsage() : null,
      includeCodex ? readWarmupHistory() : { accounts: {} },
    ]);
    const qoder = {
      installed: qoderTasks.installed || qoderHistory.installed,
      taskCount: qoderTasks.taskCount,
      recentSessions: qoderHistory.recentSessions,
      totalSessions: qoderHistory.totalSessions,
      totalMessages: qoderHistory.totalMessages,
      totalTokens: qoderHistory.totalTokens,
      lastActivityAt: [qoderTasks.lastActivityAt, qoderHistory.lastActivityAt].filter(Boolean).sort().at(-1) || null,
    };
    const activeCodexProvider = providers.find((provider) => provider.agent === 'codex' && provider.active);
    const activeClaudeProvider = providers.find((provider) => provider.agent === 'claude' && provider.active);
    const activeAccount = accounts.find((account) => account.id === store.active_account_id);
    const observedProfiles = [];
    if (activeCodexProvider && activeCodexProvider.category !== 'official') {
      observedProfiles.push(['codex', { id: activeCodexProvider.id, name: activeCodexProvider.name, kind: 'api' }]);
    } else if (activeAccount) {
      observedProfiles.push(['codex', { id: activeAccount.id, name: activeAccount.name || activeAccount.email, kind: authKind(activeAccount.auth_data) === 'chatgpt' ? 'subscription' : 'api' }]);
    } else if (activeCodexProvider) {
      observedProfiles.push(['codex', { id: activeCodexProvider.id, name: activeCodexProvider.name, kind: 'subscription' }]);
    }
    if (activeClaudeProvider) {
      observedProfiles.push(['claude', { id: activeClaudeProvider.id, name: activeClaudeProvider.name, kind: activeClaudeProvider.category === 'official' ? 'subscription' : 'api' }]);
    }
    if (qoder.installed) observedProfiles.push(['qoder', { id: 'qoder-official', name: 'Qoder 当前登录', kind: 'subscription' }]);
    await Promise.all(observedProfiles.map(([agent, profile]) => recordProfile(agent, profile, 'observed')));
    const events = await profileEvents();
    return {
      observedAt: new Date().toISOString(),
      codexSwitcher: {
        available: accounts.length > 0,
        accounts: accounts.map((account) => ({
          ...publicCodexProfile(account, store, usages.get(account.id)),
          lastWarmupAt: safeDate(warmups && warmups.accounts && warmups.accounts[account.id] && warmups.accounts[account.id].lastSuccessAt),
          lastWarmupMode: warmups && warmups.accounts && warmups.accounts[account.id]
            && ['manual', 'automatic'].includes(warmups.accounts[account.id].lastMode)
            ? warmups.accounts[account.id].lastMode : null,
          autoWarmupEnabled: Boolean(warmups && warmups.accounts && warmups.accounts[account.id]
            && warmups.accounts[account.id].autoEnabled),
        })),
      },
      ccSwitch: { available: providers.length > 0, providers },
      qoder: { ...qoder, usage: qoderUsage },
      profileEvents: events,
    };
  }

  async function activateCodex(accountId) {
    if (!validProfileId(accountId)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, '无效的账号 ID');
    }
    const operation = switchQueue.catch(() => {}).then(async () => {
      await recovery;
      const perform = async (switchLocked) => {
        const store = await readJSON(accountsPath);
        if (!store || !Array.isArray(store.accounts)) {
          throw new AppError(ErrorCode.UNSUPPORTED, 'Codex Switcher 尚未配置');
        }
        const target = store.accounts.find((account) => account.id === accountId);
        if (!target) throw new AppError(ErrorCode.VALIDATION_ERROR, '账号不存在', { status: 404 });
        const providers = await ccSwitchProviders(ccSwitchDatabase, runSQLite, null, true);
        const official = providers.find((provider) => provider.agent === 'codex' && provider.category === 'official');
        const previousProvider = providers.find((provider) => provider.agent === 'codex' && provider.active);
        const currentAuth = await readJSON(codexAuthPath);
        const originalStore = structuredClone(store);
        const journal = {
          phase: 'prepared',
          authExisted: currentAuth !== null,
          authSnapshot: currentAuth,
          storeSnapshot: originalStore,
          previousProviderId: previousProvider && previousProvider.id,
        };
        await atomicJSONWrite(accountJournalPath, journal);
        try {
          if (official && !official.active) await switchLocked(official.id);
          const storeChanged = syncActiveTokens(store, currentAuth);
          store.active_account_id = target.id;
          target.last_used_at = new Date().toISOString();
          await atomicJSONWrite(codexAuthPath, authFileFor(target));
          await atomicJSONWrite(accountsPath, store);
          journal.phase = 'committed';
          await atomicJSONWrite(accountJournalPath, journal);
          await unlink(accountJournalPath).catch(() => {});
          usageCache.expiresAt = 0;
          await recordProfile('codex', {
            id: target.id,
            name: target.name || target.email || target.id,
            kind: authKind(target.auth_data) === 'chatgpt' ? 'subscription' : 'api',
          });
          return { accountId: target.id, active: true, preservedRotatedTokens: storeChanged };
        } catch (error) {
          await restoreAccountFiles(journal).catch(() => {});
          if (journal.previousProviderId && (!official || journal.previousProviderId !== official.id)) {
            await switchLocked(journal.previousProviderId).catch(() => {});
          }
          await unlink(accountJournalPath).catch(() => {});
          throw error;
        }
      };
      if (typeof switchProvider.runExclusive === 'function') {
        return switchProvider.runExclusive(perform);
      }
      return perform(switchProvider);
    });
    switchQueue = operation;
    return operation;
  }

  async function warmupCodex(accountId, options = {}) {
    if (!validProfileId(accountId)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, '无效的账号 ID');
    }
    const automatic = options.mode === 'automatic';
    const operation = switchQueue.catch(() => {}).then(async () => {
      await recovery;
      const history = await readWarmupHistory();
      const previous = history.accounts[accountId] || {};
      const previousSuccess = Date.parse(previous.lastSuccessAt || '');
      if (automatic && (!previous.autoEnabled || previous.lastAutoWindowKey === options.windowKey
        || (Number.isFinite(previousSuccess) && Date.now() - previousSuccess < MIN_WARMUP_INTERVAL_MS))) {
        return { accountId, skipped: true, mode: 'automatic' };
      }
      const store = await readJSON(accountsPath);
      if (!store || !Array.isArray(store.accounts)) {
        throw new AppError(ErrorCode.UNSUPPORTED, 'Codex Switcher 尚未配置');
      }
      const currentAuth = await readJSON(codexAuthPath);
      if (syncActiveTokens(store, currentAuth)) await atomicJSONWrite(accountsPath, store);
      const account = store.accounts.find((candidate) => candidate.id === accountId);
      if (!account) throw new AppError(ErrorCode.VALIDATION_ERROR, '账号不存在', { status: 404 });
      const auth = account.auth_data || {};
      if (authKind(auth) !== 'chatgpt') {
        throw new AppError(ErrorCode.UNSUPPORTED, '暖号仅支持 Codex 官方订阅账号');
      }
      if (!auth.access_token) throw new AppError(ErrorCode.VALIDATION_ERROR, '账号缺少访问令牌，请重新登录');

      const headers = {
        authorization: `Bearer ${auth.access_token}`,
        accept: 'application/json, text/plain, */*',
        'accept-language': 'en-US,en;q=0.9',
        'content-type': 'application/json',
        origin: 'https://chatgpt.com',
        referer: 'https://chatgpt.com/',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'user-agent': 'Mozilla/5.0 tmux-web-panel-agent-hub',
      };
      if (auth.account_id) headers['chatgpt-account-id'] = auth.account_id;
      const payload = {
        model: CODEX_WARMUP_MODEL,
        instructions: 'You are Codex.',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply OK' }] }],
        tools: [],
        tool_choice: 'auto',
        parallel_tool_calls: false,
        reasoning: { effort: 'low' },
        store: false,
        stream: true,
      };

      let response;
      try {
        response = await fetchImpl(CHATGPT_CODEX_RESPONSES_URL, {
          method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(30_000),
        });
        await response.text();
      } catch {
        throw new AppError(ErrorCode.INTERNAL, '暖号请求未完成，请稍后重试', { status: 502, retryable: true, action: 'retry' });
      }
      if (!response.ok) {
        const messages = {
          401: '账号登录已过期，请重新登录后再暖号',
          403: '账号无权执行暖号，或请求被上游拒绝',
          429: '账号额度不足或请求过于频繁',
        };
        throw new AppError(ErrorCode.INTERNAL, messages[response.status] || `暖号失败 (${response.status})`, {
          status: response.status === 429 ? 429 : 502,
          retryable: response.status !== 401 && response.status !== 403,
          action: response.status === 401 ? 'login' : 'retry',
        });
      }

      const warmedAt = new Date().toISOString();
      history.accounts[accountId] = {
        ...previous,
        lastSuccessAt: warmedAt,
        lastMode: automatic ? 'automatic' : 'manual',
        model: CODEX_WARMUP_MODEL,
        ...(automatic ? { lastAutoWindowKey: options.windowKey } : {}),
      };
      await atomicJSONWrite(warmupHistoryPath, history);
      usageCache.expiresAt = 0;
      return { accountId, warmedAt, mode: automatic ? 'automatic' : 'manual', model: CODEX_WARMUP_MODEL, consumedQuota: true };
    });
    switchQueue = operation;
    return operation;
  }

  async function configureAutoWarmup(accountId, enabled) {
    if (!validProfileId(accountId) || typeof enabled !== 'boolean') {
      throw new AppError(ErrorCode.VALIDATION_ERROR, '无效的自动暖号配置');
    }
    const operation = switchQueue.catch(() => {}).then(async () => {
      await recovery;
      const store = await readJSON(accountsPath);
      const account = store && Array.isArray(store.accounts)
        ? store.accounts.find((candidate) => candidate.id === accountId) : null;
      if (!account) throw new AppError(ErrorCode.VALIDATION_ERROR, '账号不存在', { status: 404 });
      if (authKind(account.auth_data) !== 'chatgpt') {
        throw new AppError(ErrorCode.UNSUPPORTED, '自动暖号仅支持 Codex 官方订阅账号');
      }
      const history = await readWarmupHistory();
      history.accounts[accountId] = { ...(history.accounts[accountId] || {}), autoEnabled: enabled };
      await atomicJSONWrite(warmupHistoryPath, history);
      if (!enabled) autoWarmupRetryAt.delete(accountId);
      return { accountId, enabled };
    });
    switchQueue = operation;
    return operation;
  }

  async function runAutoWarmups(nowMs = Date.now()) {
    if (autoWarmupRunning) return [];
    autoWarmupRunning = true;
    try {
      await recovery;
      const history = await readWarmupHistory();
      const enabledIds = new Set(Object.entries(history.accounts)
        .filter(([, value]) => value && value.autoEnabled).map(([id]) => id));
      if (!enabledIds.size) return [];
      const store = await readJSON(accountsPath, { accounts: [] });
      const accounts = Array.isArray(store.accounts)
        ? store.accounts.filter((account) => enabledIds.has(account.id) && authKind(account.auth_data) === 'chatgpt') : [];
      const usages = await usageFor(accounts);
      const results = [];
      for (const account of accounts) {
        if ((autoWarmupRetryAt.get(account.id) || 0) > nowMs) continue;
        const windowKey = dueAutoWarmupWindow(usages.get(account.id), history.accounts[account.id], nowMs);
        if (!windowKey) continue;
        try {
          const result = await warmupCodex(account.id, { mode: 'automatic', windowKey });
          autoWarmupRetryAt.delete(account.id);
          if (!result.skipped) results.push(result);
        } catch (error) {
          autoWarmupRetryAt.set(account.id, nowMs + AUTO_WARMUP_RETRY_MS);
          console.warn(`[agent-hub] automatic warm-up failed for ${account.id}: ${error.message || 'unknown error'}`);
        }
      }
      return results;
    } finally {
      autoWarmupRunning = false;
    }
  }

  function startAutoWarmup() {
    if (autoWarmupTimer) return;
    runAutoWarmups().catch(() => {});
    autoWarmupTimer = setInterval(() => { runAutoWarmups().catch(() => {}); }, AUTO_WARMUP_CHECK_MS);
    if (autoWarmupTimer.unref) autoWarmupTimer.unref();
  }

  function stopAutoWarmup() {
    if (autoWarmupTimer) clearInterval(autoWarmupTimer);
    autoWarmupTimer = null;
  }

  async function activateProvider(providerId, agent = 'codex') {
    if (!validProfileId(providerId)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, '无效的供应商 ID');
    }
    if (!['claude', 'codex'].includes(agent)) throw new AppError(ErrorCode.VALIDATION_ERROR, '不支持的 Agent');
    const operation = switchQueue.catch(() => {}).then(async () => {
      await recovery;
      const providers = await ccSwitchProviders(ccSwitchDatabase, runSQLite, null, true);
      const target = providers.find((provider) => provider.id === providerId && provider.agent === agent);
      if (!target) throw new AppError(ErrorCode.VALIDATION_ERROR, `${agent === 'codex' ? 'Codex' : 'Claude'} 供应商不存在`, { status: 404 });
      await (agent === 'codex' ? switchProvider : switchClaudeProvider)(providerId);
      providerUsageCache.expiresAt = 0;
      await recordProfile(agent, {
        id: target.id,
        name: target.name,
        kind: target.category === 'official' ? 'subscription' : 'api',
      });
      return { providerId, agent, active: true };
    });
    switchQueue = operation;
    return operation;
  }

  return {
    status, activateCodex, warmupCodex, configureAutoWarmup, runAutoWarmups,
    startAutoWarmup, stopAutoWarmup, activateProvider, configureQoderSession,
  };
}

export function createAgentHubRouter(service = createAgentHubService()) {
  const router = Router();
  router.use(requireSameOrigin);
  router.get('/', handle((req) => service.status({
    claude: req.query.claude !== '0',
    codex: req.query.codex !== '0',
  })));
  router.post('/codex-switcher/:accountId/activate', handle((req) => service.activateCodex(req.params.accountId)));
  router.post('/codex-switcher/:accountId/warmup', handle((req) => service.warmupCodex(req.params.accountId)));
  router.post('/codex-switcher/:accountId/auto-warmup', handle((req) => service.configureAutoWarmup(
    req.params.accountId, req.body && req.body.enabled,
  )));
  router.post('/providers/:providerId/activate', handle((req) => service.activateProvider(req.params.providerId, req.body && req.body.agent)));
  router.post('/qoder/session', handle((req) => service.configureQoderSession(req.body)));
  return router;
}
