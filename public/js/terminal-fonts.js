/* global TERMINAL_FONT_SLICES */

// On-demand slices of the bundled terminal font.
//
// The core slice (Latin, symbols, box drawing, Powerline) is declared in
// /css/terminal-fonts.css and preloaded. CJK and Nerd Font icon slices are
// registered here as FontFaces: DOM text loads them by unicode-range like
// any web font, and the terminal — which draws on a canvas and so never
// triggers a unicode-range load — asks `ensure()` for the characters on
// screen, then repaints once a slice arrives.

var TerminalFonts = (function () {
  'use strict';

  var data = typeof window !== 'undefined' ? window.TERMINAL_FONT_SLICES : null;
  var family = data ? data.family : 'Tmux Panel Mono';
  var slices = [];
  var faceCache = {}; // sliceIndex:weight -> FontFace
  var requested = {}; // sliceIndex:weight -> promise
  var seen = {}; // code point:weight already resolved

  function hex(cp) { return cp.toString(16).toUpperCase(); }

  function rangeString(slice) {
    if (slice.ranges) {
      return slice.ranges.map(function (r) { return r[0] === r[1] ? 'U+' + hex(r[0]) : 'U+' + hex(r[0]) + '-' + hex(r[1]); }).join(', ');
    }
    var parts = [];
    for (var i = 0; i < slice.chars.length;) {
      var cp = slice.chars.codePointAt(i);
      parts.push('U+' + hex(cp));
      i += cp > 0xFFFF ? 2 : 1;
    }
    return parts.join(', ');
  }

  if (data && typeof FontFace !== 'undefined' && typeof document !== 'undefined' && document.fonts) {
    data.slices.forEach(function (slice, index) {
      var entry = { index: index, slice: slice, ranges: slice.ranges || null, set: null, unicodeRange: rangeString(slice) };
      if (slice.chars) {
        entry.set = {};
        for (var i = 0; i < slice.chars.length;) {
          var cp = slice.chars.codePointAt(i);
          entry.set[cp] = true;
          i += cp > 0xFFFF ? 2 : 1;
        }
      }
      slices.push(entry);
      Object.keys(slice.files).forEach(function (weight) {
        try {
          var face = new FontFace(family, 'url(' + data.base + slice.files[weight] + ') format("woff2")', {
            weight: weight, style: 'normal', display: 'swap', unicodeRange: entry.unicodeRange,
          });
          document.fonts.add(face);
          faceCache[index + ':' + weight] = face;
        } catch (_e) { /* an engine without unicode-range support keeps the system fallback */ }
      });
    });
  }

  /** The slice that draws `cp`: the last declared one whose range holds it. */
  function sliceFor(cp) {
    for (var i = slices.length - 1; i >= 0; i--) {
      var s = slices[i];
      if (s.set) { if (s.set[cp]) return s; continue; }
      for (var r = 0; r < s.ranges.length; r++) {
        if (cp >= s.ranges[r][0] && cp <= s.ranges[r][1]) return s;
      }
    }
    return null;
  }

  function needsSlice(cp) {
    return cp >= 0x1100 && !(cp >= 0xE0A0 && cp <= 0xE0D7);
  }

  /**
   * Loads the slices for the characters in `text` at `weight` (400 or 700).
   * Resolves true when at least one slice was newly loaded, so a canvas
   * renderer knows to rebuild its glyph cache.
   */
  function ensure(text, weight) {
    weight = weight === 700 ? 700 : 400;
    if (!slices.length || !text) return Promise.resolve(false);
    var pending = [];
    for (var i = 0; i < text.length;) {
      var cp = text.codePointAt(i);
      i += cp > 0xFFFF ? 2 : 1;
      if (!needsSlice(cp)) continue;
      var key = cp + ':' + weight;
      if (seen[key]) continue;
      seen[key] = true;
      var slice = sliceFor(cp);
      if (!slice) continue;
      var faceKey = slice.index + ':' + weight;
      if (requested[faceKey]) continue;
      var face = faceCache[faceKey];
      if (!face) continue;
      requested[faceKey] = face.status === 'loaded' ? Promise.resolve(false)
        : face.load().then(function () { return true; }, function () { return false; });
      pending.push(requested[faceKey]);
    }
    if (!pending.length) return Promise.resolve(false);
    return Promise.all(pending).then(function (results) { return results.some(Boolean); });
  }

  /** Resolves when the core faces are usable, or after `timeoutMs` regardless. */
  function coreReady(timeoutMs) {
    if (typeof document === 'undefined' || !document.fonts || !document.fonts.load) return Promise.resolve(false);
    var load = Promise.all([
      document.fonts.load("400 14px '" + family + "'", 'Aa'),
      document.fonts.load("700 14px '" + family + "'", 'Aa'),
    ]).then(function (faces) { return faces[0].length > 0; }, function () { return false; });
    if (!timeoutMs) return load;
    return Promise.race([load, new Promise(function (resolve) { setTimeout(function () { resolve(null); }, timeoutMs); })]);
  }

  return { ensure: ensure, coreReady: coreReady, family: family, _test: { sliceFor: sliceFor, slices: slices } };
})();

if (typeof window !== 'undefined') window.TerminalFonts = TerminalFonts;
