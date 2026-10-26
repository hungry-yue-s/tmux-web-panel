// Agent operations view. Third-party stores are adapter inputs only; the UI
// uses its own Agent -> runtime profile -> quota/session model.
var AgentHub = (function () {
  var POLL_MS = 30000;
  // Agent profiles and usage live on each machine; follow the server in view.
  function onMachine(method) {
    return function (path) {
      var args = Array.prototype.slice.call(arguments, 1);
      return window.Api[method].apply(window.Api, [window.Api.activeUrl(path)].concat(args));
    };
  }
  var machineApi = { get: onMachine('get'), post: onMachine('post') };
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

  function claudeWindow(quotaWindow, windowMinutes) {
    if (!quotaWindow) return null;
    var used = Number(quotaWindow.utilization == null ? NaN : quotaWindow.utilization);
    var limit = Number(quotaWindow.limit);
    var remaining = Number(quotaWindow.remaining);
    if (!Number.isFinite(used) && Number.isFinite(limit) && limit > 0 && Number.isFinite(remaining)) {
      used = ((limit - remaining) / limit) * 100;
    }
    return {
      usedPercent: used,
      windowMinutes: windowMinutes,
      resetsAt: Date.parse(quotaWindow.resets_at || quotaWindow.reset_at || '') / 1000,
    };
  }

  function timeProgress(quotaWindow) {
    var windowMs = Number(quotaWindow && quotaWindow.windowMinutes) * 60000;
    var resetMs = Number(quotaWindow && quotaWindow.resetsAt) * 1000;
    if (!(windowMs > 0) || !(resetMs > 0)) return null;
    return Math.max(0, Math.min(100, ((Date.now() - (resetMs - windowMs)) / windowMs) * 100));
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
    if (!quotaWindow || quotaWindow.usedPercent == null || !Number.isFinite(Number(quotaWindow.usedPercent))) {
      return '<div class="ah-quota unavailable"><span>' + esc(label) + '</span><strong>—</strong></div>';
    }
    var percent = Math.max(0, Math.min(100, Number(quotaWindow.usedPercent)));
    var elapsed = timeProgress(quotaWindow);
    var reset = quotaWindow.resetsAt ? new Date(Number(quotaWindow.resetsAt) * 1000) : null;
    var resetText = reset && !Number.isNaN(reset.getTime())
      ? (quotaWindow.expiresAt ? '到期 ' : '重置 ') + reset.toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '重置时间未知';
    if (elapsed !== null) resetText += ' · 时间 ' + Math.round(elapsed) + '%';
    var used = quotaWindow.usedCredits == null ? quotaWindow.used : quotaWindow.usedCredits;
    var total = quotaWindow.totalCredits == null ? quotaWindow.total : quotaWindow.totalCredits;
    var remaining = quotaWindow.remainingCredits == null ? quotaWindow.remaining : quotaWindow.remainingCredits;
    var counts = Number.isFinite(used) && Number.isFinite(total) ? '已用 ' + fmt(used) + ' / ' + fmt(total) : '';
    if (Number.isFinite(remaining)) counts += (counts ? ' · ' : '') + '剩余 ' + fmt(remaining);
    return '<div class="ah-quota"><div><span>' + esc(label) + '</span><small>' + esc(resetText) + '</small></div>'
      + '<div class="ah-quota-track" title="额度已用 ' + Math.round(percent) + '%' + (elapsed === null ? '' : '；时间已过 ' + Math.round(elapsed) + '%') + '">'
      + '<i class="ah-quota-used ' + quotaTone(percent) + '" style="width:' + percent + '%"></i>'
      + (elapsed === null ? '' : '<i class="ah-quota-time" style="width:' + elapsed + '%"></i>') + '</div>'
      + '<strong>' + Math.round(percent) + '%</strong>'
      + (counts ? '<small class="ah-quota-counts">' + esc(counts) + '</small>' : '') + '</div>';
  }

  function renderSkeleton() {
    return '<section id="agent-hub" class="agent-hub"><div class="ah-loading">正在汇总 Agent、运行身份与用量…</div></section>';
  }

  function profileTypeLabel(profile) {
    if (profile.enterprise) return '集团 Credits';
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
    var dsh = hub.dsh || {};
    var enterprise = hub.enterprise || {};
    var tokenSwitch = enterprise.tokenSwitch || {};
    var enterprisePool = (enterprise.pools || []).find(function (pool) { return pool.id === 'enterprise'; });
    var qoderPool = (enterprise.pools || []).find(function (pool) { return pool.id === 'qoder-ide'; });
    var groupModels = (tokenSwitch.models || []).filter(function (model) { return model.app === 'codex'; });
    var groupIds = groupModels.map(function (model) { return model.id; });
    function managedProfiles(agentId) {
      return groupModels.map(function (model) {
        var catalog = model.meta.managedCatalog;
        var active = providers.find(function (provider) {
          return provider.agent === agentId && provider.active && provider.embeddedEnterprise && provider.enterpriseModelId === model.id;
        });
        if (agentId === 'dsh') active = dsh.enterpriseModelId === model.id;
        return {
          id: model.id, name: model.name, kind: 'subscription', enterprise: true, current: Boolean(active),
          switchable: tokenSwitch.canSwitchInPanel === true && (agentId !== 'dsh' || dsh.installed), switchAction: 'activate-managed', agentId: agentId,
          detail: (agentId === 'claude' ? '集团资源池 · 兼容路由' : '集团资源池') + (catalog.multiplier == null ? '' : ' · ' + catalog.multiplier + '×'),
          capabilityNote: catalog.description,
          message: tokenSwitch.loggedIn ? (tokenSwitch.canSwitchInPanel ? null : tokenSwitch.error) : '集团登录已过期，请刷新登录态',
          quota: enterprisePool && enterprisePool.usage ? [{ label: '集团 Credits', value: enterprisePool.usage }] : [],
        };
      });
    }
    var claudeProviders = providers.filter(function (provider) { return provider.agent === 'claude'; });
    var codexProviders = providers.filter(function (provider) { return provider.agent === 'codex'; });
    var activeClaudeProvider = claudeProviders.find(function (provider) { return provider.active; });
    var activeCodexProvider = codexProviders.find(function (provider) { return provider.active; });
    var codexOfficial = !activeCodexProvider || activeCodexProvider.category === 'official';
    var claudeDetected = Boolean(claude.subscription || claude.aggregate || claude.utilization || claudeProviders.length);
    var claudeOfficialDetected = Boolean(claude.subscription || claude.utilization
      || (activeClaudeProvider && activeClaudeProvider.category === 'official'));

    var storedClaudeOfficial = claudeProviders.find(function (provider) { return provider.category === 'official'; });
    var claudeProfiles = (!storedClaudeOfficial && claudeOfficialDetected ? [{
      id: 'claude-official', name: 'Anthropic 官方订阅',
      detail: (claude.subscription && claude.subscription.type) || '已检测到官方登录',
      kind: 'subscription', current: claudeDetected && !activeClaudeProvider, switchable: false,
      message: claude.quotaUnavailable,
      quota: [
        { label: '5 小时', value: claudeWindow(claude.utilization && claude.utilization.five_hour, 300) },
        { label: '7 天', value: claudeWindow(claude.utilization && claude.utilization.seven_day, 10080) },
      ],
    }] : []).concat(claudeProviders.filter(function (provider) {
      return !(provider.embeddedEnterprise && groupIds.includes(provider.enterpriseModelId)) && !(provider.enterpriseRelay && !provider.active);
    }).map(function (provider) {
      var official = provider.category === 'official';
      var zhipuSubscription = provider.category === 'cn_official';
      return {
        id: provider.id, name: provider.name, detail: provider.enterpriseRelay ? 'CC Switch → Token Switch' : (official ? 'Anthropic 官方订阅' : (zhipuSubscription ? '智谱 Coding Plan' : (provider.category || '自定义接口'))), kind: official || zhipuSubscription || provider.enterpriseRelay ? 'subscription' : 'api',
        enterprise: provider.enterpriseRelay,
        current: provider.active, switchable: !provider.requiresNativeProxy, switchAction: 'activate-provider', agentId: 'claude', provider: provider,
        externalApp: provider.requiresNativeProxy ? 'ccswitch' : null, externalLabel: '在 CC Switch 启用',
        message: provider.enterpriseRelay ? '在 CC Switch 启用 Claude 本地路由，并在 Token Switch 启用集团模型；额度归属以集团账单为准。' : (official ? claude.quotaUnavailable : (provider.usage && (provider.usage.error || provider.usage.unavailable))),
        quota: official ? [
          { label: '5 小时', value: claudeWindow(claude.utilization && claude.utilization.five_hour, 300) },
          { label: '7 天', value: claudeWindow(claude.utilization && claude.utilization.seven_day, 10080) },
        ] : (provider.enterpriseRelay && enterprisePool && enterprisePool.usage ? [{ label: '集团 Credits', value: enterprisePool.usage }] : quotaItems(provider.usage, ['短周期', '长周期'])),
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
      return !(accounts.length && provider.category === 'official') && !(provider.embeddedEnterprise && groupIds.includes(provider.enterpriseModelId));
    }).map(function (provider) {
      var zhipuSubscription = provider.category === 'cn_official';
      return {
        id: provider.id, name: provider.name, detail: zhipuSubscription ? '智谱 Coding Plan' : (provider.category || '自定义接口'),
        kind: provider.category === 'official' || zhipuSubscription ? 'subscription' : 'api',
        current: provider.active, switchable: true, switchAction: 'activate-provider', agentId: 'codex', provider: provider,
        warmupAction: zhipuSubscription, warmupTarget: 'provider', lastWarmupAt: provider.lastWarmupAt,
        lastWarmupMode: provider.lastWarmupMode, autoWarmupEnabled: Boolean(provider.autoWarmupEnabled),
        message: provider.usage && (provider.usage.error || provider.usage.unavailable),
        quota: quotaItems(provider.usage, ['短周期', '长周期']),
      };
    }));

    codexProfiles = codexProfiles.concat(managedProfiles('codex'));
    claudeProfiles = claudeProfiles.concat(managedProfiles('claude'));

    return [
      {
        id: 'claude', name: 'Claude', mark: 'C', installed: claudeDetected,
        profiles: claudeProfiles, sessions: claude.recentSessions || [],
        modelUsage: claude.modelUsage || {},
        consumption: [
          { label: '会话', value: fmt(claude.aggregate && claude.aggregate.totalSessions) },
          { label: '消息', value: fmt(claude.aggregate && claude.aggregate.totalMessages) },
          { label: 'Tokens', value: claude.aggregate && claude.aggregate.totalTokens != null ? fmt(claude.aggregate.totalTokens) : '—' },
        ],
      },
      {
        id: 'codex', name: 'Codex', mark: 'X', installed: Boolean(codex.subscription || codex.aggregate || codexProfiles.length),
        profiles: codexProfiles, sessions: codex.recentSessions || [],
        modelUsage: codex.modelUsage || {},
        consumption: [
          { label: '会话', value: fmt(codex.aggregate && codex.aggregate.totalSessions) },
          { label: 'Tokens', value: fmt(codex.aggregate && codex.aggregate.totalTokens) },
        ],
      },
      {
        id: 'dsh', name: 'dsh-tui', mark: 'D', installed: Boolean(dsh.installed),
        profiles: (dsh.profiles || []).map(function (item) {
          return { id: JSON.stringify({ provider: item.provider, model: item.model }), name: item.name,
            detail: item.providerName, kind: 'api',
            current: dsh.backend === 'dsh' && dsh.provider === item.provider && dsh.model === item.model,
            switchable: true, switchAction: 'activate-dsh', agentId: 'dsh', quota: [] };
        }).concat(managedProfiles('dsh')),
        note: dsh.reason || (dsh.installed ? '原生 DSH 后端 · 启动：dsh-tui --backend dsh；已有会话可用 /model 选择集团模型。' : '尚未发现本机 dsh-tui profile'),
        sessions: [], modelUsage: {},
        consumption: [{ label: '版本', value: dsh.version || '—' }, { label: '后端', value: dsh.backend || '—' }],
      },
      {
        id: 'qoder', name: 'Qoder', mark: 'Q', installed: Boolean(qoder.installed),
        profiles: qoder.installed ? [{
          id: 'qoder-official', name: 'Qoder 当前登录', detail: enterprise.qoder && enterprise.qoder.userType === 'teams' ? '集团账号' : '官方账号', kind: 'subscription', current: true, switchable: false,
          message: qoder.usage && (qoder.usage.error || qoder.usage.unavailable),
          configureAction: qoderPool && qoderPool.usage ? null : 'configure-qoder',
          externalApp: enterprise.available ? 'alilang' : null, externalLabel: '在阿里郎查看',
          capabilityNote: enterprise.qoder && enterprise.qoder.reason,
          quota: qoder.usage && qoder.usage.usedPercent != null ? [{ label: 'Credits', value: qoder.usage }] : [],
        }] : [],
        sessions: qoder.recentSessions || [],
        modelUsage: qoder.modelUsage || {}, usageScope: qoder.usageScope,
        consumption: [
          { label: '会话', value: fmt(qoder.totalSessions || 0) },
          { label: '消息（近期）', value: fmt(qoder.totalMessages || 0) },
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
      return item.value && item.value.usedPercent != null && Number.isFinite(Number(item.value.usedPercent));
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

  function renderEnterprisePools(agent) {
    var enterprise = state.hub && state.hub.enterprise;
    if (!enterprise || !enterprise.available) return '';
    return (enterprise.pools || []).filter(function (pool) {
      return !(agent.id === 'qoder' && pool.id === 'qoder-ide' && pool.usage);
    }).map(function (pool) {
      var needsAuthorization = !pool.usage && pool.status === 'needs-authorization';
      var statusLabel = pool.usage ? '当前登录账号' : (needsAuthorization ? '等待系统授权' : '查询未接通');
      return '<article class="ah-usage-card ah-enterprise-pool"><div class="ah-usage-title"><strong>' + esc(pool.name)
        + '</strong><span>' + statusLabel + '</span></div>'
        + (pool.usage ? quotaBar('月 Credits', pool.usage) : '<p class="ah-enterprise-status">' + esc(pool.reason || '暂未获得额度数据') + '</p>')
        + (needsAuthorization ? '<p class="ah-enterprise-help">若 macOS 弹出证书或私钥访问提示，请选择“允许”后重试。</p>' : '')
        + '<button class="ms-btn ghost compact" data-ah-action="refresh-enterprise-quota">重新读取额度</button></article>';
    }).join('');
  }

  function renderProfileQuota(profile) {
    var notice = profile.message ? '<div class="ah-account-message">' + esc(profile.message) + '</div>' : '';
    var bars = (profile.quota || []).map(function (item) { return quotaBar(item.label, item.value); }).join('');
    var provider = profile.provider;
    var usage = provider && provider.usage;
    var financials = '';
    if (usage && (Number.isFinite(usage.balance) || Number.isFinite(usage.spent))) {
      financials = '<div class="ah-budget-list">'
        + (Number.isFinite(usage.balance) ? '<span>余额 <strong>¥' + esc(usage.balance.toFixed(2)) + '</strong></span>' : '')
        + (Number.isFinite(usage.spent) ? '<span>累计消费 <strong>¥' + esc(usage.spent.toFixed(2)) + '</strong></span>' : '') + '</div>';
    }
    if (bars) return notice + bars + financials;
    if (financials) return notice + financials;
    if (provider && (Number.isFinite(provider.dailyLimitUsd) || Number.isFinite(provider.monthlyLimitUsd))) {
      return notice + '<div class="ah-budget-list">'
        + (Number.isFinite(provider.dailyLimitUsd) ? '<span>日预算 <strong>$' + esc(provider.dailyLimitUsd) + '</strong></span>' : '')
        + (Number.isFinite(provider.monthlyLimitUsd) ? '<span>月预算 <strong>$' + esc(provider.monthlyLimitUsd) + '</strong></span>' : '') + '</div>';
    }
    return notice || '<div class="ah-account-message">' + (profile.kind === 'api' ? '用量由 API 服务侧计费' : '暂未读取到额度') + '</div>';
  }

  function renderProfiles(agent) {
    if (!agent.profiles.length) return '<div class="ah-empty">未发现可用运行身份。</div>';
    function card(profile) {
      var managed = profile.switchAction === 'activate-managed';
      var controls = [];
      if (profile.externalApp) controls.push('<button class="ms-btn ghost compact" data-ah-action="open-enterprise-app" data-app="'
        + esc(profile.externalApp) + '">' + esc(profile.externalLabel || '打开应用') + '</button>');
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
      return '<article class="ah-profile-card' + (managed ? ' ah-managed-profile' : '') + (profile.current ? ' active' : '') + '"><div class="ah-account-top"><div>'
        + '<div class="ah-profile-type">' + esc(profileTypeLabel(profile)) + '</div><div class="ah-account-name">' + esc(profile.name) + '</div>'
        + '<div class="ah-account-meta">' + esc(profile.detail || '') + (profile.secondary ? ' · ' + esc(profile.secondary) : '') + '</div></div>' + control + '</div>'
        + (managed ? '' : renderProfileQuota(profile))
        + (profile.capabilityNote ? '<p class="ah-capability-note">' + esc(profile.capabilityNote) + '</p>' : '')
        + (managed ? '' : '<div class="ah-account-foot"><span>' + (profile.current ? '新会话将使用此身份' : (profile.switchable ? '切换不影响运行中的会话' : '当前仅查看，暂不支持面板内切换')) + '</span>'
        + (profile.lastWarmupAt ? '<span>最近' + (profile.lastWarmupMode === 'automatic' ? '自动' : '') + '暖号 ' + esc(relative(profile.lastWarmupAt)) + '</span>'
          : (profile.expiresAt ? '<span>订阅至 ' + esc(profile.expiresAt.slice(0, 10)) + '</span>' : (profile.lastUsedAt ? '<span>最近使用 ' + esc(relative(profile.lastUsedAt)) + '</span>' : '')))
        + '</div>') + '</article>';
    }
    var managed = agent.profiles.filter(function (profile) { return profile.switchAction === 'activate-managed'; });
    var regular = agent.profiles.filter(function (profile) { return profile.switchAction !== 'activate-managed'; });
    var managedMessage = managed.find(function (profile) { return profile.message; });
    return (agent.note ? '<p class="ah-managed-note">' + esc(agent.note) + '</p>' : '') + '<div class="ah-profile-grid">' + regular.map(card).join('')
      + (managed.length ? '<div class="ah-managed-models"><p class="ah-managed-note">'
        + esc(managedMessage ? managedMessage.message : '集团模型共用月 Credits，额度统一见下方“额度与消耗”。切换仅对新会话生效。')
        + '</p>' + managed.map(card).join('') + '</div>' : '') + '</div>';
  }

  function renderUsage(agent) {
    var profile = currentProfile(agent);
    var sharedQuota = profile && profile.enterprise && state.hub && state.hub.enterprise
      && state.hub.enterprise.available && (state.hub.enterprise.pools || []).some(function (pool) { return pool.id === 'enterprise'; });
    var quota = profile ? renderProfileQuota(profile) : '<div class="ah-account-message">当前运行身份未识别</div>';
    var models = Object.entries(agent.modelUsage || {}).map(function (entry) {
      var usage = entry[1];
      var cache = Number(usage.cachedInputTokens || 0) + Number(usage.cacheReadInputTokens || 0) + Number(usage.cacheCreationInputTokens || 0);
      // Codex input includes cached tokens; Claude/Qoder report them separately.
      var input = Math.max(0, Number(usage.inputTokens || 0) - Number(usage.cachedInputTokens || 0));
      var output = Number(usage.outputTokens || 0);
      var total = usage.totalTokens == null ? input + output + cache : Number(usage.totalTokens);
      return { name: entry[0], input: input, output: output, cache: cache, total: total };
    }).sort(function (a, b) { return b.total - a.total; });
    var details = models.length ? '<div class="ah-model-usage"><table role="table"><caption>模型用量 · ' + esc(agent.usageScope || '本地历史会话')
      + '</caption><thead><tr role="row"><th scope="col">模型</th><th scope="col">非缓存输入</th><th scope="col">输出</th><th scope="col">缓存</th><th scope="col">总 Tokens</th></tr></thead><tbody role="rowgroup">'
      + models.map(function (model) {
        return '<tr role="row"><th role="rowheader" scope="row">' + esc(model.name) + '</th>'
          + '<td role="cell" data-label="非缓存输入">' + fmt(model.input) + '</td><td role="cell" data-label="输出">' + fmt(model.output)
          + '</td><td role="cell" data-label="缓存">' + fmt(model.cache) + '</td><td role="cell" data-label="总 Tokens">' + fmt(model.total) + '</td></tr>';
      }).join('') + '</tbody></table></div>' : '<div class="ah-account-message">本地日志尚未记录 Token 明细</div>';
    return '<div class="ah-usage-grid">' + (sharedQuota ? '' : '<article class="ah-usage-card"><div class="ah-usage-title"><strong>' + (agent.id === 'qoder' && profile && !profile.configureAction ? 'Qoder 月额度' : '额度') + '</strong><span>归属当前运行身份</span></div>' + quota + '</article>')
      + '<article class="ah-usage-card"><div class="ah-usage-title"><strong>本地消耗</strong><span>' + esc(agent.usageScope || '由历史会话汇总') + '</span></div><div class="ah-consumption">'
      + agent.consumption.map(function (item) { return '<div><strong>' + esc(item.value) + '</strong><span>' + esc(item.label) + '</span></div>'; }).join('')
      + '</div></article>' + renderEnterprisePools(agent) + '</div>' + details;
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
      + '</div></div>'
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
      machineApi.get('/api/agent-hub' + (query.length ? '?' + query.join('&') : '')),
      visible.claude ? machineApi.get('/api/claude-usage') : Promise.resolve({}),
      visible.codex ? machineApi.get('/api/codex-usage') : Promise.resolve({}),
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
    if (action === 'refresh') {
      load();
      return;
    }
    if (action === 'open-enterprise-app') {
      button.disabled = true;
      machineApi.post('/api/agent-hub/enterprise/apps/' + encodeURIComponent(button.dataset.app) + '/open')
        .then(function () { window.AppShell.toast('已打开应用，请在应用内查看额度或切换模型'); })
        .catch(function (error) { window.AppShell.toast(error.message || '无法打开应用'); })
        .finally(function () { button.disabled = false; });
      return;
    }
    if (action === 'refresh-enterprise-quota') {
      button.disabled = true;
      var refreshLabel = button.textContent;
      button.textContent = '正在读取…';
      machineApi.post('/api/agent-hub/enterprise/quota/refresh').then(function (result) {
        var alilang = result && result.alilang;
        if (alilang && alilang.status !== 'available' && alilang.reason) window.AppShell.toast(alilang.reason);
        return load();
      })
        .catch(function (error) { window.AppShell.toast(error.message || '额度读取失败'); })
        .finally(function () { button.disabled = false; button.textContent = refreshLabel; });
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
        return machineApi.post('/api/agent-hub/qoder/session', { cookieHeader: cookieHeader, site: 'international' })
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
        return machineApi.post(endpoint + encodeURIComponent(warmupProfileId) + '/warmup')
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
        return machineApi.post(endpoint + encodeURIComponent(autoProfileId) + '/auto-warmup', { enabled: enableAuto })
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
    if (action === 'activate-account' || action === 'activate-provider' || action === 'activate-managed' || action === 'activate-dsh') {
      var isAccount = action === 'activate-account';
      var agentId = isAccount ? 'codex' : (button.dataset.agentId || 'codex');
      var agentName = agentId === 'dsh' ? 'dsh-tui' : agentId === 'claude' ? 'Claude' : 'Codex';
      var targetName = button.dataset.targetName || '这个运行身份';
      var proceed = window.showConfirm ? window.showConfirm({
        title: '切换 ' + agentName + ' 运行身份',
        message: '切换到“' + targetName + '”。新启动的 ' + agentName + ' 会话将使用它；正在运行的会话不会改变。',
        confirmText: '切换',
      }) : Promise.resolve(window.confirm('切换 Codex 运行身份？'));
      proceed.then(function (yes) {
        if (!yes) return;
        button.disabled = true;
        var endpoint = action === 'activate-dsh' ? '/api/agent-hub/dsh/models/activate' : action === 'activate-managed'
          ? '/api/agent-hub/enterprise/models/' + encodeURIComponent(button.dataset.providerId) + '/activate'
          : isAccount
          ? '/api/agent-hub/codex-switcher/' + encodeURIComponent(button.dataset.accountId) + '/activate'
          : '/api/agent-hub/providers/' + encodeURIComponent(button.dataset.providerId) + '/activate';
        return machineApi.post(endpoint, action === 'activate-dsh' ? JSON.parse(button.dataset.providerId) : isAccount ? undefined : { agent: agentId })
          .then(function () { window.AppShell.toast('已切换到 ' + targetName + '，新会话生效'); return load(); })
          .catch(function (error) { button.disabled = false; window.AppShell.toast(error.message || '切换失败'); });
      });
    }
  }

  function start() {
    stop();
    root = document.getElementById('agent-hub');
    if (!root) return;
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

  return { renderSkeleton: renderSkeleton, start: start, stop: stop, _state: state, _normalizeAgents: normalizeAgents };
})();
