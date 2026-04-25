// Perf panel — D2 design: treemap of windows by CPU/MEM/IO + 100% stacked area history.
// Self-managing: polls only while its DOM root exists.
var PerfPanel = (function () {
  var POLL_MS = 2000;
  var HISTORY = 40; // ~80s
  var MAX_ROWS = 15; // top N windows in bar chart; rest aggregated as "others"
  var METRICS = ['cpu', 'mem', 'io', 'disk', 'claude'];
  var METRIC_LABEL = { cpu: 'CPU', mem: '内存', io: 'IO', disk: '磁盘', claude: 'Claude' };

  var timer = null;
  var state = {
    metric: 'cpu',
    history: [], // each entry: { ts, windows: [{key,name,cpu,mem,io}], total: {...} }
    last: null,
  };

  var claudeState = { data: null, timer: null, loading: false };
  var CLAUDE_POLL_MS = 30000;

  // Stable color per window key (deterministic hash → palette index)
  var PALETTE = ['#f7768e', '#e0af68', '#7aa2f7', '#9ece6a', '#bb9af7', '#7dcfff', '#ff9e64', '#73daca'];
  function colorFor(key) {
    var h = 0;
    for (var i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) & 0xffffffff;
    return PALETTE[Math.abs(h) % PALETTE.length];
  }

  function fmtBytes(n) {
    if (!n && n !== 0) return '—';
    var u = ['B', 'KB', 'MB', 'GB', 'TB']; var i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(n >= 10 ? 0 : 1) + u[i];
  }
  function fmtBps(n) { return fmtBytes(n) + '/s'; }
  function fmtUptime(s) {
    var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d) return d + 'd ' + h + 'h';
    if (h) return h + 'h ' + m + 'm';
    return m + 'm';
  }
  function metricValue(w, metric) {
    if (metric === 'cpu') return w.cpuPercent;
    if (metric === 'mem') return w.memBytes;
    return w.ioBps;
  }
  function fmtMetric(v, metric) {
    if (metric === 'cpu') return v.toFixed(v >= 10 ? 0 : 1) + '%';
    if (metric === 'mem') return fmtBytes(v);
    return fmtBps(v);
  }

  // === Squarified treemap ===
  // Returns array of {x,y,w,h, item}
  function squarify(items, x, y, w, h) {
    var out = [];
    var total = items.reduce(function (a, it) { return a + it.value; }, 0);
    if (total <= 0 || items.length === 0) return out;

    function layoutRow(row, rx, ry, rw, rh, isHorizontal) {
      var rowSum = row.reduce(function (a, it) { return a + it.value; }, 0);
      var ox = rx, oy = ry;
      for (var i = 0; i < row.length; i++) {
        var frac = row[i].value / rowSum;
        if (isHorizontal) {
          var cw = rw * frac;
          out.push({ x: ox, y: oy, w: cw, h: rh, item: row[i].item });
          ox += cw;
        } else {
          var ch = rh * frac;
          out.push({ x: ox, y: oy, w: rw, h: ch, item: row[i].item });
          oy += ch;
        }
      }
    }

    function worstRatio(row, side, scale) {
      var sum = row.reduce(function (a, it) { return a + it.value; }, 0) * scale;
      var rmax = -Infinity, rmin = Infinity;
      for (var i = 0; i < row.length; i++) {
        var v = row[i].value * scale;
        if (v > rmax) rmax = v;
        if (v < rmin) rmin = v;
      }
      var s2 = sum * sum, side2 = side * side;
      return Math.max((side2 * rmax) / s2, s2 / (side2 * rmin));
    }

    var scale = (w * h) / total;
    var scaled = items.map(function (it) { return { value: it.value, item: it }; });
    scaled.sort(function (a, b) { return b.value - a.value; });

    var rx = x, ry = y, rw = w, rh = h;
    var queue = scaled.slice();

    while (queue.length) {
      var side = Math.min(rw, rh);
      var row = [queue[0]];
      var idx = 1;
      while (idx < queue.length) {
        var with_ = row.concat([queue[idx]]);
        if (worstRatio(with_, side, scale) <= worstRatio(row, side, scale)) {
          row = with_; idx++;
        } else break;
      }
      var rowSum = row.reduce(function (a, it) { return a + it.value; }, 0);
      var rowArea = rowSum * scale;
      var isHorizontal = rw >= rh;
      if (isHorizontal) {
        var rowH = rowArea / rw;
        layoutRow(row, rx, ry, rw, rowH, true);
        ry += rowH; rh -= rowH;
      } else {
        var rowW = rowArea / rh;
        layoutRow(row, rx, ry, rowW, rh, false);
        rx += rowW; rw -= rowW;
      }
      queue.splice(0, row.length);
    }
    return out;
  }

  // === Claude Usage helpers ===
  var PRICING = {
    'claude-opus-4-7': { input: 5.0, output: 25.0 },
    'claude-opus-4-6': { input: 5.0, output: 25.0 },
    'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
    'claude-sonnet-4-5-20250929': { input: 3.0, output: 15.0 },
    'claude-haiku-4-5': { input: 1.0, output: 5.0 },
  };
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

  function paintClaude(root) {
    var d = claudeState.data;
    if (!d) {
      root.innerHTML = '<div class="pp-loading">加载 Claude 用量数据…</div>';
      return;
    }

    var html = '';

    // === Tabs (reuse existing tab rendering) ===
    html += '<div class="pp-tabs">';
    METRICS.forEach(function (m) {
      var cls = 'pp-tab' + (m === 'claude' ? ' pp-tab-active' : '');
      html += '<button class="' + cls + '" data-metric="' + m + '">' + METRIC_LABEL[m] + '</button>';
    });
    html += '</div>';

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
        var cents = u.extra_usage.used_credits || 0;
        var limit = u.extra_usage.monthly_limit || 0;
        html += '<div style="display:flex;align-items:center;gap:6px">';
        html += '<span class="cu-extra-badge">Extra Usage</span>';
        html += '<span class="cu-extra-text">$' + (cents / 100).toFixed(0) + ' / $' + (limit / 100).toFixed(0) + '</span>';
        html += '</div>';
      }
      html += '</div>';
      html += '<div class="cu-meters">';

      function renderMeter(label, obj) {
        if (!obj) return '';
        var pct = Math.floor(obj.utilization);
        var cls = meterColorClass(pct);
        var s = '<div class="cu-meter">';
        s += '<span class="cu-meter-label">' + label + '</span>';
        s += '<div class="cu-meter-track"><div class="cu-meter-fill ' + cls + '" style="width:' + pct + '%"></div></div>';
        s += '<span class="cu-meter-val">' + pct + '%</span>';
        s += '</div>';
        if (obj.resets_at) {
          var remain = Math.max(0, new Date(obj.resets_at) - Date.now());
          var rh = Math.floor(remain / 3600000);
          var rm = Math.floor((remain % 3600000) / 60000);
          s += '<div class="cu-meter-reset">重置于 ' + obj.resets_at.replace('T', ' ').slice(0, 16) + ' UTC（剩余 ' + rh + 'h ' + rm + 'm）</div>';
        }
        return s;
      }

      html += renderMeter('5h 窗口', u.five_hour);
      html += renderMeter('7d 总量', u.seven_day);
      html += renderMeter('7d Sonnet', u.seven_day_sonnet);

      if (u.extra_usage && u.extra_usage.is_enabled) {
        var euPct = Math.floor((u.extra_usage.utilization || 0) * 100);
        var euUsed = ((u.extra_usage.used_credits || 0) / 100).toFixed(2);
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
    var daily = d.dailyActivity || [];
    if (daily.length > 1) {
      html += '<div class="cu-card"><div class="cu-card-label">每日活跃</div>';
      var maxMsg = Math.max.apply(null, daily.map(function (d2) { return d2.messageCount; }));
      var maxSes = Math.max.apply(null, daily.map(function (d2) { return d2.sessionCount; }));
      if (maxMsg < 1) maxMsg = 1;
      if (maxSes < 1) maxSes = 1;
      var tW = 700, tH = 80;
      var step = tW / Math.max(1, daily.length - 1);
      html += '<svg class="cu-trend-svg" viewBox="0 0 ' + tW + ' ' + tH + '" preserveAspectRatio="none">';
      html += '<line x1="0" y1="' + (tH * 0.25) + '" x2="' + tW + '" y2="' + (tH * 0.25) + '" stroke="var(--border-subtle)" stroke-width="0.5"/>';
      html += '<line x1="0" y1="' + (tH * 0.5) + '" x2="' + tW + '" y2="' + (tH * 0.5) + '" stroke="var(--border-subtle)" stroke-width="0.5"/>';
      html += '<line x1="0" y1="' + (tH * 0.75) + '" x2="' + tW + '" y2="' + (tH * 0.75) + '" stroke="var(--border-subtle)" stroke-width="0.5"/>';
      var msgPts = daily.map(function (d2, i) { return (i * step).toFixed(1) + ',' + (tH - (d2.messageCount / maxMsg) * (tH - 4)).toFixed(1); });
      var sesPts = daily.map(function (d2, i) { return (i * step).toFixed(1) + ',' + (tH - (d2.sessionCount / maxSes) * (tH - 4)).toFixed(1); });
      html += '<path d="M' + msgPts.join(' L') + ' L' + (tW) + ',' + tH + ' L0,' + tH + 'Z" fill="rgba(122,162,247,0.1)"/>';
      html += '<polyline points="' + msgPts.join(' ') + '" fill="none" stroke="var(--accent-blue)" stroke-width="1.5"/>';
      html += '<polyline points="' + sesPts.join(' ') + '" fill="none" stroke="var(--accent-orange)" stroke-width="1.2" stroke-dasharray="3,2"/>';
      html += '</svg>';
      html += '<div class="cu-trend-legend"><div class="cu-trend-legend-item"><div class="cu-trend-legend-dot" style="background:var(--accent-blue)"></div>消息</div>';
      html += '<div class="cu-trend-legend-item"><div class="cu-trend-legend-dot" style="background:var(--accent-orange)"></div>会话</div></div>';
      html += '</div>';
    }

    // Token table: dailyModelTokens only has total per model per day (no input/output/cache split)
    var dmt = (d.dailyModelTokens || []).slice().reverse().slice(0, 7);
    if (dmt.length > 0) {
      function estimateModelDayCost(model, tokens) {
        var p = PRICING[model] || { input: 3.0, output: 15.0 };
        return tokens * ((p.input + p.output) / 2) / 1e6;
      }
      html += '<div class="cu-card" style="margin-top:8px"><div class="cu-card-label">每日 Token 明细</div>';
      html += '<table class="cu-token-table"><thead><tr>';
      html += '<th class="col-date">日期</th><th>模型</th>';
      html += '<th class="col-num col-total">Tokens</th>';
      html += '<th class="col-num col-cost">Cost</th>';
      html += '</tr></thead><tbody>';
      var weekTotal = 0, weekCost = 0;
      dmt.forEach(function (day, di) {
        var tbm = day.tokensByModel || {};
        var mods = Object.keys(tbm).sort(function (a, b) { return (tbm[b] || 0) - (tbm[a] || 0); });
        var isAlt = di % 2 === 1;
        var altCls = isAlt ? ' class="row-alt"' : '';
        if (mods.length === 0) return;
        var dayCost = 0;
        mods.forEach(function (m) { dayCost += estimateModelDayCost(m, tbm[m] || 0); });
        weekCost += dayCost;
        mods.forEach(function (m, mi) {
          var tokens = tbm[m] || 0;
          weekTotal += tokens;
          html += '<tr' + altCls + '>';
          if (mi === 0) html += '<td class="col-date" rowspan="' + mods.length + '">' + day.date.slice(5) + '</td>';
          html += '<td><span class="cu-model-tag ' + modelTagClass(m) + '">' + escapeHtml(modelShortName(m)) + '</span></td>';
          html += '<td class="col-num col-total">' + fmtTokens(tokens) + '</td>';
          if (mi === 0) html += '<td class="col-num col-cost" rowspan="' + mods.length + '">$' + dayCost.toFixed(2) + '</td>';
          html += '</tr>';
        });
      });
      html += '</tbody><tfoot>';
      html += '<tr><td class="col-date" colspan="2" style="text-align:right;font-weight:600">7日合计</td>';
      html += '<td class="col-num col-total">' + fmtTokens(weekTotal) + '</td>';
      html += '<td class="col-num col-cost">$' + weekCost.toFixed(2) + '</td></tr>';
      var allTokens = (d.dailyModelTokens || []).reduce(function (a, day) {
        return a + Object.values(day.tokensByModel || {}).reduce(function (b, v) { return b + v; }, 0);
      }, 0);
      var allCost = 0;
      (d.dailyModelTokens || []).forEach(function (day) {
        Object.entries(day.tokensByModel || {}).forEach(function (e) { allCost += estimateModelDayCost(e[0], e[1]); });
      });
      var currentMonth = new Date().getMonth() + 1;
      html += '<tr><td class="col-date" colspan="2" style="text-align:right;font-weight:600;color:var(--text-muted)">' + currentMonth + '月合计</td>';
      html += '<td class="col-num col-total">' + fmtTokens(allTokens) + '</td>';
      html += '<td class="col-num col-cost" style="color:var(--text-muted)">$' + allCost.toFixed(2) + '</td></tr>';
      html += '</tfoot></table></div>';
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

    // Bind tab clicks
    var tabs = root.querySelectorAll('.pp-tab');
    for (var ti = 0; ti < tabs.length; ti++) {
      tabs[ti].addEventListener('click', function (e) {
        var newMetric = e.currentTarget.getAttribute('data-metric');
        state.metric = newMetric;
        if (newMetric === 'claude' && !claudeState.data) startClaude();
        paint();
      });
    }
  }

  // === Render skeleton (called once when home view is built) ===
  function renderSkeleton() {
    return (
      '<div id="perf-panel" class="pp-card">' +
        '<div class="pp-loading">加载机器与窗口性能…</div>' +
      '</div>'
    );
  }

  // === Paint full panel ===
  function paint() {
    var root = document.getElementById('perf-panel');
    if (!root) return false;
    var snap = state.last;
    if (!snap) return true;

    if (state.metric === 'claude') {
      paintClaude(root);
      return true;
    }

    var t = snap.total;
    var metric = state.metric;
    var windows = (snap.windows || []).slice();
    var externals = (snap.external || []).slice();

    // Wrap external (non-tmux) processes so they share the bar item shape
    function metricValueExt(e) {
      if (metric === 'cpu') return e.cpuPercent;
      if (metric === 'mem') return e.memBytes;
      return e.ioBps;
    }
    var extItems = externals.map(function (e) {
      return {
        key: 'sys|' + e.comm,
        name: '[sys] ' + e.comm + (e.procCount > 1 ? ' ×' + e.procCount : ''),
        value: metricValueExt(e),
        win: { procCount: e.procCount, isExternal: true },
      };
    });

    // Filter zero-value windows for treemap to avoid 0-area rectangles
    var items = windows
      .map(function (w) {
        var key = w.session + '|' + w.windowIndex;
        return {
          key: key,
          name: w.session + ':' + w.windowIndex + (w.windowName && w.windowName !== String(w.windowIndex) ? ' ' + w.windowName : ''),
          value: metricValue(w, metric),
          win: w,
        };
      })
      .concat(extItems)
      .filter(function (it) { return it.value > 0.01; })
      .sort(function (a, b) { return b.value - a.value; });

    var totalForMetric;
    if (metric === 'cpu') totalForMetric = t.windowCpuPercent;
    else if (metric === 'mem') totalForMetric = t.windowMemBytes;
    else totalForMetric = t.windowIoBps;

    var html = '';

    // Header
    html += '<div class="pp-header">';
    html += '<div class="pp-host">' + escapeHtml(t.hostname) + '</div>';
    html += '<div class="pp-meta">' + t.cpuCount + ' cores · load ' + t.load1.toFixed(2) + ' · up ' + fmtUptime(t.uptime) + '</div>';
    html += '<div class="pp-totals">';
    var cpuMachinePct = t.cpuCount > 0 ? (t.windowCpuPercent / (t.cpuCount * 100)) * 100 : 0;
    var memMachinePct = t.systemMemTotal > 0 ? (t.systemMemUsed / t.systemMemTotal) * 100 : 0;
    var swapMachinePct = t.systemSwapTotal > 0 ? (t.systemSwapUsed / t.systemSwapTotal) * 100 : 0;
    html += '<span class="pp-tot"><span class="pp-tot-l">CPU</span><span class="pp-tot-v">' + t.windowCpuPercent.toFixed(0) + '% <span class="pp-tot-sub">/ ' + (t.cpuCount * 100) + '% (' + cpuMachinePct.toFixed(0) + '%)</span></span></span>';
    html += '<span class="pp-tot"><span class="pp-tot-l">MEM</span><span class="pp-tot-v">' + fmtBytes(t.systemMemUsed) + ' <span class="pp-tot-sub">/ ' + fmtBytes(t.systemMemTotal) + ' (' + memMachinePct.toFixed(0) + '%)</span></span></span>';
    if (t.systemSwapTotal > 0) {
      html += '<span class="pp-tot"><span class="pp-tot-l">SWAP</span><span class="pp-tot-v">' + fmtBytes(t.systemSwapUsed) + ' <span class="pp-tot-sub">/ ' + fmtBytes(t.systemSwapTotal) + ' (' + swapMachinePct.toFixed(0) + '%)</span></span></span>';
    }
    html += '<span class="pp-tot"><span class="pp-tot-l">IO</span><span class="pp-tot-v">' + fmtBps(t.windowIoBps) + '</span></span>';
    // Disk summary in header
    var diskArr = snap.disks || [];
    if (diskArr.length > 0) {
      var rootDisk = diskArr.find(function (d) { return d.mount === '/'; });
      if (rootDisk) {
        var rootPct = rootDisk.total > 0 ? (rootDisk.used / rootDisk.total) * 100 : 0;
        html += '<span class="pp-tot"><span class="pp-tot-l">DISK /</span><span class="pp-tot-v">' + fmtBytes(rootDisk.used) + ' <span class="pp-tot-sub">/ ' + fmtBytes(rootDisk.total) + ' (' + rootPct.toFixed(0) + '%)</span></span></span>';
      }
    }
    html += '</div>';
    html += '</div>';

    // Tabs
    html += '<div class="pp-tabs">';
    METRICS.forEach(function (m) {
      var cls = 'pp-tab' + (m === metric ? ' pp-tab-active' : '');
      html += '<button class="' + cls + '" data-metric="' + m + '">' + METRIC_LABEL[m] + '</button>';
    });
    html += '<span class="pp-tabs-spacer"></span>';
    if (metric === 'disk') {
      html += '<span class="pp-tabs-hint">各分区磁盘使用情况</span>';
    } else {
      html += '<span class="pp-tabs-hint">面积 = ' + METRIC_LABEL[metric] + ' 占比 · 百分比 = 占机器总量</span>';
    }
    html += '</div>';

    // Machine-total denominator (so cell pct = "% of machine")
    var machineTotal;
    if (metric === 'cpu') machineTotal = t.cpuCount * 100;
    else if (metric === 'mem') machineTotal = t.systemMemTotal;
    else machineTotal = totalForMetric; // IO has no machine cap, fall back to windows sum

    function drawTreemap(svgItems, W, H, denom, valueFmt, getSubExtra) {
      var s = '<svg class="pp-treemap" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">';
      if (svgItems.length === 0) {
        s += '<rect width="' + W + '" height="' + H + '" fill="#16161e" rx="6"/>';
        s += '<text x="' + (W / 2) + '" y="' + (H / 2) + '" text-anchor="middle" fill="#565f89" font-size="12">暂无数据</text>';
        s += '</svg>';
        return s;
      }
      var rects = squarify(svgItems, 0, 0, W, H);
      rects.forEach(function (r) {
        var it = r.item;
        var color = colorFor(it.key);
        var pct = denom > 0 ? (it.value / denom) * 100 : 0;
        var fontSize = Math.max(9, Math.min(28, Math.sqrt(r.w * r.h) / 6));
        var labelSize = Math.max(8, Math.min(13, fontSize * 0.42));
        s += '<g class="pp-tm-cell">';
        s += '<rect x="' + r.x + '" y="' + r.y + '" width="' + r.w + '" height="' + r.h + '" fill="#1f2335" stroke="' + color + '" stroke-width="1.2" rx="4"/>';
        s += '<rect x="' + r.x + '" y="' + r.y + '" width="3" height="' + r.h + '" fill="' + color + '" rx="2"/>';
        if (r.w > 60 && r.h > 30) {
          s += '<text x="' + (r.x + 10) + '" y="' + (r.y + labelSize + 6) + '" fill="#c0caf5" font-size="' + labelSize + '" font-weight="600">' + escapeHtml(it.name) + '</text>';
          s += '<text x="' + (r.x + 10) + '" y="' + (r.y + labelSize + 6 + fontSize + 2) + '" fill="#c0caf5" font-size="' + fontSize + '" font-weight="700">' + valueFmt(it.value) + '</text>';
          if (r.h > 70) {
            var subTxt = pct.toFixed(1) + '% of machine · ' + it.win.procCount + 'p';
            if (getSubExtra) { var ex = getSubExtra(it); if (ex) subTxt += ' · ' + ex; }
            s += '<text x="' + (r.x + 10) + '" y="' + (r.y + r.h - 8) + '" fill="#7d8590" font-size="9">' + subTxt + '</text>';
          }
        } else if (r.w > 30 && r.h > 18) {
          s += '<text x="' + (r.x + 4) + '" y="' + (r.y + 12) + '" fill="#c0caf5" font-size="9">' + escapeHtml(it.name.split(' ')[0]) + '</text>';
        }
        s += '<title>' + escapeHtml(it.name) + ' — ' + valueFmt(it.value) + ' (' + pct.toFixed(1) + '% of machine)</title>';
        s += '</g>';
      });
      s += '</svg>';
      return s;
    }

    // Use real container width so text stays at native px regardless of column size
    var containerW = root.clientWidth || 880;
    var W = Math.max(480, Math.floor(containerW - 4));
    var H = 320;
    if (metric === 'mem') {
      // Horizontal bar chart: each row = one window OR external comm group,
      // RAM + SWAP segments aligned to a common scale.
      var memWinItems = windows.map(function (w) {
        return {
          key: w.session + '|' + w.windowIndex,
          name: w.session + ':' + w.windowIndex + (w.windowName && w.windowName !== String(w.windowIndex) ? ' ' + w.windowName : ''),
          ram: w.memBytes,
          swap: w.swapBytes,
          total: w.memBytes + w.swapBytes,
          win: w,
        };
      });
      var memExtItems = externals.map(function (e) {
        return {
          key: 'sys|' + e.comm,
          name: '[sys] ' + e.comm + (e.procCount > 1 ? ' ×' + e.procCount : ''),
          ram: e.memBytes,
          swap: e.swapBytes,
          total: e.memBytes + e.swapBytes,
          win: { procCount: e.procCount, isExternal: true },
        };
      });
      var memItems = memWinItems.concat(memExtItems)
        .filter(function (it) { return it.total > 1024 * 1024; })
        .sort(function (a, b) { return b.total - a.total; });

      // Cap to top N; aggregate rest
      var memOthers = null;
      if (memItems.length > MAX_ROWS) {
        var rest = memItems.slice(MAX_ROWS);
        memItems = memItems.slice(0, MAX_ROWS);
        memOthers = {
          count: rest.length,
          ram: rest.reduce(function (a, it) { return a + it.ram; }, 0),
          swap: rest.reduce(function (a, it) { return a + it.swap; }, 0),
          total: rest.reduce(function (a, it) { return a + it.total; }, 0),
        };
      }

      var ramUsedByWin = windows.reduce(function (a, w) { return a + w.memBytes; }, 0);
      var swapUsedByWin = windows.reduce(function (a, w) { return a + w.swapBytes; }, 0);

      html += '<div class="pp-mem-legend">';
      html += '<span class="pp-legend-item"><span class="pp-swatch pp-swatch-ram"></span>RAM ' + fmtBytes(ramUsedByWin) + ' / ' + fmtBytes(t.systemMemTotal) + '</span>';
      if (t.systemSwapTotal > 0) {
        html += '<span class="pp-legend-item"><span class="pp-swatch pp-swatch-swap"></span>SWAP ' + fmtBytes(swapUsedByWin) + ' / ' + fmtBytes(t.systemSwapTotal) + '</span>';
      }
      html += '<span class="pp-legend-hint">条长 = 占整机比例（满 = ' + fmtBytes(memDenom) + '）</span>';
      html += '</div>';

      var rowH = 26;
      var rowGap = 4;
      var nameW = 170;
      var pctW = 92;
      var barW = W - nameW - pctW - 16;
      var memDenom = t.systemMemTotal + t.systemSwapTotal;
      // 条长按机器总量（RAM+SWAP）归一化——满条 = 整机占满
      var maxTotal = memDenom > 0 ? memDenom : (memItems.length > 0 ? memItems[0].total : 1);
      var othersRows = memOthers ? 1 : 0;
      var Hbar = Math.max(120, (memItems.length + othersRows) * (rowH + rowGap) + 8);

      html += '<svg class="pp-membars" viewBox="0 0 ' + W + ' ' + Hbar + '">';
      html += '<defs><pattern id="pp-swap-hatch" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">' +
              '<rect width="6" height="6" fill="#7aa2f7" fill-opacity="0.18"/>' +
              '<line x1="0" y1="0" x2="0" y2="6" stroke="#7aa2f7" stroke-width="2" stroke-opacity="0.6"/>' +
              '</pattern></defs>';
      if (memItems.length === 0) {
        html += '<rect width="' + W + '" height="' + Hbar + '" fill="#16161e" rx="6"/>';
        html += '<text x="' + (W / 2) + '" y="' + (Hbar / 2) + '" text-anchor="middle" fill="#565f89" font-size="12">暂无数据</text>';
      } else {
        memItems.forEach(function (it, i) {
          var y = 4 + i * (rowH + rowGap);
          var color = colorFor(it.key);
          var ramW = (it.ram / maxTotal) * barW;
          var swW = (it.swap / maxTotal) * barW;
          var pct = memDenom > 0 ? (it.total / memDenom) * 100 : 0;
          // Track background
          html += '<rect x="' + nameW + '" y="' + y + '" width="' + barW + '" height="' + rowH + '" fill="#16161e" rx="3"/>';
          // RAM segment (solid)
          if (ramW > 0.5) {
            html += '<rect x="' + nameW + '" y="' + y + '" width="' + ramW + '" height="' + rowH + '" fill="' + color + '" fill-opacity="0.85" rx="3"/>';
          }
          // SWAP segment (hatched, butted against RAM)
          if (swW > 0.5) {
            html += '<rect x="' + (nameW + ramW) + '" y="' + y + '" width="' + swW + '" height="' + rowH + '" fill="url(#pp-swap-hatch)" stroke="#7aa2f7" stroke-width="0.8" stroke-opacity="0.5"/>';
          }
          // Window name (left)
          html += '<text x="8" y="' + (y + rowH / 2 + 4) + '" fill="#c0caf5" font-size="12" font-weight="600">' + escapeHtml(it.name.length > 24 ? it.name.slice(0, 23) + '…' : it.name) + '</text>';
          // RAM label inside its segment (or to the right if too narrow)
          var ramTxt = fmtBytes(it.ram);
          if (ramW > 54) {
            html += '<text x="' + (nameW + 6) + '" y="' + (y + rowH / 2 + 4) + '" fill="#1a1b26" font-size="11" font-weight="700">' + ramTxt + '</text>';
          }
          // SWAP label inside its segment (or skip if tiny)
          if (it.swap > 0) {
            var swTxt = fmtBytes(it.swap);
            if (swW > 50) {
              html += '<text x="' + (nameW + ramW + swW / 2) + '" y="' + (y + rowH / 2 + 4) + '" text-anchor="middle" fill="#c0caf5" font-size="11" font-weight="700">' + swTxt + '</text>';
            } else if (swW > 20) {
              html += '<text x="' + (nameW + ramW + swW + 4) + '" y="' + (y + rowH / 2 + 4) + '" fill="#7aa2f7" font-size="10" font-weight="600">' + swTxt + '</text>';
            }
          }
          // Right column: total + machine percent
          html += '<text x="' + (W - 6) + '" y="' + (y + rowH / 2 + 4) + '" text-anchor="end" fill="#c0caf5" font-size="11" font-weight="700">' + fmtBytes(it.total) + ' <tspan fill="#7d8590" font-weight="400">· ' + pct.toFixed(1) + '%</tspan></text>';
          html += '<title>' + escapeHtml(it.name) + ' — RAM ' + ramTxt + ' + SWAP ' + fmtBytes(it.swap) + ' = ' + fmtBytes(it.total) + ' (' + pct.toFixed(1) + '% of machine)</title>';
        });
        if (memOthers) {
          var y2 = 4 + memItems.length * (rowH + rowGap);
          var ramW2 = (memOthers.ram / maxTotal) * barW;
          var swW2 = (memOthers.swap / maxTotal) * barW;
          var pct2 = memDenom > 0 ? (memOthers.total / memDenom) * 100 : 0;
          html += '<rect x="' + nameW + '" y="' + y2 + '" width="' + barW + '" height="' + rowH + '" fill="#16161e" rx="3"/>';
          if (ramW2 > 0.5) html += '<rect x="' + nameW + '" y="' + y2 + '" width="' + ramW2 + '" height="' + rowH + '" fill="#565f89" fill-opacity="0.6" rx="3"/>';
          if (swW2 > 0.5) html += '<rect x="' + (nameW + ramW2) + '" y="' + y2 + '" width="' + swW2 + '" height="' + rowH + '" fill="url(#pp-swap-hatch)" stroke="#7aa2f7" stroke-width="0.8" stroke-opacity="0.5"/>';
          html += '<text x="8" y="' + (y2 + rowH / 2 + 4) + '" fill="#7d8590" font-size="11" font-style="italic">其余 ' + memOthers.count + ' 个 window</text>';
          html += '<text x="' + (W - 6) + '" y="' + (y2 + rowH / 2 + 4) + '" text-anchor="end" fill="#c0caf5" font-size="11" font-weight="700">' + fmtBytes(memOthers.total) + ' <tspan fill="#7d8590" font-weight="400">· ' + pct2.toFixed(1) + '%</tspan></text>';
        }
      }
      html += '</svg>';
    } else if (metric === 'cpu' || metric === 'io') {
      // Horizontal bar chart for CPU / IO — same layout grammar as MEM.
      var barItems = items.slice(); // already sorted desc, filtered
      var otherAgg = null;
      if (barItems.length > MAX_ROWS) {
        var restCpu = barItems.slice(MAX_ROWS);
        barItems = barItems.slice(0, MAX_ROWS);
        otherAgg = {
          count: restCpu.length,
          value: restCpu.reduce(function (a, it) { return a + it.value; }, 0),
          procCount: restCpu.reduce(function (a, it) { return a + it.win.procCount; }, 0),
        };
      }
      var rowH2 = 26, rowGap2 = 4, nameW2 = 170, pctW2 = 92;
      var barW2 = W - nameW2 - pctW2 - 16;
      // CPU 用机器总量归一化（条长直接反映占整机比例）；IO 没有机器上限，仍按最大值
      var maxV;
      if (metric === 'cpu' && machineTotal > 0) {
        maxV = machineTotal;
      } else {
        maxV = barItems.length > 0 ? barItems[0].value : 1;
      }
      var Hbar2 = Math.max(120, (barItems.length + (otherAgg ? 1 : 0)) * (rowH2 + rowGap2) + 8);
      var fmtFn = function (v) { return fmtMetric(v, metric); };

      var hintTxt = metric === 'cpu'
        ? '条长 = 占机器总量比例（满 = ' + (t.cpuCount * 100) + '%）· 按 window 占用排序'
        : '条长 = ' + METRIC_LABEL[metric] + '（无机器上限，相对最大值）· 百分比 = 占机器总量';
      html += '<div class="pp-mem-legend"><span class="pp-legend-hint">' + hintTxt + '</span></div>';
      html += '<svg class="pp-membars" viewBox="0 0 ' + W + ' ' + Hbar2 + '">';
      if (barItems.length === 0) {
        html += '<rect width="' + W + '" height="' + Hbar2 + '" fill="#16161e" rx="6"/>';
        html += '<text x="' + (W / 2) + '" y="' + (Hbar2 / 2) + '" text-anchor="middle" fill="#565f89" font-size="12">暂无活跃窗口数据</text>';
      } else {
        barItems.forEach(function (it, i) {
          var y = 4 + i * (rowH2 + rowGap2);
          var color = colorFor(it.key);
          var bw = (it.value / maxV) * barW2;
          var pct = machineTotal > 0 ? (it.value / machineTotal) * 100 : 0;
          html += '<rect x="' + nameW2 + '" y="' + y + '" width="' + barW2 + '" height="' + rowH2 + '" fill="#16161e" rx="3"/>';
          if (bw > 0.5) {
            html += '<rect x="' + nameW2 + '" y="' + y + '" width="' + bw + '" height="' + rowH2 + '" fill="' + color + '" fill-opacity="0.85" rx="3"/>';
          }
          html += '<text x="8" y="' + (y + rowH2 / 2 + 4) + '" fill="#c0caf5" font-size="12" font-weight="600">' + escapeHtml(it.name.length > 24 ? it.name.slice(0, 23) + '…' : it.name) + '</text>';
          var vTxt = fmtFn(it.value);
          if (bw > 60) {
            html += '<text x="' + (nameW2 + 6) + '" y="' + (y + rowH2 / 2 + 4) + '" fill="#1a1b26" font-size="11" font-weight="700">' + vTxt + '</text>';
          } else {
            html += '<text x="' + (nameW2 + bw + 4) + '" y="' + (y + rowH2 / 2 + 4) + '" fill="#c0caf5" font-size="11" font-weight="700">' + vTxt + '</text>';
          }
          html += '<text x="' + (W - 6) + '" y="' + (y + rowH2 / 2 + 4) + '" text-anchor="end" fill="#7d8590" font-size="11">' + pct.toFixed(1) + '% · ' + it.win.procCount + 'p</text>';
          html += '<title>' + escapeHtml(it.name) + ' — ' + vTxt + ' (' + pct.toFixed(1) + '% of machine)</title>';
        });
        if (otherAgg) {
          var oy = 4 + barItems.length * (rowH2 + rowGap2);
          var obw = (otherAgg.value / maxV) * barW2;
          var opct = machineTotal > 0 ? (otherAgg.value / machineTotal) * 100 : 0;
          html += '<rect x="' + nameW2 + '" y="' + oy + '" width="' + barW2 + '" height="' + rowH2 + '" fill="#16161e" rx="3"/>';
          if (obw > 0.5) html += '<rect x="' + nameW2 + '" y="' + oy + '" width="' + obw + '" height="' + rowH2 + '" fill="#565f89" fill-opacity="0.6" rx="3"/>';
          html += '<text x="8" y="' + (oy + rowH2 / 2 + 4) + '" fill="#7d8590" font-size="11" font-style="italic">其余 ' + otherAgg.count + ' 个 window</text>';
          html += '<text x="' + (W - 6) + '" y="' + (oy + rowH2 / 2 + 4) + '" text-anchor="end" fill="#7d8590" font-size="11">' + opct.toFixed(1) + '% · ' + otherAgg.procCount + 'p</text>';
        }
      }
      html += '</svg>';
    }

    if (metric === 'disk') {
      // Disk usage horizontal bar chart
      var disks = (snap.disks || []).slice();
      // Color palette for disk bars based on usage severity
      function diskColor(pct) {
        if (pct >= 95) return '#f7768e'; // red — critical
        if (pct >= 80) return '#e0af68'; // yellow — warning
        return '#9ece6a'; // green — ok
      }
      function diskBarLabel(d) {
        var short = d.mount;
        if (short.length > 30) short = '…' + short.slice(-29);
        return short;
      }

      var diskRowH = 26, diskRowGap = 4, diskNameW = 200, diskPctW = 120;
      var diskBarW = W - diskNameW - diskPctW - 16;
      var diskHbar = Math.max(120, disks.length * (diskRowH + diskRowGap) + 8);

      html += '<div class="pp-mem-legend">';
      var totalDiskUsed = disks.reduce(function (a, d) { return a + d.used; }, 0);
      var totalDiskSize = disks.reduce(function (a, d) { return a + d.total; }, 0);
      html += '<span class="pp-legend-item"><span class="pp-swatch" style="background:#9ece6a"></span>&lt;80%</span>';
      html += '<span class="pp-legend-item"><span class="pp-swatch" style="background:#e0af68"></span>80-95%</span>';
      html += '<span class="pp-legend-item"><span class="pp-swatch" style="background:#f7768e"></span>&gt;95%</span>';
      html += '<span class="pp-legend-hint">已用 ' + fmtBytes(totalDiskUsed) + ' / ' + fmtBytes(totalDiskSize) + ' (' + disks.length + ' 个分区)</span>';
      html += '</div>';

      html += '<svg class="pp-membars" viewBox="0 0 ' + W + ' ' + diskHbar + '">';
      if (disks.length === 0) {
        html += '<rect width="' + W + '" height="' + diskHbar + '" fill="#16161e" rx="6"/>';
        html += '<text x="' + (W / 2) + '" y="' + (diskHbar / 2) + '" text-anchor="middle" fill="#565f89" font-size="12">暂无磁盘数据</text>';
      } else {
        disks.forEach(function (d, i) {
          var y = 4 + i * (diskRowH + diskRowGap);
          var pct = d.total > 0 ? (d.used / d.total) * 100 : 0;
          var color = diskColor(pct);
          var bw = (pct / 100) * diskBarW;
          // Track background
          html += '<rect x="' + diskNameW + '" y="' + y + '" width="' + diskBarW + '" height="' + diskRowH + '" fill="#16161e" rx="3"/>';
          // Used segment
          if (bw > 0.5) {
            html += '<rect x="' + diskNameW + '" y="' + y + '" width="' + bw + '" height="' + diskRowH + '" fill="' + color + '" fill-opacity="0.85" rx="3"/>';
          }
          // Mount point name
          html += '<text x="8" y="' + (y + diskRowH / 2 + 4) + '" fill="#c0caf5" font-size="12" font-weight="600">' + escapeHtml(diskBarLabel(d)) + '</text>';
          // Used amount inside bar
          var usedTxt = fmtBytes(d.used);
          if (bw > 60) {
            html += '<text x="' + (diskNameW + 6) + '" y="' + (y + diskRowH / 2 + 4) + '" fill="#1a1b26" font-size="11" font-weight="700">' + usedTxt + '</text>';
          }
          // Right: total + percent
          html += '<text x="' + (W - 6) + '" y="' + (y + diskRowH / 2 + 4) + '" text-anchor="end" fill="#c0caf5" font-size="11" font-weight="700">' + fmtBytes(d.used) + ' / ' + fmtBytes(d.total) + ' <tspan fill="' + color + '" font-weight="600">' + pct.toFixed(0) + '%</tspan></text>';
          html += '<title>' + escapeHtml(d.device + ' → ' + d.mount) + ' (' + d.fstype + ') — ' + fmtBytes(d.used) + ' / ' + fmtBytes(d.total) + ' (' + pct.toFixed(1) + '%)</title>';
        });
      }
      html += '</svg>';
    }

    // History strip — 100% stacked area for current metric (skip for disk — it's point-in-time)
    if (metric !== 'disk') {
      html += '<div class="pp-strip-label">最近 ' + (HISTORY * POLL_MS / 1000) + 's · 占比演化</div>';
      html += renderHistoryStrip(W, 140, metric);
    }

    root.innerHTML = html;

    // Bind tab clicks
    var tabs = root.querySelectorAll('.pp-tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function (e) {
        var newMetric = e.currentTarget.getAttribute('data-metric');
        state.metric = newMetric;
        if (newMetric === 'claude' && !claudeState.data) startClaude();
        paint();
      });
    }
    return true;
  }

  function renderHistoryStrip(W, H, metric) {
    if (state.history.length < 2) {
      return '<svg class="pp-strip" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' +
        '<rect width="' + W + '" height="' + H + '" fill="#16161e" rx="6"/>' +
        '<text x="' + (W / 2) + '" y="' + (H / 2) + '" text-anchor="middle" fill="#565f89" font-size="11">采样中…</text>' +
        '</svg>';
    }

    var stepCount = state.history.length;
    // Collect all keys ever seen (tmux windows + external comms)
    var keySet = {};
    state.history.forEach(function (snap) {
      snap.windows.forEach(function (w) {
        keySet[w.session + '|' + w.windowIndex] = true;
      });
      (snap.external || []).forEach(function (e) {
        keySet['sys|' + e.comm] = true;
      });
    });
    var keys = Object.keys(keySet);

    var perKey = {};
    keys.forEach(function (k) { perKey[k] = new Array(stepCount).fill(0); });
    // Per-step machine denominator (capacity). IO has no capacity → fall back to windows+external sum.
    var denoms = new Array(stepCount).fill(0);
    var sumBars = new Array(stepCount).fill(0);

    state.history.forEach(function (snap, i) {
      snap.windows.forEach(function (w) {
        var v = metric === 'cpu' ? w.cpuPercent : metric === 'mem' ? w.memBytes : w.ioBps;
        perKey[w.session + '|' + w.windowIndex][i] = v;
        sumBars[i] += v;
      });
      (snap.external || []).forEach(function (e) {
        var v = metric === 'cpu' ? e.cpuPercent : metric === 'mem' ? e.memBytes : e.ioBps;
        perKey['sys|' + e.comm][i] = v;
        sumBars[i] += v;
      });
      if (metric === 'cpu') denoms[i] = snap.cpuCapacity || sumBars[i];
      else if (metric === 'mem') denoms[i] = snap.memCapacity || sumBars[i];
      else denoms[i] = sumBars[i]; // IO: no fixed cap → stacked ratio across captured processes
    });

    // Stack: cumulative fraction-of-machine top of each band (0..1)
    var stepW = W / Math.max(1, HISTORY - 1);
    var svg = '<svg class="pp-strip" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">';
    svg += '<rect width="' + W + '" height="' + H + '" fill="#16161e" rx="6"/>';
    svg += '<line x1="0" y1="' + (H * 0.25) + '" x2="' + W + '" y2="' + (H * 0.25) + '" stroke="#24283b"/>';
    svg += '<line x1="0" y1="' + (H * 0.5) + '" x2="' + W + '" y2="' + (H * 0.5) + '" stroke="#24283b"/>';
    svg += '<line x1="0" y1="' + (H * 0.75) + '" x2="' + W + '" y2="' + (H * 0.75) + '" stroke="#24283b"/>';

    var cum = new Array(stepCount).fill(0);
    keys.sort(function (a, b) { return (perKey[b][stepCount - 1] || 0) - (perKey[a][stepCount - 1] || 0); });
    keys.forEach(function (k) {
      var pts = [];
      var bottomPts = [];
      for (var i = 0; i < stepCount; i++) {
        var frac = denoms[i] > 0 ? (perKey[k][i] / denoms[i]) : 0;
        if (frac > 1) frac = 1;
        var bottomY = H - (cum[i] * H);
        var topY = H - ((cum[i] + frac) * H);
        pts.push((i * stepW).toFixed(1) + ',' + topY.toFixed(1));
        bottomPts.push((i * stepW).toFixed(1) + ',' + bottomY.toFixed(1));
        cum[i] += frac;
      }
      var color = colorFor(k);
      var d = 'M' + pts.join(' L') + ' L' + bottomPts.reverse().join(' L') + ' Z';
      svg += '<path d="' + d + '" fill="' + color + '" fill-opacity="0.35"/>';
    });
    var topLabel = metric === 'io' ? '100% (相对)' : '整机 100%';
    svg += '<text x="6" y="12" fill="#565f89" font-size="9">' + topLabel + '</text>';
    svg += '<text x="6" y="' + (H - 4) + '" fill="#565f89" font-size="9">0%</text>';
    svg += '<text x="' + (W - 30) + '" y="' + (H - 4) + '" fill="#565f89" font-size="9">now</text>';
    svg += '</svg>';
    return svg;
  }

  // === Polling ===
  function tick() {
    if (!document.getElementById('perf-panel')) { stop(); return; }
    api.get('/api/window-stats')
      .then(function (resp) {
        if (!resp || !resp.success || !resp.data) return;
        state.last = resp.data;
        var t = resp.data.total || {};
        var memDenom = (t.systemMemTotal || 0) + (t.systemSwapTotal || 0);
        state.history.push({
          ts: Date.now(),
          cpuCapacity: (t.cpuCount || 1) * 100,
          memCapacity: memDenom,
          windows: resp.data.windows.map(function (w) {
            return {
              session: w.session,
              windowIndex: w.windowIndex,
              cpuPercent: w.cpuPercent,
              memBytes: w.memBytes + (w.swapBytes || 0),
              ioBps: w.ioBps,
            };
          }),
          external: (resp.data.external || []).map(function (e) {
            return {
              comm: e.comm,
              cpuPercent: e.cpuPercent,
              memBytes: e.memBytes + (e.swapBytes || 0),
              ioBps: e.ioBps,
            };
          }),
        });
        if (state.history.length > HISTORY) state.history.shift();
        paint();
      })
      .catch(function () { /* swallow transient */ });
  }

  function claudeTick() {
    if (!document.getElementById('perf-panel')) { stopClaude(); return; }
    if (claudeState.loading) return;
    claudeState.loading = true;
    api.get('/api/claude-usage')
      .then(function (resp) {
        claudeState.loading = false;
        if (!resp || !resp.success) { claudeState.data = null; return; }
        claudeState.data = resp.data;
        if (state.metric === 'claude') paint();
      })
      .catch(function () { claudeState.loading = false; });
  }

  function startClaude() {
    claudeTick();
    if (claudeState.timer) clearInterval(claudeState.timer);
    claudeState.timer = setInterval(claudeTick, CLAUDE_POLL_MS);
  }

  function stopClaude() {
    if (claudeState.timer) { clearInterval(claudeState.timer); claudeState.timer = null; }
  }

  function start() {
    state.history = [];
    state.last = null;
    if (timer) clearInterval(timer);
    tick();
    timer = setInterval(tick, POLL_MS);
    startClaude();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    stopClaude();
  }

  function escapeHtml(s) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  return { renderSkeleton: renderSkeleton, start: start, stop: stop };
})();
