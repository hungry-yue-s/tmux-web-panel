// Codex usage statistics API.
// Reads local Codex session JSONL files. No external API calls are made.

import { Router } from 'express';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CODEX_DIR = join(homedir(), '.codex');
const SESSIONS_DIR = join(CODEX_DIR, 'sessions');

function createCache(ttlMs) {
  let data = null;
  let expiry = 0;
  return {
    get() { return Date.now() < expiry ? data : null; },
    set(value) { data = value; expiry = Date.now() + ttlMs; },
  };
}

const sessionsCache = createCache(60 * 1000);

async function listJsonlFiles(dir) {
  const out = [];
  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        out.push(full);
      }
    }
  }
  await walk(dir);
  return out;
}

function textFromMessageContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => part?.text || part?.input_text?.text || '').join('').trim();
}

function dateKey(iso) {
  return iso ? iso.slice(0, 10) : null;
}

function hourKey(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return String(d.getHours());
}

function parseSessionFile(raw, file) {
  const session = {
    session_id: '',
    file,
    project_path: '',
    start_time: '',
    updated_at: '',
    duration_minutes: 0,
    first_prompt: '',
    model: '',
    cli_version: '',
    source: '',
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    },
    turns: 0,
    tool_counts: {},
    latestRateLimits: null,
    latestRateLimitTs: '',
  };

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = rec.timestamp || '';
    if (ts) {
      if (!session.start_time || ts < session.start_time) session.start_time = ts;
      if (!session.updated_at || ts > session.updated_at) session.updated_at = ts;
    }

    const payload = rec.payload || {};
    if (rec.type === 'session_meta') {
      session.session_id = payload.id || session.session_id;
      session.project_path = payload.cwd || session.project_path;
      session.cli_version = payload.cli_version || session.cli_version;
      session.source = payload.source || session.source;
      session.model = payload.model || session.model;
    }

    if (rec.type === 'turn_context') {
      session.project_path = payload.cwd || session.project_path;
      session.model = payload.model || session.model;
      if (payload.turn_id && !session.session_id) session.session_id = payload.turn_id;
    }

    if (rec.type === 'response_item') {
      if (payload.type === 'message' && payload.role === 'user' && !session.first_prompt) {
        session.first_prompt = textFromMessageContent(payload.content).slice(0, 240);
      }
      if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
        const name = payload.name || 'tool';
        session.tool_counts[name] = (session.tool_counts[name] || 0) + 1;
      }
    }

    if (rec.type === 'event_msg' && payload.type === 'token_count') {
      if (payload.rate_limits) {
        session.latestRateLimits = payload.rate_limits;
        session.latestRateLimitTs = ts;
      }
      const total = payload.info?.total_token_usage;
      if (total) {
        session.turns += 1;
        session.tokenUsage = {
          inputTokens: total.input_tokens || 0,
          outputTokens: total.output_tokens || 0,
          cachedInputTokens: total.cached_input_tokens || 0,
          reasoningTokens: total.reasoning_output_tokens || 0,
          totalTokens: total.total_tokens || 0,
        };
      }
    }
  }

  if (!session.session_id) {
    const match = file.match(/rollout-[^-]+-[^-]+-[^-]+-(.+)\.jsonl$/);
    session.session_id = match ? match[1] : file;
  }
  if (session.start_time && session.updated_at) {
    session.duration_minutes = Math.max(0, Math.round((new Date(session.updated_at) - new Date(session.start_time)) / 60000));
  }
  return session;
}

