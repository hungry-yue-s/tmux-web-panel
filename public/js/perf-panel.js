// Perf panel — Observatory layout. Top-level tabs: 性能 / Claude.
// Self-managing: polls only while its DOM root exists.
var PerfPanel = (function () {
  var POLL_MS = 2000;
  var HISTORY_POLL_MS = 4000;
  var CLAUDE_POLL_MS = 30000;
  var DEFAULT_RANGE = 60; // seconds

  var U = window.PerfUtils;
  var fmtBytes   = U.fmtBytes;
  var fmtBps     = U.fmtBps;
  var fmtUptime  = U.fmtUptime;
  var fmtPercent = U.fmtPercent;
  var colorFor   = U.colorFor;

  var state = {
    activeTab: 'perf',
    range: DEFAULT_RANGE,
    snapshot: null,
    history: { points: [] },
    drilldown: new Map(),    // windowKey → { fetchedAt, procs }
    timers: { snap: null, hist: null, claude: null },
  };
  // Claude state is kept identical to the old module so the verbatim paintClaude
  // call site continues to work unchanged.
  var claudeState = { data: null, loading: false };

  function escapeHtml(s) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // === Skeleton ===
  function renderSkeleton() {
    return [
      '<div id="perf-panel" class="pp-card">',
      '  <div class="pp-toptabs">',
      '    <div class="pp-toptabs-l">',
      '      <button class="pp-tt pp-active" data-view="perf">📊 机器性能<span class="pp-tt-badge" id="pp-badge-perf" hidden></span></button>',
      '      <button class="pp-tt" data-view="claude">💰 Claude 用量<span class="pp-tt-badge" id="pp-badge-claude" hidden></span></button>',
      '    </div>',
      '  </div>',
      '  <div class="pp-view pp-active" id="view-perf"><div id="perf-view-root"><div class="pp-loading">加载机器与窗口性能…</div></div></div>',
      '  <div class="pp-view" id="view-claude"><div id="claude-view-root"><div class="pp-loading">加载 Claude 用量…</div></div></div>',
      '</div>',
    ].join('');
  }

  function bindTopTabs() {
    var btns = document.querySelectorAll('#perf-panel .pp-tt');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function (e) {
        switchTab(e.currentTarget.getAttribute('data-view'));
      });
    }
  }

  function switchTab(name) {
    state.activeTab = name;
    document.querySelectorAll('#perf-panel .pp-tt').forEach(function (b) {
      b.classList.toggle('pp-active', b.getAttribute('data-view') === name);
    });
    document.querySelectorAll('#perf-panel .pp-view').forEach(function (v) {
      v.classList.toggle('pp-active', v.id === 'view-' + name);
    });
    // Repaint the now-visible tab immediately so the user doesn't wait for next poll.
    if (name === 'perf' && state.snapshot) paintPerf();
    if (name === 'claude' && claudeState.data) paintClaude(document.getElementById('claude-view-root'));
  }

  // === Renderers (filled in by Tasks 8–12) ===
  function renderHero(s, alerts) {
    var t = s.total;
    var cpuMachinePct = t.cpuCount > 0 ? (t.windowCpuPercent / (t.cpuCount * 100)) * 100 : 0;
    var memPct = t.systemMemTotal > 0 ? (t.systemMemUsed / t.systemMemTotal) * 100 : 0;
    var rootDisk = (s.disks || []).find(function (d) { return d.mount === '/'; }) || (s.disks && s.disks[0]) || null;

    var rangeOptions = [{v:60,l:'1分'},{v:600,l:'10分'},{v:3600,l:'1小时'}];

    var alertPill = '';
    if (alerts.critical.length > 0) {
      alertPill = '<div class="pp-alert"><span class="pp-alert-dot"></span>' + escapeHtml(alerts.critical.length + ' 项告警 · ' + alerts.critical[0].message) + '</div>';
    }

    var html = '<div class="pp-hdr">';
    html += '<div class="pp-hdr-l">';
    html += '  <div class="pp-host-badge"><span class="pp-pulse"></span><span class="pp-host">' + escapeHtml(t.hostname) + '</span><span class="pp-host-meta">' + t.cpuCount + ' cores · load ' + t.load1.toFixed(2) + ' · up ' + U.fmtUptime(t.uptime) + '</span></div>';
    html += alertPill;
    html += '</div>';
    html += '<div class="pp-hdr-r"><div class="pp-range">';
    rangeOptions.forEach(function (r) {
      html += '<button class="pp-rb' + (r.v === state.range ? ' pp-active' : '') + '" data-range="' + r.v + '">' + r.l + '</button>';
    });
    html += '</div></div>';
    html += '</div>';

    // KPI hero
    var historyTotals = (state.history.points || []);
    var sparkCpu = historyTotals.map(function (p) { return p.total.cpu / (t.cpuCount * 100); });
    var sparkMem = historyTotals.map(function (p) { return p.total.mem / t.systemMemTotal; });
    var sparkIo  = historyTotals.map(function (p) { return p.total.io; });
    var ioCurrent = sparkIo.length ? sparkIo[sparkIo.length - 1] : t.windowIoBps;

    function kpi(cls, label, valueText, unit, sub, sparkValues, color, bar) {
      var sp = sparkValues && sparkValues.length ? U.sparkPath(sparkValues, 160, 32, { pad: 2 }) : null;
      var spId = 'pp-sg-' + cls;
      var spSvg = sp ? '<svg viewBox="0 0 160 32" preserveAspectRatio="none" class="pp-kpi-spark"><defs><linearGradient id="' + spId + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="' + color + '" stop-opacity=".4"/><stop offset="100%" stop-color="' + color + '" stop-opacity="0"/></linearGradient></defs><path d="' + sp.fill + '" fill="url(#' + spId + ')"/><path d="' + sp.line + '" fill="none" stroke="' + color + '" stroke-width="1.6"/></svg>' : '';
      var barHtml = bar != null ? '<div class="pp-kpi-bar"><div style="width:' + Math.min(100, bar) + '%;background:' + color + '"></div></div>' : '';
      return '<div class="pp-kpi pp-kpi-' + cls + '">' +
        '<div class="pp-kpi-row"><span class="pp-kpi-label">' + label + '</span></div>' +
        '<div class="pp-kpi-value">' + valueText + '<span class="pp-kpi-unit">' + unit + '</span></div>' +
        '<div class="pp-kpi-sub">' + escapeHtml(sub) + '</div>' +
        spSvg + barHtml +
        '</div>';
    }

    html += '<div class="pp-kpis">';
    html += kpi('cpu',  'CPU', cpuMachinePct.toFixed(0), '% of cores', t.windowCpuPercent.toFixed(0) + '% / ' + (t.cpuCount * 100) + '%',
                sparkCpu, 'var(--accent-red)', cpuMachinePct);
    html += kpi('mem',  'MEM', memPct.toFixed(0), '%', U.fmtBytes(t.systemMemUsed) + ' / ' + U.fmtBytes(t.systemMemTotal),
                sparkMem, 'var(--accent-blue)', memPct);
    html += kpi('io',   'IO',  U.fmtBps(ioCurrent).split(' ')[0], U.fmtBps(ioCurrent).split(' ').slice(1).join(' '),
                '累计 ' + U.fmtBytes(ioCurrent * 60) + ' / 1min', sparkIo, 'var(--accent-yellow)', null);
    if (rootDisk) {
      html += kpi('disk', 'DISK ' + rootDisk.mount, String(rootDisk.percent), '%', U.fmtBytes(rootDisk.used) + ' / ' + U.fmtBytes(rootDisk.total),
                  null, 'var(--accent-green)', rootDisk.percent);
    }
    html += '</div>';
    return html;
  }

  function renderPressureList(_) { return '<div class="pp-loading-row">…</div>'; }
  function renderTrendChart() { return '<div class="pp-loading-row">…</div>'; }
  function renderTable(_) { return '<div class="pp-loading-row">…</div>'; }
  function bindRangeButtons() {
    document.querySelectorAll('#perf-panel .pp-rb').forEach(function (b) {
      b.addEventListener('click', function (e) {
        state.range = Number(e.currentTarget.getAttribute('data-range'));
        tickHist();
        paintPerf();
      });
    });
  }
  function bindTableRows() { /* filled in by Task 12 */ }

  function paintPerf() {
    var root = document.getElementById('perf-view-root');
    if (!root) return;
    if (!state.snapshot) { root.innerHTML = '<div class="pp-loading">加载机器与窗口性能…</div>'; return; }
    var s = state.snapshot;
    var alerts = U.detectAlerts(s);
    var html = '';
    html += renderHero(s, alerts);
    html += '<div class="pp-row-2col">';
    html += '  <div class="pp-card pp-pressure-card"><div class="pp-card-title"><h3>⚡ Top 压力来源</h3><span class="pp-hint">CPU 50% · MEM 35% · IO 15% 加权</span></div><div class="pp-pressure-list" id="pp-pressure-list">' + renderPressureList(s) + '</div></div>';
    html += '  <div class="pp-card pp-trend-card"><div class="pp-card-title"><h3>📈 历史趋势</h3><span class="pp-hint">最近 ' + state.range + ' 秒</span></div><div class="pp-trend-legend"><span class="pp-li"><span class="pp-sw" style="background:var(--accent-red)"></span>CPU</span><span class="pp-li"><span class="pp-sw" style="background:var(--accent-blue)"></span>MEM</span><span class="pp-li"><span class="pp-sw" style="background:var(--accent-yellow)"></span>IO</span></div><div class="pp-trend" id="pp-trend">' + renderTrendChart() + '</div></div>';
    html += '</div>';
    html += '<div class="pp-card pp-wt-card"><div class="pp-card-title"><h3>🪟 Windows & 系统进程</h3><span class="pp-hint">点击行展开进程详情 · 按 CPU 排序</span></div>' + renderTable(s) + '</div>';
    root.innerHTML = html;
    bindRangeButtons();
    bindTableRows();
  }

  // === paintClaude — pasted verbatim from old module in Task 13 ===
  function paintClaude(_root) {
    var root = _root || document.getElementById('claude-view-root');
    if (!root) return;
    if (!claudeState.data) { root.innerHTML = '<div class="pp-loading">加载 Claude 用量…</div>'; return; }
    root.innerHTML = '<pre style="padding:20px;color:var(--text-muted);font-size:11px">claude data ready (placeholder)</pre>';
  }

  // === Polling loops ===
  function tickSnap() {
    if (!document.getElementById('perf-panel')) { stop(); return; }
    fetch('/api/window-stats', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (resp) {
        if (!resp || !resp.success) return;
        state.snapshot = resp.data;
        updatePerfBadge();
        if (state.activeTab === 'perf') paintPerf();
      })
      .catch(function () { /* swallow transient */ });
  }

  function tickHist() {
    if (!document.getElementById('perf-panel')) { stop(); return; }
    fetch('/api/perf/history?window=' + state.range, { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (resp) {
        if (!resp || !resp.success) return;
        state.history = resp.data;
        if (state.activeTab === 'perf') paintPerf();
      })
      .catch(function () {});
  }

  function tickClaude() {
    if (!document.getElementById('perf-panel')) { stop(); return; }
    if (claudeState.loading) return;
    claudeState.loading = true;
    fetch('/api/claude-usage', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (resp) {
        claudeState.loading = false;
        if (!resp || !resp.success) return;
        claudeState.data = resp.data;
        updateClaudeBadge();
        if (state.activeTab === 'claude') paintClaude(document.getElementById('claude-view-root'));
      })
      .catch(function () { claudeState.loading = false; });
  }

  function updatePerfBadge() {
    if (!state.snapshot || !U) return;
    var a = U.detectAlerts(state.snapshot);
    var el = document.getElementById('pp-badge-perf');
    if (!el) return;
    if (a.critical.length === 0) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = String(a.critical.length);
    el.className = 'pp-tt-badge pp-badge-bad';
  }

  function updateClaudeBadge() {
    var d = claudeState.data;
    var el = document.getElementById('pp-badge-claude');
    if (!el) return;
    if (!d || !d.utilization || !d.utilization.seven_day) { el.hidden = true; return; }
    var pct = Math.floor(d.utilization.seven_day.utilization);
    el.hidden = false;
    el.textContent = '7d ' + pct + '%';
    el.className = 'pp-tt-badge ' + (pct >= 85 ? 'pp-badge-bad' : pct >= 60 ? 'pp-badge-warn' : 'pp-badge-ok');
  }

  function start() {
    bindTopTabs();
    tickSnap();
    tickHist();
    tickClaude();
    stop();
    state.timers.snap = setInterval(tickSnap, POLL_MS);
    state.timers.hist = setInterval(tickHist, HISTORY_POLL_MS);
    state.timers.claude = setInterval(tickClaude, CLAUDE_POLL_MS);
  }

  function stop() {
    ['snap', 'hist', 'claude'].forEach(function (k) {
      if (state.timers[k]) clearInterval(state.timers[k]);
      state.timers[k] = null;
    });
  }

  return { renderSkeleton: renderSkeleton, start: start, stop: stop, _state: state };
})();
