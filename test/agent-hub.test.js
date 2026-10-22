import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const SOURCE = readFileSync('public/js/agent-hub.js', 'utf8');

function loadHub(data = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', {
    url: 'http://localhost:7681/#/servers/local/agents',
    runScripts: 'outside-only',
  });
  const win = dom.window;
  win.Router = { serialize: () => '#/servers/local/agents' };
  win.Api = {
    get: vi.fn(async (path) => {
      if (path === '/api/agent-hub') return data.hub || { codexSwitcher: { accounts: [] }, ccSwitch: { providers: [] }, qoder: {} };
      if (path === '/api/claude-usage') {
        if (data.claudeError) throw new Error(data.claudeError);
        return data.claude || {};
      }
      if (path === '/api/codex-usage') return data.codex || {};
      return {};
    }),
    post: vi.fn(async () => ({})),
  };
  win.AppShell = { toast: vi.fn() };
  if (data.ui) win.Store = { getState: () => ({ ui: data.ui }) };
  win.eval(SOURCE);
  win.document.getElementById('host').innerHTML = win.AgentHub.renderSkeleton();
  return { dom, win, hub: win.AgentHub };
}

describe('AgentHub', () => {
  it('switches DSH between existing native models and the shared enterprise pool in the same view', async () => {
    const { win, hub } = loadHub({ hub: {
      dsh: { installed: true, version: '0.16.1', backend: 'dsh', provider: 'tmux-enterprise', model: 'mode-auto', enterpriseModelId: 'mode-auto',
        profiles: [{ provider: 'glm', model: 'glm-test', name: 'GLM', providerName: 'Coding Plan' }] },
      enterprise: { available: true, pools: [{ id: 'enterprise', name: '集团 AI 资源包', usage: { usedCredits: 10, totalCredits: 100, remainingCredits: 90, usedPercent: 10 } }],
        tokenSwitch: { loggedIn: true, canSwitchInPanel: true, models: [
          { id: 'mode-auto', app: 'codex', name: 'Auto', meta: { managedCatalog: { multiplier: 1 } } },
          { id: 'mode-base', app: 'codex', name: '基础', meta: { managedCatalog: { multiplier: 0.1 } } },
        ] } },
    } });
    win.showConfirm = vi.fn().mockResolvedValue(true);
    hub.start();
    await new Promise((resolve) => win.setTimeout(resolve, 0));
    win.document.querySelector('[data-agent-id="dsh"]').click();
    expect(win.document.querySelector('.section-head h3').textContent).toBe('dsh-tui 运行身份');
    expect(win.document.querySelector('.ah-current-profile').textContent).toContain('Auto');
    expect(win.document.getElementById('agent-hub').textContent).toContain('集团 AI 资源包');
    win.document.querySelector('[data-ah-action="activate-managed"]').click();
    await new Promise((resolve) => win.setTimeout(resolve, 0));
    expect(win.Api.post).toHaveBeenCalledWith('/api/agent-hub/enterprise/models/mode-base/activate', { agent: 'dsh' });
    win.document.querySelector('[data-ah-action="activate-dsh"]').click();
    await new Promise((resolve) => win.setTimeout(resolve, 0));
    expect(win.Api.post).toHaveBeenCalledWith('/api/agent-hub/dsh/models/activate', { provider: 'glm', model: 'glm-test' });
    hub.stop();
  });

  it('uses one focused URL that opens as a browser tab or a Swift child window', () => {
    const { hub } = loadHub();
    expect(hub._detachedURL()).toBe('http://localhost:7681/?standalone=agents#/servers/local/agents');
  });

  it('treats background indexing as a soft state instead of a panel error', async () => {
    const { win, hub } = loadHub({ claudeError: 'loading' });
    hub.start();
    await new Promise((resolve) => win.setTimeout(resolve, 0));
    expect(win.document.querySelector('.ah-error')).toBeNull();
    hub.stop();
  });

  it('renders agents and normalizes accounts and providers as peer runtime profiles', async () => {
    const { win, hub } = loadHub({
      hub: {
        codexSwitcher: { accounts: [{
          id: 'acct-1', name: 'Work', email: 'hidden@example.com', masked: true, authKind: 'chatgpt', active: true,
          usage: { primary: { usedPercent: 20 }, secondary: { usedPercent: 40 } },
        }] },
        ccSwitch: { providers: [{ id: 'glm', agent: 'codex', name: 'Zhipu GLM', category: 'cn_official', active: false }] },
        qoder: { installed: true, taskCount: 12, lastActivityAt: new Date().toISOString() },
      },
      claude: { subscription: { type: 'max' }, aggregate: { totalSessions: 7, totalMessages: 20 } },
      codex: {
        aggregate: { totalSessions: 2, totalTokens: 12345 },
        recentSessions: [{ project_path: '/tmp/demo', start_time: new Date().toISOString(), model: 'gpt-5.5', tokens: 1234 }],
      },
    });

    hub.start();
    await new Promise((resolve) => win.setTimeout(resolve, 0));
    const text = win.document.getElementById('agent-hub').textContent;
    expect(text).toContain('Claude');
    expect(text).toContain('Codex');
    expect(text).toContain('Qoder');
    expect(text).toContain('Work');
    expect(text).toContain('Zhipu GLM');
    expect(text).toContain('官方订阅与 API 服务使用同一个切换入口');
    expect(text).toContain('额度 跟随运行身份');
    expect(text).toContain('运行身份未记录');
    expect(win.document.querySelector('[data-ah-action="activate-provider"]')).toBeTruthy();
    expect(text).not.toContain('hidden@example.com');
    expect(text).not.toMatch(/access_token|refresh_token|api[_ -]?key/i);
    hub.stop();
  });

  it('changes the detail view when an Agent card is selected', async () => {
    const { win, hub } = loadHub({
      hub: {
        codexSwitcher: { accounts: [{ id: 'acct', name: 'Codex Work', active: true, usage: {} }] },
        ccSwitch: { providers: [] },
        qoder: { installed: true, taskCount: 3 },
      },
      claude: { subscription: { type: 'max' }, aggregate: { totalSessions: 1 } },
    });
    hub.start();
    await new Promise((resolve) => win.setTimeout(resolve, 0));
    expect(win.document.querySelector('.section-head h3').textContent).toBe('Codex 运行身份');
    win.document.querySelector('[data-agent-id="claude"]').click();
    expect(win.document.querySelector('.section-head h3').textContent).toBe('Claude 运行身份');
    expect(win.document.getElementById('agent-hub').textContent).toContain('Anthropic 官方订阅');
    hub.stop();
  });

  it('routes account and API provider cards through the same switch interaction', async () => {
    const { win, hub } = loadHub({
      hub: {
        codexSwitcher: { accounts: [{ id: 'acct', name: 'Account', active: false, usage: {} }] },
        ccSwitch: { providers: [{ id: 'glm', agent: 'codex', name: 'Zhipu GLM', category: 'cn_official', active: false }] },
        qoder: {},
      },
    });
    win.showConfirm = vi.fn().mockResolvedValue(true);
    hub.start();
    await new Promise((resolve) => win.setTimeout(resolve, 0));
    win.document.querySelector('[data-ah-action="activate-provider"]').click();
    await new Promise((resolve) => win.setTimeout(resolve, 0));
    expect(win.Api.post).toHaveBeenCalledWith('/api/agent-hub/providers/glm/activate', { agent: 'codex' });
    hub.stop();
  });

  it('requires confirmation before warming one Codex OAuth account', async () => {
    const { win, hub } = loadHub({
      hub: {
        codexSwitcher: { accounts: [{ id: 'acct', name: 'Weekly', authKind: 'chatgpt', active: true, usage: {} }] },
        ccSwitch: { providers: [] }, qoder: {},
      },
    });
    win.showConfirm = vi.fn().mockResolvedValue(true);
    hub.start();
    await new Promise((resolve) => win.setTimeout(resolve, 0));
    win.document.querySelector('[data-ah-action="warmup-account"]').click();
    await new Promise((resolve) => win.setTimeout(resolve, 0));
    expect(win.showConfirm.mock.calls[0][0].message).toContain('消耗该账号的周额度');
    expect(win.Api.post).toHaveBeenCalledWith('/api/agent-hub/codex-switcher/acct/warmup');
    hub.stop();
  });

  it('requires confirmation before enabling per-account automatic warm-up', async () => {
    const { win, hub } = loadHub({
      hub: {
        codexSwitcher: { accounts: [{ id: 'acct', name: 'Weekly', authKind: 'chatgpt', active: true, usage: {} }] },
        ccSwitch: { providers: [] }, qoder: {},
      },
    });
    win.showConfirm = vi.fn().mockResolvedValue(true);
    hub.start();
    await new Promise((resolve) => win.setTimeout(resolve, 0));
    win.document.querySelector('[data-ah-action="toggle-auto-warmup"]').click();
    await new Promise((resolve) => win.setTimeout(resolve, 0));
    expect(win.showConfirm.mock.calls[0][0].message).toContain('页面关闭');
    expect(win.Api.post).toHaveBeenCalledWith('/api/agent-hub/codex-switcher/acct/auto-warmup', { enabled: true });
    hub.stop();
  });

  it('treats Zhipu Coding Plan as a subscription with provider warm-up controls', async () => {
    const { win, hub } = loadHub({
      hub: {
        codexSwitcher: { accounts: [] },
        ccSwitch: { providers: [{
          id: 'glm', agent: 'codex', name: 'Zhipu GLM', category: 'cn_official', active: true,
          autoWarmupEnabled: false,
          usage: {
            primary: { usedPercent: 0, windowMinutes: 300 },
            secondary: { usedPercent: 20, windowMinutes: 10080 },
          },
        }] },
        qoder: {},
      },
    });
    win.showConfirm = vi.fn().mockResolvedValue(true);
    hub.start();
    await new Promise((resolve) => win.setTimeout(resolve, 0));

    const card = win.document.querySelector('.ah-profile-card');
    expect(card.textContent).toContain('智谱 Coding Plan');
    expect(card.textContent).toContain('5 小时');
    expect(card.textContent).toContain('周额度');
    win.document.querySelector('[data-ah-action="warmup-provider"]').click();
    await new Promise((resolve) => win.setTimeout(resolve, 0));
    expect(win.showConfirm.mock.calls[0][0].message).toContain('5 小时与周订阅额度');
    expect(win.Api.post).toHaveBeenCalledWith('/api/agent-hub/providers/glm/warmup');

    win.document.querySelector('[data-ah-action="toggle-auto-warmup"]').click();
    await new Promise((resolve) => win.setTimeout(resolve, 0));
    expect(win.showConfirm.mock.calls[1][0].message).toContain('5 小时订阅窗口');
    expect(win.Api.post).toHaveBeenCalledWith('/api/agent-hub/providers/glm/auto-warmup', { enabled: true });
    hub.stop();
  });

  it('keeps a stored Claude official profile switchable and renders Qoder sessions', async () => {
    const { win, hub } = loadHub({
      hub: {
        codexSwitcher: { accounts: [] },
        ccSwitch: { providers: [
          { id: 'claude-api', agent: 'claude', name: 'Claude API', category: 'custom', active: true },
          { id: 'claude-official', agent: 'claude', name: 'Claude Official', category: 'official', active: false },
        ] },
        qoder: {
          installed: true, taskCount: 1, totalSessions: 1, totalTokens: 150,
          recentSessions: [{ project_path: '/tmp/qoder-demo', start_time: new Date().toISOString(), model: 'qoder-model', tokens: 150 }],
        },
      },
      claude: { subscription: { type: 'max' }, aggregate: { totalSessions: 1 } },
    });
    hub.start();
    await new Promise((resolve) => win.setTimeout(resolve, 0));
    win.document.querySelector('[data-agent-id="claude"]').click();
    const official = win.document.querySelector('[data-provider-id="claude-official"]');
    expect(official).toBeTruthy();
    expect(official.dataset.agentId).toBe('claude');
    win.document.querySelector('[data-agent-id="qoder"]').click();
    expect(win.document.getElementById('agent-hub').textContent).toContain('qoder-demo');
    expect(win.document.getElementById('agent-hub').textContent).toContain('150 tokens');
    hub.stop();
  });

  it('attributes sessions only when a profile event predates the session', async () => {
    const switchedAt = '2026-09-21T10:00:00Z';
    const { win, hub } = loadHub({
      hub: {
        codexSwitcher: { accounts: [{ id: 'acct', name: 'Work', active: true, usage: {} }] },
        ccSwitch: { providers: [] }, qoder: {},
        profileEvents: [{ agent: 'codex', profileId: 'acct', profileName: 'Work', switchedAt }],
      },
      codex: { recentSessions: [
        { project_path: '/tmp/before', start_time: '2026-09-21T09:00:00Z', tokens: 1 },
        { project_path: '/tmp/after', start_time: '2026-09-21T11:00:00Z', tokens: 2 },
      ] },
    });
    hub.start();
    await new Promise((resolve) => win.setTimeout(resolve, 0));
    const rows = [...win.document.querySelectorAll('.ah-activity-row')].map((row) => row.textContent);
    expect(rows.find((row) => row.includes('before'))).toContain('运行身份未记录');
    expect(rows.find((row) => row.includes('after'))).toContain('Work');
    hub.stop();
  });

  it('labels the actual Codex quota window instead of assuming a five-hour limit', async () => {
    const { win, hub } = loadHub({
      hub: {
        codexSwitcher: { accounts: [{
          id: 'acct', name: 'Weekly only', active: true,
          usage: { primary: { usedPercent: 10, windowMinutes: 10080 } },
        }] },
        ccSwitch: { providers: [] }, qoder: {},
      },
    });
    hub.start();
    await new Promise((resolve) => win.setTimeout(resolve, 0));
    const text = win.document.getElementById('agent-hub').textContent;
    expect(text).toContain('周额度');
    expect(text).not.toContain('5 小时');
    expect(text).not.toContain('7 天');
    hub.stop();
  });

  it('shows elapsed time in the same quota progress track when the window is known', async () => {
    const nowMs = Date.parse('2026-10-01T12:00:00Z');
    const { win, hub } = loadHub({
      hub: {
        codexSwitcher: { accounts: [{
          id: 'acct', name: 'Weekly', active: true,
          usage: {
            primary: {
              usedPercent: 25,
              windowMinutes: 10080,
              resetsAt: (nowMs + 3.5 * 24 * 60 * 60 * 1000) / 1000,
            },
          },
        }] },
        ccSwitch: { providers: [] }, qoder: {},
      },
    });
    vi.spyOn(win.Date, 'now').mockReturnValue(nowMs);
    hub.start();
    await new Promise((resolve) => win.setTimeout(resolve, 0));

    const track = win.document.querySelector('.ah-quota-track');
    expect(track.title).toBe('额度已用 25%；时间已过 50%');
    expect(track.querySelector('.ah-quota-used').style.width).toBe('25%');
    expect(track.querySelector('.ah-quota-time').style.width).toBe('50%');
    expect(win.document.getElementById('agent-hub').textContent).toContain('时间 50%');
    hub.stop();
  });

  it('does not request or render data sources disabled in settings', async () => {
    const { win, hub } = loadHub({ ui: { showClaude: false, showCodex: true } });
    hub.start();
    await new Promise((resolve) => win.setTimeout(resolve, 0));
    expect(win.Api.get).toHaveBeenCalledWith('/api/agent-hub?claude=0');
    expect(win.Api.get).not.toHaveBeenCalledWith('/api/claude-usage');
    expect(win.document.getElementById('agent-hub').textContent).not.toContain('Claude');
    hub.stop();
  });

  it('shows Claude GLM subscription quota and per-model tokens without an official login', async () => {
    const { win, hub } = loadHub({
      hub: { codexSwitcher: { accounts: [] }, ccSwitch: { providers: [{
        id: 'claude-glm', agent: 'claude', name: 'GLM', category: 'cn_official', active: true,
        usage: { primary: { usedPercent: 25, windowMinutes: 300, used: 25, total: 100, remaining: 75 }, balance: 42.5 },
      }] }, qoder: {} },
      claude: { subscription: null, aggregate: { totalSessions: 2, totalMessages: 8, totalTokens: 190 }, modelUsage: {
        'glm-5.3': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 30, cacheCreationInputTokens: 10 },
      } },
    });
    hub.start();
    await new Promise((resolve) => win.setTimeout(resolve, 0));
    win.document.querySelector('[data-agent-id="claude"]').click();
    const text = win.document.getElementById('agent-hub').textContent;
    expect(text).toContain('智谱 Coding Plan');
    expect(text).toContain('已用 25 / 100 · 剩余 75');
    expect(text).toContain('¥42.50');
    expect(text).not.toContain('Anthropic 官方订阅');
    const cells = [...win.document.querySelectorAll('.ah-model-usage tbody tr > *')].map((cell) => cell.textContent);
    expect(cells).toEqual(['glm-5.3', '100', '50', '40', '190']);
    expect(win.document.querySelector('[data-ah-action="warmup-provider"]')).toBeNull();
    hub.stop();
  });

  it('shows Qoder credit counts and marks the sampled history scope', async () => {
    const { win, hub } = loadHub({ hub: {
      codexSwitcher: { accounts: [] }, ccSwitch: { providers: [] }, qoder: {
        installed: true, totalSessions: 30, totalMessages: 50, totalTokens: 150, usageScope: '最近 20 个会话',
        usage: { usedPercent: 20, usedCredits: 20, totalCredits: 100, remainingCredits: 80 },
        modelUsage: { 'qoder-model': { inputTokens: 120, outputTokens: 30 } },
      },
    } });
    hub.start();
    await new Promise((resolve) => win.setTimeout(resolve, 0));
    win.document.querySelector('[data-agent-id="qoder"]').click();
    const text = win.document.getElementById('agent-hub').textContent;
    expect(text).toContain('已用 20 / 100 · 剩余 80');
    expect(text).toContain('模型用量 · 最近 20 个会话');
    expect(text).toContain('qoder-model');
    hub.stop();
  });

  it('separates cached Codex input without adding it to the total a second time', async () => {
    const { win, hub } = loadHub({ codex: { modelUsage: {
      'codex-model': { inputTokens: 100, outputTokens: 20, cachedInputTokens: 40, totalTokens: 120 },
    } } });
    hub.start();
    await new Promise((resolve) => win.setTimeout(resolve, 0));
    const cells = [...win.document.querySelectorAll('.ah-model-usage tbody tr > *')].map((cell) => cell.textContent);
    expect(cells).toEqual(['codex-model', '60', '20', '40', '120']);
    hub.stop();
  });

  it('does not turn unknown quotas into zero-percent usage', async () => {
    const { win, hub } = loadHub({ hub: {
      codexSwitcher: { accounts: [] }, ccSwitch: { providers: [{
        id: 'unknown', agent: 'claude', name: 'Unknown quota', active: true,
        usage: { primary: { usedPercent: null } },
      }] }, qoder: {},
    } });
    hub.start();
    await new Promise((resolve) => win.setTimeout(resolve, 0));
    win.document.querySelector('[data-agent-id="claude"]').click();
    expect(win.document.querySelector('.ah-quota-used')).toBeNull();
    expect(win.document.querySelector('.ah-source-card.claude').textContent).not.toContain('已用 0%');
    hub.stop();
  });

  it('merges both credit pools and managed models into the existing profiles and usage area', async () => {
    const usage = { usedPercent: 100, usedCredits: 20000, totalCredits: 20000, remainingCredits: 0 };
    const { win, hub } = loadHub({ hub: {
      codexSwitcher: { accounts: [] }, ccSwitch: { providers: [] },
      qoder: { installed: true, usage },
      enterprise: { available: true, qoder: { reason: '当前账号未开通自定义模型' },
        tokenSwitch: { installed: true, loggedIn: true, canSwitchInPanel: true, models: [{ id: 'auto', app: 'codex', name: 'Auto',
          meta: { managedCatalog: { multiplier: 1, description: '<集团模型>' } } }] },
        pools: [{ id: 'qoder-ide', name: 'Qoder 专属月额度', usage },
          { id: 'enterprise', name: '集团 AI 月额度', reason: '阿里郎额度查询尚未接通' }],
      },
    } });
    hub.start();
    await new Promise((resolve) => win.setTimeout(resolve, 0));
    const profile = [...win.document.querySelectorAll('.ah-profile-card')].find((card) => card.textContent.includes('Auto'));
    expect(profile.textContent).toContain('集团 Credits');
    expect(profile.textContent).toContain('<集团模型>');
    expect(profile.querySelector('[data-ah-action="activate-provider"]')).toBeNull();
    expect(profile.querySelector('[data-ah-action="activate-managed"]')).toBeTruthy();
    expect(profile.querySelector('[data-app="tokenswitch"]')).toBeNull();
    expect(win.document.querySelectorAll('.ah-usage-grid .ah-enterprise-pool')).toHaveLength(2);
    const unknown = [...win.document.querySelectorAll('.ah-enterprise-pool')].find((card) => card.textContent.includes('集团 AI'));
    expect(unknown.textContent).toContain('查询未接通');
    expect(unknown.querySelector('.ah-quota-used')).toBeNull();
    win.document.querySelector('[data-agent-id="qoder"]').click();
    expect(win.document.querySelectorAll('.ah-usage-grid .ah-enterprise-pool')).toHaveLength(1);
    expect(win.document.querySelector('.ah-usage-grid').textContent).toContain('Qoder 月额度');
    expect(win.document.querySelector('[data-ah-action="configure-qoder"]')).toBeNull();
    expect(win.document.querySelector('.ah-profile-card').textContent).toContain('当前账号未开通自定义模型');
    hub.stop();
  });

  it('merges the active embedded Claude provider into its managed model card', async () => {
    const { win, hub } = loadHub({ hub: {
      ccSwitch: { providers: [{ id: 'relay', agent: 'claude', name: '集团中继', active: true,
        embeddedEnterprise: true, enterpriseModelId: 'auto', requiresNativeProxy: false }] },
      enterprise: { available: true, tokenSwitch: { installed: true, loggedIn: true, canSwitchInPanel: true,
        models: [{ id: 'auto', app: 'codex', name: 'Auto', meta: { managedCatalog: {} } }] }, pools: [] },
    } });
    hub.start();
    await new Promise((resolve) => win.setTimeout(resolve, 0));
    win.document.querySelector('[data-agent-id="claude"]').click();
    expect(win.document.querySelectorAll('.ah-profile-card')).toHaveLength(1);
    expect(win.document.querySelector('.ah-profile-card').textContent).toContain('集团 Credits');
    expect(win.document.querySelector('.ah-profile-card').classList.contains('active')).toBe(true);
    expect(win.document.querySelector('[data-app="ccswitch"]')).toBeNull();
    expect(win.document.querySelector('[data-ah-action="activate-provider"]')).toBeNull();
    expect(win.document.querySelector('[data-ah-action="preview-claude-relay"]')).toBeNull();
    hub.stop();
  });

  it('shows a shared group quota once and gives actionable authorization feedback on retry', async () => {
    const reason = '额度读取超时，请检查系统钥匙串授权或网络后手动重试';
    const { win, hub } = loadHub({ hub: {
      ccSwitch: { providers: [{ id: 'group', agent: 'codex', active: true,
        embeddedEnterprise: true, enterpriseModelId: 'auto' }] },
      enterprise: { available: true,
        tokenSwitch: { installed: true, loggedIn: true, canSwitchInPanel: true,
          models: ['auto', 'basic'].map((id) => ({ id, app: 'codex', name: id, meta: { managedCatalog: {} } })) },
        pools: [{ id: 'enterprise', name: '集团 AI 月额度', status: 'needs-authorization', reason }],
      },
    } });
    let finish;
    win.Api.post.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    hub.start();
    await new Promise((resolve) => win.setTimeout(resolve, 0));
    const profiles = win.document.querySelector('.ah-profile-grid');
    expect(profiles.querySelectorAll('[data-ah-action="activate-managed"]')).toHaveLength(1);
    expect(profiles.textContent).toContain('集团模型共用月 Credits');
    expect(profiles.textContent).not.toContain('暂未读取到额度');
    expect(win.document.querySelectorAll('.ah-enterprise-pool')).toHaveLength(1);
    expect(win.document.getElementById('agent-hub').textContent.split(reason)).toHaveLength(2);
    const retry = win.document.querySelector('[data-ah-action="refresh-enterprise-quota"]');
    expect(retry.closest('article').textContent).toContain('等待系统授权');
    expect(retry.closest('article').textContent).toContain('证书或私钥访问提示');
    retry.click();
    expect(retry.disabled).toBe(true);
    expect(retry.textContent).toBe('正在读取…');
    finish({ alilang: { status: 'needs-authorization', reason } });
    await new Promise((resolve) => win.setTimeout(resolve, 0));
    expect(win.Api.post).toHaveBeenCalledWith('/api/agent-hub/enterprise/quota/refresh');
    expect(win.AppShell.toast).toHaveBeenCalledWith(reason);
    expect(win.document.querySelector('[data-ah-action="refresh-enterprise-quota"]').disabled).toBe(false);
    hub.stop();
  });

  it('switches a managed Claude model directly through the existing confirmation flow', async () => {
    const { win, hub } = loadHub({ hub: {
      enterprise: { available: true, tokenSwitch: { installed: true, loggedIn: true, canSwitchInPanel: true,
        models: [{ id: 'auto', app: 'codex', name: 'Auto', meta: { managedCatalog: {} } }] }, pools: [] },
    } });
    win.showConfirm = vi.fn().mockResolvedValue(false);
    hub.start();
    await new Promise((resolve) => win.setTimeout(resolve, 0));
    win.document.querySelector('[data-agent-id="claude"]').click();
    win.document.querySelector('[data-ah-action="activate-managed"]').click();
    await new Promise((resolve) => win.setTimeout(resolve, 0));
    expect(win.Api.post).not.toHaveBeenCalled();
    win.showConfirm.mockResolvedValue(true);
    win.document.querySelector('[data-ah-action="activate-managed"]').click();
    await new Promise((resolve) => win.setTimeout(resolve, 0));
    expect(win.Api.post).toHaveBeenCalledWith('/api/agent-hub/enterprise/models/auto/activate', { agent: 'claude' });
    expect(win.Api.post).toHaveBeenCalledTimes(1);
    hub.stop();
  });
});
