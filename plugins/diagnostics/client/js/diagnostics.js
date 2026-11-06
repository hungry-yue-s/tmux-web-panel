/** Opt-in, bounded performance measurements. Never retains terminal or request contents. */
(function (global) {
  'use strict';
  var nativeFetch = typeof global.fetch === 'function' ? global.fetch.bind(global) : null;
  var session = null, queue = [], dropped = 0, checking = false, uploading = false;
  var sampleTimer = null, expiryTimer = null, heartbeat = null, longTasks = null;
  var traceWasEnabled = false, traceStart = 0, traceRuns = new WeakMap();
  var terms = new Map();
  var disposedTerms = new WeakSet();
  var heartbeatVisible = false;
  var MAX_EVENTS = 300;
  var NUMBERS = ['durationMs', 'ttfbMs', 'responseBytes', 'requestBytes', 'frameCount', 'inputBytes', 'outputBytes', 'bufferedAmount', 'cols', 'rows', 'count', 'queueMs', 'parseMs', 'renderMs', 'lagMs', 'elapsedMs'];
  var CODES = /^(?:OK|HTTP_ERROR|SERVER_ERROR|NETWORK_ERROR|ABORTED|TIMEOUT|NOT_REPO|PARSE_ERROR|GIT_(?:LOAD_OK|API_ERROR|RENDER_ERROR|NOT_REPO|DIFF_OK|DIFF_ERROR|FOCUS_ERROR|STALE)|TERM_SAMPLE|WS_(?:OPEN|ERROR|CLOSE_NORMAL|CLOSE_GOING_AWAY|CLOSE_ABNORMAL|CLOSE_REJECTED|CLOSE_OTHER)|CLIENT_(?:STALL|LONGTASK|ERROR|DROPPED)|NAV_(?:WORKSPACE|PANES|RENDERER_READY|WS_CREATED|WS_OPEN|READY|FIRST_OUTPUT|FIRST_PARSED|FIRST_RENDER|STABLE))$/;

  function clock() { return global.performance ? global.performance.now() : Date.now(); }
  function id() {
    if (global.crypto && typeof global.crypto.getRandomValues === 'function') {
      var bytes = new Uint8Array(16);
      global.crypto.getRandomValues(bytes);
      return Array.from(bytes, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    }
    return Date.now().toString(16) + Math.random().toString(16).slice(2);
  }
  var clientId = id();
  function safeId(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : undefined; }
  function currentServer() { return global.Api && global.Api.activeServerId ? global.Api.activeServerId() : 'local'; }
  function enabled(serverId) {
    return !!(session && Date.now() < session.expires && (serverId || currentServer()) === session.targetServerId);
  }
  // Count UTF-8 without allocating another copy of a potentially large output frame.
  function byteLength(text) {
    if (typeof text !== 'string') return 0;
    var bytes = 0;
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c < 128) bytes++;
      else if (c < 2048) bytes += 2;
      else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xDC00 && text.charCodeAt(i + 1) <= 0xDFFF) { bytes += 4; i++; }
      else bytes += 3;
    }
    return bytes;
  }
  function route(path) {
    var url;
    try { url = new URL(path, global.location.href); } catch (_) { return null; }
    if (url.origin !== global.location.origin) return null;
    var pathname = url.pathname, serverId = 'local';
    var relay = /^\/n\/([^/]+)(\/.*)$/.exec(pathname);
    if (relay) { try { serverId = decodeURIComponent(relay[1]); } catch (_) { return null; } pathname = relay[2]; }
    if (!/^\/api\//.test(pathname) || /^\/api\/diagnostics(?:\/|$)/.test(pathname)) return null;
    var safe = '/api/:other';
    if (/^\/api\/git\/(?:status|diff|log|show|file|raw|commit-files|branches|stage|unstage|discard|apply|commit|undo-commit|commit-message|sync|checkout|line-changes)$/.test(pathname)) safe = pathname;
    else if (/^\/api\/workspace\/windows\/[^/]+\/panes(?:\/|$)/.test(pathname)) safe = '/api/workspace/windows/:window/panes';
    else if (/^\/api\/windows\/[^/]+\/panes(?:\/|$)/.test(pathname)) safe = '/api/windows/:window/panes';
    else if (/^\/api\/workspace(?:\/|$)/.test(pathname)) safe = '/api/workspace';
    else if (/^\/api\/metrics\/(?:current|history|drilldown)$/.test(pathname)) safe = pathname;
    else if (/^\/api\/metrics(?:\/|$)/.test(pathname)) safe = '/api/metrics';
    else if (/^\/api\/servers(?:\/|$)/.test(pathname)) safe = '/api/servers';
    else if (/^\/api\/files(?:\/|$)/.test(pathname)) safe = '/api/files';
    return { serverId: serverId, path: safe };
  }
  function record(kind, fields) {
    fields = fields || {};
    var serverId = fields.serverId || currentServer();
    if (!enabled(serverId) || !/^(api|terminal|client|navigation|git)$/.test(kind)) return;
    var at = typeof fields.ts === 'number' && Number.isFinite(fields.ts) && fields.ts >= 0 && fields.ts < 8640000000000000 ? fields.ts : Date.now();
    var event = { kind: kind, ts: new Date(at).toISOString(), serverId: serverId };
    if (CODES.test(fields.code || '')) event.code = fields.code;
    var normalized = typeof fields.path === 'string' && route(fields.path);
    if (normalized) event.path = normalized.path;
    if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(fields.method || '')) event.method = fields.method;
    if (Number.isInteger(fields.status) && fields.status >= 0 && fields.status <= 599) event.status = fields.status;
    ['requestId', 'parentRequestId', 'traceId'].forEach(function (key) { if (safeId(fields[key])) event[key] = fields[key]; });
    NUMBERS.forEach(function (key) {
      if (typeof fields[key] === 'number' && Number.isFinite(fields[key]) && fields[key] >= 0) event[key] = Math.round(fields[key] * 10) / 10;
    });
    if (queue.length >= MAX_EVENTS) { queue.shift(); dropped++; }
    queue.push(event);
  }
  function errorCode(error) {
    if (error && error.message === 'not_a_git_repository') return 'NOT_REPO';
    if (error && /^(ABORTED|TIMEOUT|NETWORK_ERROR)$/.test(error.code || '')) return error.code;
    if (error && error.name === 'AbortError') return 'ABORTED';
    return error && error.status >= 500 ? 'SERVER_ERROR' : 'HTTP_ERROR';
  }
  function beginApi(method, path, body) {
    var target = route(path);
    if (!target || !enabled(target.serverId)) return null;
    var owner = session, started = clock(), data = { serverId: target.serverId, path: target.path, method: method, traceId: id(), requestBytes: byteLength(body) };
    return {
      id: data.traceId,
      headers: function (response) {
        data.ttfbMs = clock() - started;
        data.status = response.status;
        if (response.headers && response.headers.get) {
          var size = response.headers.get('Content-Length');
          if (size !== null && /^\d+$/.test(size)) data.responseBytes = Number(size);
          data.requestId = safeId(response.headers.get('X-TWP-Diagnostic-Id'));
          data.parentRequestId = safeId(response.headers.get('X-TWP-Hub-Diagnostic-Id'));
        }
      },
      finish: function (error) {
        if (session !== owner) return;
        data.durationMs = clock() - started;
        data.code = error ? errorCode(error) : (this.parseFailed ? 'PARSE_ERROR' : 'OK');
        record('api', data);
      },
    };
  }
  function beginGit(serverId) {
    if (!enabled(serverId)) return null;
    var owner = session, started = clock();
    return function (fields) {
      if (session === owner) record('git', Object.assign({ serverId: serverId, durationMs: clock() - started }, fields));
    };
  }

  function termState(term, serverId) {
    if (!enabled(serverId) || disposedTerms.has(term)) return null;
    var state = terms.get(term);
    if (state) return state;
    state = { term: term, serverId: serverId, inputBytes: 0, outputBytes: 0, frameCount: 0, bufferedAmount: 0, issued: 0, parsed: 0, count: 0, queueMs: 0, parseMs: 0, renderMs: 0, oldest: null, paint: null, timer: null, marker: false };
    if (typeof term.onRender === 'function') state.render = term.onRender(function () {
      if (state.paint === null) return;
      state.renderMs = Math.max(state.renderMs, clock() - state.paint);
      state.paint = null;
    });
    terms.set(term, state);
    return state;
  }
  function clearTerminal(term) {
    var state = terms.get(term);
    if (!state) return;
    clearTimeout(state.timer);
    if (state.render) state.render.dispose();
    terms.delete(term);
  }
  function releaseTerminal(term) { disposedTerms.add(term); clearTerminal(term); }
  // One empty write marker per batch, rather than a new callback on every frame.
  function scheduleMarker(state) {
    if (state.timer || state.marker) return;
    state.timer = setTimeout(function () {
      state.timer = null;
      if (terms.get(state.term) !== state || !enabled(state.serverId)) return;
      state.marker = true;
      var watermark = state.issued, started = clock();
      try { state.term.write('', function () {
        if (terms.get(state.term) !== state) return;
        state.marker = false;
        state.parseMs = Math.max(state.parseMs, clock() - started);
        state.parsed = watermark;
        if (watermark === state.issued) state.oldest = null;
        else scheduleMarker(state);
      }); } catch (_) { clearTerminal(state.term); }
    }, 100);
  }
  function writeTerminal(term, text, serverId) {
    var state = termState(term, serverId);
    if (state) {
      state.issued += text.length;
      state.count = Math.max(state.count, state.issued - state.parsed);
      if (state.oldest === null) state.oldest = clock();
      if (state.paint === null && global.document.visibilityState === 'visible') state.paint = clock();
      scheduleMarker(state);
    }
    return term.write(text);
  }
  function watchSocket(ws, term, serverId) {
    if (!ws || typeof ws.addEventListener !== 'function') return;
    var original = ws.send, created = clock();
    function send(data) {
      var result = original.apply(this, arguments);
      var state = termState(term, serverId);
      if (state) {
        state.inputBytes += byteLength(data); state.frameCount++;
        state.bufferedAmount = Math.max(state.bufferedAmount, ws.bufferedAmount || 0);
      }
      return result;
    }
    ws.send = send;
    ws.addEventListener('message', function (event) {
      var state = termState(term, serverId);
      if (state) { state.outputBytes += byteLength(event.data); state.frameCount++; }
    });
    ws.addEventListener('open', function () { record('terminal', { serverId: serverId, code: 'WS_OPEN', durationMs: clock() - created }); });
    ws.addEventListener('error', function () { record('terminal', { serverId: serverId, code: 'WS_ERROR', count: 1 }); });
    ws.addEventListener('close', function (event) {
      var codes = { 1000: 'NORMAL', 1001: 'GOING_AWAY', 1006: 'ABNORMAL', 1008: 'REJECTED', 1013: 'REJECTED' };
      record('terminal', { serverId: serverId, code: 'WS_CLOSE_' + (codes[event.code] || 'OTHER'), durationMs: clock() - created });
      if (ws.send === send) ws.send = original;
    });
  }
  function sample() {
    terms.forEach(function (state) {
      if (!enabled(state.serverId)) return;
      // High-water UTF-16 characters ahead of the last batch marker, not a private xterm queue.
      state.count = Math.max(state.count, state.issued - state.parsed);
      state.queueMs = state.oldest === null ? 0 : clock() - state.oldest;
      if (state.paint !== null) state.renderMs = Math.max(state.renderMs, clock() - state.paint);
      record('terminal', Object.assign({ code: 'TERM_SAMPLE', cols: state.term.cols, rows: state.term.rows }, state));
      state.inputBytes = state.outputBytes = state.frameCount = state.bufferedAmount = state.parseMs = state.renderMs = state.count = 0;
    });
    var trace = global.TerminalTrace;
    var names = { workspace: 'WORKSPACE', panes: 'PANES', rendererReady: 'RENDERER_READY', wsCreated: 'WS_CREATED', wsOpen: 'WS_OPEN', ready: 'READY', firstOutput: 'FIRST_OUTPUT', firstParsed: 'FIRST_PARSED', firstRender: 'FIRST_RENDER', stable: 'STABLE' };
    if (trace && enabled()) trace.all().forEach(function (run) {
      if (run.startedAt < traceStart) return;
      if (run.serverId !== session.targetServerId && String(run.label).indexOf(session.targetServerId + ' ') !== 0) return;
      var seen = traceRuns.get(run);
      if (!seen) { seen = { id: id(), marks: {} }; traceRuns.set(run, seen); }
      Object.keys(names).forEach(function (name) {
        var value = run.marks[name];
        if (value === undefined || seen.marks[name] === value) return;
        seen.marks[name] = value;
        record('navigation', { code: 'NAV_' + names[name], durationMs: value, traceId: seen.id, ts: Date.now() - (clock() - run.startedAt - value) });
      });
    });
    if (dropped) { var count = dropped; dropped = 0; record('client', { code: 'CLIENT_DROPPED', count: count }); }
  }
  function headers() { return global.Auth && global.Auth.headers ? global.Auth.headers() : {}; }
  function fetchBounded(path, init, consume) {
    var controller = typeof global.AbortController === 'function' ? new global.AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 3000) : null;
    if (controller) init.signal = controller.signal;
    return nativeFetch(path, init).then(function (response) { return consume ? consume(response) : response; }).finally(function () { clearTimeout(timer); });
  }
  function flush(leaving) {
    if (!session || !enabled(session.targetServerId) || uploading || !queue.length || !nativeFetch) return;
    var batch = queue.splice(0, 100);
    var payload = { id: session.id, clientId: clientId, events: batch };
    var body = JSON.stringify(payload);
    var limit = leaving ? 48000 : 95000;
    while (byteLength(body) > limit && batch.length > 1) { queue.unshift(batch.pop()); body = JSON.stringify(payload); }
    uploading = true;
    var auth = headers(); auth['Content-Type'] = 'application/json';
    // Failed uploads are dropped; diagnostics must never grow an unbounded retry queue.
    fetchBounded('/api/diagnostics/client', { method: 'POST', headers: auth, body: body, keepalive: !!leaving })
      .catch(function () {}).finally(function () { uploading = false; });
  }
  function stop() {
    clearInterval(sampleTimer); clearInterval(heartbeat); clearTimeout(expiryTimer);
    sampleTimer = heartbeat = expiryTimer = null;
    if (longTasks) longTasks.disconnect();
    longTasks = null;
    terms.forEach(function (state) { clearTerminal(state.term); });
    if (session && !traceWasEnabled && global.TerminalTrace) global.TerminalTrace.disable();
    session = null; queue = []; dropped = 0;
  }
  function start(next) {
    stop(); session = next; traceStart = clock(); traceRuns = new WeakMap();
    traceWasEnabled = !!(global.TerminalTrace && global.TerminalTrace.enabled());
    if (global.TerminalTrace && !traceWasEnabled) global.TerminalTrace.enable({ persist: false });
    var last = clock();
    heartbeatVisible = global.document.visibilityState === 'visible';
    heartbeat = setInterval(function () {
      var at = clock(), lag = at - last - 1000; last = at;
      var visible = global.document.visibilityState === 'visible';
      if (visible && heartbeatVisible && lag > 200) record('client', { code: 'CLIENT_STALL', lagMs: lag });
      heartbeatVisible = visible;
    }, 1000);
    if (global.PerformanceObserver && (global.PerformanceObserver.supportedEntryTypes || []).indexOf('longtask') >= 0) {
      try {
        longTasks = new global.PerformanceObserver(function (list) {
          if (global.document.visibilityState !== 'visible') return;
          list.getEntries().forEach(function (entry) { record('client', { code: 'CLIENT_LONGTASK', durationMs: entry.duration }); });
        });
        longTasks.observe({ entryTypes: ['longtask'] });
      } catch (_) { longTasks = null; }
    }
    sampleTimer = setInterval(function () { sample(); flush(); }, 5000);
    expiryTimer = setTimeout(stop, Math.max(0, next.expires - Date.now()));
  }
  function checkStatus() {
    if (!nativeFetch || checking || !global.Auth || !global.Auth.headers) return;
    checking = true;
    fetchBounded('/api/diagnostics/status', { headers: headers(), cache: 'no-store' }, function (response) {
      if (!response.ok) return null;
      return response.json();
    }).then(function (payload) {
      if (!payload) return;
      var data = payload.data || payload;
      var expires = typeof data.expiresAt === 'number' ? data.expiresAt : Date.parse(data.expiresAt);
      if (!data.active || !safeId(data.id) || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(data.targetServerId || '') || !Number.isFinite(expires) || expires <= Date.now()) { stop(); return; }
      if (session && session.id === data.id) return;
      start({ id: data.id, targetServerId: data.targetServerId, expires: expires });
    }).catch(function () {}).finally(function () { checking = false; });
  }
  global.Diagnostics = { enabled: enabled, record: record, beginApi: beginApi, beginGit: beginGit, errorCode: errorCode, writeTerminal: writeTerminal, watchSocket: watchSocket, releaseTerminal: releaseTerminal };
  global.addEventListener('error', function () { record('client', { code: 'CLIENT_ERROR', count: 1 }); });
  global.addEventListener('unhandledrejection', function () { record('client', { code: 'CLIENT_ERROR', count: 1 }); });
  global.addEventListener('pagehide', function () { sample(); flush(true); });
  global.document.addEventListener('visibilitychange', function () {
    heartbeatVisible = false;
    // Background rendering is throttled by the host; it is not a visible-frame delay.
    terms.forEach(function (state) { state.paint = null; state.renderMs = 0; });
    if (global.document.visibilityState !== 'visible') { sample(); flush(true); }
  });
  global.addEventListener('authready', checkStatus);
  if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', checkStatus, { once: true });
  else checkStatus();
  setInterval(checkStatus, 15000);
})(window);
