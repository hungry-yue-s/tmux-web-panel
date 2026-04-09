/* global state */
var FilePreview = (function () {
  'use strict';

  var _overlay = null;
  var _maximized = false;
  var _currentFile = null;

  // --- Lazy loading ---
  var _loaded = {};

  function _loadScript(url) {
    if (_loaded[url]) return _loaded[url];
    var p = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = url;
      var timer = setTimeout(function () { reject(new Error('Timeout loading: ' + url)); }, 10000);
      s.onload = function () { clearTimeout(timer); resolve(); };
      s.onerror = function () { clearTimeout(timer); reject(new Error('Failed to load: ' + url)); };
      document.head.appendChild(s);
    });
    _loaded[url] = p.catch(function (err) { delete _loaded[url]; throw err; });
    return _loaded[url];
  }

  function _loadCSS(url) {
    if (_loaded[url]) return _loaded[url];
    _loaded[url] = new Promise(function (resolve) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = url;
      link.onload = resolve;
      link.onerror = resolve;
      document.head.appendChild(link);
    });
    return _loaded[url];
  }

  var CDN = {
    hljs: 'https://unpkg.com/@highlightjs/cdn-assets@11.11.1/highlight.min.js',
    hljsCss: 'https://unpkg.com/@highlightjs/cdn-assets@11.11.1/styles/github-dark.min.css',
    markdownIt: 'https://unpkg.com/markdown-it@14.1.0/dist/markdown-it.min.js',
    katexCss: 'https://unpkg.com/katex@0.16.21/dist/katex.min.css',
    katexJs: 'https://unpkg.com/katex@0.16.21/dist/katex.min.js',
    markdownItKatex: 'https://unpkg.com/@iktakahiro/markdown-it-katex@4.0.1/dist/markdown-it-katex.min.js',
    mermaid: 'https://unpkg.com/mermaid@11.6.0/dist/mermaid.min.js',
  };

  // --- Modal ---

  function _createModal(title) {
    if (_overlay) _overlay.remove();
    _maximized = false;

    _overlay = document.createElement('div');
    _overlay.className = 'fp-overlay';
    _overlay.addEventListener('click', function (e) {
      if (e.target === _overlay) close();
    });

    var modal = document.createElement('div');
    modal.className = 'fp-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-label', 'File Preview');

    var header = document.createElement('div');
    header.className = 'fp-header';

    var titleEl = document.createElement('span');
    titleEl.className = 'fp-title';
    titleEl.textContent = title;
    titleEl.title = title;

    var actions = document.createElement('div');
    actions.className = 'fp-actions';

    var btnMaximize = _btn('\u2610', 'Maximize', function () {
      _maximized = !_maximized;
      modal.classList.toggle('fp-maximized', _maximized);
      btnMaximize.textContent = _maximized ? '\u2612' : '\u2610';
      btnMaximize.setAttribute('aria-label', _maximized ? 'Restore' : 'Maximize');
    });
    var btnNewTab = _btn('\u2197', 'Open in new tab', function () { _openNewTab(); });
    var btnDownload = _btn('\u2B07', 'Download', function () { _download(); });
    var btnClose = _btn('\u2715', 'Close', close);

    actions.appendChild(btnMaximize);
    actions.appendChild(btnNewTab);
    actions.appendChild(btnDownload);
    actions.appendChild(btnClose);
    header.appendChild(titleEl);
    header.appendChild(actions);

    var body = document.createElement('div');
    body.className = 'fp-body';
    body.innerHTML = '<div class="fp-loading">Loading\u2026</div>';

    modal.appendChild(header);
    modal.appendChild(body);
    _overlay.appendChild(modal);
    document.body.appendChild(_overlay);

    btnClose.focus();
    _overlay.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { close(); e.stopPropagation(); }
      if (e.key === 'Tab') {
        var focusable = modal.querySelectorAll('button, [tabindex]');
        if (focusable.length === 0) return;
        var first = focusable[0], last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });

    return body;
  }

  function _btn(text, label, onclick) {
    var b = document.createElement('button');
    b.className = 'fp-btn';
    b.textContent = text;
    b.setAttribute('aria-label', label);
    b.addEventListener('click', onclick);
    return b;
  }

  function _openNewTab() {
    if (!_currentFile) return;
    if (_currentFile.isText || _currentFile.isMarkdown) {
      var blob = new Blob([_currentFile.rawContent || ''], { type: 'text/plain' });
      window.open(URL.createObjectURL(blob), '_blank');
    } else {
      window.open(_currentFile.rawUrl, '_blank');
    }
  }

  function _download() {
    if (!_currentFile) return;
    var a = document.createElement('a');
    a.href = _currentFile.rawUrl;
    a.download = _currentFile.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function close() {
    if (_overlay) { _overlay.remove(); _overlay = null; }
    _maximized = false;
    _currentFile = null;
  }

  function _showError(body, message, absPath) {
    body.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.className = 'fp-error';
    var msg = document.createElement('div');
    msg.textContent = message;
    wrap.appendChild(msg);
    if (absPath) {
      var btn = document.createElement('button');
      btn.className = 'fp-error-download';
      btn.textContent = 'Download';
      btn.addEventListener('click', function () {
        var a = document.createElement('a');
        var _tp = typeof Auth !== 'undefined' ? Auth.wsTokenParam() : '';
        a.href = '/api/files/raw?path=' + encodeURIComponent(absPath) + (_tp ? '&' + _tp : '');
        a.download = '';
        document.body.appendChild(a);
        a.click();
        a.remove();
      });
      wrap.appendChild(btn);
    }
    body.appendChild(wrap);
  }

  // --- Renderers ---

  function _renderImage(body, url) {
    body.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.className = 'fp-image-wrap';
    var img = document.createElement('img');
    img.src = url;
    img.alt = 'Preview';
    var scale = 1;
    img.addEventListener('wheel', function (e) {
      e.preventDefault();
      scale = Math.max(0.1, Math.min(10, scale + (e.deltaY > 0 ? -0.1 : 0.1)));
      img.style.transform = 'scale(' + scale + ')';
    });
    wrap.appendChild(img);
    body.appendChild(wrap);
  }

  function _renderPdf(body, url) {
    body.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.className = 'fp-pdf-wrap';
    var iframe = document.createElement('iframe');
    iframe.src = url;
    iframe.title = 'PDF Preview';
    wrap.appendChild(iframe);
    body.appendChild(wrap);
  }

  function _renderCode(body, content, language) {
    body.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.className = 'fp-code-wrap';

    var lines = content.split('\n');
    var lineNums = document.createElement('div');
    lineNums.className = 'fp-line-numbers';
    lineNums.textContent = lines.map(function (_, i) { return i + 1; }).join('\n');

    var pre = document.createElement('pre');
    var code = document.createElement('code');
    code.textContent = content;

    Promise.all([_loadScript(CDN.hljs), _loadCSS(CDN.hljsCss)])
      .then(function () {
        if (window.hljs && language) {
          try {
            var result = window.hljs.highlight(content, { language: language, ignoreIllegals: true });
            code.innerHTML = result.value;
          } catch (_) {
            window.hljs.highlightElement(code);
          }
        } else if (window.hljs) {
          window.hljs.highlightElement(code);
        }
      })
      .catch(function () { /* highlight failed — show plain text */ });

    pre.appendChild(lineNums);
    pre.appendChild(code);
    wrap.appendChild(pre);
    body.appendChild(wrap);
  }

  function _renderMarkdown(body, content, filePath) {
    body.innerHTML = '<div class="fp-loading">Rendering Markdown\u2026</div>';
    var baseDir = filePath.substring(0, filePath.lastIndexOf('/'));

    Promise.all([
      _loadScript(CDN.markdownIt),
      _loadScript(CDN.hljs),
      _loadCSS(CDN.hljsCss),
    ])
      .then(function () {
        var md = window.markdownit({
          html: false,
          linkify: true,
          highlight: function (str, lang) {
            if (window.hljs && lang) {
              try {
                return window.hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
              } catch (_) { /* fallback */ }
            }
            return '';
          },
        });

        var katexLoaded = Promise.all([
          _loadCSS(CDN.katexCss),
          _loadScript(CDN.katexJs),
        ])
          .then(function () { return _loadScript(CDN.markdownItKatex); })
          .then(function () {
            if (window.markdownitKatex) md.use(window.markdownitKatex);
          })
          .catch(function () { /* KaTeX optional */ });

        return katexLoaded.then(function () { return md; });
      })
      .then(function (md) {
        var html = md.render(content);

        var _mdTp = typeof Auth !== 'undefined' ? Auth.wsTokenParam() : '';
        html = html.replace(
          /(<img\s+[^>]*src=")(?!https?:\/\/|data:|\/)([^"]+)(")/g,
          function (_, pre, src, post) {
            var absImgPath = baseDir + '/' + src;
            return pre + '/api/files/raw?path=' + encodeURIComponent(absImgPath) + (_mdTp ? '&' + _mdTp : '') + post;
          }
        );

        body.innerHTML = '';
        var wrap = document.createElement('div');
        wrap.className = 'fp-md-wrap';
        wrap.innerHTML = html;
        body.appendChild(wrap);

        var mermaidBlocks = wrap.querySelectorAll('code.language-mermaid');
        if (mermaidBlocks.length > 0) {
          _loadScript(CDN.mermaid)
            .then(function () {
              window.mermaid.initialize({ startOnLoad: false, theme: 'dark' });
              mermaidBlocks.forEach(function (block) {
                var pre = block.parentElement;
                var container = document.createElement('div');
                container.className = 'mermaid';
                container.textContent = block.textContent;
                pre.replaceWith(container);
                window.mermaid.run({ nodes: [container] });
              });
            })
            .catch(function () { /* mermaid optional */ });
        }
      })
      .catch(function () {
        _renderCode(body, content, 'markdown');
      });
  }

  // --- Path detection ---

  // A path must not be preceded by a "path-continuation" character that
  // would indicate it's part of a larger token (like a URL or word).
  // Allowed preceding chars: whitespace, =, (, [, {, etc.
  // Disallowed: word chars (\w), -, :, /, . (which would mean we're in the
  // middle of something).
  var NOT_PREFIX = "(?<![\\w\\-:\\/\\.~])";

  // Path body: exclude terminators and all CJK/full-width chars to prevent
  // paths from extending into Chinese text.
  //   \u3000-\u303f  CJK symbols and punctuation (。、「」 etc.)
  //   \u4e00-\u9fff  CJK Unified Ideographs
  //   \uff00-\uffef  Halfwidth/fullwidth forms (（）)
  //   \u2000-\u206f  General punctuation
  // Also exclude =, ?, #, &, @ which commonly indicate URL query/params.
  var PATH_BODY = "[^\\s'\"()\\[\\]{}<>:;,?#&@=\\u3000-\\u303f\\u4e00-\\u9fff\\uff00-\\uffef\\u2000-\\u206f]";

  // Absolute: /path (preceded by non-path-char; handles "file=/path", "(/path" etc.)
  var ABS_RE = new RegExp(NOT_PREFIX + "\\/" + PATH_BODY + "+(?:\\/" + PATH_BODY + "+)*", "g");
  // Home: ~/path or ~user/path
  var TILDE_RE = new RegExp(NOT_PREFIX + "~[a-zA-Z0-9_\\-]*\\/" + PATH_BODY + "+(?:\\/" + PATH_BODY + "+)*", "g");
  // Dot relative: ./path or ../path
  var REL_RE = new RegExp(NOT_PREFIX + "\\.\\.?\\/" + PATH_BODY + "+(?:\\/" + PATH_BODY + "+)*", "g");
  // Bare relative: word/word/... (at least one slash segment)
  var BARE_RE = new RegExp(NOT_PREFIX + "[a-zA-Z0-9_\\-]+(?:\\/" + PATH_BODY + "+)+", "g");
  // Bare filename: name.ext where ext is 1-6 lowercase letters/digits
  // (e.g. README.md, index.js, package.json). Starts with letter to avoid
  // matching IPs (192.168...) and version numbers (1.0.0).
  var BARE_FILE_RE = new RegExp(NOT_PREFIX + "[a-zA-Z][\\w\\-]*(?:\\.[\\w\\-]+)*\\.[a-z][a-z0-9]{0,5}(?![\\w\\-\\/.])", "g");

  function _runRegex(line, re, minLen, matches, seen, allowNoSlash) {
    re.lastIndex = 0;
    var m;
    while ((m = re.exec(line)) !== null) {
      var raw = m[0];
      // For bare-file matches, don't strip trailing dots (they may be part
      // of an extension); for path-style matches, strip common trailing
      // punctuation that's likely sentence punctuation, not path content.
      var trimmed = allowNoSlash
        ? raw.replace(/[,;:!?)>\]}]+$/, '')
        : raw.replace(/[.,;:!?)>\]}]+$/, '');
      if (trimmed.length < minLen) continue;
      if (!allowNoSlash && trimmed.indexOf('/') === -1) continue;
      var startCol = m.index;
      var endCol = startCol + trimmed.length;
      if (seen[startCol]) continue;
      // Check overlap with existing matches: skip if contained in one
      var overlap = false;
      for (var i = 0; i < matches.length; i++) {
        var ex = matches[i];
        if (startCol >= ex.startCol && endCol <= ex.endCol) { overlap = true; break; }
      }
      if (overlap) continue;
      matches.push({ text: trimmed, startCol: startCol, endCol: endCol });
      seen[startCol] = true;
    }
  }

  function _findLinks(line) {
    var matches = [];
    var seen = {};
    // Order matters: more specific patterns first
    _runRegex(line, ABS_RE, 2, matches, seen);
    _runRegex(line, TILDE_RE, 3, matches, seen);
    _runRegex(line, REL_RE, 3, matches, seen);
    _runRegex(line, BARE_RE, 3, matches, seen);
    _runRegex(line, BARE_FILE_RE, 3, matches, seen, true);
    return matches;
  }

  // --- Wrapped line helpers ---

  // Collect a logical line by merging wrapped buffer lines.
  // Returns { text, startRow, rows } where rows is an array of
  // { line, row, strStart, strLen } for each physical row.
  function _getLogicalLine(buffer, bufRow) {
    var startRow = bufRow;
    while (startRow > 0) {
      var prev = buffer.getLine(startRow);
      if (!prev || !prev.isWrapped) break;
      startRow--;
    }
    var text = '';
    var rows = [];
    var row = startRow;
    while (row < buffer.length) {
      var ln = buffer.getLine(row);
      if (!ln) break;
      if (row > startRow && !ln.isWrapped) break;
      var rowText = ln.translateToString(false);
      rows.push({ line: ln, row: row, strStart: text.length, strLen: rowText.length });
      text += rowText;
      row++;
    }
    return { text: text, startRow: startRow, rows: rows };
  }

  // Convert a string offset in the merged logical line to { y (1-based
  // lineNumber), x (1-based terminal column) }, correctly handling wide
  // (CJK) characters by walking cells.
  function _logicalStrOffsetToTermPos(rows, strOffset) {
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (strOffset < r.strStart + r.strLen || i === rows.length - 1) {
        var strInRow = Math.max(0, Math.min(strOffset - r.strStart, r.strLen));
        // Walk cells to find terminal column for strInRow-th character
        var col = 0;
        var chars = 0;
        var lineLen = r.line.length;
        while (chars < strInRow && col < lineLen) {
          var cell = r.line.getCell(col);
          var w = cell ? (cell.getWidth() || 1) : 1;
          col += w;
          chars++;
        }
        return { y: r.row + 1, x: col + 1 };
      }
    }
    var last = rows[rows.length - 1];
    return { y: last.row + 1, x: last.line.length + 1 };
  }

  // --- Open from tmux paste buffer ---

  function _cleanBufferText(text) {
    // Join wrapped/indented lines, strip :line:col suffix
    var cleaned = text.split('\n').map(function (l) { return l.trim(); }).filter(Boolean).join('');
    cleaned = cleaned.replace(/:\d+(?::\d+)?$/, '');
    cleaned = cleaned.replace(/\(\d+(?:,\d+)?\)$/, '');
    return cleaned;
  }

  function openFromBuffer(paneId) {
    var _authHeaders = typeof Auth !== 'undefined' ? Auth.headers() : {};
    fetch('/api/files/tmux-buffer', { headers: _authHeaders })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res.success || !res.data.path) return;
        openFile(res.data.path, paneId);
      })
      .catch(function () { /* ignore */ });
  }

  // --- Link Provider ---

  function registerLinkProvider(term, paneId) {
    term.registerLinkProvider({
      provideLinks: function (lineNumber, callback) {
        var bufRow = lineNumber - 1;
        var buf = term.buffer.active;
        var logical = _getLogicalLine(buf, bufRow);
        var found = _findLinks(logical.text);
        if (found.length === 0) return callback(undefined);

        if (window._FP_DEBUG) {
          console.log('[FP] line', lineNumber, 'text=', JSON.stringify(logical.text), 'matches=', found);
        }

        var links = found.map(function (f) {
          var start = _logicalStrOffsetToTermPos(logical.rows, f.startCol);
          var end = _logicalStrOffsetToTermPos(logical.rows, f.endCol);
          return {
            range: { start: start, end: { y: end.y, x: Math.max(end.x - 1, start.x) } },
            text: f.text,
            activate: function () { openFile(f.text, paneId); },
          };
        }).filter(function (link) {
          return link.range.start.y <= lineNumber && link.range.end.y >= lineNumber;
        });

        if (window._FP_DEBUG && links.length > 0) {
          console.log('[FP] returning links for line', lineNumber, links.map(function(l) {
            return { text: l.text, range: l.range };
          }));
        }

        callback(links.length > 0 ? links : undefined);
      },
    });
  }

  // --- Open File ---

  function openFile(filePath, paneId) {
    var body = _createModal(filePath);

    var qs = '?path=' + encodeURIComponent(filePath);
    if (paneId) qs += '&paneId=' + encodeURIComponent(paneId);

    var _authHeaders = typeof Auth !== 'undefined' ? Auth.headers() : {};
    var _tokenQs = typeof Auth !== 'undefined' ? Auth.wsTokenParam() : '';

    fetch('/api/files/info' + qs, { headers: _authHeaders })
      .then(function (r) {
        if (r.status === 401) { close(); return null; }
        return r.json();
      })
      .then(function (res) {
        if (!res) return;
        if (!res.success) {
          if (res.error === 'File not found') { close(); return; }
          var errorAbsPath = (res.data && res.data.absPath) ? res.data.absPath : null;
          _showError(body, res.error, errorAbsPath);
          return;
        }
        var info = res.data;
        var rawUrl = '/api/files/raw?path=' + encodeURIComponent(info.absPath)
          + (_tokenQs ? '&' + _tokenQs : '');
        var filename = info.absPath.split('/').pop();

        _currentFile = {
          absPath: info.absPath,
          rawUrl: rawUrl,
          filename: filename,
          isText: info.isText,
          isImage: info.isImage,
          isPdf: info.isPdf,
          isMarkdown: info.isMarkdown,
          rawContent: null,
        };

        if (info.isImage) {
          _renderImage(body, rawUrl);
        } else if (info.isPdf) {
          _renderPdf(body, rawUrl);
        } else {
          fetch('/api/files/content?path=' + encodeURIComponent(info.absPath), { headers: _authHeaders })
            .then(function (r) { return r.json(); })
            .then(function (cr) {
              if (!cr.success) { _showError(body, cr.error, info.absPath); return; }
              _currentFile.rawContent = cr.data.content;
              if (info.isMarkdown) {
                _renderMarkdown(body, cr.data.content, info.absPath);
              } else {
                _renderCode(body, cr.data.content, cr.data.language);
              }
            })
            .catch(function (err) { _showError(body, err.message); });
        }
      })
      .catch(function (err) { _showError(body, err.message); });
  }

  // Convert a terminal (bufRow, termCol) position to a string offset in
  // the merged logical line. Walks cells to skip wide-char placeholders.
  function _termPosToLogicalStrOffset(logical, bufRow, termCol) {
    for (var i = 0; i < logical.rows.length; i++) {
      var r = logical.rows[i];
      if (r.row !== bufRow) continue;
      // Walk cells on this row up to termCol, counting characters
      var col = 0;
      var chars = 0;
      var lineLen = r.line.length;
      while (col < termCol && col < lineLen) {
        var cell = r.line.getCell(col);
        var w = cell ? (cell.getWidth() || 1) : 1;
        col += w;
        chars++;
      }
      return r.strStart + chars;
    }
    return -1;
  }

  // Check if a position falls on a file path.
  // For mobile: pass term + viewportRow to enable wrapped line detection.
  function hitTest(lineText, col, term, viewportRow) {
    if (term && viewportRow !== undefined) {
      var bufRow = term.buffer.active.viewportY + viewportRow;
      var logical = _getLogicalLine(term.buffer.active, bufRow);
      var strOffset = _termPosToLogicalStrOffset(logical, bufRow, col);
      if (strOffset < 0) return null;
      var links = _findLinks(logical.text);
      for (var i = 0; i < links.length; i++) {
        if (strOffset >= links[i].startCol && strOffset < links[i].endCol) {
          return links[i].text;
        }
      }
      return null;
    }
    // Fallback: single-line hit test
    var simpleLinks = _findLinks(lineText);
    for (var j = 0; j < simpleLinks.length; j++) {
      if (col >= simpleLinks[j].startCol && col < simpleLinks[j].endCol) {
        return simpleLinks[j].text;
      }
    }
    return null;
  }

  return { registerLinkProvider: registerLinkProvider, openFile: openFile, openFromBuffer: openFromBuffer, close: close, hitTest: hitTest };
})();
