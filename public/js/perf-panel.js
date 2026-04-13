// Perf panel — D2 design: treemap of windows by CPU/MEM/IO + 100% stacked area history.
// Self-managing: polls only while its DOM root exists.
var PerfPanel = (function () {
  var POLL_MS = 2000;
  var HISTORY = 40; // ~80s
  var MAX_ROWS = 15; // top N windows in bar chart; rest aggregated as "others"
  var METRICS = ['cpu', 'mem', 'io', 'disk'];
  var METRIC_LABEL = { cpu: 'CPU', mem: '内存', io: 'IO', disk: '磁盘' };

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
      // Horizontal bar chart: each row = one window, RAM + SWAP segments aligned to a common scale.
      var memItems = windows
        .map(function (w) {
          return {
            key: w.session + '|' + w.windowIndex,
            name: w.session + ':' + w.windowIndex + (w.windowName && w.windowName !== String(w.windowIndex) ? ' ' + w.windowName : ''),
            ram: w.memBytes,
            swap: w.swapBytes,
            total: w.memBytes + w.swapBytes,
            win: w,
          };
        })
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
      html += '<span class="pp-legend-hint">条长 = RAM+SWAP，按 window 总占用排序</span>';
      html += '</div>';

      var rowH = 26;
      var rowGap = 4;
      var nameW = 170;
      var pctW = 92;
      var barW = W - nameW - pctW - 16;
      var maxTotal = memItems.length > 0 ? memItems[0].total : 1;
      var memDenom = t.systemMemTotal + t.systemSwapTotal;
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
      var maxV = barItems.length > 0 ? barItems[0].value : 1;
      var Hbar2 = Math.max(120, (barItems.length + (otherAgg ? 1 : 0)) * (rowH2 + rowGap2) + 8);
      var fmtFn = function (v) { return fmtMetric(v, metric); };

      html += '<div class="pp-mem-legend"><span class="pp-legend-hint">条长 = ' + METRIC_LABEL[metric] + '，按 window 占用排序 · 百分比 = 占机器总量</span></div>';
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
