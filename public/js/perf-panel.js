// Perf panel — Observatory layout. Top-level tabs: 性能 / Claude / Codex.
// Self-managing: polls only while its DOM root exists.
var PerfPanel = (function () {
  var POLL_MS = 2000;
  var HISTORY_POLL_MS = 4000;
  var CLAUDE_POLL_MS = 30000;
  var CODEX_POLL_MS = 30000;
  var DEFAULT_RANGE = 60; // seconds

  var U = window.PerfUtils;
  var fmtBytes   = U.fmtBytes;
  var fmtBps     = U.fmtBps;
  var fmtUptime  = U.fmtUptime;
  var fmtPercent = U.fmtPercent;
  var colorFor   = U.colorFor;

  var state = {
    range: DEFAULT_RANGE,
    snapshot: null,
    history: { points: [] },
    drilldown: new Map(),    // windowKey → { fetchedAt, procs }
    timers: { snap: null, hist: null, claude: null, codex: null },
  };
  // Claude state is kept identical to the old module so the verbatim paintClaude
  // call site continues to work unchanged.
  var claudeState = { data: null, loading: false };
  var codexState = { data: null, loading: false };

  function escapeHtml(s) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function hasCapability(snapshot, name) {
    return !snapshot.capabilities || snapshot.capabilities[name] !== false;
  }

  // === Skeleton ===
  function panelMode(mode) {
    return mode === 'performance' || mode === 'codex' ? mode : 'all';
  }

  /**
   * Builds only the sections owned by this route. The legacy shell omits mode
   * and keeps the complete dashboard; the multi-server shell splits Codex into
   * its own top-level section without copying any renderer code.
   */
  function renderSkeleton(mode) {
    var selected = panelMode(mode);
    var sections = [];
    if (selected !== 'codex') {
      sections.push(panelSection('perf', '机器性能', '加载机器与窗口性能…'));
      sections.push(panelSection('claude', 'Claude 用量', '加载 Claude 用量…'));
    }
    if (selected !== 'performance') {
      sections.push(panelSection('codex', 'Codex 用量', '加载 Codex 用量…'));
    }
    return '<div id="perf-panel" class="pp-card">' + sections.join('') + '</div>';
  }

  function panelSection(name, title, loading) {
    return '<div class="section"><div class="section-head"><h3>' + title + '</h3>'
      + '<span class="ms-badge" id="pp-badge-' + name + '" hidden></span></div>'
      + '<div id="' + name + '-view-root"><div class="pp-loading">' + loading + '</div></div></div>';
  }

  // === Renderers (filled in by Tasks 8–12) ===
  function renderDiskKpi(disks, capabilities) {
    var count = disks.length;
    var rows = disks.map(function(d) {
      var pct = Number.isFinite(Number(d.percent)) ? Number(d.percent) : 0;
      var color = pct >= 95 ? 'var(--accent-red)' : pct >= 80 ? 'var(--accent-yellow)' : 'var(--accent-green)';
      var ioParts = [];
      if (capabilities.diskIoPerDevice === false) {
        ioParts.push('I/O —（仅提供整机吞吐）');
      } else {
        if (d.readBps > 100) ioParts.push('R ' + U.fmtBps(d.readBps));
        if (d.writeBps > 100) ioParts.push('W ' + U.fmtBps(d.writeBps));
      }
      var ioLine = ioParts.join(' · ') || 'I/O 0 B/s';
      return '<div class="pp-disk-row">' +
        '<div class="pp-disk-head">' +
          '<span class="pp-disk-mount" title="' + escapeHtml(d.mount) + '">' + escapeHtml(d.mount) + '</span>' +
          '<span class="pp-disk-pct">' + pct + '%</span>' +
        '</div>' +
        '<div class="pp-disk-bar"><div class="pp-disk-fill" style="width:' + pct + '%;background:' + color + '"></div></div>' +
        '<div class="pp-disk-io">' + escapeHtml(ioLine) + '</div>' +
      '</div>';
    }).join('');
    return '<div class="pp-kpi pp-kpi-disk">' +
      '<div class="pp-kpi-row">' +
        '<span class="pp-kpi-label">DISK</span>' +
        '<span class="pp-kpi-count">' + count + ' mount' + (count !== 1 ? 's' : '') + '</span>' +
      '</div>' +
      '<div class="pp-disk-list">' + rows + '</div>' +
    '</div>';
  }

  function renderHero(s, alerts) {
    var t = s.total;
    var capabilities = s.capabilities || {};
    var cpuMachinePct = Number.isFinite(t.systemCpuPercent) ? t.systemCpuPercent : null;
    var memPct = t.systemMemTotal > 0 ? (t.systemMemUsed / t.systemMemTotal) * 100 : 0;

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
    var sparkCpu = historyTotals.map(function (p) { return p.total.cpu / 100; });
    var sparkMem = historyTotals.map(function (p) { return p.total.mem / t.systemMemTotal; });
    var sparkIo  = historyTotals.map(function (p) { return p.total.io; });
    var ioCurrent = Number.isFinite(t.systemDiskIoBps)
      ? t.systemDiskIoBps
      : (sparkIo.length ? sparkIo[sparkIo.length - 1] : null);

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
    html += kpi('cpu', 'CPU', cpuMachinePct == null ? '—' : cpuMachinePct.toFixed(0), cpuMachinePct == null ? '' : '%',
                '整机 · tmux ' + t.windowCpuPercent.toFixed(0) + '% / ' + (t.cpuCount * 100) + '%',
                sparkCpu, 'var(--accent-red)', cpuMachinePct);
    var memSub = U.fmtBytes(t.systemMemUsed) + ' / ' + U.fmtBytes(t.systemMemTotal);
    if (Number.isFinite(t.systemMemCached)) memSub += ' · 缓存 ' + U.fmtBytes(t.systemMemCached);
    if (t.systemMemoryMetric === 'os-free-fallback') memSub += ' · 估算值';
    html += kpi('mem',  'MEM', memPct.toFixed(0), '%', memSub,
                sparkMem, 'var(--accent-blue)', memPct);
    var ioText = ioCurrent == null ? ['—', ''] : [U.fmtBps(ioCurrent).split(' ')[0], U.fmtBps(ioCurrent).split(' ').slice(1).join(' ')];
    html += kpi('io', 'IO', ioText[0], ioText[1],
                ioCurrent == null ? '当前平台不可用' : '整机磁盘吞吐', sparkIo, 'var(--accent-yellow)', null);
    html += renderDiskKpi(s.disks || [], capabilities);
    html += '</div>';
    return html;
  }

  function renderPressureList(s) {
    var t = s.total;
    var processIoAvailable = hasCapability(s, 'processIo');
    var items = [];
    (s.windows || []).forEach(function (w) {
      items.push({
        key: w.session + '|' + w.windowIndex,
        name: w.session + ':' + w.windowIndex + ' ' + w.windowName,
        ext: false,
        cpu: w.cpuPercent,
        mem: w.memBytes,
        io: w.ioBps,
        procs: w.procCount,
        score: U.pressureScore({ cpuPercent: w.cpuPercent, memBytes: w.memBytes, ioBps: w.ioBps }, t, s.capabilities),
      });
    });
    (s.external || []).forEach(function (e) {
      items.push({
        key: 'sys|' + e.comm,
        name: e.comm,
        ext: true,
        cpu: e.cpuPercent,
        mem: e.memBytes,
        io: e.ioBps,
        procs: e.procCount,
        score: U.pressureScore({ cpuPercent: e.cpuPercent, memBytes: e.memBytes, ioBps: e.ioBps }, t, s.capabilities),
      });
    });
    items.sort(function (a, b) { return b.score - a.score; });
    items = items.slice(0, 5);
    if (items.length === 0) return '<div class="pp-empty">暂无活跃 window</div>';

    return items.map(function (it, i) {
      return '<div class="pp-pr-row" data-rank="' + (i + 1) + '">' +
        '<span class="pp-pr-rank">' + (i + 1) + '</span>' +
        '<div class="pp-pr-main">' +
          '<div class="pp-pr-name">' + escapeHtml(it.name) + '<span class="pp-pr-tag' + (it.ext ? ' pp-pr-tag-ext' : '') + '">' + (it.ext ? 'system' : 'tmux') + '</span></div>' +
          '<div class="pp-pr-metrics">' +
            '<span class="pp-pr-m"><span class="pp-sw" style="background:var(--accent-red)"></span>' + it.cpu.toFixed(0) + '% CPU</span>' +
            '<span class="pp-pr-m"><span class="pp-sw" style="background:var(--accent-blue)"></span>' + U.fmtBytes(it.mem) + '</span>' +
            '<span class="pp-pr-m"><span class="pp-sw" style="background:var(--accent-yellow)"></span>' + (processIoAvailable ? U.fmtBps(it.io) : 'IO —') + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="pp-pr-score"><div class="pp-pr-score-num">' + it.score.toFixed(1) + '</div><div class="pp-pr-score-lbl">压力分</div></div>' +
      '</div>';
    }).join('');
  }
  function renderTrendChart() {
    var pts = (state.history && state.history.points) || [];
    if (pts.length === 0) {
      return '<svg viewBox="0 0 540 200" preserveAspectRatio="none" class="pp-trend-svg"><text x="270" y="100" text-anchor="middle" fill="var(--text-muted)" font-size="12">采样中…</text></svg>';
    }
    var t = (state.snapshot && state.snapshot.total) || {};
    var memMax = t.systemMemTotal || 1;
    var ioPeak = Math.max(1, Math.max.apply(null, pts.map(function (p) { return p.total.io; })));

    var series = [
      { color: 'var(--accent-red)',    name: 'cpu', values: pts.map(function (p) { return p.total.cpu / 100; }) },
      { color: 'var(--accent-blue)',   name: 'mem', values: pts.map(function (p) { return p.total.mem / memMax; }) },
      { color: 'var(--accent-yellow)', name: 'io',  values: pts.map(function (p) { return p.total.io / ioPeak; }) },
    ];

    var W = 540, H = 200;
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" class="pp-trend-svg">';
    for (var i = 1; i < 4; i++) {
      var y = (H / 4) * i;
      svg += '<line x1="0" y1="' + y + '" x2="' + W + '" y2="' + y + '" stroke="var(--border-subtle)" stroke-dasharray="2,4" opacity=".5"/>';
    }
    series.forEach(function (s, idx) {
      var p = U.sparkPath(s.values, W, H, { pad: 8 });
      var gid = 'pp-tg-' + idx;
      svg += '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="' + s.color + '" stop-opacity=".22"/><stop offset="100%" stop-color="' + s.color + '" stop-opacity="0"/></linearGradient></defs>';
      svg += '<path d="' + p.fill + '" fill="url(#' + gid + ')"/>';
      svg += '<path d="' + p.line + '" fill="none" stroke="' + s.color + '" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>';
    });
    svg += '</svg>';
    return svg;
  }
  function renderTable(s) {
    var t = s.total;
    var processIoAvailable = hasCapability(s, 'processIo');
    var rows = [];
    (s.windows || []).forEach(function (w) {
      rows.push({
        key: w.session + '|' + w.windowIndex,
        session: w.session,
        windowIndex: w.windowIndex,
        label: w.windowName,
        sLabel: w.session + ':' + w.windowIndex,
        ext: false,
        cpu: w.cpuPercent, mem: w.memBytes, io: w.ioBps, procs: w.procCount,
      });
    });
    (s.external || []).forEach(function (e) {
      rows.push({
        key: 'sys|' + e.comm,
        label: e.comm, sLabel: '[sys]', ext: true,
        cpu: e.cpuPercent, mem: e.memBytes, io: e.ioBps, procs: e.procCount,
      });
    });
    rows.sort(function (a, b) { return b.cpu - a.cpu; });
    if (rows.length === 0) return '<div class="pp-empty">暂无活动 tmux 窗口</div>';

    var maxMem = Math.max.apply(null, rows.map(function (r) { return r.mem; })) || 1;
    var maxIO = Math.max.apply(null, rows.map(function (r) { return r.io; })) || 1;
    // Per-key recent history from state.history.points
    var perKeyHist = {};
    (state.history.points || []).forEach(function (p) {
      (p.top || []).forEach(function (e) {
        if (!perKeyHist[e.key]) perKeyHist[e.key] = [];
        perKeyHist[e.key].push(e.cpu);
      });
    });

    var head =
      '<div class="pp-wt-head">' +
        '<span>名称</span><span class="pp-r">CPU</span><span>CPU 趋势</span>' +
        '<span class="pp-r">MEM</span><span class="pp-r">IO</span><span class="pp-r">P</span><span></span>' +
      '</div>';

    var body = rows.map(function (r) {
      var color = U.colorFor(r.key);
      var hist = perKeyHist[r.key] || [];
      var sp = hist.length >= 2 ? U.sparkPath(hist.slice(-20), 90, 22, { pad: 2 }) : null;
      var cpuCls = r.cpu >= 200 ? 'pp-hi' : r.cpu >= 80 ? 'pp-warn' : '';
      return '<div class="pp-wt-row" data-key="' + escapeHtml(r.key) + '"' + (r.ext ? '' : ' data-session="' + escapeHtml(r.session) + '" data-windowindex="' + escapeHtml(String(r.windowIndex)) + '"') + '>' +
        '<div class="pp-wt-name"><span class="pp-wt-icn" style="background:' + color + '"></span>' +
          '<span class="pp-wt-txt">' + (r.ext ? '<span class="pp-wt-sess">[sys]</span>' : '<span class="pp-wt-sess">' + escapeHtml(r.sLabel) + '</span>') + escapeHtml(r.label) + '</span></div>' +
        '<div class="pp-wt-cpu-val ' + cpuCls + '">' + r.cpu.toFixed(0) + '%</div>' +
        (sp ? '<svg class="pp-wt-spark" viewBox="0 0 90 22" preserveAspectRatio="none"><path d="' + sp.line + '" fill="none" stroke="' + color + '" stroke-width="1.4"/></svg>' : '<span class="pp-wt-spark">—</span>') +
        '<div class="pp-wt-bar" data-l="MEM"><div class="pp-wt-tr"><div class="pp-wt-fl" style="width:' + Math.min(100,(r.mem/maxMem)*100) + '%;background:var(--accent-blue)"></div></div><span class="pp-wt-lbl">' + U.fmtBytes(r.mem) + '</span></div>' +
        '<div class="pp-wt-bar" data-l="IO"><div class="pp-wt-tr"><div class="pp-wt-fl" style="width:' + (processIoAvailable ? Math.min(100,(r.io/maxIO)*100) : 0) + '%;background:var(--accent-yellow)"></div></div><span class="pp-wt-lbl">' + (processIoAvailable ? U.fmtBps(r.io) : '—') + '</span></div>' +
        '<span class="pp-wt-procs">' + r.procs + 'p</span>' +
        '<span class="pp-wt-arrow">›</span>' +
      '</div>';
    }).join('');
    return head + body;
  }
  function bindRangeButtons() {
    document.querySelectorAll('#perf-panel .pp-rb').forEach(function (b) {
      b.addEventListener('click', function (e) {
        state.range = Number(e.currentTarget.getAttribute('data-range'));
        tickHist();
        paintPerf();
      });
    });
  }
  function bindTableRows() {
    function renderDrill(procs) {
      procs = procs || [];
      if (procs.length === 0) {
        return '<div class="pp-wt-drill"><div class="pp-empty">暂无进程详情</div></div>';
      }
      var rows = procs.map(function (p) {
        return '<tr>' +
          '<td>' + escapeHtml(p.pid) + '</td>' +
          '<td>' + escapeHtml(p.comm || '') + '</td>' +
          '<td class="pp-r">' + fmtPercent(p.cpuPercent || 0) + '</td>' +
          '<td class="pp-r">' + fmtBytes(p.memBytes || 0) + '</td>' +
          '<td class="pp-wt-cmd">' + escapeHtml(p.cmdline || '') + '</td>' +
        '</tr>';
      }).join('');
      return '<div class="pp-wt-drill">' +
        '<table><thead><tr><th>PID</th><th>comm</th><th class="pp-r">CPU</th><th class="pp-r">MEM</th><th>cmdline</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '</div>';
    }

    function setDrill(row, html) {
      var open = row.querySelector('.pp-wt-drill');
      if (open) open.remove();
      row.insertAdjacentHTML('beforeend', html);
    }

    document.querySelectorAll('#perf-panel .pp-wt-row').forEach(function (row) {
      row.addEventListener('click', function () {
        var open = row.querySelector('.pp-wt-drill');
        if (open) { open.remove(); return; }

        var key = row.getAttribute('data-key') || '';
        if (key.indexOf('sys|') === 0) {
          setDrill(row, '<div class="pp-wt-drill">comm group drilldown not implemented</div>');
          return;
        }

        var cached = state.drilldown.get(key);
        if (cached && Date.now() - cached.ts < 5000) {
          setDrill(row, renderDrill(cached.procs));
          return;
        }

        var session = row.getAttribute('data-session');
        var windowIndex = row.getAttribute('data-windowindex');
        if (!session || windowIndex == null) return;

        var token = Date.now() + ':' + Math.random();
        row._ppDrillToken = token;
        setDrill(row, '<div class="pp-wt-drill"><div class="pp-loading">加载进程详情…</div></div>');
        api.get('/api/perf/drilldown?session=' + encodeURIComponent(session) + '&windowIndex=' + encodeURIComponent(windowIndex))
          .then(function (resp) {
            if (row._ppDrillToken !== token || !row.querySelector('.pp-wt-drill')) return;
            if (!resp || !resp.success) {
              setDrill(row, '<div class="pp-wt-drill"><div class="pp-empty">进程详情加载失败</div></div>');
              return;
            }
            var procs = (resp.data && resp.data.procs) || [];
            state.drilldown.set(key, { ts: Date.now(), procs: procs });
            setDrill(row, renderDrill(procs));
          })
          .catch(function () {
            if (row._ppDrillToken !== token || !row.querySelector('.pp-wt-drill')) return;
            setDrill(row, '<div class="pp-wt-drill"><div class="pp-empty">进程详情加载失败</div></div>');
          });
      });
    });
  }

  function paintPerf() {
    var root = document.getElementById('perf-view-root');
    if (!root) return;
    if (!state.snapshot) { root.innerHTML = '<div class="pp-loading">加载机器与窗口性能…</div>'; return; }
    var s = state.snapshot;
    var alerts = U.detectAlerts(s);
    var pressureHint = hasCapability(s, 'processIo')
      ? 'CPU 50% · MEM 35% · IO 15% 加权'
      : 'CPU 59% · MEM 41% 加权 · 进程 IO 不可用';
    var html = '';
    html += renderHero(s, alerts);
    html += '<div class="pp-row-2col">';
    html += '  <div class="pp-card pp-pressure-card"><div class="pp-card-title"><h3>⚡ Top 压力来源</h3><span class="pp-hint">' + pressureHint + '</span></div><div class="pp-pressure-list" id="pp-pressure-list">' + renderPressureList(s) + '</div></div>';
    html += '  <div class="pp-card pp-trend-card"><div class="pp-card-title"><h3>📈 历史趋势</h3><span class="pp-hint">最近 ' + state.range + ' 秒</span></div><div class="pp-trend-legend"><span class="pp-li"><span class="pp-sw" style="background:var(--accent-red)"></span>CPU</span><span class="pp-li"><span class="pp-sw" style="background:var(--accent-blue)"></span>MEM</span><span class="pp-li"><span class="pp-sw" style="background:var(--accent-yellow)"></span>IO</span></div><div class="pp-trend" id="pp-trend">' + renderTrendChart() + '</div></div>';
    html += '</div>';
    html += '<div class="pp-card pp-wt-card"><div class="pp-card-title"><h3>🪟 Windows & 系统进程</h3><span class="pp-hint">点击行展开进程详情 · 按 CPU 排序</span></div>' + renderTable(s) + '</div>';
    root.innerHTML = html;
    bindRangeButtons();
    bindTableRows();
  }

  // Claude usage palettes — referenced by the verbatim paintClaude block.
  var TOOL_COLORS = {
    Bash: '#7aa2f7', Read: '#7dcfff', Edit: '#bb9af7', Write: '#9ece6a',
    Agent: '#f6a623', Grep: '#e0af68', Glob: '#f7768e', Skill: '#73daca',
  };
  var MODEL_COLORS = ['#7aa2f7', '#9ece6a', '#bb9af7', '#7dcfff', '#e0af68', '#f7768e'];

  function fmtTokens(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
  }

  function meterColorClass(pct) {
    if (pct >= 80) return 'red';
    if (pct >= 50) return 'yellow';
    return 'green';
  }

  function modelShortName(id) {
    return id.replace(/^claude-/, '').replace(/-\d{8}$/, '');
  }

  function modelTagClass(id) {
    if (id.includes('opus')) return 'opus';
    if (id.includes('sonnet')) return 'sonnet';
    if (id.includes('haiku')) return 'haiku';
    return 'sonnet';
  }

  function paintClaude(_root) {
    var root = _root || document.getElementById('claude-view-root');
    if (!root) return;
    var d = claudeState.data;
    if (!d) {
      root.innerHTML = '<div class="pp-loading">加载 Claude 用量数据…</div>';
      return;
    }

    var html = '';

    // === Tier 1: Subscription Status ===
    if (d.utilization) {
      var u = d.utilization;
      html += '<div class="cu-sub-hero">';
      html += '<div class="cu-sub-top">';
      html += '<div style="display:flex;align-items:center;gap:8px">';
      html += '<span class="cu-plan-badge">' + escapeHtml(d.subscription.type || 'free') + '</span>';
      if (d.subscription.rateLimitTier) html += '<span class="cu-plan-tier">' + escapeHtml(d.subscription.rateLimitTier) + '</span>';
      html += '</div>';
      if (u.extra_usage && u.extra_usage.is_enabled) {
        var euCredits = u.extra_usage.used_credits || 0;
        var euLimitCents = u.extra_usage.monthly_limit || 0;
        html += '<div style="display:flex;align-items:center;gap:6px">';
        html += '<span class="cu-extra-badge">Extra Usage</span>';
        html += '<span class="cu-extra-text">$' + Math.round(euCredits) + ' / $' + Math.round(euLimitCents / 100) + '</span>';
        html += '</div>';
      }
      html += '</div>';
      html += '<div class="cu-meters">';

      var WINDOW_DURATIONS = { 'five_hour': 5 * 3600000, 'seven_day': 7 * 86400000 };

      function renderMeter(label, obj, windowKey) {
        if (!obj) return '';
        var pct = Math.floor(obj.utilization);
        var cls = meterColorClass(pct);
        var timePct = 0;
        var remain = 0;
        if (obj.resets_at) {
          remain = Math.max(0, new Date(obj.resets_at) - Date.now());
          var totalMs = WINDOW_DURATIONS[windowKey] || 0;
          if (totalMs > 0) timePct = Math.min(100, Math.max(0, ((totalMs - remain) / totalMs) * 100));
        }
        var s = '<div class="cu-meter">';
        s += '<span class="cu-meter-label">' + label + '</span>';
        s += '<div class="cu-meter-track">';
        s += '<div class="cu-meter-fill ' + cls + '" style="width:' + pct + '%"></div>';
        if (timePct > 0) s += '<div class="cu-meter-time" style="left:' + timePct.toFixed(1) + '%"></div>';
        s += '</div>';
        s += '<span class="cu-meter-val">' + pct + '%</span>';
        s += '</div>';
        if (obj.resets_at) {
          var rh = Math.floor(remain / 3600000);
          var rm = Math.floor((remain % 3600000) / 60000);
          var status = pct > timePct ? ' · 超前' : ' · 健康';
          s += '<div class="cu-meter-reset">重置于 ' + obj.resets_at.replace('T', ' ').slice(0, 16) + ' UTC（剩余 ' + rh + 'h ' + rm + 'm）' + status + '</div>';
        }
        return s;
      }

      html += renderMeter('5h 窗口', u.five_hour, 'five_hour');
      html += renderMeter('7d 总量', u.seven_day, 'seven_day');
      html += renderMeter('7d Sonnet', u.seven_day_sonnet, 'seven_day');

      if (u.extra_usage && u.extra_usage.is_enabled) {
        var euPct = Math.floor((u.extra_usage.utilization || 0) * 100);
        var euUsed = (u.extra_usage.used_credits || 0).toFixed(2);
        var euLimit = ((u.extra_usage.monthly_limit || 0) / 100).toFixed(2);
        html += '<div class="cu-extra-meter">';
        html += '<div class="cu-meter"><span class="cu-meter-label">Extra 本月</span>';
        html += '<div class="cu-meter-track"><div class="cu-meter-fill" style="width:' + euPct + '%;background:var(--accent-blue)"></div></div>';
        html += '<span class="cu-meter-val">' + euPct + '%</span></div>';
        html += '<div class="cu-extra-nums"><span>$' + euUsed + ' 已用</span><span>$' + euLimit + ' 上限</span></div>';
        html += '</div>';
      }
      html += '</div></div>';
    }

    // === Tier 2: Overview cards ===
    html += '<div class="cu-section-title">概览</div>';
    var agg = d.aggregate || {};
    html += '<div class="cu-row-3" style="margin-bottom:8px">';
    html += '<div class="cu-card cu-qs"><div class="cu-val">' + (agg.totalSessions || 0) + '</div><div class="cu-label">总会话</div>';
    if (agg.firstSessionDate) html += '<div class="cu-sub">自 ' + agg.firstSessionDate.slice(0, 10) + '</div>';
    html += '</div>';
    html += '<div class="cu-card cu-qs"><div class="cu-val">' + fmtTokens(agg.totalMessages || 0) + '</div><div class="cu-label">总消息</div></div>';
    html += '<div class="cu-card cu-qs"><div class="cu-code-inline">';
    html += '<span style="color:var(--accent-green);font-weight:700">+' + (d.totalLinesAdded || 0).toLocaleString() + '</span>';
    html += '<span style="color:var(--text-muted)">/</span>';
    html += '<span style="color:var(--accent-red);font-weight:700">-' + (d.totalLinesRemoved || 0).toLocaleString() + '</span>';
    html += '</div><div class="cu-label">代码行变更</div>';
    html += '<div class="cu-sub">' + (d.totalCommits || 0) + ' commits</div></div>';
    html += '</div>';

    // Model distribution + Cache efficiency
    var mu = d.modelUsage || {};
    var models = Object.keys(mu).sort(function (a, b) {
      var ta = (mu[a].inputTokens || 0) + (mu[a].outputTokens || 0) + (mu[a].cacheReadInputTokens || 0) + (mu[a].cacheCreationInputTokens || 0);
      var tb = (mu[b].inputTokens || 0) + (mu[b].outputTokens || 0) + (mu[b].cacheReadInputTokens || 0) + (mu[b].cacheCreationInputTokens || 0);
      return tb - ta;
    });
    var modelTotals = models.map(function (m) {
      var u2 = mu[m];
      return (u2.inputTokens || 0) + (u2.outputTokens || 0) + (u2.cacheReadInputTokens || 0) + (u2.cacheCreationInputTokens || 0);
    });
    var grandTotal = modelTotals.reduce(function (a, b) { return a + b; }, 0);
    var totalCacheRead = 0, totalCacheWrite = 0, totalInput = 0;
    models.forEach(function (m) {
      totalCacheRead += mu[m].cacheReadInputTokens || 0;
      totalCacheWrite += mu[m].cacheCreationInputTokens || 0;
      totalInput += mu[m].inputTokens || 0;
    });
    var cacheTotal = totalCacheRead + totalCacheWrite + totalInput;
    var cacheHitPct = cacheTotal > 0 ? Math.round((totalCacheRead / cacheTotal) * 100) : 0;

    html += '<div class="cu-row-2">';

    // Donut chart
    html += '<div class="cu-card"><div class="cu-card-label">模型分布</div><div class="cu-model-dist">';
    html += '<div class="cu-donut-wrap"><svg viewBox="0 0 100 100">';
    html += '<circle cx="50" cy="50" r="36" fill="none" stroke="var(--bg-card)" stroke-width="10"/>';
    var offset = 0;
    var circ = 2 * Math.PI * 36;
    models.forEach(function (m, i) {
      var frac = grandTotal > 0 ? modelTotals[i] / grandTotal : 0;
      var dash = frac * circ;
      var gap = circ - dash;
      html += '<circle cx="50" cy="50" r="36" fill="none" stroke="' + MODEL_COLORS[i % MODEL_COLORS.length] + '" stroke-width="10" stroke-dasharray="' + dash.toFixed(1) + ' ' + gap.toFixed(1) + '" stroke-dashoffset="' + (-offset).toFixed(1) + '" transform="rotate(-90 50 50)"/>';
      offset += dash;
    });
    html += '</svg></div>';
    html += '<div class="cu-model-list">';
    models.forEach(function (m, i) {
      html += '<div class="cu-model-row"><div class="cu-model-dot" style="background:' + MODEL_COLORS[i % MODEL_COLORS.length] + '"></div>';
      html += '<span class="cu-model-name">' + escapeHtml(modelShortName(m)) + '</span>';
      html += '<span class="cu-model-val">' + fmtTokens(modelTotals[i]) + '</span></div>';
    });
    html += '</div></div></div>';

    // Cache efficiency
    var gaugeCirc = 2 * Math.PI * 36;
    var gaugeFill = (cacheHitPct / 100) * gaugeCirc;
    var gaugeGap = gaugeCirc - gaugeFill;
    html += '<div class="cu-card"><div class="cu-card-label">缓存效率</div><div class="cu-cache-row">';
    html += '<div class="cu-cache-gauge"><svg viewBox="0 0 100 100">';
    html += '<circle cx="50" cy="50" r="36" fill="none" stroke="var(--bg-card)" stroke-width="8"/>';
    html += '<circle cx="50" cy="50" r="36" fill="none" stroke="var(--accent-green)" stroke-width="8" stroke-dasharray="' + gaugeFill.toFixed(1) + ' ' + gaugeGap.toFixed(1) + '" stroke-dashoffset="0" transform="rotate(-90 50 50)" stroke-linecap="round"/>';
    html += '</svg><div class="cu-cache-gauge-text">' + cacheHitPct + '%</div></div>';
    html += '<div class="cu-cache-detail">';
    html += '<div class="cu-cache-item"><span class="k">Read</span><span class="v">' + fmtTokens(totalCacheRead) + '</span></div>';
    html += '<div class="cu-cache-item"><span class="k">Write</span><span class="v">' + fmtTokens(totalCacheWrite) + '</span></div>';
    html += '<div class="cu-cache-item"><span class="k">Miss</span><span class="v">' + fmtTokens(totalInput) + '</span></div>';
    if (d.estimatedCost) html += '<div class="cu-cache-item"><span class="k">估算费用</span><span class="v" style="color:var(--accent-yellow)">$' + d.estimatedCost + '</span></div>';
    html += '</div></div></div>';
    html += '</div>';

    // === Tier 3: Trends ===
    html += '<div class="cu-section-title">趋势</div>';
    var ccDaily = d.ccusageDaily;
    if (ccDaily && ccDaily.length > 1) {
      var trendData = ccDaily.slice(-14);
      html += '<div class="cu-card"><div class="cu-card-label">每日 TOKEN 趋势</div>';
      var maxTok = Math.max.apply(null, trendData.map(function (d2) { return d2.totalTokens || 0; }).concat([1]));
      var maxCost = Math.max.apply(null, trendData.map(function (d2) { return d2.totalCost || 0; }).concat([1]));
      var tW = 700, tH = 80;
      var step = tW / Math.max(1, trendData.length - 1);
      html += '<svg class="cu-trend-svg" viewBox="0 0 ' + tW + ' ' + tH + '" preserveAspectRatio="none">';
      html += '<line x1="0" y1="' + (tH * 0.25) + '" x2="' + tW + '" y2="' + (tH * 0.25) + '" stroke="var(--border-subtle)" stroke-width="0.5"/>';
      html += '<line x1="0" y1="' + (tH * 0.5) + '" x2="' + tW + '" y2="' + (tH * 0.5) + '" stroke="var(--border-subtle)" stroke-width="0.5"/>';
      html += '<line x1="0" y1="' + (tH * 0.75) + '" x2="' + tW + '" y2="' + (tH * 0.75) + '" stroke="var(--border-subtle)" stroke-width="0.5"/>';
      var tokPts = trendData.map(function (d2, i) { return (i * step).toFixed(1) + ',' + (tH - ((d2.totalTokens || 0) / maxTok) * (tH - 4)).toFixed(1); });
      var costPts = trendData.map(function (d2, i) { return (i * step).toFixed(1) + ',' + (tH - ((d2.totalCost || 0) / maxCost) * (tH - 4)).toFixed(1); });
      html += '<path d="M' + tokPts.join(' L') + ' L' + tW + ',' + tH + ' L0,' + tH + 'Z" fill="rgba(122,162,247,0.1)"/>';
      html += '<polyline points="' + tokPts.join(' ') + '" fill="none" stroke="var(--accent-blue)" stroke-width="1.5"/>';
      html += '<polyline points="' + costPts.join(' ') + '" fill="none" stroke="var(--accent-orange)" stroke-width="1.2" stroke-dasharray="3,2"/>';
      html += '</svg>';
      html += '<div class="cu-trend-dates">';
      trendData.forEach(function (d2, i) {
        if (i % Math.ceil(trendData.length / 7) === 0 || i === trendData.length - 1) {
          var pct = (i / Math.max(1, trendData.length - 1) * 100).toFixed(1);
          html += '<span style="left:' + pct + '%">' + (d2.date || '').slice(5) + '</span>';
        }
      });
      html += '</div>';
      html += '<div class="cu-trend-legend"><div class="cu-trend-legend-item"><div class="cu-trend-legend-dot" style="background:var(--accent-blue)"></div>Tokens</div>';
      html += '<div class="cu-trend-legend-item"><div class="cu-trend-legend-dot" style="background:var(--accent-orange)"></div>Cost</div></div>';
      html += '</div>';
    }

    // Daily token table from session-meta aggregation
    // Daily token table — use ccusageDaily (accurate) if available, else session-meta (input+output only)
    var ccDaily = d.ccusageDaily;
    var ccTotals = d.ccusageTotals;
    if (ccDaily && ccDaily.length > 0) {
      var recentCc = ccDaily.slice().reverse().slice(0, 14);
      html += '<div class="cu-card" style="margin-top:8px"><div class="cu-card-label">每日 Token 明细</div>';
      html += '<table class="cu-token-table">';
      html += '<colgroup><col class="col-w-date"><col class="col-w-model"><col class="col-w-num"><col class="col-w-num"><col class="col-w-num"><col class="col-w-cost"></colgroup>';
      html += '<thead><tr>';
      html += '<th class="col-date">日期</th><th>模型</th>';
      html += '<th class="col-num">Input</th><th class="col-num">Output</th>';
      html += '<th class="col-num col-total">Total</th>';
      html += '<th class="col-num col-cost">Cost</th>';
      html += '</tr></thead><tbody>';
      var weekCost = 0, weekTokens = 0;
      recentCc.forEach(function (day, di) {
        var isAlt = di % 2 === 1;
        var altCls = isAlt ? ' class="row-alt"' : '';
        var bk = day.modelBreakdowns || [];
        var rowCount = Math.max(1, bk.length);
        bk.forEach(function (mb, mi) {
          html += '<tr' + altCls + '>';
          if (mi === 0) html += '<td class="col-date" rowspan="' + rowCount + '">' + day.date.slice(5) + '</td>';
          var mName = (mb.modelName || '').replace(/^claude-/, '').replace(/-\d{8}$/, '');
          html += '<td><span class="cu-model-tag ' + modelTagClass(mb.modelName || '') + '">' + escapeHtml(mName) + '</span></td>';
          html += '<td class="col-num">' + fmtTokens(mb.inputTokens || 0) + '</td>';
          html += '<td class="col-num">' + fmtTokens(mb.outputTokens || 0) + '</td>';
          var mbTotal = (mb.inputTokens || 0) + (mb.outputTokens || 0) + (mb.cacheCreationTokens || 0) + (mb.cacheReadTokens || 0);
          html += '<td class="col-num col-total">' + fmtTokens(mbTotal) + '</td>';
          if (mi === 0) html += '<td class="col-num col-cost" rowspan="' + rowCount + '">$' + (day.totalCost || 0).toFixed(2) + '</td>';
          html += '</tr>';
        });
        if (di < 7) { weekCost += day.totalCost || 0; weekTokens += day.totalTokens || 0; }
      });
      html += '</tbody><tfoot>';
      html += '<tr><td class="col-date" colspan="2" style="text-align:right;font-weight:600">7日合计</td>';
      html += '<td class="col-num" colspan="2"></td>';
      html += '<td class="col-num col-total">' + fmtTokens(weekTokens) + '</td>';
      html += '<td class="col-num col-cost">$' + weekCost.toFixed(2) + '</td></tr>';
      if (ccTotals) {
        var currentMonth = new Date().getMonth() + 1;
        html += '<tr><td class="col-date" colspan="2" style="text-align:right;font-weight:600;color:var(--text-muted)">' + currentMonth + '月合计</td>';
        html += '<td class="col-num" colspan="2"></td>';
        html += '<td class="col-num col-total">' + fmtTokens(ccTotals.totalTokens || 0) + '</td>';
        html += '<td class="col-num col-cost" style="color:var(--text-muted)">$' + (ccTotals.totalCost || 0).toFixed(2) + '</td></tr>';
      }
      html += '</tfoot></table></div>';
    } else {
      // Fallback: session-meta daily (no cache tokens, no model split)
      var daily = d.dailyActivity || [];
      var recentDays = daily.slice().reverse().slice(0, 14);
      if (recentDays.length > 0) {
        html += '<div class="cu-card" style="margin-top:8px"><div class="cu-card-label">每日明细（仅 Input+Output）</div>';
        html += '<table class="cu-token-table"><thead><tr>';
        html += '<th class="col-date">日期</th>';
        html += '<th class="col-num">会话</th><th class="col-num">消息</th>';
        html += '<th class="col-num col-total">Tokens</th>';
        html += '</tr></thead><tbody>';
        recentDays.forEach(function (day, di) {
          html += '<tr' + (di % 2 === 1 ? ' class="row-alt"' : '') + '>';
          html += '<td class="col-date">' + day.date.slice(5) + '</td>';
          html += '<td class="col-num">' + day.sessions + '</td>';
          html += '<td class="col-num">' + day.messages + '</td>';
          html += '<td class="col-num col-total">' + fmtTokens(day.tokens) + '</td>';
          html += '</tr>';
        });
        html += '</tbody></table></div>';
      }
    }

    // === Tier 4: Patterns ===
    html += '<div class="cu-section-title">使用画像</div>';
    html += '<div class="cu-row-2">';

    // Active hours bar chart
    var hc = d.hourCounts || {};
    var maxHVal = Math.max.apply(null, Object.values(hc).concat([1]));
    var peakHour = Object.keys(hc).reduce(function (a, b) { return (hc[a] || 0) > (hc[b] || 0) ? a : b; }, '0');
    html += '<div class="cu-card"><div class="cu-card-label">活跃时段</div>';
    html += '<div class="cu-hours-chart">';
    for (var h = 0; h < 24; h++) {
      var cnt = hc[String(h)] || 0;
      var barH = cnt > 0 ? Math.max(2, Math.round((cnt / maxHVal) * 52)) : 2;
      var lvl = cnt === 0 ? 'h0' : cnt <= maxHVal * 0.2 ? 'h1' : cnt <= maxHVal * 0.5 ? 'h2' : cnt <= maxHVal * 0.8 ? 'h3' : 'h4';
      html += '<div class="cu-hour-bar-col"><div class="cu-hour-bar ' + lvl + '" style="height:' + barH + 'px"></div></div>';
    }
    html += '</div>';
    html += '<div class="cu-hours-labels">';
    for (var h2 = 0; h2 < 24; h2++) {
      html += h2 % 3 === 0 ? '<span>' + h2 + '</span>' : '<span class="dim">.</span>';
    }
    html += '</div>';
    html += '<div class="cu-hour-peak">峰值 ' + peakHour + ':00</div></div>';

    // Tool usage bars
    var tools = d.aggregatedTools || {};
    var toolEntries = Object.entries(tools).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 8);
    var maxTool = toolEntries.length > 0 ? toolEntries[0][1] : 1;
    html += '<div class="cu-card"><div class="cu-card-label">工具使用</div><div class="cu-tool-bars">';
    toolEntries.forEach(function (e) {
      var name = e[0], count = e[1];
      var pct = (count / maxTool) * 100;
      var color = TOOL_COLORS[name] || '#7aa2f7';
      html += '<div class="cu-tool-row"><span class="cu-tool-name">' + escapeHtml(name) + '</span>';
      html += '<div class="cu-tool-bar-wrap"><div class="cu-tool-bar" style="width:' + pct.toFixed(1) + '%;background:' + color + '"></div></div>';
      html += '<span class="cu-tool-count">' + count + '</span></div>';
    });
    html += '</div></div>';
    html += '</div>';

    // === Tier 5: Recent Sessions ===
    var sessions = d.recentSessions || [];
    if (sessions.length > 0) {
      html += '<div class="cu-section-title">最近会话</div>';
      html += '<div class="cu-card"><div class="cu-session-list">';
      sessions.forEach(function (s) {
        var proj = (s.project_path || '').replace(/^\/home\/[^/]+/, '~');
        html += '<div class="cu-session-item"><div class="cu-session-main">';
        html += '<div class="cu-session-project">' + escapeHtml(proj) + '</div>';
        html += '<div class="cu-session-prompt">' + escapeHtml(s.first_prompt || '') + '</div>';
        html += '</div><div class="cu-session-meta">';
        html += '<span>' + (s.duration_minutes || 0) + 'm</span>';
        html += '<span>' + fmtTokens((s.input_tokens || 0) + (s.output_tokens || 0)) + '</span>';
        html += '<span style="color:var(--accent-green)">+' + (s.lines_added || 0) + '</span>';
        html += '<span style="color:var(--accent-red)">-' + (s.lines_removed || 0) + '</span>';
        html += '</div></div>';
      });
      html += '</div></div>';
    }

    root.innerHTML = html;
  }

  function codexModelShortName(id) {
    return String(id || 'unknown').replace(/^openai\//, '');
  }

  function renderCodexLimitMeter(label, obj) {
    if (!obj) return '';
    var pct = Math.floor(obj.used_percent || 0);
    var cls = meterColorClass(pct);
    var s = '<div class="cu-meter">';
    s += '<span class="cu-meter-label">' + label + '</span>';
    s += '<div class="cu-meter-track"><div class="cu-meter-fill ' + cls + '" style="width:' + Math.min(100, pct) + '%"></div></div>';
    s += '<span class="cu-meter-val">' + pct + '%</span>';
    s += '</div>';
    if (obj.resets_at) {
      var reset = new Date(obj.resets_at * 1000);
      var remain = Math.max(0, reset - Date.now());
      var rh = Math.floor(remain / 3600000);
      var rm = Math.floor((remain % 3600000) / 60000);
      s += '<div class="cu-meter-reset">窗口 ' + (obj.window_minutes || 0) + 'm · 重置于 ' + reset.toISOString().replace('T', ' ').slice(0, 16) + ' UTC（剩余 ' + rh + 'h ' + rm + 'm）</div>';
    }
    return s;
  }

  function paintCodex(_root) {
    var root = _root || document.getElementById('codex-view-root');
    if (!root) return;
    var d = codexState.data;
    if (!d) {
      root.innerHTML = '<div class="pp-loading">加载 Codex 用量数据…</div>';
      return;
    }

    var html = '';
    var u = d.utilization;
    if (u) {
      html += '<div class="cu-sub-hero">';
      html += '<div class="cu-sub-top"><div style="display:flex;align-items:center;gap:8px">';
      html += '<span class="cu-plan-badge">' + escapeHtml((d.subscription && d.subscription.type) || 'codex') + '</span>';
      if (d.subscription && d.subscription.limitId) html += '<span class="cu-plan-tier">' + escapeHtml(d.subscription.limitId) + '</span>';
      html += '</div>';
      if (u.observedAt) html += '<span class="cu-extra-text">采样 ' + escapeHtml(u.observedAt.replace('T', ' ').slice(0, 16)) + '</span>';
      html += '</div><div class="cu-meters">';
      html += renderCodexLimitMeter('5h 窗口', u.primary);
      html += renderCodexLimitMeter('7d 总量', u.secondary);
      html += '</div></div>';
    }

    var agg = d.aggregate || {};
    html += '<div class="cu-section-title">概览</div>';
    html += '<div class="cu-row-3" style="margin-bottom:8px">';
    html += '<div class="cu-card cu-qs"><div class="cu-val">' + (agg.totalSessions || 0) + '</div><div class="cu-label">总会话</div>';
    if (agg.firstSessionDate) html += '<div class="cu-sub">自 ' + agg.firstSessionDate.slice(0, 10) + '</div>';
    html += '</div>';
    html += '<div class="cu-card cu-qs"><div class="cu-val">' + fmtTokens(agg.totalTurns || 0) + '</div><div class="cu-label">Token 采样</div></div>';
    html += '<div class="cu-card cu-qs"><div class="cu-val">' + fmtTokens(agg.totalTokens || 0) + '</div><div class="cu-label">总 Tokens</div></div>';
    html += '</div>';

    var mu = d.modelUsage || {};
    var models = Object.keys(mu).sort(function (a, b) { return (mu[b].totalTokens || 0) - (mu[a].totalTokens || 0); });
    var grandTotal = models.reduce(function (sum, m) { return sum + (mu[m].totalTokens || 0); }, 0);
    var totalInput = models.reduce(function (sum, m) { return sum + (mu[m].inputTokens || 0); }, 0);
    var totalOutput = models.reduce(function (sum, m) { return sum + (mu[m].outputTokens || 0); }, 0);
    var totalCached = models.reduce(function (sum, m) { return sum + (mu[m].cachedInputTokens || 0); }, 0);
    var totalReasoning = models.reduce(function (sum, m) { return sum + (mu[m].reasoningTokens || 0); }, 0);
    var cachePct = totalInput > 0 ? Math.round((totalCached / totalInput) * 100) : 0;

    html += '<div class="cu-row-2">';
    html += '<div class="cu-card"><div class="cu-card-label">模型分布</div><div class="cu-model-dist">';
    html += '<div class="cu-donut-wrap"><svg viewBox="0 0 100 100">';
    html += '<circle cx="50" cy="50" r="36" fill="none" stroke="var(--bg-card)" stroke-width="10"/>';
    var offset = 0;
    var circ = 2 * Math.PI * 36;
    models.forEach(function (m, i) {
      var frac = grandTotal > 0 ? (mu[m].totalTokens || 0) / grandTotal : 0;
      var dash = frac * circ;
      var gap = circ - dash;
      html += '<circle cx="50" cy="50" r="36" fill="none" stroke="' + MODEL_COLORS[i % MODEL_COLORS.length] + '" stroke-width="10" stroke-dasharray="' + dash.toFixed(1) + ' ' + gap.toFixed(1) + '" stroke-dashoffset="' + (-offset).toFixed(1) + '" transform="rotate(-90 50 50)"/>';
      offset += dash;
    });
    html += '</svg></div><div class="cu-model-list">';
    models.forEach(function (m, i) {
      html += '<div class="cu-model-row"><div class="cu-model-dot" style="background:' + MODEL_COLORS[i % MODEL_COLORS.length] + '"></div>';
      html += '<span class="cu-model-name">' + escapeHtml(codexModelShortName(m)) + '</span>';
      html += '<span class="cu-model-val">' + fmtTokens(mu[m].totalTokens || 0) + '</span></div>';
    });
    html += '</div></div></div>';

    html += '<div class="cu-card"><div class="cu-card-label">Token 结构</div><div class="cu-cache-row">';
    html += '<div class="cu-cache-gauge"><svg viewBox="0 0 100 100">';
    var gaugeCirc = 2 * Math.PI * 36;
    var gaugeFill = (Math.min(100, cachePct) / 100) * gaugeCirc;
    html += '<circle cx="50" cy="50" r="36" fill="none" stroke="var(--bg-card)" stroke-width="8"/>';
    html += '<circle cx="50" cy="50" r="36" fill="none" stroke="var(--accent-green)" stroke-width="8" stroke-dasharray="' + gaugeFill.toFixed(1) + ' ' + (gaugeCirc - gaugeFill).toFixed(1) + '" transform="rotate(-90 50 50)" stroke-linecap="round"/>';
    html += '</svg><div class="cu-cache-gauge-text">' + cachePct + '%</div></div>';
    html += '<div class="cu-cache-detail">';
    html += '<div class="cu-cache-item"><span class="k">Input</span><span class="v">' + fmtTokens(totalInput) + '</span></div>';
    html += '<div class="cu-cache-item"><span class="k">Cached</span><span class="v">' + fmtTokens(totalCached) + '</span></div>';
    html += '<div class="cu-cache-item"><span class="k">Output</span><span class="v">' + fmtTokens(totalOutput) + '</span></div>';
    html += '<div class="cu-cache-item"><span class="k">Reasoning</span><span class="v">' + fmtTokens(totalReasoning) + '</span></div>';
    html += '</div></div></div></div>';

    html += '<div class="cu-section-title">趋势</div>';
    var daily = d.dailyActivity || [];
    if (daily.length > 1) {
      html += '<div class="cu-card"><div class="cu-card-label">每日 Token</div>';
      var maxTok = Math.max.apply(null, daily.map(function (day) { return day.tokens || 0; }).concat([1]));
      var tW = 700, tH = 80;
      var step = tW / Math.max(1, daily.length - 1);
      var pts = daily.map(function (day, i) { return (i * step).toFixed(1) + ',' + (tH - ((day.tokens || 0) / maxTok) * (tH - 4)).toFixed(1); });
      html += '<svg class="cu-trend-svg" viewBox="0 0 ' + tW + ' ' + tH + '" preserveAspectRatio="none">';
      html += '<path d="M' + pts.join(' L') + ' L' + tW + ',' + tH + ' L0,' + tH + 'Z" fill="rgba(122,162,247,0.1)"/>';
      html += '<polyline points="' + pts.join(' ') + '" fill="none" stroke="var(--accent-blue)" stroke-width="1.5"/></svg></div>';
    }

    var recentDays = daily.slice().reverse().slice(0, 14);
    if (recentDays.length > 0) {
      html += '<div class="cu-card" style="margin-top:8px"><div class="cu-card-label">每日明细</div>';
      html += '<table class="cu-token-table"><thead><tr>';
      html += '<th class="col-date">日期</th><th class="col-num">会话</th><th class="col-num">采样</th><th class="col-num col-total">Tokens</th><th class="col-num">工具</th>';
      html += '</tr></thead><tbody>';
      recentDays.forEach(function (day, di) {
        html += '<tr' + (di % 2 === 1 ? ' class="row-alt"' : '') + '>';
        html += '<td class="col-date">' + day.date.slice(5) + '</td>';
        html += '<td class="col-num">' + (day.sessions || 0) + '</td>';
        html += '<td class="col-num">' + (day.turns || 0) + '</td>';
        html += '<td class="col-num col-total">' + fmtTokens(day.tokens || 0) + '</td>';
        html += '<td class="col-num">' + (day.toolCalls || 0) + '</td></tr>';
      });
      html += '</tbody></table></div>';
    }

    html += '<div class="cu-section-title">使用画像</div><div class="cu-row-2">';
    var hc = d.hourCounts || {};
    var maxHVal = Math.max.apply(null, Object.values(hc).concat([1]));
    var peakHour = Object.keys(hc).reduce(function (a, b) { return (hc[a] || 0) > (hc[b] || 0) ? a : b; }, '0');
    html += '<div class="cu-card"><div class="cu-card-label">活跃时段</div><div class="cu-hours-chart">';
    for (var h = 0; h < 24; h++) {
      var cnt = hc[String(h)] || 0;
      var barH = cnt > 0 ? Math.max(2, Math.round((cnt / maxHVal) * 52)) : 2;
      var lvl = cnt === 0 ? 'h0' : cnt <= maxHVal * 0.2 ? 'h1' : cnt <= maxHVal * 0.5 ? 'h2' : cnt <= maxHVal * 0.8 ? 'h3' : 'h4';
      html += '<div class="cu-hour-bar-col"><div class="cu-hour-bar ' + lvl + '" style="height:' + barH + 'px"></div></div>';
    }
    html += '</div><div class="cu-hours-labels">';
    for (var h2 = 0; h2 < 24; h2++) html += h2 % 3 === 0 ? '<span>' + h2 + '</span>' : '<span class="dim">.</span>';
    html += '</div><div class="cu-hour-peak">峰值 ' + peakHour + ':00</div></div>';

    var tools = d.aggregatedTools || {};
    var toolEntries = Object.entries(tools).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 8);
    var maxTool = toolEntries.length > 0 ? toolEntries[0][1] : 1;
    html += '<div class="cu-card"><div class="cu-card-label">工具调用</div><div class="cu-tool-bars">';
    toolEntries.forEach(function (e) {
      var pct = (e[1] / maxTool) * 100;
      html += '<div class="cu-tool-row"><span class="cu-tool-name">' + escapeHtml(e[0]) + '</span>';
      html += '<div class="cu-tool-bar-wrap"><div class="cu-tool-bar" style="width:' + pct.toFixed(1) + '%;background:' + (TOOL_COLORS[e[0]] || '#7aa2f7') + '"></div></div>';
      html += '<span class="cu-tool-count">' + e[1] + '</span></div>';
    });
    html += '</div></div></div>';

    var sessions = d.recentSessions || [];
    if (sessions.length > 0) {
      html += '<div class="cu-section-title">最近会话</div><div class="cu-card"><div class="cu-session-list">';
      sessions.forEach(function (s) {
        var proj = (s.project_path || '').replace(/^\/home\/[^/]+/, '~');
        html += '<div class="cu-session-item"><div class="cu-session-main">';
        html += '<div class="cu-session-project">' + escapeHtml(proj) + '</div>';
        html += '<div class="cu-session-prompt">' + escapeHtml(s.first_prompt || s.model || '') + '</div>';
        html += '</div><div class="cu-session-meta">';
        html += '<span>' + (s.duration_minutes || 0) + 'm</span>';
        html += '<span>' + fmtTokens(s.tokens || 0) + '</span>';
        html += '<span>' + (s.turns || 0) + ' turns</span>';
        html += '</div></div>';
      });
      html += '</div></div>';
    }

    root.innerHTML = html;
  }

  // === Polling loops ===
  // Uses the global `api` ApiClient (defined in app.js) which sends the
  // bearer auth header. Plain fetch() would 401 because the server checks
  // the Authorization header, not cookies.
  function tickSnap() {
    if (!document.getElementById('perf-panel')) { stop(); return; }
    api.get('/api/window-stats')
      .then(function (resp) {
        if (!resp || !resp.success) return;
        state.snapshot = resp.data;
        updatePerfBadge();
        paintPerf();
      })
      .catch(function () { /* swallow transient */ });
  }

  function tickHist() {
    if (!document.getElementById('perf-panel')) { stop(); return; }
    api.get('/api/perf/history?window=' + state.range)
      .then(function (resp) {
        if (!resp || !resp.success) return;
        state.history = resp.data;
        paintPerf();
      })
      .catch(function () {});
  }

  /**
   * These panels are always on screen, so a load message left behind by a failed
   * poll reads as a hang. Say there is no data instead — but only before the first
   * successful paint, so a transient failure keeps the last good render.
   */
  function markNoUsageData(rootId, label) {
    var root = document.getElementById(rootId);
    if (!root) return;
    root.innerHTML = '<div class="pp-empty">' + label + '不可用：未配置或本机没有用量数据</div>';
  }

  function tickClaude() {
    if (!document.getElementById('perf-panel')) { stop(); return; }
    if (claudeState.loading) return;
    claudeState.loading = true;
    api.get('/api/claude-usage')
      .then(function (resp) {
        claudeState.loading = false;
        if (!resp || !resp.success) {
          if (!claudeState.data) markNoUsageData('claude-view-root', 'Claude 用量');
          return;
        }
        claudeState.data = resp.data;
        updateClaudeBadge();
        paintClaude(document.getElementById('claude-view-root'));
      })
      .catch(function () {
        claudeState.loading = false;
        if (!claudeState.data) markNoUsageData('claude-view-root', 'Claude 用量');
      });
  }

  function tickCodex() {
    if (!document.getElementById('perf-panel')) { stop(); return; }
    if (codexState.loading) return;
    codexState.loading = true;
    api.get('/api/codex-usage')
      .then(function (resp) {
        codexState.loading = false;
        if (!resp || !resp.success) {
          if (!codexState.data) markNoUsageData('codex-view-root', 'Codex 用量');
          return;
        }
        codexState.data = resp.data;
        updateCodexBadge();
        paintCodex(document.getElementById('codex-view-root'));
      })
      .catch(function () {
        codexState.loading = false;
        if (!codexState.data) markNoUsageData('codex-view-root', 'Codex 用量');
      });
  }

  /** Both usage badges read as percentages, so they share one severity scale. */
  function usageTone(pct) {
    return pct >= 85 ? 'red' : pct >= 60 ? 'yellow' : 'green';
  }

  function paintBadge(id, text, toneName) {
    var el = document.getElementById(id);
    if (!el) return;
    if (text === null) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = text;
    el.className = 'ms-badge ' + toneName;
  }

  function updatePerfBadge() {
    if (!state.snapshot || !U) return;
    var critical = U.detectAlerts(state.snapshot).critical.length;
    // Carries a unit: this is a count, unlike the two usage percentages below.
    paintBadge('pp-badge-perf', critical === 0 ? null : critical + ' 项告警', 'red');
  }

  function updateClaudeBadge() {
    var d = claudeState.data;
    if (!d || !d.utilization || !d.utilization.seven_day) { paintBadge('pp-badge-claude', null); return; }
    var pct = Math.floor(d.utilization.seven_day.utilization);
    paintBadge('pp-badge-claude', '7d ' + pct + '%', usageTone(pct));
  }

  function updateCodexBadge() {
    var d = codexState.data;
    if (!d || !d.utilization || !d.utilization.primary) { paintBadge('pp-badge-codex', null); return; }
    var pct = Math.floor(d.utilization.primary.used_percent || 0);
    paintBadge('pp-badge-codex', '5h ' + pct + '%', usageTone(pct));
  }

  function start(mode) {
    var selected = panelMode(mode);
    stop();

    if (selected !== 'codex') {
      tickSnap();
      tickHist();
      tickClaude();
      state.timers.snap = setInterval(tickSnap, POLL_MS);
      state.timers.hist = setInterval(tickHist, HISTORY_POLL_MS);
      state.timers.claude = setInterval(tickClaude, CLAUDE_POLL_MS);
    }
    if (selected !== 'performance') {
      tickCodex();
      state.timers.codex = setInterval(tickCodex, CODEX_POLL_MS);
    }
  }

  function stop() {
    ['snap', 'hist', 'claude', 'codex'].forEach(function (k) {
      if (state.timers[k]) clearInterval(state.timers[k]);
      state.timers[k] = null;
    });
  }

  return { renderSkeleton: renderSkeleton, start: start, stop: stop, _state: state };
})();
