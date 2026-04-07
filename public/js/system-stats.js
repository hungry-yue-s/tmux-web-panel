// System stats panel — graphical CPU/memory/load display with sparkline charts.
// Self-managing: polls only while the target DOM nodes exist, otherwise stops.
var SystemStats = (function () {
  var POLL_MS = 2000;
  var HISTORY = 40; // ~80 seconds of samples

  var timer = null;
  var cpuHistory = [];
  var memHistory = [];

  function fmtBytes(n) {
    if (!n && n !== 0) return '—';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return n.toFixed(n >= 10 ? 0 : 1) + ' ' + units[i];
  }

  function fmtUptime(sec) {
    var d = Math.floor(sec / 86400);
    var h = Math.floor((sec % 86400) / 3600);
    var m = Math.floor((sec % 3600) / 60);
    if (d > 0) return d + 'd ' + h + 'h';
    if (h > 0) return h + 'h ' + m + 'm';
    return m + 'm';
  }

  // Build a smooth SVG polyline (0..100 values) into a 200x60 viewBox.
  function sparkline(points, color) {
    var W = 200, H = 60;
    if (points.length === 0) {
      return '<svg class="ss-spark" viewBox="0 0 ' + W + ' ' + H + '"></svg>';
    }
    var step = W / Math.max(1, HISTORY - 1);
    var coords = points.map(function (v, i) {
      var x = i * step;
      var y = H - (Math.max(0, Math.min(100, v)) / 100) * H;
      return x.toFixed(1) + ',' + y.toFixed(1);
    });
    var line = coords.join(' ');
    var area = 'M0,' + H + ' L' + coords.map(function (c) { return c; }).join(' L') + ' L' + ((points.length - 1) * step).toFixed(1) + ',' + H + ' Z';
    return (
      '<svg class="ss-spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' +
        '<path d="' + area + '" fill="' + color + '" fill-opacity="0.18"/>' +
        '<polyline points="' + line + '" fill="none" stroke="' + color + '" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>' +
      '</svg>'
    );
  }

  // Circular gauge for a 0..100 percentage value.
  function gauge(percent, color, label, value) {
    var p = Math.max(0, Math.min(100, percent || 0));
    var R = 32;
    var C = 2 * Math.PI * R;
    var dash = (p / 100) * C;
    return (
      '<div class="ss-gauge">' +
        '<svg viewBox="0 0 80 80">' +
          '<circle cx="40" cy="40" r="' + R + '" fill="none" stroke="var(--bg-hover)" stroke-width="6"/>' +
          '<circle cx="40" cy="40" r="' + R + '" fill="none" stroke="' + color + '" stroke-width="6" ' +
            'stroke-dasharray="' + dash.toFixed(2) + ' ' + C.toFixed(2) + '" ' +
            'stroke-linecap="round" transform="rotate(-90 40 40)"/>' +
          '<text x="40" y="46" text-anchor="middle" fill="var(--text-primary)" font-size="16" font-weight="600">' + value + '</text>' +
        '</svg>' +
        '<div class="ss-gauge-label">' + label + '</div>' +
      '</div>'
    );
  }

  function renderSkeleton() {
    return (
      '<div id="system-stats" class="ss-card">' +
        '<div class="ss-loading">加载机器状态…</div>' +
      '</div>'
    );
  }

  function paint(d) {
    var root = document.getElementById('system-stats');
    if (!root) return false;

    cpuHistory.push(d.cpuPercent);
    memHistory.push(d.memPercent);
    if (cpuHistory.length > HISTORY) cpuHistory.shift();
    if (memHistory.length > HISTORY) memHistory.shift();

    var cpuColor = 'var(--accent-blue)';
    var memColor = 'var(--accent-green)';

    var html = '';
    html += '<div class="ss-header">';
    html += '<span class="ss-host">' + escapeHtml(d.hostname) + '</span>';
    html += '<span class="ss-meta">' + escapeHtml(d.platform) + '/' + escapeHtml(d.arch) + ' · ' + d.cpuCount + ' cores · up ' + fmtUptime(d.uptime) + '</span>';
    html += '</div>';

    html += '<div class="ss-grid">';

    // CPU panel
    html += '<div class="ss-panel">';
    html += '<div class="ss-panel-row">';
    html += gauge(d.cpuPercent, cpuColor, 'CPU', d.cpuPercent.toFixed(0) + '%');
    html += '<div class="ss-panel-body">';
    html += '<div class="ss-panel-title">CPU 使用率</div>';
    html += sparkline(cpuHistory, '#7aa2f7');
    html += '<div class="ss-panel-sub">load ' + d.load1.toFixed(2) + ' · ' + d.load5.toFixed(2) + ' · ' + d.load15.toFixed(2) + '</div>';
    html += '</div></div></div>';

    // Memory panel
    html += '<div class="ss-panel">';
    html += '<div class="ss-panel-row">';
    html += gauge(d.memPercent, memColor, 'MEM', d.memPercent.toFixed(0) + '%');
    html += '<div class="ss-panel-body">';
    html += '<div class="ss-panel-title">内存使用率</div>';
    html += sparkline(memHistory, '#9ece6a');
    html += '<div class="ss-panel-sub">' + fmtBytes(d.memUsed) + ' / ' + fmtBytes(d.memTotal) + '</div>';
    html += '</div></div></div>';

    html += '</div>';

    root.innerHTML = html;
    return true;
  }

  function tick() {
    // If our DOM is gone, auto-stop polling.
    if (!document.getElementById('system-stats')) {
      stop();
      return;
    }
    api.get('/api/system-stats')
      .then(function (resp) {
        if (resp && resp.success && resp.data) paint(resp.data);
      })
      .catch(function () { /* ignore transient errors */ });
  }

  function start() {
    cpuHistory = [];
    memHistory = [];
    if (timer) clearInterval(timer);
    tick();
    timer = setInterval(tick, POLL_MS);
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  // Minimal escapeHtml fallback if app.js's escapeHtml is not yet on window
  function escapeHtml(s) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  return { renderSkeleton: renderSkeleton, start: start, stop: stop };
})();
