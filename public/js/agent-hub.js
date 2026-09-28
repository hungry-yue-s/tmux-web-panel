// Agent operations view. Third-party stores are adapter inputs only; the UI
// uses its own Agent -> runtime profile -> quota/session model.
var AgentHub = (function () {
  var POLL_MS = 30000;
  var timer = null;
  var root = null;
  var state = {
    hub: null, claude: null, codex: null, selectedAgent: 'codex', loading: false, error: null,
    warmingProfileKey: null, updatingAutoProfileKey: null,
  };

  function esc(value) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(value);
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }

  function fmt(value) {
    var n = Number(value) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
  }

  function relative(iso) {
    var time = Date.parse(iso || '');
    if (!Number.isFinite(time)) return '暂无记录';
    var minutes = Math.max(0, Math.round((Date.now() - time) / 60000));
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return minutes + ' 分钟前';
    if (minutes < 1440) return Math.floor(minutes / 60) + ' 小时前';
    return Math.floor(minutes / 1440) + ' 天前';
  }

  function windowFromLegacy(quotaWindow) {
    if (!quotaWindow) return null;
    return {
      usedPercent: Number(quotaWindow.used_percent),
      windowMinutes: Number(quotaWindow.window_minutes),
      resetsAt: Number(quotaWindow.resets_at),
    };
  }

  function claudeWindow(quotaWindow) {
    if (!quotaWindow) return null;
    var used = Number(quotaWindow.utilization);
    var limit = Number(quotaWindow.limit);
    var remaining = Number(quotaWindow.remaining);
    if (!Number.isFinite(used) && Number.isFinite(limit) && limit > 0 && Number.isFinite(remaining)) {
      used = ((limit - remaining) / limit) * 100;
    }
    return {
      usedPercent: used,
      resetsAt: Date.parse(quotaWindow.resets_at || quotaWindow.reset_at || '') / 1000,
    };
  }

  function quotaTone(percent) {
    var n = Number(percent);
    if (!Number.isFinite(n)) return 'muted';
    if (n >= 85) return 'red';
    if (n >= 60) return 'yellow';
    return 'green';
  }

  function quotaItems(usage, fallbacks) {
    return [usage && usage.primary, usage && usage.secondary].filter(Boolean).map(function (value, index) {
      var minutes = Number(value.windowMinutes);
      var label = fallbacks[index];
      if (minutes === 10080) label = '周额度';
      else if (Number.isFinite(minutes) && minutes > 0 && minutes % 1440 === 0) label = (minutes / 1440) + ' 天';
      else if (Number.isFinite(minutes) && minutes > 0 && minutes % 60 === 0) label = (minutes / 60) + ' 小时';
      else if (Number.isFinite(minutes) && minutes > 0) label = minutes + ' 分钟';
      return { label: label, value: value };
    });
  }

  function quotaBar(label, quotaWindow) {
    if (!quotaWindow || !Number.isFinite(Number(quotaWindow.usedPercent))) {
      return '<div class="ah-quota unavailable"><span>' + esc(label) + '</span><strong>—</strong></div>';
    }
    var percent = Math.max(0, Math.min(100, Number(quotaWindow.usedPercent)));
    var reset = quotaWindow.resetsAt ? new Date(Number(quotaWindow.resetsAt) * 1000) : null;
    var resetText = reset && !Number.isNaN(reset.getTime())
      ? '重置 ' + reset.toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '重置时间未知';
    return '<div class="ah-quota"><div><span>' + esc(label) + '</span><small>' + esc(resetText) + '</small></div>'
      + '<div class="ah-quota-track"><i class="' + quotaTone(percent) + '" style="width:' + percent + '%"></i></div>'
      + '<strong>' + Math.round(percent) + '%</strong></div>';
  }

  function renderSkeleton() {
    return '<section id="agent-hub" class="agent-hub"><div class="ah-loading">正在汇总 Agent、运行身份与用量…</div></section>';
  }

  function profileTypeLabel(profile) {
    return profile.kind === 'subscription' ? '官方订阅' : 'API 服务';
  }

  function visibility() {
    var ui = window.Store && window.Store.getState ? window.Store.getState().ui || {} : {};
    return { claude: ui.showClaude !== false, codex: ui.showCodex !== false };
  }

  function normalizeAgents() {
    var hub = state.hub || {};
    var claude = state.claude || {};
    var codex = state.codex || {};
    var providers = (hub.ccSwitch && hub.ccSwitch.providers) || [];
    var accounts = (hub.codexSwitcher && hub.codexSwitcher.accounts) || [];
    var qoder = hub.qoder || {};
    var claudeProviders = providers.filter(function (provider) { return provider.agent === 'claude'; });
    var codexProviders = providers.filter(function (provider) { return provider.agent === 'codex'; });
    var activeClaudeProvider = claudeProviders.find(function (provider) { return provider.active; });
    var activeCodexProvider = codexProviders.find(function (provider) { return provider.active; });
    var codexOfficial = !activeCodexProvider || activeCodexProvider.category === 'official';
    var claudeDetected = Boolean(claude.subscription || claude.aggregate || claude.utilization || claudeProviders.length);
    var claudeOfficialDetected = Boolean(claude.subscription || claude.aggregate || claude.utilization
      || (activeClaudeProvider && activeClaudeProvider.category === 'official'));

    var storedClaudeOfficial = claudeProviders.find(function (provider) { return provider.category === 'official'; });
    var claudeProfiles = (!storedClaudeOfficial && claudeOfficialDetected ? [{
      id: 'claude-official', name: 'Anthropic 官方订阅',
      detail: (claude.subscription && claude.subscription.type) || '已检测到官方登录',
      kind: 'subscription', current: claudeDetected && !activeClaudeProvider, switchable: false,
      quota: [
        { label: '5 小时', value: claudeWindow(claude.utilization && claude.utilization.five_hour) },
        { label: '7 天', value: claudeWindow(claude.utilization && claude.utilization.seven_day) },
      ],
    }] : []).concat(claudeProviders.map(function (provider) {
      var official = provider.category === 'official';
      return {
        id: provider.id, name: provider.name, detail: official ? 'Anthropic 官方订阅' : (provider.category || '自定义接口'), kind: official ? 'subscription' : 'api',
        current: provider.active, switchable: true, switchAction: 'activate-provider', agentId: 'claude', provider: provider,
        message: provider.usage && provider.usage.error,
        quota: official ? [
          { label: '5 小时', value: claudeWindow(claude.utilization && claude.utilization.five_hour) },
          { label: '7 天', value: claudeWindow(claude.utilization && claude.utilization.seven_day) },
        ] : quotaItems(provider.usage, ['短周期', '长周期']),
      };
    }));

    var codexProfiles = accounts.map(function (account) {
      var usage = account.usage || {};
      return {
        id: account.id, name: account.name,
        detail: account.authKind === 'api_key' ? 'OpenAI API Key' : (account.planType || 'ChatGPT'),
        secondary: !account.masked && account.email && account.email !== account.name ? account.email : null,
        kind: account.authKind === 'api_key' ? 'api' : 'subscription',
        current: Boolean(account.active && codexOfficial), switchable: true, switchAction: 'activate-account',
        warmupAction: account.authKind === 'chatgpt', lastWarmupAt: account.lastWarmupAt,
        lastWarmupMode: account.lastWarmupMode, autoWarmupEnabled: Boolean(account.autoWarmupEnabled),
        lastUsedAt: account.lastUsedAt, expiresAt: account.subscriptionExpiresAt,
        message: usage.error || usage.unavailable || null,
        quota: quotaItems(usage, ['5 小时', '7 天']),
      };
    }).concat(codexProviders.filter(function (provider) {
      return !(accounts.length && provider.category === 'official');
    }).map(function (provider) {
      var zhipuSubscription = provider.category === 'cn_official';
      return {
        id: provider.id, name: provider.name, detail: zhipuSubscription ? '智谱 Coding Plan' : (provider.category || '自定义接口'),
        kind: provider.category === 'official' || zhipuSubscription ? 'subscription' : 'api',
        current: provider.active, switchable: true, switchAction: 'activate-provider', agentId: 'codex', provider: provider,
        warmupAction: zhipuSubscription, warmupTarget: 'provider', lastWarmupAt: provider.lastWarmupAt,
        lastWarmupMode: provider.lastWarmupMode, autoWarmupEnabled: Boolean(provider.autoWarmupEnabled),
        message: provider.usage && provider.usage.error,
        quota: quotaItems(provider.usage, ['短周期', '长周期']),
      };
    }));

    return [
      {
        id: 'claude', name: 'Claude', mark: 'C', installed: claudeDetected,
        profiles: claudeProfiles, sessions: claude.recentSessions || [],
        consumption: [
          { label: '会话', value: fmt(claude.aggregate && claude.aggregate.totalSessions) },
          { label: '消息', value: fmt(claude.aggregate && claude.aggregate.totalMessages) },
        ],
      },
      {
        id: 'codex', name: 'Codex', mark: 'X', installed: Boolean(codex.subscription || codex.aggregate || codexProfiles.length),
        profiles: codexProfiles, sessions: codex.recentSessions || [],
        consumption: [
          { label: '会话', value: fmt(codex.aggregate && codex.aggregate.totalSessions) },
          { label: 'Tokens', value: fmt(codex.aggregate && codex.aggregate.totalTokens) },
        ],
      },
      {
        id: 'qoder', name: 'Qoder', mark: 'Q', installed: Boolean(qoder.installed),
        profiles: qoder.installed ? [{
          id: 'qoder-official', name: 'Qoder 当前登录', detail: '官方账号', kind: 'subscription', current: true, switchable: false,
          message: qoder.usage && qoder.usage.error,
          configureAction: 'configure-qoder',
          quota: qoder.usage ? [{ label: 'Credits', value: qoder.usage }] : [],
        }] : [],
        sessions: qoder.recentSessions || [],
        consumption: [
          { label: '会话', value: fmt(qoder.totalSessions || 0) },
          { label: 'Tokens', value: Number.isFinite(qoder.totalTokens) ? fmt(qoder.totalTokens) : '—' },
          { label: '本地任务', value: fmt(qoder.taskCount || 0) },
        ],
      },
    ].filter(function (agent) {
      var visible = visibility();
      return agent.id === 'claude' ? visible.claude : visible.codex;
    });
  }

  function currentProfile(agent) {
    return agent.profiles.find(function (profile) { return profile.current; }) || null;
  }

  function primaryQuota(profile) {
    if (!profile) return '未识别运行身份';
    var quota = (profile.quota || []).find(function (item) {
      return item.value && Number.isFinite(Number(item.value.usedPercent));
    });
    if (quota) return quota.label + '已用 ' + Math.round(Number(quota.value.usedPercent)) + '%';
    if (profile.provider && Number.isFinite(profile.provider.monthlyLimitUsd)) return '月预算 $' + profile.provider.monthlyLimitUsd;
    return profile.kind === 'api' ? '供应商侧计费' : '额度暂不可用';
  }

  function renderAgentCards(agents) {
    return '<div class="ah-source-grid">' + agents.map(function (agent) {
      var profile = currentProfile(agent);
      var selected = agent.id === state.selectedAgent;
      return '<button type="button" class="ah-source-card ' + agent.id + (selected ? ' selected' : '') + '" data-agent-id="' + agent.id + '">'
        + '<div class="ah-source-head"><span class="ah-agent-mark">' + esc(agent.mark) + '</span><div><h3>' + esc(agent.name) + '</h3>'
        + '<p>' + esc(profile ? profile.name : (agent.installed ? '未识别运行身份' : '尚未发现')) + '</p></div>'
        + '<span class="ms-badge ' + (profile ? 'green' : (agent.installed ? 'yellow' : 'muted')) + '">' + (profile ? '当前' : (agent.installed ? '待配置' : '离线')) + '</span></div>'
        + '<div class="ah-card-route"><small>下一次启动</small><strong>' + esc(profile ? profileTypeLabel(profile) : '—') + '</strong><span>' + esc(primaryQuota(profile)) + '</span></div>'
        + '<div class="ah-source-stats">' + agent.consumption.map(function (item) {
          return '<span><strong>' + esc(item.value) + '</strong> ' + esc(item.label) + '</span>';
        }).join('') + '</div></button>';
    }).join('') + '</div>';
  }

  function renderCurrentProfile(agent) {
    var profile = currentProfile(agent);
    if (!profile) {
      return '<div class="ah-current-profile unknown"><div><small>当前运行身份</small><strong>未识别</strong><span>无法确定下一次启动会使用哪个身份。</span></div></div>';
    }
    return '<div class="ah-current-profile"><div class="ah-current-main"><small>当前运行身份</small><strong>' + esc(profile.name) + '</strong>'
      + '<span>' + esc(agent.name) + ' · ' + esc(profileTypeLabel(profile)) + (profile.detail ? ' · ' + esc(profile.detail) : '') + '</span></div>'
      + '<div class="ah-current-next"><small>生效范围</small><strong>新会话</strong><span>运行中的会话保持原身份</span></div></div>';
  }

  function renderProfileQuota(profile) {
    if (profile.message) return '<div class="ah-account-message">' + esc(profile.message) + '</div>';
    var bars = (profile.quota || []).map(function (item) { return quotaBar(item.label, item.value); }).join('');
    var provider = profile.provider;
    var usage = provider && provider.usage;
    var financials = '';
    if (usage && (Number.isFinite(usage.balance) || Number.isFinite(usage.spent))) {
      financials = '<div class="ah-budget-list">'
        + (Number.isFinite(usage.balance) ? '<span>余额 <strong>¥' + esc(usage.balance.toFixed(2)) + '</strong></span>' : '')
        + (Number.isFinite(usage.spent) ? '<span>累计消费 <strong>¥' + esc(usage.spent.toFixed(2)) + '</strong></span>' : '') + '</div>';
    }
    if (bars) return bars + financials;
    if (financials) return financials;
    if (provider && (Number.isFinite(provider.dailyLimitUsd) || Number.isFinite(provider.monthlyLimitUsd))) {
      return '<div class="ah-budget-list">'
        + (Number.isFinite(provider.dailyLimitUsd) ? '<span>日预算 <strong>$' + esc(provider.dailyLimitUsd) + '</strong></span>' : '')
        + (Number.isFinite(provider.monthlyLimitUsd) ? '<span>月预算 <strong>$' + esc(provider.monthlyLimitUsd) + '</strong></span>' : '') + '</div>';
    }
    return '<div class="ah-account-message">' + (profile.kind === 'api' ? '用量由 API 服务侧计费' : '暂未读取到额度') + '</div>';
  }

  function renderProfiles(agent) {
    if (!agent.profiles.length) return '<div class="ah-empty">未发现可用运行身份。</div>';
    return '<div class="ah-profile-grid">' + agent.profiles.map(function (profile) {
      var controls = [];
      if (profile.configureAction) {
        controls.push('<span class="ms-badge green">当前</span><button class="ms-btn ghost compact" data-ah-action="configure-qoder">配置额度</button>');
      } else if (profile.current) {
        controls.push('<span class="ms-badge green">当前</span>');
      } else if (profile.switchable) {
        var idAttr = profile.switchAction === 'activate-account' ? ' data-account-id="' : ' data-provider-id="';
        controls.push('<button class="ms-btn ghost compact" data-ah-action="' + esc(profile.switchAction) + '" data-agent-id="' + esc(profile.agentId || 'codex') + '" data-target-name="' + esc(profile.name) + '"'
          + idAttr + esc(profile.id) + '">切换</button>');
      } else {
        controls.push('<span class="ms-badge muted">只读</span>');
      }
      var warmupKey = (profile.warmupTarget || 'account') + ':' + profile.id;
      var warmupIdAttr = profile.warmupTarget === 'provider' ? ' data-provider-id="' : ' data-account-id="';
      if (profile.warmupAction) controls.push('<button class="ms-btn ghost compact" data-ah-action="warmup-' + esc(profile.warmupTarget || 'account') + '"'
        + warmupIdAttr + esc(profile.id) + '" data-target-name="' + esc(profile.name) + '"' + (state.warmingProfileKey === warmupKey ? ' disabled' : '') + '>'
        + (state.warmingProfileKey === warmupKey ? '暖号中…' : '暖号') + '</button>');
      if (profile.warmupAction) controls.push('<button class="ms-btn ' + (profile.autoWarmupEnabled ? 'primary' : 'ghost')
        + ' compact" data-ah-action="toggle-auto-warmup"' + warmupIdAttr + esc(profile.id)
        + '" data-target-name="' + esc(profile.name) + '" data-enabled="' + (profile.autoWarmupEnabled ? 'true' : 'false') + '"'
        + (state.updatingAutoProfileKey === warmupKey ? ' disabled' : '') + '>'
        + (state.updatingAutoProfileKey === warmupKey ? '保存中…' : ('自动：' + (profile.autoWarmupEnabled ? '开' : '关'))) + '</button>');
      var control = '<div class="ah-card-controls">' + controls.join('') + '</div>';
      return '<article class="ah-profile-card' + (profile.current ? ' active' : '') + '"><div class="ah-account-top"><div>'
        + '<div class="ah-profile-type">' + esc(profileTypeLabel(profile)) + '</div><div class="ah-account-name">' + esc(profile.name) + '</div>'
        + '<div class="ah-account-meta">' + esc(profile.detail || '') + (profile.secondary ? ' · ' + esc(profile.secondary) : '') + '</div></div>' + control + '</div>'
        + renderProfileQuota(profile)
        + '<div class="ah-account-foot"><span>' + (profile.current ? '新会话将使用此身份' : (profile.switchable ? '切换不影响运行中的会话' : '当前仅查看，暂不支持面板内切换')) + '</span>'
        + (profile.lastWarmupAt ? '<span>最近' + (profile.lastWarmupMode === 'automatic' ? '自动' : '') + '暖号 ' + esc(relative(profile.lastWarmupAt)) + '</span>'
          : (profile.expiresAt ? '<span>订阅至 ' + esc(profile.expiresAt.slice(0, 10)) + '</span>' : (profile.lastUsedAt ? '<span>最近使用 ' + esc(relative(profile.lastUsedAt)) + '</span>' : '')))
        + '</div></article>';
    }).join('') + '</div>';
  }

  function renderUsage(agent) {
    var profile = currentProfile(agent);
    var quota = profile ? renderProfileQuota(profile) : '<div class="ah-account-message">当前运行身份未识别</div>';
    return '<div class="ah-usage-grid"><article class="ah-usage-card"><div class="ah-usage-title"><strong>额度</strong><span>归属当前运行身份</span></div>' + quota + '</article>'
      + '<article class="ah-usage-card"><div class="ah-usage-title"><strong>本地消耗</strong><span>由历史会话汇总</span></div><div class="ah-consumption">'
      + agent.consumption.map(function (item) { return '<div><strong>' + esc(item.value) + '</strong><span>' + esc(item.label) + '</span></div>'; }).join('')
      + '</div></article></div>';
  }

  function renderSessions(agent) {
    var events = (state.hub && state.hub.profileEvents || []).filter(function (event) { return event.agent === agent.id; });
    var rows = (agent.sessions || []).map(function (session) {
      var path = session.project_path || '未知工作区';
      var tokens = session.tokens || (Number(session.input_tokens || 0) + Number(session.output_tokens || 0));
      var startedAt = Date.parse(session.start_time || '');
      var event = Number.isFinite(startedAt) ? events.filter(function (candidate) {
        var switchedAt = Date.parse(candidate.switchedAt || '');
        return Number.isFinite(switchedAt) && switchedAt <= startedAt;
      }).sort(function (a, b) { return Date.parse(b.switchedAt) - Date.parse(a.switchedAt); })[0] : null;
      return {
        path: path, name: path.split('/').filter(Boolean).pop() || path,
        at: session.updated_at || session.start_time,
        detail: tokens ? fmt(tokens) + ' tokens' : (session.duration_minutes || 0) + ' 分钟',
        model: session.model || '模型未记录',
        profile: session.profile_name || (event && event.profileName) || '运行身份未记录',
      };
    }).sort(function (a, b) { return Date.parse(b.at || '') - Date.parse(a.at || ''); });
    if (!rows.length) {
      return '<div class="ah-empty">暂无本地会话记录。</div>';
    }
    return '<div class="ah-activity-list">' + rows.slice(0, 8).map(function (item) {
      return '<div class="ah-activity-row"><div><strong>' + esc(item.name) + '</strong><small title="' + esc(item.path) + '">' + esc(item.path) + '</small></div>'
        + '<span>' + esc(item.model) + '</span><span class="ah-session-profile">' + esc(item.profile) + '</span><span>' + esc(item.detail) + '</span><time>' + esc(relative(item.at)) + '</time></div>';
    }).join('') + '</div>';
  }

  function selectedAgent(agents) {
    return agents.find(function (agent) { return agent.id === state.selectedAgent; }) || agents[0];
  }

  function paint() {
    if (!root || !root.isConnected) return;
    if (!state.hub && state.loading) {
      root.innerHTML = '<div class="ah-loading">正在汇总 Agent、运行身份与用量…</div>';
      return;
    }
    var agents = normalizeAgents();
    var agent = selectedAgent(agents);
    var error = state.error ? '<div class="ah-error">部分数据刷新失败：' + esc(state.error) + '</div>' : '';
    root.innerHTML = '<div class="ah-actions"><span>切换 Agent 查看其运行身份、额度与会话</span><div><button class="ms-btn ghost" data-ah-action="refresh">刷新</button>'
      + '<button class="ms-btn primary" data-ah-action="detach">独立展示</button></div></div>'
      + error + renderAgentCards(agents) + renderCurrentProfile(agent)
      + '<div class="ah-binding-note"><span><strong>额度</strong> 跟随运行身份</span><span><strong>消耗</strong> 从会话汇总</span><span><strong>切换</strong> 只影响新会话</span></div>'
      + '<section><div class="section-head"><h3>' + esc(agent.name) + ' 运行身份</h3><span>官方订阅与 API 服务使用同一个切换入口</span></div>' + renderProfiles(agent) + '</section>'
      + '<section><div class="section-head"><h3>额度与消耗</h3><span>两类数据不混算</span></div>' + renderUsage(agent) + '</section>'
      + '<section><div class="section-head"><h3>' + esc(agent.name) + ' 会话</h3><span>会话身份未被日志记录时保持未知</span></div>' + renderSessions(agent) + '</section>';
  }

  function load() {
    if (state.loading) return Promise.resolve();
    state.loading = true;
    state.error = null;
    paint();
    var visible = visibility();
    var query = [];
    if (!visible.claude) query.push('claude=0');
    if (!visible.codex) query.push('codex=0');
    return Promise.allSettled([
      window.Api.get('/api/agent-hub' + (query.length ? '?' + query.join('&') : '')),
      visible.claude ? window.Api.get('/api/claude-usage') : Promise.resolve({}),
      visible.codex ? window.Api.get('/api/codex-usage') : Promise.resolve({}),
    ]).then(function (results) {
      state.loading = false;
      if (results[0].status === 'fulfilled') state.hub = results[0].value;
      if (results[1].status === 'fulfilled') state.claude = results[1].value;
      if (results[2].status === 'fulfilled') state.codex = results[2].value;
      var failed = results.find(function (result) {
        if (result.status !== 'rejected') return false;
        var message = String(result.reason && result.reason.message || '');
        return message !== 'loading' && message !== 'not_configured';
      });
      state.error = failed ? (failed.reason.message || '数据源暂时不可用') : null;
      paint();
    });
  }

  function detachedURL() {
    var route = window.Router.serialize({ name: 'server', params: { serverId: 'local', section: 'agents' } });
    return window.location.origin + '/?standalone=agents' + route;
  }

  function onClick(event) {
    var agentButton = event.target.closest('[data-agent-id]');
    if (agentButton && !agentButton.dataset.ahAction) {
      state.selectedAgent = agentButton.dataset.agentId;
      paint();
      return;
    }
    var button = event.target.closest('[data-ah-action]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    var action = button.dataset.ahAction;
    if (action === 'detach') {
      window.open(detachedURL(), '_blank');
      return;
    }
    if (action === 'refresh') {
      load();
      return;
    }
    if (action === 'configure-qoder') {
      var prompt = window.showPrompt ? window.showPrompt({
        title: '配置 Qoder 网页会话 Cookie',
        placeholder: '从 qoder.com 请求中复制完整 Cookie 请求头',
        type: 'password',
        confirmText: '保存并读取额度',
      }) : Promise.resolve(window.prompt('Qoder Cookie'));
      prompt.then(function (cookieHeader) {
        if (!cookieHeader) return;
        button.disabled = true;
        return window.Api.post('/api/agent-hub/qoder/session', { cookieHeader: cookieHeader, site: 'international' })
          .then(function () { window.AppShell.toast('Qoder 额度配置已保存'); return load(); })
          .catch(function (error) { button.disabled = false; window.AppShell.toast(error.message || '配置失败'); });
      });
      return;
    }
    if (action === 'warmup-account' || action === 'warmup-provider') {
      var warmupProvider = action === 'warmup-provider';
      var warmupProfileId = warmupProvider ? button.dataset.providerId : button.dataset.accountId;
      var warmupKey = (warmupProvider ? 'provider:' : 'account:') + warmupProfileId;
      var warmupName = button.dataset.targetName || '这个账号';
      var confirmWarmup = window.showConfirm ? window.showConfirm({
        title: '暖号 ' + warmupName,
        message: warmupProvider
          ? '这会向智谱发送一次最小模型请求，并消耗 Coding Plan 的 5 小时与周订阅额度。暖号不会切换当前 Provider，是否继续？'
          : '这会向 OpenAI 发送一次最小模型请求，并消耗该账号的周额度。暖号不会切换当前账号，是否继续？',
        confirmText: '暖号',
      }) : Promise.resolve(window.confirm('暖号会消耗周额度，是否继续？'));
      confirmWarmup.then(function (yes) {
        if (!yes) return;
        state.warmingProfileKey = warmupKey;
        paint();
        var endpoint = warmupProvider ? '/api/agent-hub/providers/' : '/api/agent-hub/codex-switcher/';
        return window.Api.post(endpoint + encodeURIComponent(warmupProfileId) + '/warmup')
          .then(function () {
            window.AppShell.toast('已完成 ' + warmupName + ' 的暖号请求');
            state.warmingProfileKey = null;
            return load();
          })
          .catch(function (error) {
            state.warmingProfileKey = null;
            paint();
            window.AppShell.toast(error.message || '暖号失败');
          });
      });
      return;
    }
    if (action === 'toggle-auto-warmup') {
      var autoProvider = Boolean(button.dataset.providerId);
      var autoProfileId = autoProvider ? button.dataset.providerId : button.dataset.accountId;
      var autoKey = (autoProvider ? 'provider:' : 'account:') + autoProfileId;
      var autoName = button.dataset.targetName || '这个账号';
      var enableAuto = button.dataset.enabled !== 'true';
      var saveAuto = function () {
        state.updatingAutoProfileKey = autoKey;
        paint();
        var endpoint = autoProvider ? '/api/agent-hub/providers/' : '/api/agent-hub/codex-switcher/';
        return window.Api.post(endpoint + encodeURIComponent(autoProfileId) + '/auto-warmup', { enabled: enableAuto })
          .then(function () {
            window.AppShell.toast(autoName + '自动暖号已' + (enableAuto ? '开启' : '关闭'));
            state.updatingAutoProfileKey = null;
            return load();
          })
          .catch(function (error) {
            state.updatingAutoProfileKey = null;
            paint();
            window.AppShell.toast(error.message || '自动暖号配置失败');
          });
      };
      if (!enableAuto) {
        saveAuto();
        return;
      }
      var confirmAuto = window.showConfirm ? window.showConfirm({
        title: '开启自动暖号',
        message: autoProvider
          ? '服务会在智谱新的 5 小时订阅窗口开始时，为“' + autoName + '”发送一次最小请求，并在周额度接近耗尽时停止。页面关闭后仍会运行。'
          : '服务会在新的周额度窗口开始后自动为“' + autoName + '”发送一次最小请求。即使页面关闭，只要本机面板服务运行就会执行，并消耗周额度。',
        confirmText: '开启',
      }) : Promise.resolve(window.confirm('自动暖号会消耗周额度，是否开启？'));
      confirmAuto.then(function (yes) { if (yes) return saveAuto(); });
      return;
    }
    if (action === 'activate-account' || action === 'activate-provider') {
      var isAccount = action === 'activate-account';
      var agentId = isAccount ? 'codex' : (button.dataset.agentId || 'codex');
      var agentName = agentId === 'claude' ? 'Claude' : 'Codex';
      var targetName = button.dataset.targetName || '这个运行身份';
      var proceed = window.showConfirm ? window.showConfirm({
        title: '切换 ' + agentName + ' 运行身份',
        message: '切换到“' + targetName + '”。新启动的 ' + agentName + ' 会话将使用它；正在运行的会话不会改变。',
        confirmText: '切换',
      }) : Promise.resolve(window.confirm('切换 Codex 运行身份？'));
      proceed.then(function (yes) {
        if (!yes) return;
        button.disabled = true;
        var endpoint = isAccount
          ? '/api/agent-hub/codex-switcher/' + encodeURIComponent(button.dataset.accountId) + '/activate'
          : '/api/agent-hub/providers/' + encodeURIComponent(button.dataset.providerId) + '/activate';
        return window.Api.post(endpoint, isAccount ? undefined : { agent: agentId })
          .then(function () { window.AppShell.toast('已切换到 ' + targetName + '，新会话生效'); return load(); })
          .catch(function (error) { button.disabled = false; window.AppShell.toast(error.message || '切换失败'); });
      });
    }
  }

  function start() {
    stop();
    root = document.getElementById('agent-hub');
    if (!root) return;
    if (new URLSearchParams(window.location.search).get('standalone') === 'agents') document.documentElement.classList.add('agent-standalone');
    root.addEventListener('click', onClick);
    load();
    timer = setInterval(load, POLL_MS);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (root) root.removeEventListener('click', onClick);
    root = null;
  }

  return { renderSkeleton: renderSkeleton, start: start, stop: stop, _state: state, _detachedURL: detachedURL, _normalizeAgents: normalizeAgents };
})();
