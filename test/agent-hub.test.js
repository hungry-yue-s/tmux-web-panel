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

  it('does not request or render data sources disabled in settings', async () => {
    const { win, hub } = loadHub({ ui: { showClaude: false, showCodex: true } });
    hub.start();
    await new Promise((resolve) => win.setTimeout(resolve, 0));
    expect(win.Api.get).toHaveBeenCalledWith('/api/agent-hub?claude=0');
    expect(win.Api.get).not.toHaveBeenCalledWith('/api/claude-usage');
    expect(win.document.getElementById('agent-hub').textContent).not.toContain('Claude');
    hub.stop();
  });
});
