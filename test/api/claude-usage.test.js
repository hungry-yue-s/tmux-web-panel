import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import http from 'node:http';

// ── helpers ──────────────────────────────────────────────────────────

function makeApp(createRouter) {
  const app = express();
  app.use('/api/claude-usage', createRouter());
  return app;
}

function get(app, path) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      http.get(`http://localhost:${port}${path}`, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        });
      }).on('error', (err) => {
        server.close();
        reject(err);
      });
    });
  });
}

// ── mock data ────────────────────────────────────────────────────────

const FAKE_CREDENTIALS = {
  claudeAiOauth: {
    accessToken: 'sk-ant-fake-token-for-testing',
    refreshToken: 'sk-ant-fake-refresh',
    expiresAt: Date.now() + 3_600_000,
    scopes: ['user:inference'],
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_20x',
  },
};

const FAKE_STATS_CACHE = {
  version: 2,
  lastComputedDate: '2026-04-20',
  dailyActivity: [
    { date: '2026-04-20', messageCount: 100, sessionCount: 3, toolCallCount: 50 },
  ],
  dailyModelTokens: [
    { date: '2026-04-20', tokensByModel: { 'claude-opus-4-6': 5000 } },
  ],
  modelUsage: {
    'claude-opus-4-6': {
      inputTokens: 1000,
      outputTokens: 2000,
      cacheReadInputTokens: 500000,
      cacheCreationInputTokens: 100000,
    },
  },
  hourCounts: { '15': 5, '16': 3 },
  totalSessions: 10,
  totalMessages: 200,
  firstSessionDate: '2026-04-01T00:00:00.000Z',
};

const FAKE_USAGE_API_RESPONSE = {
  five_hour: { limit: 1000, remaining: 800, reset_at: '2026-04-20T20:00:00Z' },
  seven_day: { limit: 10000, remaining: 7000 },
  seven_day_sonnet: { limit: 50000, remaining: 40000 },
  extra_usage: { enabled: false },
};

function makeFakeSession(id, startTime) {
  return {
    session_id: id,
    project_path: '/home/user/project',
    start_time: startTime,
    duration_minutes: 30,
    input_tokens: 500,
    output_tokens: 1000,
    lines_added: 20,
    lines_removed: 5,
    git_commits: 1,
    first_prompt: 'test prompt',
    tool_counts: { Bash: 10, Read: 5 },
    languages: { JavaScript: 3 },
  };
}

// ── tests ────────────────────────────────────────────────────────────

