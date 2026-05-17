// Claude Code usage statistics API.
// Reads local Claude CLI data (credentials, stats, session metadata)
// and optionally fetches live utilization from the Anthropic OAuth API.

import { Router } from 'express';
import { readFile, readdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
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
    sessions.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));

    const recent = sessions.slice(0, 10).map((s) => ({
      session_id: s.sessionId,
      project_path: s.cwd || '',
      start_time: s.startedAt ? new Date(s.startedAt).toISOString() : '',
      updated_at: s.updatedAt ? new Date(s.updatedAt).toISOString() : '',
      duration_minutes: s.startedAt && s.updatedAt ? Math.round((s.updatedAt - s.startedAt) / 60000) : 0,
      version: s.version || '',
    }));

    // Build daily activity + hour counts from session timestamps
    const dailyMap = {};
    const hourCounts = {};
    let firstDate = null;
    for (const s of sessions) {
      if (!s.startedAt) continue;
      const d = new Date(s.startedAt);
      const date = d.toISOString().slice(0, 10);
      if (!firstDate || date < firstDate) firstDate = date;
      if (!dailyMap[date]) dailyMap[date] = { date, sessions: 0, messages: 0, tokens: 0, toolCalls: 0 };
      dailyMap[date].sessions += 1;
      const h = String(d.getHours());
      hourCounts[h] = (hourCounts[h] || 0) + 1;
    }
    const dailyActivity = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));

    // 2. Scan recent conversation JSONL files for tool usage
    const aggregatedTools = {};
    const projDir = join(CLAUDE_DIR, 'projects');
    const projFolders = await readdir(projDir).catch(() => []);
    const allJsonl = [];
    for (const folder of projFolders) {
      const folderPath = join(projDir, folder);
      const files = await readdir(folderPath).catch(() => []);
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        try {
          const s = await stat(join(folderPath, f));
          allJsonl.push({ path: join(folderPath, f), mtime: s.mtimeMs });
        } catch { /* skip */ }
      }
    }
    allJsonl.sort((a, b) => b.mtime - a.mtime);
    const recentJsonl = allJsonl.slice(0, 20);

    for (const { path } of recentJsonl) {
      try {
        const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
        for await (const line of rl) {
          if (!line.includes('"tool_use"')) continue;
          try {
            const rec = JSON.parse(line);
            const content = rec?.message?.content;
            if (!Array.isArray(content)) continue;
            for (const c of content) {
              if (c?.type === 'tool_use' && c.name) {
                aggregatedTools[c.name] = (aggregatedTools[c.name] || 0) + 1;
              }
            }
          } catch { /* skip malformed lines */ }
        }
      } catch { /* skip unreadable files */ }
    }

    // 3. Get code change stats from git across recent project dirs
    let totalLinesAdded = 0, totalLinesRemoved = 0, totalCommits = 0;
    const seenDirs = new Set();
    for (const s of sessions.slice(0, 20)) {
      const dir = s.cwd;
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
      recent, aggregatedTools,
      totalLinesAdded, totalLinesRemoved, totalCommits,
      totalSessions: sessions.length,
      totalMessages: 0,
      firstDate,
      dailyActivity, hourCounts,
    };

    // Enrich from stats-cache.json if available
    try {
      const raw = await readFile(join(CLAUDE_DIR, 'stats-cache.json'), 'utf8');
      const stats = JSON.parse(raw);
      if (stats.totalMessages) result.totalMessages = stats.totalMessages;
      if (stats.totalSessions > result.totalSessions) result.totalSessions = stats.totalSessions;
      if (stats.firstSessionDate) {
        const sd = stats.firstSessionDate.slice(0, 10);
        if (!result.firstDate || sd < result.firstDate) result.firstDate = sd;
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
    const creds = await readCredentials();
    if (!creds || !creds.claudeAiOauth) return;
    const oauth = creds.claudeAiOauth;

    const [utilization, stats, sessionData, ccusage] = await Promise.all([
      fetchUtilization(oauth.accessToken),
      readStatsCache(),
      readSessionsMeta(),
      readCcusageDaily(),
    ]);

    const modelUsage    = stats?.modelUsage || {};
    const estimatedCost = estimateCost(modelUsage);

    latestSnapshot = {
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
    };
  } catch (err) {
    console.error('claude-usage poll error:', err.message);
  }
}

// ── Router factory ───────────────────────────────────────────────────

export default function createRouter() {
  const router = Router();

  // Start background polling immediately
  refreshSnapshot();
  setInterval(refreshSnapshot, POLL_INTERVAL);

  router.get('/', async (_req, res) => {
    if (!latestSnapshot) {
      return res.json({ success: false, error: 'loading' });
    }
    res.json({ success: true, data: latestSnapshot });
  });

  return router;
}
