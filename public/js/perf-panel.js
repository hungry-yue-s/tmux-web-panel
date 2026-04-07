// Perf panel — D2 design: treemap of windows by CPU/MEM/IO + 100% stacked area history.
// Self-managing: polls only while its DOM root exists.
var PerfPanel = (function () {
  var POLL_MS = 2000;
  var HISTORY = 40; // ~80s
  var METRICS = ['cpu', 'mem', 'io'];
  var METRIC_LABEL = { cpu: 'CPU', mem: '内存', io: 'IO' };

  var timer = null;
  var state = {
    metric: 'cpu',
    history: [], // each entry: { ts, windows: [{key,name,cpu,mem,io}], total: {...} }
    last: null,
  };

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

    var t = snap.total;
    var metric = state.metric;
    var windows = (snap.windows || []).slice();
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
    html += '<span class="pp-tot"><span class="pp-tot-l">CPU</span><span class="pp-tot-v">' + t.windowCpuPercent.toFixed(0) + '%</span></span>';
    html += '<span class="pp-tot"><span class="pp-tot-l">MEM</span><span class="pp-tot-v">' + fmtBytes(t.systemMemUsed) + '</span></span>';
    html += '<span class="pp-tot"><span class="pp-tot-l">IO</span><span class="pp-tot-v">' + fmtBps(t.windowIoBps) + '</span></span>';
    html += '</div>';
    html += '</div>';

    // Tabs
    html += '<div class="pp-tabs">';
    METRICS.forEach(function (m) {
      var cls = 'pp-tab' + (m === metric ? ' pp-tab-active' : '');
      html += '<button class="' + cls + '" data-metric="' + m + '">' + METRIC_LABEL[m] + '</button>';
    });
    html += '<span class="pp-tabs-spacer"></span>';
    html += '<span class="pp-tabs-hint">面积 = ' + METRIC_LABEL[metric] + ' 占比</span>';
    html += '</div>';

    // Treemap
    var W = 880, H = 320;
    html += '<svg class="pp-treemap" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">';
    if (items.length === 0) {
      html += '<rect width="' + W + '" height="' + H + '" fill="#16161e" rx="6"/>';
      html += '<text x="' + (W / 2) + '" y="' + (H / 2) + '" text-anchor="middle" fill="#565f89" font-size="12">暂无活跃窗口数据</text>';
    } else {
      var rects = squarify(items, 0, 0, W, H);
      rects.forEach(function (r) {
        var it = r.item;
        var color = colorFor(it.key);
        var pct = totalForMetric > 0 ? (it.value / totalForMetric) * 100 : 0;
        var fontSize = Math.max(9, Math.min(28, Math.sqrt(r.w * r.h) / 6));
        var labelSize = Math.max(8, Math.min(13, fontSize * 0.42));
        html += '<g class="pp-tm-cell">';
        html += '<rect x="' + r.x + '" y="' + r.y + '" width="' + r.w + '" height="' + r.h + '" fill="#1f2335" stroke="' + color + '" stroke-width="1.2" rx="4"/>';
        // accent stripe
        html += '<rect x="' + r.x + '" y="' + r.y + '" width="3" height="' + r.h + '" fill="' + color + '" rx="2"/>';
        if (r.w > 60 && r.h > 30) {
          html += '<text x="' + (r.x + 10) + '" y="' + (r.y + labelSize + 6) + '" fill="#c0caf5" font-size="' + labelSize + '" font-weight="600">' + escapeHtml(it.name) + '</text>';
          html += '<text x="' + (r.x + 10) + '" y="' + (r.y + labelSize + 6 + fontSize + 2) + '" fill="#c0caf5" font-size="' + fontSize + '" font-weight="700">' + fmtMetric(it.value, metric) + '</text>';
          if (r.h > 70) {
            html += '<text x="' + (r.x + 10) + '" y="' + (r.y + r.h - 8) + '" fill="#7d8590" font-size="9">' + pct.toFixed(1) + '% · ' + it.win.procCount + ' procs</text>';
          }
        } else if (r.w > 30 && r.h > 18) {
          html += '<text x="' + (r.x + 4) + '" y="' + (r.y + 12) + '" fill="#c0caf5" font-size="9">' + escapeHtml(it.name.split(' ')[0]) + '</text>';
        }
        html += '<title>' + escapeHtml(it.name) + ' — ' + fmtMetric(it.value, metric) + ' (' + pct.toFixed(1) + '%)</title>';
        html += '</g>';
      });
    }
    html += '</svg>';

    // History strip — 100% stacked area for current metric
    html += '<div class="pp-strip-label">最近 ' + (HISTORY * POLL_MS / 1000) + 's · 占比演化</div>';
    html += renderHistoryStrip(W, 100, metric);

    root.innerHTML = html;

    // Bind tab clicks
    var tabs = root.querySelectorAll('.pp-tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function (e) {
        state.metric = e.currentTarget.getAttribute('data-metric');
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

    // Collect all window keys ever seen
    var keySet = {};
    state.history.forEach(function (snap) {
      snap.windows.forEach(function (w) {
        keySet[w.session + '|' + w.windowIndex] = true;
      });
    });
    var keys = Object.keys(keySet);

    // Build per-key value arrays + per-step total
    var stepCount = state.history.length;
    var totals = new Array(stepCount).fill(0);
    var perKey = {};
    keys.forEach(function (k) { perKey[k] = new Array(stepCount).fill(0); });
    state.history.forEach(function (snap, i) {
      snap.windows.forEach(function (w) {
        var v = metric === 'cpu' ? w.cpuPercent : metric === 'mem' ? w.memBytes : w.ioBps;
        perKey[w.session + '|' + w.windowIndex][i] = v;
        totals[i] += v;
      });
    });

    // Stack: cumulative top of each band
    var stepW = W / Math.max(1, HISTORY - 1);
    var svg = '<svg class="pp-strip" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">';
    svg += '<rect width="' + W + '" height="' + H + '" fill="#16161e" rx="6"/>';
    svg += '<line x1="0" y1="' + (H * 0.25) + '" x2="' + W + '" y2="' + (H * 0.25) + '" stroke="#24283b"/>';
    svg += '<line x1="0" y1="' + (H * 0.5) + '" x2="' + W + '" y2="' + (H * 0.5) + '" stroke="#24283b"/>';
    svg += '<line x1="0" y1="' + (H * 0.75) + '" x2="' + W + '" y2="' + (H * 0.75) + '" stroke="#24283b"/>';

    var cum = new Array(stepCount).fill(0);
    // Sort keys by latest value desc so dominant ones are bottom
    keys.sort(function (a, b) { return (perKey[b][stepCount - 1] || 0) - (perKey[a][stepCount - 1] || 0); });
    keys.forEach(function (k) {
      var pts = [];
      var bottomPts = [];
      for (var i = 0; i < stepCount; i++) {
        var t = totals[i] > 0 ? (perKey[k][i] / totals[i]) : 0;
        var bottomY = H - (cum[i] * H);
        var topY = H - ((cum[i] + t) * H);
        pts.push((i * stepW).toFixed(1) + ',' + topY.toFixed(1));
        bottomPts.push((i * stepW).toFixed(1) + ',' + bottomY.toFixed(1));
        cum[i] += t;
      }
      var color = colorFor(k);
      var d = 'M' + pts.join(' L') + ' L' + bottomPts.reverse().join(' L') + ' Z';
      svg += '<path d="' + d + '" fill="' + color + '" fill-opacity="0.35"/>';
    });
    svg += '<text x="6" y="12" fill="#565f89" font-size="9">100%</text>';
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
        state.history.push({
          ts: Date.now(),
          windows: resp.data.windows.map(function (w) {
            return {
              session: w.session,
              windowIndex: w.windowIndex,
              cpuPercent: w.cpuPercent,
              memBytes: w.memBytes,
              ioBps: w.ioBps,
            };
          }),
        });
        if (state.history.length > HISTORY) state.history.shift();
        paint();
      })
      .catch(function () { /* swallow transient */ });
  }

  function start() {
    state.history = [];
    state.last = null;
    if (timer) clearInterval(timer);
    tick();
    timer = setInterval(tick, POLL_MS);
  }

  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  function escapeHtml(s) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  return { renderSkeleton: renderSkeleton, start: start, stop: stop };
})();
