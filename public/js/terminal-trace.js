/**
 * Optional timing of one terminal coming up, from the click to a stable screen.
 *
 * Off by default and then costs one check per call. Turn it on with
 * `TerminalTrace.enable()` (remembered in this browser), read it with
 * `TerminalTrace.last()`. It keeps times, grid sizes and counts only: never a
 * token, a URL, input or anything shown in the terminal, and only the last few runs.
 *
 * It is an aid, not an acceptance test. `ready` only means the attach client exists.
 * `marks.stable` is a heuristic for when drawing ended: the last render after
 * substantial activity (a large write, a new alternate-screen entry, a size change or
 * a new connection), once STABLE_QUIET_MS has passed with none. It is moved or
 * withdrawn whenever more of that arrives, so read it after the screen has settled,
 * and treat a screenshot as the real answer: it cannot see what the pixels show.
 * Small writes such as a spinner do not count. `counts.alternateScreens` above 1
 * means tmux drew from scratch again, which is what a second attach looks like;
 * every entry in `sizes` after the first is a real change of grid.
 *
 * A terminal reports through the handle from attach(), tied to the run it belongs
 * to. Once a newer run has begun, an old terminal still finishing up writes nothing.
 */
var TerminalTrace = (function () {
  'use strict';

  var STORAGE_KEY = 'twp_terminal_trace';
  var STABLE_QUIET_MS = 1000;
  var REDRAW_MIN_CHARS = 512;
  var KEEP = 20;
  var ALTERNATE_SCREEN = '\x1b[?1049h';

  var enabled = false;
  try { enabled = !!window.localStorage.getItem(STORAGE_KEY); } catch (_) { /* private mode */ }

  var history = [];
  var current = null;
  var lastClickAt = null;
  var quietTimer = null;
  var clicksWatched = false;

  function now() {
    return performance.now();
  }

  function watchClicks() {
    if (clicksWatched || typeof document === 'undefined') return;
    clicksWatched = true;
    document.addEventListener('click', function () {
      if (enabled) lastClickAt = now();
    }, true);
  }

  /**
   * @param {string} label
   * @param {{ continues?: boolean }} [options] the same navigation going on, such as a
   *   bare server route resolving to its default window: keep the time already counted
   */
  function begin(label, options) {
    if (!enabled) return;
    if (options && options.continues && current) {
      current.label = label;
      return;
    }
    var at = now();
    var fromClick = lastClickAt !== null && at - lastClickAt < 1000;
    clearTimeout(quietTimer);
    current = {
      label: label,
      startedAt: fromClick ? lastClickAt : at,
      marks: {},
      sizes: [],
      counts: { alternateScreens: 0, connects: 0 },
    };
    lastClickAt = null;
    history.push(current);
    if (history.length > KEEP) history.shift();
  }

  function markOn(trace, name, detail) {
    if (trace.marks[name] !== undefined) return;
    trace.marks[name] = Math.round(now() - trace.startedAt);
    if (detail) trace[name + 'Detail'] = detail;
  }

  function mark(name, detail) {
    if (enabled && current) markOn(current, name, detail);
  }

  function armQuietTimer(trace) {
    clearTimeout(quietTimer);
    quietTimer = setTimeout(function () {
      if (trace.marks.stable === undefined) trace.marks.stable = Math.round(trace.lastDrawAt - trace.startedAt);
    }, STABLE_QUIET_MS);
  }

  /** Something that changes the whole screen: any earlier verdict no longer holds. */
  function noteActivity(trace) {
    if (trace.marks.firstOutput === undefined) return;
    trace.lastDrawAt = now();
    trace.drawPending = true;
    delete trace.marks.stable;
    armQuietTimer(trace);
  }

  function noteSizeOn(trace, cols, rows) {
    var last = trace.sizes[trace.sizes.length - 1];
    if (last && last.cols === cols && last.rows === rows) return;
    trace.sizes.push({ at: Math.round(now() - trace.startedAt), cols: cols, rows: rows });
    if (last) noteActivity(trace);
  }

  /**
   * Ties one terminal to the run under way, or to a new one when that run already has
   * a terminal (a pane switch or a re-render, which no route announced).
   * @returns {object|null} what the terminal reports through; null when turned off
   */
  function attach(term) {
    if (!enabled) return null;
    if (!current || current.owned) begin('remount');
    var trace = current;
    trace.owned = true;
    // The end of the last output frame, because the marker can be cut in two. Only
    // ever a few bytes, and outside anything `last()` returns.
    var outputTail = '';
    function live() {
      return enabled && trace === current;
    }

    var parsed = term.onWriteParsed(function () {
      parsed.dispose();
      if (live()) markOn(trace, 'firstParsed');
    });
    term.onRender(function () {
      if (!live() || trace.marks.firstParsed === undefined) return;
      markOn(trace, 'firstRender');
      // A substantial write has reached the screen: this is when it was drawn.
      if (trace.drawPending && trace.marks.stable === undefined) {
        trace.drawPending = false;
        trace.lastDrawAt = now();
        armQuietTimer(trace);
      }
    });
    term.onResize(function (size) {
      if (live()) noteSizeOn(trace, size.cols, size.rows);
    });

    return {
      mark: function (name, detail) {
        if (live()) markOn(trace, name, detail);
      },
      connecting: function (cols, rows) {
        if (!live()) return;
        markOn(trace, 'wsCreated', { cols: cols, rows: rows });
        trace.counts.connects += 1;
        noteSizeOn(trace, cols, rows);
        noteActivity(trace);
      },
      /** Each output frame's text, which is only measured and searched here. */
      output: function (text) {
        if (!live()) return;
        markOn(trace, 'firstOutput');
        var scanned = outputTail + text;
        outputTail = scanned.slice(-(ALTERNATE_SCREEN.length - 1));
        var entries = 0;
        for (var at = scanned.indexOf(ALTERNATE_SCREEN); at >= 0; at = scanned.indexOf(ALTERNATE_SCREEN, at + 1)) entries += 1;
        trace.counts.alternateScreens += entries;
        if (entries > 0 || text.length >= REDRAW_MIN_CHARS || trace.lastDrawAt === undefined) noteActivity(trace);
      },
    };
  }

  if (enabled) watchClicks();

  return {
    begin: begin,
    mark: mark,
    attach: attach,
    enabled: function () { return enabled; },
    enable: function () {
      enabled = true;
      watchClicks();
      try { window.localStorage.setItem(STORAGE_KEY, '1'); } catch (_) { /* private mode */ }
    },
    disable: function () {
      enabled = false;
      current = null;
      history = [];
      clearTimeout(quietTimer);
      try { window.localStorage.removeItem(STORAGE_KEY); } catch (_) { /* private mode */ }
    },
    last: function () { return current; },
    all: function () { return history.slice(); },
  };
})();

if (typeof window !== 'undefined') window.TerminalTrace = TerminalTrace;
