// Claude Code usage statistics API.
// Reads local Claude CLI data (credentials, stats, session metadata)
// and optionally fetches live utilization from the Anthropic OAuth API.

import { Router } from 'express';
import { readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const execFileAsync = promisify(execFile);

// ── Pricing per 1M tokens ────────────────────────────────────────────

const PRICING = {
  'claude-opus-4-7':            { input: 5.0,  output: 25.0 },
  'claude-opus-4-6':            { input: 5.0,  output: 25.0 },
  'claude-sonnet-4-6':          { input: 3.0,  output: 15.0 },
  'claude-sonnet-4-5-20250929': { input: 3.0,  output: 15.0 },
  'claude-haiku-4-5':           { input: 1.0,  output: 5.0  },
};

// ── Cache helpers ────────────────────────────────────────────────────

function createCache(ttlMs) {
  let data = null;
  let expiry = 0;
  return {
    get()        { return Date.now() < expiry ? data : null; },
    set(value)   { data = value; expiry = Date.now() + ttlMs; },
    clear()      { data = null; expiry = 0; },
  };
}

const POLL_INTERVAL = 5 * 60 * 1000; // 5 min background poll

const utilizationCache = createCache(POLL_INTERVAL + 30_000); // slightly longer than poll
const statsCache        = createCache(30 * 1000);
const sessionsCache     = createCache(30 * 1000);
const ccusageCache      = createCache(POLL_INTERVAL + 30_000);

let latestSnapshot = null; // full assembled response, always served to clients

// ── File readers ─────────────────────────────────────────────────────

const CLAUDE_DIR = join(homedir(), '.claude');

async function readCredentials() {
  try {
    const raw = await readFile(join(CLAUDE_DIR, '.credentials.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readStatsCache() {
  const cached = statsCache.get();
  if (cached) return cached;
  try {
    const raw = await readFile(join(CLAUDE_DIR, 'stats-cache.json'), 'utf8');
    const data = JSON.parse(raw);
    statsCache.set(data);
    return data;
  } catch {
    return null;
  }
}

export async function readClaudeConversation(path) {
  const session = { session_id: basename(path, '.jsonl'), tool_counts: {}, modelUsage: {} };
  const messages = new Map();
  const tools = new Set();
  let first = Infinity;
  let last = 0;
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (!record || !['user', 'assistant'].includes(record.type)) continue;
    session.session_id = record.sessionId || record.session_id || session.session_id;
    session.project_path = record.cwd || session.project_path;
    const timestamp = Date.parse(record.timestamp || '');
    if (Number.isFinite(timestamp)) {
      first = Math.min(first, timestamp);
      last = Math.max(last, timestamp);
    }
    const message = record.message || {};
    const id = message.id || record.uuid || `line-${messages.size}`;
    const previous = messages.get(id) || { type: record.type, model: message.model, usage: {} };
    // Streaming blocks can repeat a message's cumulative usage. Count each
    // message once and retain the largest recorded count for each token kind.
    for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
      previous.usage[key] = Math.max(previous.usage[key] || 0, Number(message.usage?.[key]) || 0);
    }
    messages.set(id, previous);
    for (const content of Array.isArray(message.content) ? message.content : []) {
      if (content?.type !== 'tool_use' || !content.name) continue;
      const toolId = content.id || `${id}:${content.name}`;
      if (tools.has(toolId)) continue;
      tools.add(toolId);
      session.tool_counts[content.name] = (session.tool_counts[content.name] || 0) + 1;
    }
  }
  session.user_message_count = 0;
  session.assistant_message_count = 0;
  for (const message of messages.values()) {
    session[`${message.type}_message_count`] += 1;
    if (message.type !== 'assistant' || !message.model || message.model === '<synthetic>') continue;
    session.model = message.model;
    const usage = session.modelUsage[message.model] ||= { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
    usage.inputTokens += message.usage.input_tokens;
    usage.outputTokens += message.usage.output_tokens;
    usage.cacheReadInputTokens += message.usage.cache_read_input_tokens;
    usage.cacheCreationInputTokens += message.usage.cache_creation_input_tokens;
  }
  session.input_tokens = Object.values(session.modelUsage).reduce((sum, usage) => sum + usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens, 0);
  session.output_tokens = Object.values(session.modelUsage).reduce((sum, usage) => sum + usage.outputTokens, 0);
  if (Number.isFinite(first)) session.start_time = new Date(first).toISOString();
  if (last) session.updated_at = new Date(last).toISOString();
  return session;
}

async function readSessionsMeta() {
  const cached = sessionsCache.get();
  if (cached) return cached;
  try {
    // 1. Read session files for recent sessions + daily activity
    const sessDir = join(CLAUDE_DIR, 'sessions');
    const sessFiles = (await readdir(sessDir).catch(() => [])).filter((f) => f.endsWith('.json'));
    const sessions = [];
    for (const file of sessFiles) {
      try {
        const raw = await readFile(join(sessDir, file), 'utf8');
        sessions.push(JSON.parse(raw));
      } catch { /* skip */ }
    }
    const value = (session, camel, snake) => session[camel] ?? session[snake];
    const millis = (input) => typeof input === 'number' ? input : Date.parse(input || '') || 0;

    // Native conversation logs also exist when Claude uses an API provider
    // without an Anthropic login or stats-cache.json.
    const projDir = join(CLAUDE_DIR, 'projects');
    const byId = new Map(sessions.map((session) => [value(session, 'sessionId', 'session_id'), session]));
    const modelUsage = {};
    for (const folder of await readdir(projDir).catch(() => [])) {
      const folderPath = join(projDir, folder);
      for (const file of await readdir(folderPath).catch(() => [])) {
        if (!file.endsWith('.jsonl')) continue;
        try {
          const conversation = await readClaudeConversation(join(folderPath, file));
          if (!conversation.user_message_count && !conversation.assistant_message_count) continue;
          const existing = byId.get(conversation.session_id);
          if (existing?.modelUsage && millis(value(existing, 'updatedAt', 'updated_at')) > millis(conversation.updated_at)) continue;
          // Prefer recorded conversation counts over transient session metadata.
          const merged = { ...existing, ...conversation };
          for (const key of ['inputTokens', 'outputTokens', 'userMessageCount', 'assistantMessageCount', 'toolCounts', 'startedAt', 'updatedAt']) delete merged[key];
          byId.set(conversation.session_id, merged);
        } catch { /* history can rotate while scanning */ }
      }
    }
    sessions.splice(0, sessions.length, ...byId.values());
    for (const session of sessions) {
      for (const [model, usage] of Object.entries(session.modelUsage || {})) {
        const total = modelUsage[model] ||= { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
        for (const key of Object.keys(total)) total[key] += usage[key];
      }
    }
    sessions.sort((a, b) => millis(value(b, 'startedAt', 'start_time')) - millis(value(a, 'startedAt', 'start_time')));

    const recent = sessions.slice(0, 10).map((s) => {
      const startedAt = millis(value(s, 'startedAt', 'start_time'));
      const updatedAt = millis(value(s, 'updatedAt', 'updated_at'));
      return {
        session_id: value(s, 'sessionId', 'session_id'),
        project_path: value(s, 'cwd', 'project_path') || '',
        start_time: startedAt ? new Date(startedAt).toISOString() : '',
        updated_at: updatedAt ? new Date(updatedAt).toISOString() : '',
        duration_minutes: value(s, 'durationMinutes', 'duration_minutes')
          ?? (startedAt && updatedAt ? Math.round((updatedAt - startedAt) / 60000) : 0),
        version: s.version || '',
        model: s.model || '',
        first_prompt: value(s, 'firstPrompt', 'first_prompt') || '',
        input_tokens: Number(value(s, 'inputTokens', 'input_tokens')) || 0,
        output_tokens: Number(value(s, 'outputTokens', 'output_tokens')) || 0,
      };
    });

    // Build daily activity + hour counts from session timestamps
    const dailyMap = {};
    const hourCounts = {};
    let firstDate = null;
    let totalMessages = 0;
    for (const s of sessions) {
      const startedAt = millis(value(s, 'startedAt', 'start_time'));
      if (!startedAt) continue;
      const d = new Date(startedAt);
      const date = d.toISOString().slice(0, 10);
      if (!firstDate || date < firstDate) firstDate = date;
      if (!dailyMap[date]) dailyMap[date] = { date, sessions: 0, messages: 0, tokens: 0, toolCalls: 0 };
      dailyMap[date].sessions += 1;
      const messages = (Number(value(s, 'userMessageCount', 'user_message_count')) || 0)
        + (Number(value(s, 'assistantMessageCount', 'assistant_message_count')) || 0);
      const tokens = (Number(value(s, 'inputTokens', 'input_tokens')) || 0)
        + (Number(value(s, 'outputTokens', 'output_tokens')) || 0);
      dailyMap[date].messages += messages;
      dailyMap[date].tokens += tokens;
      totalMessages += messages;
      const hours = value(s, 'messageHours', 'message_hours');
      if (Array.isArray(hours) && hours.length) {
        for (const hour of hours) hourCounts[String(hour)] = (hourCounts[String(hour)] || 0) + 1;
      } else {
        const h = String(d.getHours());
        hourCounts[h] = (hourCounts[h] || 0) + 1;
      }
    }
    const dailyActivity = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));

    // 2. Aggregate tool counts from metadata and native conversation logs.
    const aggregatedTools = {};
    for (const session of sessions) {
      const tools = value(session, 'toolCounts', 'tool_counts') || {};
      for (const [name, count] of Object.entries(tools)) {
        aggregatedTools[name] = (aggregatedTools[name] || 0) + (Number(count) || 0);
      }
    }

    // 3. Get code change stats from git across recent project dirs
    let totalLinesAdded = sessions.reduce((sum, s) => sum + (Number(value(s, 'linesAdded', 'lines_added')) || 0), 0);
    let totalLinesRemoved = sessions.reduce((sum, s) => sum + (Number(value(s, 'linesRemoved', 'lines_removed')) || 0), 0);
    let totalCommits = sessions.reduce((sum, s) => sum + (Number(value(s, 'gitCommits', 'git_commits')) || 0), 0);
    const hasMetadataCodeStats = totalLinesAdded > 0 || totalLinesRemoved > 0 || totalCommits > 0;
    const seenDirs = new Set();
    for (const s of hasMetadataCodeStats ? [] : sessions.slice(0, 20)) {
      const dir = value(s, 'cwd', 'project_path');
      if (!dir || seenDirs.has(dir)) continue;
      seenDirs.add(dir);
      try {
        const { stdout } = await execFileAsync('git', ['-C', dir, 'log', '--since=30 days ago', '--format=', '--shortstat'], { timeout: 5000 });
        for (const line of stdout.split('\n')) {
          const m = line.match(/(\d+) files? changed(?:, (\d+) insertions?)?(?:, (\d+) deletions?)?/);
          if (m) {
            totalCommits++;
            totalLinesAdded += parseInt(m[2] || '0', 10);
            totalLinesRemoved += parseInt(m[3] || '0', 10);
          }
        }
      } catch { /* not a git repo or timeout */ }
    }

    const result = {
      recent, aggregatedTools, modelUsage,
      totalLinesAdded, totalLinesRemoved, totalCommits,
      totalSessions: sessions.length,
      totalMessages,
      firstDate,
      dailyActivity, hourCounts,
    };

    // Enrich from stats-cache.json if available
    try {
      const raw = await readFile(join(CLAUDE_DIR, 'stats-cache.json'), 'utf8');
      const stats = JSON.parse(raw);
      if (!result.totalMessages && stats.totalMessages) result.totalMessages = stats.totalMessages;
      if (!result.totalSessions && stats.totalSessions) result.totalSessions = stats.totalSessions;
      if (!result.firstDate && stats.firstSessionDate) {
        const sd = stats.firstSessionDate.slice(0, 10);
        result.firstDate = sd;
      }
    } catch { /* no stats-cache */ }

    sessionsCache.set(result);
    return result;
  } catch {
    return { recent: [], aggregatedTools: {}, totalLinesAdded: 0, totalLinesRemoved: 0, totalCommits: 0, totalSessions: 0, totalMessages: 0, firstDate: null, dailyActivity: [], hourCounts: {} };
  }
}

// ── Utilization fetch ────────────────────────────────────────────────

async function fetchUtilization(accessToken) {
  const cached = utilizationCache.get();
  if (cached) return cached;
  try {
    const resp = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
    });
    if (!resp.ok) {
      console.error('fetchUtilization: HTTP', resp.status);
      return null;
    }
    const data = await resp.json();
    utilizationCache.set(data);
    return data;
  } catch (err) {
    console.error('fetchUtilization error:', err.message);
    return null;
  }
}

