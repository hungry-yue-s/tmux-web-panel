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
  function paintPerf() {
    var root = document.getElementById('perf-view-root');
    if (!root) return;
    if (!state.snapshot) { root.innerHTML = '<div class="pp-loading">加载机器与窗口性能…</div>'; return; }
    // PLACEHOLDER — filled in by next tasks
    root.innerHTML = '<pre style="padding:20px;color:var(--text-muted);font-size:11px">snapshot ready · windows=' + state.snapshot.windows.length + '</pre>';
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