describe('GET /api/claude-usage', () => {
  let mockReadFile;
  let mockReaddir;
  let mockFetch;

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();

    // Set up fs/promises mock
    mockReadFile = vi.fn();
    mockReaddir = vi.fn();

    vi.doMock('node:fs/promises', () => ({
      readFile: mockReadFile,
      readdir: mockReaddir,
    }));

    // Set up global.fetch mock
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  it('should return full data when all sources are available', async () => {
    // Arrange
    const session1 = makeFakeSession('sess-1', '2026-04-20T10:00:00Z');
    const session2 = makeFakeSession('sess-2', '2026-04-20T08:00:00Z');

    mockReadFile.mockImplementation((path) => {
      if (path.includes('.credentials.json')) {
        return Promise.resolve(JSON.stringify(FAKE_CREDENTIALS));
      }
      if (path.includes('stats-cache.json')) {
        return Promise.resolve(JSON.stringify(FAKE_STATS_CACHE));
      }
      if (path.includes('sess-1.json')) {
        return Promise.resolve(JSON.stringify(session1));
      }
      if (path.includes('sess-2.json')) {
        return Promise.resolve(JSON.stringify(session2));
      }
      return Promise.reject(new Error('ENOENT'));
    });

    mockReaddir.mockResolvedValue(['sess-1.json', 'sess-2.json']);

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(FAKE_USAGE_API_RESPONSE),
    });

    // Act
    const { default: createRouter } = await import('../../server/api/claude-usage.js');
    const app = makeApp(createRouter);
    const res = await get(app, '/api/claude-usage');

    // Assert
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const data = res.body.data;

    // Subscription
    expect(data.subscription.type).toBe('max');
    expect(data.subscription.rateLimitTier).toBe('default_claude_max_20x');

    // Utilization from API
    expect(data.utilization).toEqual(FAKE_USAGE_API_RESPONSE);

    // Model usage
    expect(data.modelUsage['claude-opus-4-6'].inputTokens).toBe(1000);

    // Estimated cost > 0
    expect(data.estimatedCost).toBeGreaterThan(0);

    // Daily activity
    expect(data.dailyActivity).toHaveLength(1);
    expect(data.dailyActivity[0].date).toBe('2026-04-20');

    // Daily model tokens
    expect(data.dailyModelTokens).toHaveLength(1);

    // Hour counts
    expect(data.hourCounts['15']).toBe(5);

    // Aggregate
    expect(data.aggregate.totalSessions).toBe(10);
    expect(data.aggregate.totalMessages).toBe(200);
    expect(data.aggregate.firstSessionDate).toBe('2026-04-01T00:00:00.000Z');

    // Recent sessions (sorted by start_time desc)
    expect(data.recentSessions).toHaveLength(2);
    expect(data.recentSessions[0].session_id).toBe('sess-1'); // more recent

    // Aggregated tools
    expect(data.aggregatedTools.Bash).toBe(20); // 10 * 2 sessions
    expect(data.aggregatedTools.Read).toBe(10);

    // Totals
    expect(data.totalLinesAdded).toBe(40); // 20 * 2
    expect(data.totalLinesRemoved).toBe(10); // 5 * 2
    expect(data.totalCommits).toBe(2); // 1 * 2

    // Security: access token must NOT appear in response
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain('sk-ant-fake-token-for-testing');
    expect(bodyStr).not.toContain('accessToken');
  });

  it('should return not_configured when credentials.json is missing', async () => {
    // Arrange
    mockReadFile.mockImplementation((path) => {
      if (path.includes('.credentials.json')) {
        return Promise.reject(new Error('ENOENT: no such file'));
      }
      return Promise.resolve('{}');
    });
    mockReaddir.mockResolvedValue([]);

    // Act
    const { default: createRouter } = await import('../../server/api/claude-usage.js');
    const app = makeApp(createRouter);
    const res = await get(app, '/api/claude-usage');

    // Assert
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('not_configured');
  });

  it('should return utilization=null when OAuth API fails, rest of data present', async () => {
    // Arrange
    const session1 = makeFakeSession('sess-1', '2026-04-20T10:00:00Z');

    mockReadFile.mockImplementation((path) => {
      if (path.includes('.credentials.json')) {
        return Promise.resolve(JSON.stringify(FAKE_CREDENTIALS));
      }
      if (path.includes('stats-cache.json')) {
        return Promise.resolve(JSON.stringify(FAKE_STATS_CACHE));
      }
      if (path.includes('sess-1.json')) {
        return Promise.resolve(JSON.stringify(session1));
      }
      return Promise.reject(new Error('ENOENT'));
    });

    mockReaddir.mockResolvedValue(['sess-1.json']);

    // API failure
    mockFetch.mockRejectedValue(new Error('Network error'));

    // Act
    const { default: createRouter } = await import('../../server/api/claude-usage.js');
    const app = makeApp(createRouter);
    const res = await get(app, '/api/claude-usage');

    // Assert
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const data = res.body.data;

    // Utilization should be null (graceful fallback)
    expect(data.utilization).toBeNull();

    // But all other data should still be present
    expect(data.subscription.type).toBe('max');
    expect(data.modelUsage['claude-opus-4-6']).toBeDefined();
    expect(data.estimatedCost).toBeGreaterThan(0);
    expect(data.dailyActivity).toHaveLength(1);
    expect(data.aggregate.totalSessions).toBe(10);
    expect(data.recentSessions).toHaveLength(1);
    expect(data.aggregatedTools.Bash).toBe(10);
    expect(data.totalLinesAdded).toBe(20);
    expect(data.totalLinesRemoved).toBe(5);
    expect(data.totalCommits).toBe(1);
  });
});