// ── Cost estimation ──────────────────────────────────────────────────

function estimateCost(modelUsage) {
  let total = 0;
  for (const [model, usage] of Object.entries(modelUsage)) {
    const price = PRICING[model];
    if (!price) continue;
    const input       = usage.inputTokens || 0;
    const output      = usage.outputTokens || 0;
    const cacheRead   = usage.cacheReadInputTokens || 0;
    const cacheCreate = usage.cacheCreationInputTokens || 0;
    total += (
      input * price.input +
      output * price.output +
      cacheRead * price.input * 0.1 +
      cacheCreate * price.input * 1.25
    ) / 1_000_000;
  }
  return Math.round(total * 100) / 100;
}

// ── ccusage daily data ───────────────────────────────────────────────

let ccusageRunning = false;

async function readCcusageDaily() {
  const cached = ccusageCache.get();
  if (cached) return cached;
  if (ccusageRunning) return null;
  ccusageRunning = true;
  try {
    const { stdout } = await execFileAsync('npx', ['ccusage', 'claude', 'daily', '--json', '--offline'], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    const jsonStr = stdout.replace(/^\[ccusage[^\n]*\n/gm, '');
    const parsed = JSON.parse(jsonStr);
    ccusageCache.set(parsed);
    return parsed;
  } catch {
    return null;
  } finally {
    ccusageRunning = false;
  }
}

function transformCcusageDaily(daily) {
  if (!daily || !Array.isArray(daily)) return null;
  return daily.map((day) => ({
    date: day.period,
    totalCost: day.totalCost || 0,
    totalTokens: day.totalTokens || 0,
    modelBreakdowns: [{
      modelName: (day.modelsUsed || []).join(', '),
      inputTokens: day.inputTokens || 0,
      outputTokens: day.outputTokens || 0,
      cacheCreationTokens: day.cacheCreationTokens || 0,
      cacheReadTokens: day.cacheReadTokens || 0,
    }],
  }));
}

// ── Background poller ────────────────────────────────────────────────

async function refreshSnapshot() {
  try {
    const [creds, stats, sessionData] = await Promise.all([
      readCredentials(), readStatsCache(), readSessionsMeta(),
    ]);
    const oauth = creds?.claudeAiOauth;
    if (!oauth && !sessionData.totalSessions && !Object.keys(stats?.modelUsage || {}).length) {
      latestSnapshot = null;
      return;
    }
    const [utilization, ccusage] = await Promise.all([
      oauth?.accessToken ? fetchUtilization(oauth.accessToken) : null,
      readCcusageDaily(),
    ]);

    const modelUsage = Object.keys(sessionData.modelUsage).length ? sessionData.modelUsage : (stats?.modelUsage || {});
    const tokenTotals = Object.values(modelUsage).reduce((total, usage) => {
      total.totalInputTokens += usage.inputTokens || 0;
      total.totalOutputTokens += usage.outputTokens || 0;
      total.totalCachedTokens += (usage.cacheReadInputTokens || 0) + (usage.cacheCreationInputTokens || 0);
      return total;
    }, { totalInputTokens: 0, totalOutputTokens: 0, totalCachedTokens: 0 });
    const estimatedCost = estimateCost(modelUsage);

    latestSnapshot = {
      subscription: oauth ? {
        type: oauth.subscriptionType,
        rateLimitTier: oauth.rateLimitTier,
      } : null,
      quotaUnavailable: !oauth ? '未登录 Anthropic 官方账号；第三方服务额度请查看对应运行身份' : (!utilization ? '暂时无法读取 Anthropic 官方额度' : null),
      utilization,
      modelUsage,
      estimatedCost,
      ccusageDaily:     ccusage?.daily || null,
      ccusageTotals:    ccusage?.totals || null,
      dailyActivity:    sessionData.dailyActivity,
      hourCounts:       sessionData.hourCounts,
      aggregate: {
        ...tokenTotals,
        totalTokens: tokenTotals.totalInputTokens + tokenTotals.totalOutputTokens + tokenTotals.totalCachedTokens,
        totalSessions:    sessionData.totalSessions,
        totalMessages:    sessionData.totalMessages,
        firstSessionDate: sessionData.firstDate,
      },
      recentSessions:   sessionData.recent,
      aggregatedTools:  sessionData.aggregatedTools,
      totalLinesAdded:  sessionData.totalLinesAdded,
      totalLinesRemoved: sessionData.totalLinesRemoved,
      totalCommits:     sessionData.totalCommits,
    };
  } catch (err) {
    console.error('claude-usage poll error:', err.message);
  }
}

// ── Router factory ───────────────────────────────────────────────────

export default function createRouter() {
  const router = Router();

  // Start background polling immediately
  const initialRefresh = refreshSnapshot();
  const poller = setInterval(refreshSnapshot, POLL_INTERVAL);
  poller.unref?.();

  router.get('/', async (_req, res) => {
    await initialRefresh;
    if (!latestSnapshot) {
      const credentials = await readCredentials();
      return res.json({ success: false, error: credentials && credentials.claudeAiOauth ? 'loading' : 'not_configured' });
    }
    res.json({ success: true, data: latestSnapshot });
  });

  return router;
}
