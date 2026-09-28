import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAgentHubService } from '../../server/api/agent-hub.js';

const roots = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tmux-agent-hub-'));
  roots.push(root);
  const accountsPath = join(root, '.codex-switcher', 'accounts.json');
  const codexAuthPath = join(root, '.codex', 'auth.json');
  const qoderTasksPath = join(root, '.qoder', 'tasks');
  const qoderProjectsPath = join(root, '.qoder', 'projects');
  const qoderSessionPath = join(root, '.config', 'tmux-web-panel', 'qoder-session.json');
  const profileEventsPath = join(root, '.config', 'tmux-web-panel', 'agent-profile-events.json');
  const warmupHistoryPath = join(root, '.config', 'tmux-web-panel', 'agent-warmups.json');
  await mkdir(join(qoderTasksPath, 'task-one'), { recursive: true });
  await mkdir(join(qoderProjectsPath, '-Users-test-work'), { recursive: true });
  await writeFile(join(qoderProjectsPath, '-Users-test-work', 'session-one.jsonl'), [
    JSON.stringify({ type: 'user', cwd: '/Users/test/work', sessionId: 'session-one', timestamp: '2026-09-20T10:00:00Z' }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-09-20T10:02:00Z', message: { model: 'qoder-model', usage: { input_tokens: 120, output_tokens: 30 } } }),
  ].join('\n'));
  await mkdir(join(root, '.codex-switcher'), { recursive: true });
  await mkdir(join(root, '.codex'), { recursive: true });
  const accounts = {
    version: 1,
    active_account_id: 'acct-a',
    masked_account_ids: [],
    accounts: [
      {
        id: 'acct-a', name: 'Work', email: 'work@example.test', plan_type: 'team',
        auth_data: {
          type: 'chat_g_p_t', account_id: 'chat-a', id_token: 'old-id-a',
          access_token: 'old-access-a', refresh_token: 'old-refresh-a',
        },
      },
      {
        id: 'acct-b', name: 'Personal', email: 'personal@example.test', plan_type: 'plus',
        auth_data: {
          type: 'chat_g_p_t', account_id: 'chat-b', id_token: 'id-b',
          access_token: 'access-b', refresh_token: 'refresh-b',
        },
      },
    ],
  };
  await writeFile(accountsPath, JSON.stringify(accounts));
  await writeFile(codexAuthPath, JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      account_id: 'chat-a', id_token: 'rotated-id-a',
      access_token: 'rotated-access-a', refresh_token: 'rotated-refresh-a',
    },
  }));
  return { root, accountsPath, codexAuthPath, qoderTasksPath, qoderProjectsPath, qoderSessionPath, profileEventsPath, warmupHistoryPath };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Agent hub service', () => {
  it('returns only public account/provider metadata and sanitized live quotas', async () => {
    const paths = await fixture();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        plan_type: 'plus',
        rate_limit: {
          primary_window: { used_percent: 27, limit_window_seconds: 18000, reset_at: 1900000000 },
          secondary_window: { used_percent: 41, limit_window_seconds: 604800, reset_at: 1900100000 },
        },
        credits: { has_credits: true, unlimited: false, balance: 12.5 },
      }),
    });
    const runSQLite = vi.fn().mockResolvedValue(JSON.stringify([
      { id: 'glm', app_type: 'codex', name: 'Zhipu GLM', category: 'cn_official', is_current: 0, in_failover_queue: 1 },
    ]));
    const service = createAgentHubService({ ...paths, fetchImpl, runSQLite });

    const status = await service.status();
    expect(status.codexSwitcher.accounts).toHaveLength(2);
    expect(status.codexSwitcher.accounts[0].usage.primary.usedPercent).toBe(27);
    expect(status.ccSwitch.providers[0]).toMatchObject({ name: 'Zhipu GLM', failover: true });
    expect(status.qoder).toMatchObject({ installed: true, taskCount: 1 });
    expect(status.qoder.recentSessions[0]).toMatchObject({
      session_id: 'session-one', project_path: '/Users/test/work', model: 'qoder-model', tokens: 150, messages: 2,
    });
    expect(status.qoder).toMatchObject({ totalSessions: 1, totalMessages: 2, totalTokens: 150 });
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain('access-b');
    expect(serialized).not.toContain('refresh-b');
    expect(serialized).not.toContain('id_token');
  });

  it('preserves rotated credentials before atomically activating another Codex account', async () => {
    const paths = await fixture();
    const service = createAgentHubService({
      ...paths,
      fetchImpl: vi.fn(),
      runSQLite: vi.fn().mockResolvedValue('[]'),
    });

    const result = await service.activateCodex('acct-b');
    expect(result).toMatchObject({ accountId: 'acct-b', active: true, preservedRotatedTokens: true });

    const store = JSON.parse(await readFile(paths.accountsPath, 'utf8'));
    expect(store.active_account_id).toBe('acct-b');
    expect(store.accounts[0].auth_data).toMatchObject({
      access_token: 'rotated-access-a', refresh_token: 'rotated-refresh-a', id_token: 'rotated-id-a',
    });
    const auth = JSON.parse(await readFile(paths.codexAuthPath, 'utf8'));
    expect(auth.tokens).toMatchObject({ account_id: 'chat-b', access_token: 'access-b', refresh_token: 'refresh-b' });
  });

  it('manually warms one OAuth account with its latest active token and records only public metadata', async () => {
    const paths = await fixture();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => 'data: [DONE]' });
    const service = createAgentHubService({
      ...paths,
      fetchImpl,
      runSQLite: vi.fn().mockResolvedValue('[]'),
    });

    const result = await service.warmupCodex('acct-a');
    expect(result).toMatchObject({ accountId: 'acct-a', model: 'gpt-5.6-luna', consumedQuota: true });
    expect(JSON.stringify(result)).not.toMatch(/rotated-access|rotated-refresh/);
    const [url, request] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(request).toMatchObject({ method: 'POST' });
    expect(request.headers.authorization).toBe('Bearer rotated-access-a');
    expect(request.headers['chatgpt-account-id']).toBe('chat-a');
    expect(JSON.parse(request.body)).toMatchObject({
      model: 'gpt-5.6-luna', stream: true, store: false, reasoning: { effort: 'low' },
    });
    const history = JSON.parse(await readFile(paths.warmupHistoryPath, 'utf8'));
    expect(history.accounts['acct-a']).toMatchObject({ model: 'gpt-5.6-luna' });
    expect(JSON.stringify(history)).not.toMatch(/rotated-access|rotated-refresh/);
  });

  it('switches an API provider through the embedded adapter', async () => {
    const paths = await fixture();
    const switchProvider = vi.fn().mockResolvedValue({ active: true });
    const runSQLite = vi.fn().mockResolvedValue(JSON.stringify([
      { id: 'glm', app_type: 'codex', name: 'Zhipu GLM', category: 'cn_official', is_current: 0 },
    ]));
    const service = createAgentHubService({ ...paths, fetchImpl: vi.fn(), runSQLite, switchProvider });

    await expect(service.activateProvider('glm')).resolves.toMatchObject({ providerId: 'glm', active: true });
    expect(switchProvider).toHaveBeenCalledWith('glm');
    await expect(service.activateProvider('../bad')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('reads Qoder credits and Zhipu quota/balance without exposing credentials', async () => {
    const paths = await fixture();
    await mkdir(join(paths.root, '.config', 'tmux-web-panel'), { recursive: true });
    await writeFile(paths.qoderSessionPath, JSON.stringify({ site: 'international', cookieHeader: 'session=private-cookie' }));
    const fetchImpl = vi.fn(async (url) => {
      if (url.includes('qoder.com')) return { ok: true, json: async () => ({
        totalQuota: { quotaSummary: { usedValue: 20, limitValue: 100 } },
        nextResetAt: '2026-10-01T00:00:00Z',
      }) };
      if (url.includes('query-customer')) return { ok: true, json: async () => ({
        success: true, data: { availableBalance: 42.5, totalSpendAmount: 9.5 },
      }) };
      if (url.includes('open.bigmodel.cn')) return { ok: true, json: async () => ({
        success: true, code: 200, data: { limits: [{
          type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 100, remaining: 70, percentage: 30, nextResetTime: 1900000000000,
        }] },
      }) };
      return { ok: true, json: async () => ({ rate_limit: {} }) };
    });
    const runSQLite = vi.fn().mockResolvedValue(JSON.stringify([{
      id: 'glm', app_type: 'codex', name: 'Zhipu GLM', category: 'cn_official', is_current: 1,
      settings_config: JSON.stringify({ auth: { OPENAI_API_KEY: 'private-zhipu-key' } }),
    }]));
    const service = createAgentHubService({ ...paths, fetchImpl, runSQLite });

    const status = await service.status();
    expect(status.qoder.usage).toMatchObject({ usedCredits: 20, totalCredits: 100, usedPercent: 20 });
    expect(status.ccSwitch.providers[0].usage).toMatchObject({ balance: 42.5, spent: 9.5 });
    expect(status.ccSwitch.providers[0].usage.primary.usedPercent).toBe(30);
    expect(JSON.stringify(status)).not.toContain('private-cookie');
    expect(JSON.stringify(status)).not.toContain('private-zhipu-key');
  });

  it('switches Claude providers and records a profile event', async () => {
    const paths = await fixture();
    const switchClaudeProvider = vi.fn().mockResolvedValue({ active: true });
    const runSQLite = vi.fn().mockResolvedValue(JSON.stringify([
      { id: 'claude-official', app_type: 'claude', name: 'Claude Official', category: 'official', is_current: 0 },
    ]));
    const service = createAgentHubService({ ...paths, fetchImpl: vi.fn(), runSQLite, switchClaudeProvider });

    await expect(service.activateProvider('claude-official', 'claude')).resolves.toMatchObject({ agent: 'claude', active: true });
    expect(switchClaudeProvider).toHaveBeenCalledWith('claude-official');
    const ledger = JSON.parse(await readFile(paths.profileEventsPath, 'utf8'));
    expect(ledger.events.at(-1)).toMatchObject({ agent: 'claude', profileId: 'claude-official', profileKind: 'subscription' });
  });

  it('stores Qoder session configuration with restrictive local persistence', async () => {
    const paths = await fixture();
    const service = createAgentHubService({ ...paths, fetchImpl: vi.fn(), runSQLite: vi.fn().mockResolvedValue('[]') });
    await expect(service.configureQoderSession({ cookieHeader: 'session=test', site: 'china' }))
      .resolves.toEqual({ configured: true, site: 'china' });
    const stored = JSON.parse(await readFile(paths.qoderSessionPath, 'utf8'));
    expect(stored).toEqual({ site: 'china', cookieHeader: 'session=test' });
    await expect(service.configureQoderSession({ cookieHeader: 'bad\nvalue' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('skips disabled Agent data sources instead of fetching them in the background', async () => {
    const paths = await fixture();
    const fetchImpl = vi.fn();
    const runSQLite = vi.fn();
    const service = createAgentHubService({ ...paths, fetchImpl, runSQLite });

    const status = await service.status({ claude: false, codex: false });
    expect(status.codexSwitcher.accounts).toEqual([]);
    expect(status.ccSwitch.providers).toEqual([]);
    expect(status.qoder.installed).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(runSQLite).not.toHaveBeenCalled();
  });

});