async function readSessions() {
  const cached = sessionsCache.get();
  if (cached) return cached;

  const files = await listJsonlFiles(SESSIONS_DIR);
  const sessions = [];
  for (const file of files) {
    try {
      const raw = await readFile(file, 'utf8');
      sessions.push(parseSessionFile(raw, file));
    } catch {
      // skip unreadable files
    }
  }

  sessions.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  const dailyMap = {};
  const hourCounts = {};
  const aggregatedTools = {};
  const modelUsage = {};

  let firstDate = null;
  let totalTurns = 0;
  let totalTokens = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCachedTokens = 0;
  let totalReasoningTokens = 0;
  let latestRateLimits = null;
  let latestRateLimitTs = '';

  for (const s of sessions) {
    const dayKey = dateKey(s.start_time);
    if (dayKey) {
      if (!firstDate || dayKey < firstDate) firstDate = dayKey;
      if (!dailyMap[dayKey]) dailyMap[dayKey] = { date: dayKey, sessions: 0, turns: 0, tokens: 0, toolCalls: 0 };
      dailyMap[dayKey].sessions += 1;
      dailyMap[dayKey].turns += s.turns || 0;
      dailyMap[dayKey].tokens += s.tokenUsage.totalTokens || 0;
    }

    const hour = hourKey(s.start_time);
    if (hour != null) hourCounts[hour] = (hourCounts[hour] || 0) + 1;

    const model = s.model || 'unknown';
    if (!modelUsage[model]) {
      modelUsage[model] = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, totalTokens: 0, turns: 0 };
    }
    modelUsage[model].inputTokens += s.tokenUsage.inputTokens || 0;
    modelUsage[model].outputTokens += s.tokenUsage.outputTokens || 0;
    modelUsage[model].cachedInputTokens += s.tokenUsage.cachedInputTokens || 0;
    modelUsage[model].reasoningTokens += s.tokenUsage.reasoningTokens || 0;
    modelUsage[model].totalTokens += s.tokenUsage.totalTokens || 0;
    modelUsage[model].turns += s.turns || 0;

    totalTurns += s.turns || 0;
    totalTokens += s.tokenUsage.totalTokens || 0;
    totalInputTokens += s.tokenUsage.inputTokens || 0;
    totalOutputTokens += s.tokenUsage.outputTokens || 0;
    totalCachedTokens += s.tokenUsage.cachedInputTokens || 0;
    totalReasoningTokens += s.tokenUsage.reasoningTokens || 0;

    for (const [tool, count] of Object.entries(s.tool_counts || {})) {
      aggregatedTools[tool] = (aggregatedTools[tool] || 0) + count;
      if (dayKey && dailyMap[dayKey]) dailyMap[dayKey].toolCalls += count;
    }

    if (s.latestRateLimits && (!latestRateLimitTs || s.latestRateLimitTs > latestRateLimitTs)) {
      latestRateLimits = s.latestRateLimits;
      latestRateLimitTs = s.latestRateLimitTs;
    }
  }

  const result = {
    subscription: {
      type: latestRateLimits?.plan_type || null,
      limitId: latestRateLimits?.limit_id || null,
    },
    utilization: latestRateLimits ? {
      primary: latestRateLimits.primary || null,
      secondary: latestRateLimits.secondary || null,
      credits: latestRateLimits.credits || null,
      rateLimitReachedType: latestRateLimits.rate_limit_reached_type || null,
      observedAt: latestRateLimitTs,
    } : null,
    modelUsage,
    dailyActivity: Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date)),
    hourCounts,
    aggregate: {
      totalSessions: sessions.length,
      totalTurns,
      totalTokens,
      totalInputTokens,
      totalOutputTokens,
      totalCachedTokens,
      totalReasoningTokens,
      firstSessionDate: firstDate,
    },
    recentSessions: sessions.slice(0, 10).map((s) => ({
      session_id: s.session_id,
      project_path: s.project_path,
      start_time: s.start_time,
      updated_at: s.updated_at,
      duration_minutes: s.duration_minutes,
      first_prompt: s.first_prompt,
      model: s.model,
      tokens: s.tokenUsage.totalTokens,
      turns: s.turns,
      tool_counts: s.tool_counts,
    })),
    aggregatedTools,
  };

  sessionsCache.set(result);
  return result;
}

export default function createRouter() {
  const router = Router();

  router.get('/', async (_req, res) => {
    try {
      const data = await readSessions();
      res.json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}
