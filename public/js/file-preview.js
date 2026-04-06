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
        a.href = '/api/files/raw?path=' + encodeURIComponent(absPath);
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

        html = html.replace(
          /(<img\s+[^>]*src=")(?!https?:\/\/|data:|\/)([^"]+)(")/g,
          function (_, pre, src, post) {
            var absImgPath = baseDir + '/' + src;
            return pre + '/api/files/raw?path=' + encodeURIComponent(absImgPath) + post;
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

  var ABS_RE = /(^|[\s])(\/[^\s'")\]:;,>]+)/g;
  var REL_RE = /(^|[\s])(\.\.?\/[^\s'")\]:;,>]+)/g;
  // Bare relative paths: word/word... containing at least one / (e.g. public/css/style.css)
  var BARE_RE = /(^|[\s])([a-zA-Z0-9_\-][^\s'")\]:;,>]*\/[^\s'")\]:;,>]+)/g;

  function _findLinks(line) {
    var matches = [];
    var seen = {}; // dedupe by startCol
    var m;
    ABS_RE.lastIndex = 0;
    while ((m = ABS_RE.exec(line)) !== null) {
      var path = m[2].replace(/[.,;:)>\]]+$/, '');
      var before = line.substring(0, m.index + m[1].length);
      if (/:\/{2}[^\s]*$/.test(before)) continue;
      if (path.length < 2 || path === '/') continue;
      var startCol = m.index + m[1].length;
      matches.push({ text: path, startCol: startCol, endCol: startCol + path.length });
      seen[startCol] = true;
    }
    REL_RE.lastIndex = 0;
    while ((m = REL_RE.exec(line)) !== null) {
      var path2 = m[2].replace(/[.,;:)>\]]+$/, '');
      var before2 = line.substring(0, m.index + m[1].length);
      if (/:\/{2}[^\s]*$/.test(before2)) continue;
      if (path2.length < 3) continue;
      var startCol2 = m.index + m[1].length;
      if (!seen[startCol2]) {
        matches.push({ text: path2, startCol: startCol2, endCol: startCol2 + path2.length });
        seen[startCol2] = true;
      }
    }
    BARE_RE.lastIndex = 0;
    while ((m = BARE_RE.exec(line)) !== null) {
      var path3 = m[2].replace(/[.,;:)>\]]+$/, '');
      var before3 = line.substring(0, m.index + m[1].length);
      if (/:\/{2}[^\s]*$/.test(before3)) continue;
      // Must contain at least one / after trimming
      if (path3.indexOf('/') === -1) continue;
      if (path3.length < 3) continue;
      var startCol3 = m.index + m[1].length;
      if (!seen[startCol3]) {
        matches.push({ text: path3, startCol: startCol3, endCol: startCol3 + path3.length });
        seen[startCol3] = true;
      }
    }
    return matches;
  }

  // --- Link Provider ---

  function registerLinkProvider(term, paneId) {
    term.registerLinkProvider({
      provideLinks: function (lineNumber, callback) {
        var line = term.buffer.active.getLine(lineNumber - 1);
        if (!line) return callback(undefined);
        var text = line.translateToString();
        var found = _findLinks(text);
        if (found.length === 0) return callback(undefined);

        var links = found.map(function (f) {
          return {
            range: {
              start: { x: f.startCol + 1, y: lineNumber },
              end: { x: f.endCol + 1, y: lineNumber },
            },
            text: f.text,
            activate: function () { openFile(f.text, paneId); },
          };
        });
        callback(links);
      },
    });
  }

  // --- Open File ---

  function openFile(filePath, paneId) {
    var body = _createModal(filePath);

    var qs = '?path=' + encodeURIComponent(filePath);
    if (paneId) qs += '&paneId=' + encodeURIComponent(paneId);

    fetch('/api/files/info' + qs)
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res.success) {
          if (res.error === 'File not found') { close(); return; }
          var errorAbsPath = (res.data && res.data.absPath) ? res.data.absPath : null;
          _showError(body, res.error, errorAbsPath);
          return;
        }
        var info = res.data;
        var rawUrl = '/api/files/raw?path=' + encodeURIComponent(info.absPath);
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
          fetch('/api/files/content?path=' + encodeURIComponent(info.absPath))
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

  // Check if a column position in a line of text falls on a file path.
  // Returns the path string if found, null otherwise.
  function hitTest(lineText, col) {
    var links = _findLinks(lineText);
    for (var i = 0; i < links.length; i++) {
      if (col >= links[i].startCol && col < links[i].endCol) {
        return links[i].text;
      }
    }
    return null;
  }

  return { registerLinkProvider: registerLinkProvider, openFile: openFile, close: close, hitTest: hitTest };
})();
