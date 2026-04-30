/* global state */
var FilePreview = (function () {
  'use strict';

  var _overlay = null;
  var _maximized = false;
  var _currentFile = null;
  var _currentPaneId = null;
  var _dirContext = null; // parent dir abs path, set when a file is opened from the dir browser

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

    var btnBack = _btn('\u2190', 'Back to parent directory', function () {
      if (_dirContext) {
        var parent = _dirContext;
        _dirContext = null;
        openFile(parent, _currentPaneId);
      }
    });
    btnBack.className += ' fp-btn-back';

    var btnMaximize = _btn('\u2610', 'Maximize', function () {
      _maximized = !_maximized;
      modal.classList.toggle('fp-maximized', _maximized);
      btnMaximize.textContent = _maximized ? '\u2612' : '\u2610';
      btnMaximize.setAttribute('aria-label', _maximized ? 'Restore' : 'Maximize');
    });
    var btnNewTab = _btn('\u2197', 'Open in new tab', function () { _openNewTab(); });
    btnNewTab.className += ' fp-btn-file-only';
    var btnDownload = _btn('\u2B07', 'Download', function () { _download(); });
    btnDownload.className += ' fp-btn-file-only';
    var btnClose = _btn('\u2715', 'Close', close);

    actions.appendChild(btnMaximize);
    actions.appendChild(btnNewTab);
    actions.appendChild(btnDownload);
    actions.appendChild(btnClose);
    header.appendChild(btnBack);
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
    if (!_currentFile || _currentFile.isDirectory) return;
    if (_currentFile.isText || _currentFile.isMarkdown) {
      var blob = new Blob([_currentFile.rawContent || ''], { type: 'text/plain' });
      window.open(URL.createObjectURL(blob), '_blank');
    } else {
      window.open(_currentFile.rawUrl, '_blank');
    }
  }

  // Fetch authenticated bytes from the page's origin and trigger a local
  // Blob download. Avoids handing the URL to the system download manager
  // (which on Android/iOS doesn't share the browser's TLS-trust nor cookies,
  // and fails with "请检查互联网连接状况" on self-signed certs).
  function _blobDownload(url, filename) {
    var headers = typeof Auth !== 'undefined' ? Auth.headers() : {};
    return fetch(url, { headers: headers, credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.blob();
      })
      .then(function (blob) {
        var blobUrl = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename || 'download';
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 60000);
      });
  }

  function _download() {
    if (!_currentFile || _currentFile.isDirectory) return;
    _blobDownload(_currentFile.rawUrl, _currentFile.filename)
      .catch(function (err) {
        alert('下载失败: ' + (err && err.message ? err.message : err));
      });
  }

  function close() {
    if (_overlay) { _overlay.remove(); _overlay = null; }
    _maximized = false;
    _currentFile = null;
    _dirContext = null;
    _currentPaneId = null;
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
        var _tp = typeof Auth !== 'undefined' ? Auth.wsTokenParam() : '';
        var url = '/api/files/raw?path=' + encodeURIComponent(absPath)
          + (_tp ? '&' + _tp : '');
        var filename = absPath.split('/').pop();
        _blobDownload(url, filename).catch(function (err) {
          alert('下载失败: ' + (err && err.message ? err.message : err));
        });
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

  // Path body: exclude terminators and CJK punctuation/full-width chars.
  // CJK Unified Ideographs (\u4e00-\u9fff) are ALLOWED because paths on
  // CJK systems commonly contain Chinese characters (e.g. ~/文档/...).
  //   \u3000-\u303f  CJK symbols and punctuation (。、「」 etc.)
  //   \uff00-\uffef  Halfwidth/fullwidth forms (（）,，。)
  //   \u2000-\u206f  General punctuation
  // Also exclude =, ?, #, &, @ which commonly indicate URL query/params.
  var PATH_BODY = "[^\\s'\"()\\[\\]{}<>:;,?#&@=\\u3000-\\u303f\\uff00-\\uffef\\u2000-\\u206f]";

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
      // Strip trailing CJK chars that leak past a file extension
      // e.g. "file.txt然后继续" → "file.txt"
      trimmed = trimmed.replace(/(\.[a-zA-Z][a-zA-Z0-9]{0,5})[\u4e00-\u9fff]+$/, '$1');
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

  function openFile(filePath, paneId, _keepDirContext) {
    _currentPaneId = paneId || _currentPaneId;
    if (!_keepDirContext) _dirContext = null;
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
          if (res.error === 'File not found' || res.error === 'Path not found') { close(); return; }
          var errorAbsPath = (res.data && res.data.absPath) ? res.data.absPath : null;
          _showError(body, res.error, errorAbsPath);
          return;
        }
        var info = res.data;

        if (info.isDirectory) {
          _currentFile = { absPath: info.absPath, isDirectory: true };
          _applyMode('dir');
          _renderDirectory(body, info.absPath);
          return;
        }

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
        _applyMode('file');

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

  function _applyMode(mode) {
    if (!_overlay) return;
    _overlay.classList.toggle('fp-mode-dir', mode === 'dir');
    _overlay.classList.toggle('fp-has-back', !!_dirContext);
  }

  // --- Directory browser ---

  function _fmtSize(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function _fmtMtime(ms) {
    if (!ms) return '';
    var diff = Date.now() - ms;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' min ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' h ago';
    if (diff < 7 * 86400000) return Math.floor(diff / 86400000) + ' d ago';
    var d = new Date(ms);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function _iconFor(entry) {
    if (entry.type === 'dir' || entry.targetType === 'dir') return '📁'; // 📁
    if (entry.type === 'symlink' && entry.targetType === 'broken') return '⚠️'; // ⚠️
    return '📄'; // 📄
  }

  function _navDir(body, dirPath) {
    _renderDirectory(body, dirPath);
  }

  function _renderDirectory(body, dirPath) {
    body.innerHTML = '<div class="fp-loading">Loading directory…</div>';
    var _authHeaders = typeof Auth !== 'undefined' ? Auth.headers() : {};
    var qs = '?path=' + encodeURIComponent(dirPath);
    if (_currentPaneId) qs += '&paneId=' + encodeURIComponent(_currentPaneId);

    fetch('/api/files/list' + qs, { headers: _authHeaders })
      .then(function (r) {
        if (r.status === 401) { close(); return null; }
        return r.json();
      })
      .then(function (res) {
        if (!res) return;
        if (!res.success) {
          _showError(body, res.error, dirPath);
          return;
        }
        var data = res.data;
        if (_currentFile) _currentFile.absPath = data.absPath;
        // Back button in dir mode goes to the parent of the currently-shown dir.
        _dirContext = data.parent || null;
        _applyMode('dir');

        if (_overlay) {
          var titleEl = _overlay.querySelector('.fp-title');
          if (titleEl) {
            titleEl.textContent = data.absPath;
            titleEl.title = data.absPath;
          }
        }

        var wrap = document.createElement('div');
        wrap.className = 'fp-dir-wrap';

        // Breadcrumb
        var crumb = document.createElement('div');
        crumb.className = 'fp-dir-crumb';
        var segs = data.absPath.split('/').filter(Boolean);
        var rootLink = document.createElement('a');
        rootLink.className = 'fp-dir-crumb-seg';
        rootLink.textContent = '/';
        rootLink.href = '#';
        rootLink.addEventListener('click', function (e) {
          e.preventDefault();
          _navDir(body, '/');
        });
        crumb.appendChild(rootLink);
        var accum = '';
        segs.forEach(function (seg, i) {
          accum += '/' + seg;
          var sep = document.createElement('span');
          sep.className = 'fp-dir-crumb-sep';
          sep.textContent = '/';
          var el;
          if (i === segs.length - 1) {
            el = document.createElement('span');
            el.className = 'fp-dir-crumb-seg fp-dir-crumb-current';
            el.textContent = seg;
          } else {
            el = document.createElement('a');
            el.className = 'fp-dir-crumb-seg';
            el.textContent = seg;
            el.href = '#';
            var target = accum;
            el.addEventListener('click', function (e) {
              e.preventDefault();
              _navDir(body, target);
            });
          }
          crumb.appendChild(sep);
          crumb.appendChild(el);
        });
        wrap.appendChild(crumb);

        // List
        var list = document.createElement('div');
        list.className = 'fp-dir-list';

        if (data.parent) {
          var upRow = document.createElement('div');
          upRow.className = 'fp-dir-row fp-dir-parent';
          upRow.tabIndex = 0;
          upRow.innerHTML = '<span class="fp-dir-icon">↰</span>'
            + '<span class="fp-dir-name">..</span>'
            + '<span class="fp-dir-size"></span>'
            + '<span class="fp-dir-mtime"></span>';
          var parentPath = data.parent;
          upRow.addEventListener('click', function () { _navDir(body, parentPath); });
          upRow.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _navDir(body, parentPath); }
          });
          list.appendChild(upRow);
        }

        if (data.entries.length === 0) {
          var empty = document.createElement('div');
          empty.className = 'fp-dir-empty';
          empty.textContent = '(empty directory)';
          list.appendChild(empty);
        }

        data.entries.forEach(function (entry) {
          var row = document.createElement('div');
          row.className = 'fp-dir-row';
          if (entry.isHidden) row.className += ' fp-dir-hidden';
          if (entry.unreadable) row.className += ' fp-dir-unreadable';
          var isDir = entry.type === 'dir' || entry.targetType === 'dir';
          if (isDir) row.className += ' fp-dir-isdir';
          row.tabIndex = 0;

          var fullPath = (data.absPath === '/' ? '' : data.absPath) + '/' + entry.name;

          var icon = document.createElement('span');
          icon.className = 'fp-dir-icon';
          icon.textContent = _iconFor(entry);

          var name = document.createElement('span');
          name.className = 'fp-dir-name';
          var nameText = entry.name;
          if (entry.type === 'symlink') {
            var suffix = entry.targetType === 'broken'
              ? ' → (broken)'
              : ' → ' + (entry.targetType === 'dir' ? 'dir' : 'file');
            nameText += suffix;
          }
          name.textContent = nameText;
          name.title = fullPath;

          var size = document.createElement('span');
          size.className = 'fp-dir-size';
          size.textContent = isDir ? '' : _fmtSize(entry.size);

          var mtime = document.createElement('span');
          mtime.className = 'fp-dir-mtime';
          mtime.textContent = _fmtMtime(entry.mtime);

          row.appendChild(icon);
          row.appendChild(name);
          row.appendChild(size);
          row.appendChild(mtime);

          var activate = function () {
            if (entry.unreadable) return;
            if (isDir) {
              _navDir(body, fullPath);
            } else {
              // Remember the parent dir so the back button returns here
              _dirContext = data.absPath;
              openFile(fullPath, _currentPaneId, true);
            }
          };
          row.addEventListener('click', activate);
          row.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
          });

          list.appendChild(row);
        });

        wrap.appendChild(list);

        if (data.truncated) {
          var warn = document.createElement('div');
          warn.className = 'fp-dir-truncated';
          warn.textContent = 'Showing first ' + data.entries.length + ' of ' + data.totalCount + ' entries';
          wrap.appendChild(warn);
        }

        body.innerHTML = '';
        body.appendChild(wrap);
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
