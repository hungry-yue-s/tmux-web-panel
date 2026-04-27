// Claude Code usage statistics API.
// Reads local Claude CLI data (credentials, stats, session metadata)
// and optionally fetches live utilization from the Anthropic OAuth API.

import { Router } from 'express';
import { readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

const utilizationCache = createCache(5 * 60 * 1000);   // 5 min
const statsCache        = createCache(60 * 1000);       // 60 s
const sessionsCache     = createCache(60 * 1000);       // 60 s
const ccusageCache      = createCache(10 * 60 * 1000);  // 10 min (slow command)

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

async function readSessionsMeta() {
  const cached = sessionsCache.get();
  if (cached) return cached;
  try {
    const dir = join(CLAUDE_DIR, 'usage-data', 'session-meta');
    const files = await readdir(dir);
    const jsonFiles = files.filter((f) => f.endsWith('.json'));

    const sessions = [];
    for (const file of jsonFiles) {
      try {
        const raw = await readFile(join(dir, file), 'utf8');
        sessions.push(JSON.parse(raw));
      } catch {
        // skip corrupt files
      }
    }

    // Sort by start_time desc, take top 10
    sessions.sort((a, b) => {
      const ta = a.start_time ? new Date(a.start_time).getTime() : 0;
      const tb = b.start_time ? new Date(b.start_time).getTime() : 0;
      return tb - ta;
    });

    const recent = sessions.slice(0, 10);

    // Aggregate across ALL sessions
    const aggregatedTools = {};
    let totalLinesAdded = 0;
    let totalLinesRemoved = 0;
    let totalCommits = 0;
    let totalMessages = 0;
    const dailyMap = {};
    const hourCounts = {};
    let firstDate = null;

    for (const s of sessions) {
      if (s.tool_counts) {
        for (const [tool, count] of Object.entries(s.tool_counts)) {
          aggregatedTools[tool] = (aggregatedTools[tool] || 0) + count;
        }
      }
      totalLinesAdded += s.lines_added || 0;
      totalLinesRemoved += s.lines_removed || 0;
      totalCommits += s.git_commits || 0;
      totalMessages += (s.user_message_count || 0) + (s.assistant_message_count || 0);

      // Build daily activity from session dates
      const date = s.start_time ? s.start_time.slice(0, 10) : null;
      if (date) {
        if (!firstDate || date < firstDate) firstDate = date;
        if (!dailyMap[date]) dailyMap[date] = { date, sessions: 0, messages: 0, tokens: 0, lines_added: 0, lines_removed: 0, commits: 0 };
        const day = dailyMap[date];
        day.sessions += 1;
        day.messages += (s.user_message_count || 0) + (s.assistant_message_count || 0);
        day.tokens += (s.input_tokens || 0) + (s.output_tokens || 0);
        day.lines_added += s.lines_added || 0;
        day.lines_removed += s.lines_removed || 0;
        day.commits += s.git_commits || 0;
      }

      // Build hour counts from message_hours
      if (Array.isArray(s.message_hours)) {
        for (const h of s.message_hours) {
          hourCounts[String(h)] = (hourCounts[String(h)] || 0) + 1;
        }
      }
    }

    const dailyActivity = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));

    const result = {
      recent, aggregatedTools, totalLinesAdded, totalLinesRemoved, totalCommits,
      totalSessions: sessions.length, totalMessages, firstDate,
      dailyActivity, hourCounts,
    };
    sessionsCache.set(result);
    return result;
  } catch {
    return { recent: [], aggregatedTools: {}, totalLinesAdded: 0, totalLinesRemoved: 0, totalCommits: 0 };
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
    if (!resp.ok) return null;
    const data = await resp.json();
    utilizationCache.set(data);
    return data;
  } catch {
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
    const { stdout } = await execFileAsync('npx', ['ccusage', 'daily', '--json', '--offline'], {
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

// ── Router factory ───────────────────────────────────────────────────

export default function createRouter() {
  const router = Router();

  router.get('/', async (_req, res) => {
    try {
      const creds = await readCredentials();

      if (!creds || !creds.claudeAiOauth) {
        return res.json({ success: false, error: 'not_configured' });
      }

      const oauth = creds.claudeAiOauth;

      // Parallel data fetching (ccusage is slow, don't block on it)
      const [utilization, stats, sessionData, ccusage] = await Promise.all([
        fetchUtilization(oauth.accessToken),
        readStatsCache(),
        readSessionsMeta(),
        readCcusageDaily(),
      ]);

      const modelUsage    = stats?.modelUsage || {};
      const estimatedCost = estimateCost(modelUsage);

      res.json({
        success: true,
        data: {
          subscription: {
            type: oauth.subscriptionType,
            rateLimitTier: oauth.rateLimitTier,
          },
          utilization,
          modelUsage,
          estimatedCost,
          ccusageDaily:     ccusage?.daily || null,
          ccusageTotals:    ccusage?.totals || null,
          dailyActivity:    sessionData.dailyActivity,
          hourCounts:       sessionData.hourCounts,
          aggregate: {
            totalSessions:    sessionData.totalSessions,
            totalMessages:    sessionData.totalMessages,
            firstSessionDate: sessionData.firstDate,
          },
          recentSessions:   sessionData.recent,
          aggregatedTools:  sessionData.aggregatedTools,
          totalLinesAdded:  sessionData.totalLinesAdded,
          totalLinesRemoved: sessionData.totalLinesRemoved,
          totalCommits:     sessionData.totalCommits,
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}
