// Claude Code usage statistics API.
// Reads local Claude CLI data (credentials, stats, session metadata)
// and optionally fetches live utilization from the Anthropic OAuth API.

import { Router } from 'express';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

    for (const s of sessions) {
      if (s.tool_counts) {
        for (const [tool, count] of Object.entries(s.tool_counts)) {
          aggregatedTools[tool] = (aggregatedTools[tool] || 0) + count;
        }
      }
      totalLinesAdded += s.lines_added || 0;
      totalLinesRemoved += s.lines_removed || 0;
      totalCommits += s.git_commits || 0;
    }

    const result = { recent, aggregatedTools, totalLinesAdded, totalLinesRemoved, totalCommits };
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

      // Parallel data fetching
      const [utilization, stats, sessionData] = await Promise.all([
        fetchUtilization(oauth.accessToken),
        readStatsCache(),
        readSessionsMeta(),
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
          dailyActivity:    stats?.dailyActivity || [],
          dailyModelTokens: stats?.dailyModelTokens || [],
          hourCounts:       stats?.hourCounts || {},
          aggregate: {
            totalSessions:    stats?.totalSessions || 0,
            totalMessages:    stats?.totalMessages || 0,
            firstSessionDate: stats?.firstSessionDate || null,
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
