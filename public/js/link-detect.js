// Pure, DOM-free link detection for terminal output: URLs, file paths,
// file:// URIs, label-prefixed paths, line refs, and web/file ambiguity.
//
// Exposes window.LinkDetect.findLinks(text) -> array of matches on a single
// LOGICAL line (callers merge soft-wrapped rows first). Each match:
//   { kind: 'web'|'file'|'ambiguous', text, href, lineRef, start, end }
//     - start/end : string offsets [start,end) for the HIGHLIGHT range
//     - text      : clean payload — for file/ambiguous the path; for web the URL
//     - href      : for web/ambiguous, the URL to open (scheme prepended); else null
//     - lineRef   : for file, an optional line number to jump to (else null)
//
// Kept independent of file-preview.js so it is unit-testable in node via the
// repo's `new Function('window', src)` pattern (see test/perf-utils.test.js).
var LinkDetect = (function () {
  'use strict';

  // --- Character classes (RegExp source fragments) ---

  // CJK ideographs are ALLOWED inside paths/URLs (CJK filenames, Chinese
  // Wikipedia URLs). Only CJK *punctuation* terminates a token.
  var CJK = '\\u4e00-\\u9fff';
  var CJK_PUNCT = '\\u3000-\\u303f\\uff00-\\uffef\\u2000-\\u206f';
  // Middle dots (U+00B7 ·, U+30FB ・) read as separators, not path content (D23).
  var DOTS = '\\u00b7\\u30fb';

  // Path body: excludes whitespace, quotes, brackets, URL delimiters, CJK
  // punctuation and middle dots. CJK ideographs allowed.
  var PB = '[^\\s\'"()\\[\\]{}<>:;,?#&@=' + CJK_PUNCT + DOTS + ']';
  // URL body: re-admits query/fragment chars ? & = # @ ; only whitespace,
  // quotes, brackets, backtick, CJK punctuation and middle dots terminate.
  var UB = '[^\\s\'"()\\[\\]{}<>`' + CJK_PUNCT + DOTS + ']';

  // A path must not start in the middle of a larger token.
  var NP = '(?<![\\w\\-:/.~])';
  // Web links must not start inside a word/host (D4/D5).
  var UNP = '(?<![\\w./-])';
  // Label-prefix lookbehind: a path glued to `<letter|CJK>:` (Fix 8).
  var LB = '(?<=[A-Za-z' + CJK + ']:)';

  function re(src, flags) { return new RegExp(src, flags || 'g'); }

  // --- Regexes ---

  // Web (http first so a containing http match wins over www/localhost inside it)
  var HTTP_RE = re(UNP + '(?:https?|HTTPS?)://' + UB + '+');
  var WWW_RE = re(UNP + 'www\\.' + UB + '+');
  var HOST_RE = re(UNP + '(?:localhost|127\\.0\\.0\\.1):\\d+(?:/' + UB + '*)?');

  // file:// (two-or-more slashes tolerated; CJK punct/whitespace/quotes stop it)
  var FILE_URL_RE = re('(?:file|FILE):/{2,}[^\\s\'"()\\[\\]{}<>`' + CJK_PUNCT + ']*');

  // Paths
  var ABS_RE = re(NP + '/' + PB + '+(?:/' + PB + '+)*');
  var TILDE_RE = re(NP + '~[a-zA-Z0-9_\\-]*/' + PB + '+(?:/' + PB + '+)*');
  var REL_RE = re(NP + '\\.\\.?/' + PB + '+(?:/' + PB + '+)*');
  var BARE_RE = re(NP + '[a-zA-Z0-9_\\-]+(?:/' + PB + '+)+');
  // CJK allowed only in the LEADING name; interior dotted segments + the
  // trailing lookahead stay ASCII so `报告.pdf和笔记.txt` splits into two (D17).
  var FILE_TAIL = '(?:\\.[\\w\\-]+)*\\.[a-z][a-z0-9]{0,5}(?![\\w\\-/.])';
  var BARE_FILE_RE = re(NP + '[a-zA-Z' + CJK + '][\\w' + CJK + '\\-]*' + FILE_TAIL);

  // Label-prefixed paths (Fix 8 + D25/D26): abs, rel, bare-with-slash, bare-file.
  // LABEL_ABS guards against a scheme's `//` (file://, http://) being mistaken
  // for `<label>:<abspath>` (its colon satisfies the letter-colon lookbehind).
  var LABEL_ABS_RE = re(LB + '/(?!/)' + PB + '+(?:/' + PB + '+)*');
  var LABEL_REL_RE = re(LB + '\\.\\.?/' + PB + '+(?:/' + PB + '+)*');
  var LABEL_BARE_RE = re(LB + '[a-zA-Z][\\w\\-]*(?:/' + PB + '+)+');
  var LABEL_FILE_RE = re(LB + '[a-zA-Z' + CJK + '][\\w' + CJK + '\\-]*' + FILE_TAIL);

  // Extensionless build files referenced as `Name:line` (D3), kept to a safe
  // allowlist so arbitrary `word:42` prose is not promoted to a link.
  var BUILDFILE_RE = re('(?<![\\w./~-])(?:Makefile|Dockerfile|Rakefile|Gemfile|Jenkinsfile|Vagrantfile|Procfile|BUILD|GNUmakefile)(?=:\\d)');

  // --- Domain vs file ambiguity (user rule: ambiguous => let user choose) ---

  // Extensions that look like a domain TLD when they end a bare name.ext.
  var TLD = {};
  ('com org net io co cn dev app ai me info xyz gov edu top site tech cloud biz tv cc us uk jp de fr ru in nl eu so gg')
    .split(' ').forEach(function (t) { TLD[t] = true; });
  // Extensions that are unambiguously files even if they collide with a ccTLD.
  var FILE_EXT = {};
  ('js ts jsx tsx mjs cjs py rb go rs java kt c cc cpp cxx h hpp cs php swift sh bash zsh fish lua pl pm r jl dart scala clj ' +
   'json yaml yml toml xml html htm css scss sass less md markdown txt text log conf cfg ini env properties sql csv tsv ' +
   'png jpg jpeg gif svg webp ico bmp tiff mp4 mp3 wav flac ogg webm mov avi mkv pdf doc docx xls xlsx ppt pptx odt ' +
   'zip tar gz tgz bz2 xz 7z rar lock sum mod gradle mk cmake vue svelte astro tf hcl proto graphql gql ipynb')
    .split(' ').forEach(function (e) { FILE_EXT[e] = true; });

  // A bare `name.ext` (no slash) whose ext reads like a TLD and is not a known
  // file extension is ambiguous between a domain and a file.
  function _isAmbiguousDomain(text) {
    if (text.indexOf('/') !== -1) return false;
    var dot = text.lastIndexOf('.');
    if (dot < 0) return false;
    var ext = text.slice(dot + 1).toLowerCase();
    return !!TLD[ext] && !FILE_EXT[ext];
  }

  // --- Trimming ---

  // Strip trailing sentence punctuation that the regex over-captured. Paths and
  // URLs differ: the old WebLinksAddon kept `;` `#` `&` `=` `/` as valid URL
  // final chars (D36), so web trim must not shed them.
  function _webTrim(s) {
    s = s.replace(/[.,:!?)\]}>]+$/, '');
    // Trailing Chinese prose glued to a domain/path (github.com然后克隆 ->
    // github.com). Only when there's no query/fragment — CJK inside ?...=值 / #锚
    // is real URL content (D15) — and only when the CJK run follows an ASCII
    // alnum, so a pure-CJK path segment (/wiki/中文) stays intact.
    if (!/[?#]/.test(s)) s = s.replace(/([A-Za-z0-9])[一-鿿]+$/, '$1');
    return s;
  }
  function _pathTrim(s, isBareFile) {
    s = isBareFile
      ? s.replace(/[,;:!?)>\]}]+$/, '')
      : s.replace(/[.,;:!?)>\]}]+$/, '');
    // Trailing CJK leaking past a file extension: file.txt然后 -> file.txt
    s = s.replace(/(\.[a-zA-Z][a-zA-Z0-9]{0,5})[一-鿿]+$/, '$1');
    // Trailing CJK glued to an ASCII alnum on an extensionless leaf:
    // /etc/hosts看看 -> /etc/hosts (pure-CJK segments after `/` are preserved).
    s = s.replace(/([A-Za-z0-9])[一-鿿]+$/, '$1');
    return s;
  }

  // --- Guards ---

  // Reject bare slash tuples that are dates/ratios/versions: every segment is
  // purely numeric (D41). 2024/06/05, 3/4, 100/200 -> not a path.
  function _allNumericSegments(s) {
    var segs = s.split('/');
    for (var i = 0; i < segs.length; i++) {
      if (segs[i] === '' || !/^\d+$/.test(segs[i])) return false;
    }
    return true;
  }

  // Reject a pure-CJK run with no ASCII anchor and no extension (D42):
  // 前端/后端 must not yield /后端.
  function _isPureCjkNoAnchor(s) {
    if (/[A-Za-z0-9]/.test(s)) return false;      // has ASCII -> not pure CJK
    if (/^(?:\.\.?\/|~|\/[A-Za-z0-9])/.test(s)) return false; // anchored
    return /[一-鿿]/.test(s);
  }

  // scp/ssh remote `user@host:path` — the label-prefix colon is preceded by a
  // host token containing `@`; reject as a local path (D27). Bounded backward
  // scan (stops at the first whitespace) so it stays O(token), not O(line).
  function _labelHasAtHost(line, colonIdx) {
    for (var i = colonIdx - 1; i >= 0; i--) {
      var ch = line.charAt(i);
      if (ch === ' ' || ch === '\t' || ch === '\n') return false;
      if (ch === '@') return true;
    }
    return false;
  }

  // --- file:// processing (D7-D12) ---

  function _processFileUrl(line, start, raw) {
    var rest = raw.replace(/^(?:file|FILE):\/\//, '');   // drop scheme + //
    // Optional authority: file://host/path -> keep from first '/'. file:////a
    // (empty authority, leading //) -> collapse to '/'.
    var local;
    if (rest.charAt(0) === '/') {
      local = rest.replace(/^\/+/, '/');                 // collapse leading slashes
    } else {
      var slash = rest.indexOf('/');
      if (slash === -1) return null;                     // authority, no path (D10)
      local = rest.slice(slash);
    }
    if (!local || local === '/') return null;            // empty / root-only (D9)
    // Preserve a trailing :line[:col] before decoding (D7).
    var lineRef = null;
    var suf = /:(\d+)(?::\d+)?$/.exec(local);
    if (suf) { lineRef = Number(suf[1]); local = local.slice(0, suf.index); }
    try { local = decodeURIComponent(local); } catch (_e) { /* keep raw (D8) */ }
    if (!local) return null;
    return { kind: 'file', text: local, href: null, lineRef: lineRef,
      start: start, end: start + raw.length };          // span covers raw file://… (D12)
  }

  // --- Line-ref attachment for paths (Fix 1 + D1/D2) ---

  function _attachLineRef(line, m) {
    var after = line.slice(m.end);
    // Inline path:line[:col]
    var inl = /^:(\d{1,6})(?::\d+)?(?![\w\-])/.exec(after);
    if (inl) {
      var hasExt = /\.[a-zA-Z][a-zA-Z0-9]{0,5}$/.test(m.text);
      var yearLike = /^(?:19|20)\d{2}$/.test(inl[1]);
      // Don't treat a 4-digit year glued to an extensionless leaf as a line
      // (D1): /var/log/syslog:2024 stays a path, no fake line jump.
      if (hasExt || !yearLike) {
        m.lineRef = Number(inl[1]);
        m.end += inl[0].length;                          // highlight covers :42:10
        return;
      }
    }
    // Python/Ruby traceback: <path>", line 42  /  <path>, line 42 (D2)
    var tb = /^["',\s]+line\s+(\d+)/.exec(after);
    if (tb) m.lineRef = Number(tb[1]);
  }

  // --- Overlap dedup (D13) ---
  // Keep maximal, non-intersecting spans, preferring leftmost-then-longest.
  // Web matches win ties so a path fragment never steals a URL span (D29/Q3).
  // Linear sweep: sorted by start, lastEnd grows monotonically so a candidate
  // clashes with the kept set iff its start falls before lastEnd.
  function _dedup(matches) {
    matches.sort(function (a, b) {
      if (a.start !== b.start) return a.start - b.start;
      if (a.end !== b.end) return b.end - a.end;          // longer first
      var wa = a.kind === 'file' ? 1 : 0, wb = b.kind === 'file' ? 1 : 0;
      return wa - wb;                                     // web/ambiguous before file
    });
    var kept = [], lastEnd = -1;
    for (var i = 0; i < matches.length; i++) {
      if (matches[i].start >= lastEnd) { kept.push(matches[i]); lastEnd = matches[i].end; }
    }
    return kept;
  }

  // --- Path regex runner ---

  function _runPath(line, rx, isBareFile, out) {
    rx.lastIndex = 0;
    var m;
    while ((m = rx.exec(line)) !== null) {
      var raw = m[0];
      var trimmed = _pathTrim(raw, isBareFile);
      if (!isBareFile && trimmed.indexOf('/') === -1) continue;
      if (trimmed.length < 2) continue;
      // FP guards
      if (rx === BARE_RE && _allNumericSegments(trimmed)) continue;     // D41
      if (_isPureCjkNoAnchor(trimmed)) continue;                        // D42
      var isLabel = (rx === LABEL_ABS_RE || rx === LABEL_REL_RE ||
        rx === LABEL_BARE_RE || rx === LABEL_FILE_RE);
      if (isLabel && _labelHasAtHost(line, m.index - 1)) continue;      // D27
      var kind = 'file', href = null;
      if (isBareFile && _isAmbiguousDomain(trimmed)) {                  // user rule
        kind = 'ambiguous';
        href = 'https://' + trimmed;
      }
      out.push({ kind: kind, text: trimmed, href: href, lineRef: null,
        start: m.index, end: m.index + trimmed.length });
    }
  }

  function _runWeb(line, rx, out) {
    rx.lastIndex = 0;
    var m;
    while ((m = rx.exec(line)) !== null) {
      var trimmed = _webTrim(m[0]);
      if (trimmed.length < 4) continue;
      out.push({ kind: 'web', text: trimmed, href: computeHref(trimmed),
        lineRef: null, start: m.index, end: m.index + trimmed.length });
    }
  }

  // --- Public: href computation (also used by the chooser) ---

  function computeHref(text) {
    if (/^https?:\/\//i.test(text)) return text;
    if (/^www\./i.test(text)) return 'https://' + text;
    if (/^(?:localhost|127\.0\.0\.1):/i.test(text)) return 'http://' + text;
    return 'https://' + text;                            // ambiguous domain
  }

  // --- Public: split a path token into { path, lineRef } (openFile fallback) ---

  function parseLineRef(p) {
    var m = /^(.+?):(\d{1,6})(?::\d+)?$/.exec(p);
    if (!m) return { path: p, lineRef: null };
    var hasExt = /\.[a-zA-Z][a-zA-Z0-9]{0,5}$/.test(m[1]);
    var yearLike = /^(?:19|20)\d{2}$/.test(m[2]);
    if (!hasExt && yearLike) return { path: p, lineRef: null };
    return { path: m[1], lineRef: Number(m[2]) };
  }

  // --- Public: hard-newline merge decision (Fix 10, guarded) ---

  function shouldJoinHardWrap(prevText, prevIsFull, nextText) {
    if (!prevIsFull || !prevText || !nextText) return false;
    var last = prevText.charAt(prevText.length - 1);
    // Classify the seam token so open-token set matches its alphabet (D33/D34).
    var lastTok = (prevText.match(/\S+$/) || [''])[0];
    var isUrl = /(?:https?:\/\/|www\.)/i.test(lastTok);
    var open = isUrl ? /[/_\-%=?&]/ : /[/_\-%]/;
    if (!open.test(last)) return false;
    if (/^\s/.test(nextText)) return false;              // indented continuation
    var first = nextText.charAt(0);
    // CJK ideographs / CJK punctuation lead prose, never a wrapped token (D31).
    if (new RegExp('[\\u4e00-\\u9fff' + CJK_PUNCT + ']').test(first)) return false;
    if (!/[A-Za-z0-9_./~\-%?=&#]/.test(first)) return false;
    return true;
  }

  // --- Public: find all links on one logical line ---

  // A merged logical line longer than this is almost certainly not a single
  // clickable token; skip detection to bound worst-case cost on pathological
  // input (very long wrapped runs).
  var MAX_LINE = 16384;

  function findLinks(line) {
    if (!line || line.length > MAX_LINE) return [];
    var out = [];
    // 1) Web (highest authority) and file:// first.
    _runWeb(line, HTTP_RE, out);
    _runWeb(line, WWW_RE, out);
    _runWeb(line, HOST_RE, out);
    FILE_URL_RE.lastIndex = 0;
    var fm;
    while ((fm = FILE_URL_RE.exec(line)) !== null) {
      var f = _processFileUrl(line, fm.index, fm[0]);
      if (f) out.push(f);
    }
    // 2) Paths (specific first; dedup keeps the widest).
    _runPath(line, TILDE_RE, false, out);
    _runPath(line, REL_RE, false, out);
    _runPath(line, ABS_RE, false, out);
    _runPath(line, LABEL_ABS_RE, false, out);
    _runPath(line, LABEL_REL_RE, false, out);
    _runPath(line, LABEL_BARE_RE, false, out);
    _runPath(line, BARE_RE, false, out);
    _runPath(line, LABEL_FILE_RE, true, out);
    _runPath(line, BARE_FILE_RE, true, out);
    // 3) Extensionless build files (Name:line) — promote then let dedup place it.
    BUILDFILE_RE.lastIndex = 0;
    var bm;
    while ((bm = BUILDFILE_RE.exec(line)) !== null) {
      out.push({ kind: 'file', text: bm[0], href: null, lineRef: null,
        start: bm.index, end: bm.index + bm[0].length });
    }
    // 4) Attach line refs to file matches (not web/ambiguous).
    for (var i = 0; i < out.length; i++) {
      if (out[i].kind === 'file' && out[i].lineRef == null) _attachLineRef(line, out[i]);
    }
    // 5) Resolve overlaps, return left-to-right.
    return _dedup(out);
  }

  return {
    findLinks: findLinks,
    computeHref: computeHref,
    parseLineRef: parseLineRef,
    shouldJoinHardWrap: shouldJoinHardWrap,
    _isAmbiguousDomain: _isAmbiguousDomain,   // exposed for tests
  };
})();

if (typeof window !== 'undefined') window.LinkDetect = LinkDetect;
if (typeof module !== 'undefined' && module.exports) module.exports = LinkDetect;
