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
    exceljs: 'https://unpkg.com/exceljs@4.4.0/dist/exceljs.min.js',
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

  // Snapshot the theme vars the main window currently has applied (Theme.apply
  // writes these onto documentElement), so the standalone tab follows whatever
  // theme — including light themes — the user has switched to.
  function _rootVars() {
    var keys = ['--bg-primary', '--bg-card', '--border-subtle',
      '--text-primary', '--text-muted', '--accent-blue', '--accent-red'];
    var cs = getComputedStyle(document.documentElement);
    var out = ':root{';
    keys.forEach(function (k) {
      var v = (cs.getPropertyValue(k) || '').trim();
      if (v) out += k + ':' + v + ';';
    });
    return out + '}';
  }

  // Inline theme so the standalone tab matches the in-modal preview (the new
  // document has none of the page's stylesheets). Mirrors the .fp-* rules in
  // public/css/style.css; keep them in sync.
  function _standaloneCss() {
    return [
      _rootVars(),
      'html,body{margin:0;background:var(--bg-card);color:var(--text-primary);',
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;}",
      '.fp-code-wrap,.fp-md-wrap{height:auto;min-height:100vh;box-sizing:border-box;}',
      ".fp-code-wrap pre{margin:0;padding:14px;font-size:0.82rem;line-height:1.5;font-family:'JetBrains Mono',monospace;tab-size:4;display:flex;align-items:flex-start;}",
      '.fp-code-wrap .fp-line-numbers{flex:0 0 auto;padding-right:14px;border-right:1px solid var(--border-subtle);margin-right:14px;text-align:right;color:var(--text-muted);user-select:none;white-space:pre;}',
      '.fp-code-wrap pre > code{flex:1 1 auto;min-width:0;white-space:pre;overflow-x:auto;}',
      '.fp-code-wrap pre > code.hljs{padding:0;}',
      '.fp-md-wrap{padding:20px 28px;font-size:0.9rem;line-height:1.7;color:var(--text-primary);}',
      '.fp-md-wrap h1,.fp-md-wrap h2,.fp-md-wrap h3{margin:1em 0 0.5em;}',
      '.fp-md-wrap h1{font-size:1.5rem;border-bottom:1px solid var(--border-subtle);padding-bottom:6px;}',
      '.fp-md-wrap h2{font-size:1.25rem;}.fp-md-wrap h3{font-size:1.1rem;}',
      '.fp-md-wrap pre{background:var(--bg-primary);border-radius:6px;padding:12px;overflow-x:auto;}',
      ".fp-md-wrap code{font-family:'JetBrains Mono',monospace;font-size:0.82rem;}",
      '.fp-md-wrap :not(pre) > code{background:var(--bg-primary);padding:2px 5px;border-radius:3px;}',
      '.fp-md-wrap img{max-width:100%;border-radius:6px;}',
      '.fp-md-wrap table{border-collapse:collapse;width:100%;margin:1em 0;}',
      '.fp-md-wrap th,.fp-md-wrap td{border:1px solid var(--border-subtle);padding:6px 10px;text-align:left;}',
      '.fp-md-wrap th{background:var(--bg-primary);}',
      '.fp-md-wrap blockquote{border-left:3px solid var(--accent-blue);margin:1em 0;padding:4px 16px;color:var(--text-muted);}',
      '.fp-md-wrap a{color:var(--accent-blue);}',
      '.fp-md-wrap .katex-display{overflow-x:auto;padding:4px 0;}',
      '.fp-xlsx-wrap{min-height:100vh;}',
      '.fp-xlsx-tabs{display:flex;gap:2px;padding:6px 8px 0;overflow-x:auto;border-bottom:1px solid var(--border-subtle);background:var(--bg-primary);position:sticky;top:0;}',
      '.fp-xlsx-tab{flex:0 0 auto;padding:5px 12px;border:1px solid var(--border-subtle);border-bottom:none;border-radius:6px 6px 0 0;cursor:pointer;background:transparent;color:var(--text-muted);font-size:0.82rem;white-space:nowrap;}',
      '.fp-xlsx-tab.active{color:var(--text-primary);background:var(--bg-card);}',
      '.fp-xlsx-pane{display:none;}.fp-xlsx-pane.active{display:block;}',
      '.fp-xlsx-table{border-collapse:collapse;font-size:0.82rem;background:var(--bg-card);color:var(--text-primary);}',
      '.fp-xlsx-table td{border:1px solid var(--border-subtle);padding:3px 8px;white-space:nowrap;max-width:480px;overflow:hidden;text-overflow:ellipsis;vertical-align:top;}',
      '.fp-fs-btn{position:fixed;top:12px;right:12px;z-index:9999;width:34px;height:34px;',
      'display:flex;align-items:center;justify-content:center;font-size:16px;line-height:1;',
      'background:var(--bg-card);color:var(--text-primary);border:1px solid var(--border-subtle);',
      'border-radius:6px;cursor:pointer;opacity:0.5;transition:opacity 0.15s;}',
      '.fp-fs-btn:hover{opacity:1;}',
      ':fullscreen .fp-md-wrap,:fullscreen .fp-code-wrap{min-height:100vh;}',
    ].join('');
  }

  // Floating fullscreen toggle injected into the standalone tab. The inline
  // script runs because blob: text/html documents execute their own scripts.
  function _fullscreenWidget() {
    return '<button class="fp-fs-btn" id="fpFs" title="全屏 / Fullscreen" aria-label="Toggle fullscreen">⛶</button>'
      + '<script>(function(){var b=document.getElementById("fpFs");if(!b)return;'
      + 'function sync(){b.textContent=document.fullscreenElement?"\\u00d7":"\\u26f6";}'
      + 'b.addEventListener("click",function(){'
      + 'if(document.fullscreenElement){document.exitFullscreen();}'
      + 'else{var el=document.documentElement;if(el.requestFullscreen)el.requestFullscreen();}});'
      + 'document.addEventListener("fullscreenchange",sync);})();<\/script>';
  }

  // Re-wire xlsx sheet tabs in the standalone tab — the modal's addEventListener
  // handlers don't survive outerHTML serialization, so delegate by index.
  function _xlsxTabScript() {
    return '<script>document.addEventListener("click",function(e){'
      + 'var t=e.target.closest&&e.target.closest(".fp-xlsx-tab");if(!t)return;'
      + 'var w=t.closest(".fp-xlsx-wrap");if(!w)return;'
      + 'var tabs=w.querySelectorAll(".fp-xlsx-tab"),panes=w.querySelectorAll(".fp-xlsx-pane");'
      + 'var i=Array.prototype.indexOf.call(tabs,t);'
      + 'for(var k=0;k<tabs.length;k++){tabs[k].classList.remove("active");}'
      + 'for(var j=0;j<panes.length;j++){panes[j].classList.remove("active");}'
      + 't.classList.add("active");if(panes[i])panes[i].classList.add("active");'
      + '});<\/script>';
  }

  function _escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function _openNewTab() {
    if (!_currentFile || _currentFile.isDirectory) return;
    if (_currentFile.isText || _currentFile.isMarkdown || _currentFile.isXlsx) {
      // Reuse the already-rendered preview (markdown HTML / highlighted code /
      // xlsx tables) so the standalone tab carries the same theme as the modal.
      var rendered = _overlay && _overlay.querySelector('.fp-md-wrap, .fp-code-wrap, .fp-xlsx-wrap');
      if (rendered) {
        // Strip interactive filter buttons (their handlers don't serialize);
        // keep the current row visibility so the tab matches what's on screen.
        var capture = rendered;
        if (rendered.querySelector && rendered.querySelector('.fp-colfilter-btn')) {
          capture = rendered.cloneNode(true);
          capture.querySelectorAll('.fp-colfilter-btn').forEach(function (b) { b.remove(); });
        }
        var title = _escapeHtml(_currentFile.filename || 'preview');
        var doc = '<!DOCTYPE html><html><head><meta charset="utf-8">'
          + '<meta name="viewport" content="width=device-width, initial-scale=1">'
          + '<title>' + title + '</title>'
          + '<link rel="stylesheet" href="' + CDN.hljsCss + '">'
          + '<link rel="stylesheet" href="' + CDN.katexCss + '">'
          + '<style>' + _standaloneCss() + '</style></head><body>'
          + _fullscreenWidget()
          + capture.outerHTML
          + _xlsxTabScript() + '</body></html>';
        var htmlBlob = new Blob([doc], { type: 'text/html;charset=utf-8' });
        window.open(URL.createObjectURL(htmlBlob), '_blank');
        return;
      }
      // Not rendered yet — xlsx has no text content, hand off the raw file.
      if (_currentFile.isXlsx) { window.open(_currentFile.rawUrl, '_blank'); return; }
      // Otherwise fall back to raw text (still UTF-8 to avoid 乱码).
      var blob = new Blob([_currentFile.rawContent || ''], { type: 'text/plain;charset=utf-8' });
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

  // --- xlsx (ExcelJS → styled HTML tables) ---

  function _argbToCss(argb) {
    // ExcelJS colors are 'AARRGGBB'. Theme/indexed colors lack argb → skip.
    if (!argb || typeof argb !== 'string' || argb.length < 6) return null;
    var hex = argb.length === 8 ? argb.slice(2) : argb;
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
    return '#' + hex;
  }

  function _xlsxColStyle(width) {
    // ExcelJS width ≈ character units; ~7px per char is a decent approximation.
    if (!width || !isFinite(width)) return '';
    return ' style="width:' + Math.round(width * 7) + 'px"';
  }

  // Pick black/white text for a given background so a fill never hides its text.
  function _contrastText(hex) {
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);
    var lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.55 ? '#1f2328' : '#f5f5f5';
  }

  function _xlsxCellStyle(cell) {
    var s = [];
    var f = cell.font || {};
    if (f.bold) s.push('font-weight:600');
    if (f.italic) s.push('font-style:italic');
    if (f.underline) s.push('text-decoration:underline');
    if (f.size) s.push('font-size:' + f.size + 'px');
    var fill = cell.fill;
    var bg = (fill && fill.type === 'pattern' && fill.fgColor)
      ? _argbToCss(fill.fgColor.argb) : null;
    if (bg) s.push('background:' + bg);
    var fc = f.color && _argbToCss(f.color.argb);
    if (fc) {
      s.push('color:' + fc);
    } else if (bg) {
      // Cell has a fill but no explicit font color (Excel "auto" = black on a
      // white sheet). On our table the fill could be light or dark, so derive a
      // contrasting color from its luminance instead of inheriting the default.
      s.push('color:' + _contrastText(bg));
    }
    var a = cell.alignment || {};
    if (a.horizontal) s.push('text-align:' + a.horizontal);
    if (a.vertical) s.push('vertical-align:' + (a.vertical === 'middle' ? 'middle' : a.vertical));
    if (a.wrapText) s.push('white-space:normal');
    return s.length ? ' style="' + s.join(';') + '"' : '';
  }

  // Build a lookup of merged ranges so we emit rowspan/colspan on the
  // top-left cell and skip the cells it covers.
  function _xlsxMerges(ws) {
    var masters = {}; // "r,c" -> {rowspan, colspan}
    var covered = {}; // "r,c" -> true (non-master cells inside a merge)
    var ranges = (ws.model && ws.model.merges) || [];
    ranges.forEach(function (range) {
      var m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);
      if (!m) return;
      var c1 = _colToNum(m[1]), r1 = +m[2], c2 = _colToNum(m[3]), r2 = +m[4];
      masters[r1 + ',' + c1] = { rowspan: r2 - r1 + 1, colspan: c2 - c1 + 1 };
      for (var r = r1; r <= r2; r++) {
        for (var c = c1; c <= c2; c++) {
          if (r === r1 && c === c1) continue;
          covered[r + ',' + c] = true;
        }
      }
    });
    return { masters: masters, covered: covered };
  }

  function _colToNum(letters) {
    var n = 0;
    for (var i = 0; i < letters.length; i++) {
      n = n * 26 + (letters.charCodeAt(i) - 64);
    }
    return n;
  }

  function _xlsxSheetTable(ws) {
    var merges = _xlsxMerges(ws);
    var colCount = ws.actualColumnCount || ws.columnCount || 0;
    var html = '<table class="fp-xlsx-table"><colgroup>';
    for (var c = 1; c <= colCount; c++) {
      var col = ws.getColumn(c);
      html += '<col' + _xlsxColStyle(col && col.width) + '>';
    }
    html += '</colgroup><tbody>';
    var rowCount = ws.actualRowCount || ws.rowCount || 0;
    for (var r = 1; r <= rowCount; r++) {
      var row = ws.getRow(r);
      html += '<tr>';
      for (var cc = 1; cc <= colCount; cc++) {
        var key = r + ',' + cc;
        if (merges.covered[key]) continue;
        var cell = row.getCell(cc);
        var span = merges.masters[key];
        var attrs = _xlsxCellStyle(cell);
        if (span) {
          if (span.rowspan > 1) attrs += ' rowspan="' + span.rowspan + '"';
          if (span.colspan > 1) attrs += ' colspan="' + span.colspan + '"';
        }
        var text = cell.text != null ? String(cell.text) : '';
        html += '<td' + attrs + '>' + _escapeHtml(text) + '</td>';
      }
      html += '</tr>';
    }
    return html + '</tbody></table>';
  }

  function _renderXlsx(body, rawUrl) {
    body.innerHTML = '<div class="fp-loading">Loading spreadsheet…</div>';
    var headers = typeof Auth !== 'undefined' ? Auth.headers() : {};
    Promise.all([
      _loadScript(CDN.exceljs),
      fetch(rawUrl, { headers: headers }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      }),
    ])
      .then(function (results) {
        var buf = results[1];
        var wb = new window.ExcelJS.Workbook();
        return wb.xlsx.load(buf);
      })
      .then(function (wb) {
        var sheets = [];
        wb.eachSheet(function (ws) { sheets.push(ws); });
        if (!sheets.length) { _showError(body, '空工作簿'); return; }

        body.innerHTML = '';
        var wrap = document.createElement('div');
        wrap.className = 'fp-xlsx-wrap';

        var tabs = document.createElement('div');
        tabs.className = 'fp-xlsx-tabs';
        var panes = document.createElement('div');
        panes.className = 'fp-xlsx-panes';

        sheets.forEach(function (ws, i) {
          var tab = document.createElement('button');
          tab.className = 'fp-xlsx-tab' + (i === 0 ? ' active' : '');
          tab.textContent = ws.name || ('Sheet' + (i + 1));
          var pane = document.createElement('div');
          pane.className = 'fp-xlsx-pane' + (i === 0 ? ' active' : '');
          pane.innerHTML = _xlsxSheetTable(ws);
          tab.addEventListener('click', function () {
            tabs.querySelectorAll('.fp-xlsx-tab').forEach(function (t) { t.classList.remove('active'); });
            panes.querySelectorAll('.fp-xlsx-pane').forEach(function (p) { p.classList.remove('active'); });
            tab.classList.add('active');
            pane.classList.add('active');
          });
          tabs.appendChild(tab);
          panes.appendChild(pane);
        });

        if (sheets.length > 1) wrap.appendChild(tabs);
        wrap.appendChild(panes);
        body.appendChild(wrap);
        wrap.querySelectorAll('.fp-xlsx-table').forEach(_attachColumnFilters);
      })
      .catch(function (err) {
        _showError(body, '表格解析失败: ' + (err && err.message ? err.message : err));
      });
  }

  // --- csv / tsv (parsed → table, reusing the xlsx table styling) ---

  function _isCsvPath(p) { return /\.(csv|tsv)$/i.test(p || ''); }

  function _csvDelim(absPath, text) {
    if (/\.tsv$/i.test(absPath)) return '\t';
    var first = (text.split('\n', 1)[0] || '');
    var cand = [',', ';', '\t'];
    var best = ',', bestN = -1;
    cand.forEach(function (d) {
      var n = first.split(d).length - 1;
      if (n > bestN) { bestN = n; best = d; }
    });
    return best;
  }

  // RFC 4180: handles quoted fields, escaped quotes (""), and newlines/delims
  // inside quotes.
  function _parseCsv(text, delim) {
    var rows = [], row = [], field = '', inQ = false, i = 0, n = text.length;
    while (i < n) {
      var c = text.charAt(i);
      if (inQ) {
        if (c === '"') {
          if (text.charAt(i + 1) === '"') { field += '"'; i += 2; continue; }
          inQ = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') { inQ = true; i++; continue; }
      if (c === delim) { row.push(field); field = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += c; i++;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function _renderCsv(body, content, absPath) {
    var rows = _parseCsv(content, _csvDelim(absPath, content));
    // Drop a trailing blank row from a final newline.
    if (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();
    if (!rows.length) { _renderCode(body, content, 'plaintext'); return; }

    var MAX_ROWS = 2000;
    var truncated = rows.length > MAX_ROWS;
    if (truncated) rows = rows.slice(0, MAX_ROWS);

    var html = '<table class="fp-xlsx-table"><tbody>';
    for (var r = 0; r < rows.length; r++) {
      html += '<tr>';
      var bold = r === 0 ? ' style="font-weight:600"' : '';
      var cells = rows[r];
      for (var c = 0; c < cells.length; c++) {
        html += '<td' + bold + '>' + _escapeHtml(cells[c]) + '</td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table>';

    body.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.className = 'fp-xlsx-wrap';
    var panes = document.createElement('div');
    panes.className = 'fp-xlsx-panes';
    var pane = document.createElement('div');
    pane.className = 'fp-xlsx-pane active';
    pane.innerHTML = html;
    panes.appendChild(pane);
    wrap.appendChild(panes);
    if (truncated) {
      var note = document.createElement('div');
      note.className = 'fp-dir-truncated';
      note.textContent = '已截断显示前 ' + MAX_ROWS + ' 行';
      wrap.appendChild(note);
    }
    body.appendChild(wrap);
    _attachColumnFilters(wrap.querySelector('.fp-xlsx-table'));
  }

  // --- Excel-style per-column filter (xlsx & csv flat tables) ---

  function _attachColumnFilters(table) {
    if (!table || !table.tBodies || !table.tBodies[0]) return;
    // Merged cells break column/row indexing — skip those tables.
    if (table.querySelector('[rowspan],[colspan]')) return;
    var rows = Array.prototype.slice.call(table.tBodies[0].rows);
    if (rows.length < 2) return;
    var header = rows[0];
    var dataRows = rows.slice(1);
    var filters = {}; // colIndex -> Set(allowed values); absent = no filter
    var openPop = null;

    function applyFilters() {
      for (var i = 0; i < dataRows.length; i++) {
        var show = true, row = dataRows[i];
        for (var col in filters) {
          var cell = row.cells[col];
          if (!filters[col].has(cell ? cell.textContent : '')) { show = false; break; }
        }
        row.style.display = show ? '' : 'none';
      }
    }

    function distinct(col) {
      var seen = {}, out = [];
      for (var i = 0; i < dataRows.length; i++) {
        var cell = dataRows[i].cells[col];
        var v = cell ? cell.textContent : '';
        if (!Object.prototype.hasOwnProperty.call(seen, v)) { seen[v] = 1; out.push(v); }
      }
      return out.sort();
    }

    function closePop() {
      if (!openPop) return;
      openPop.remove(); openPop = null;
      document.removeEventListener('mousedown', onDoc, true);
    }
    function onDoc(e) {
      if (openPop && !openPop.contains(e.target) && !e.target.classList.contains('fp-colfilter-btn')) closePop();
    }

    function openFilter(col, btn) {
      var reopen = openPop && openPop._col === col;
      closePop();
      if (reopen) return; // clicking the same button toggles it closed

      var values = distinct(col);
      var allowed = filters[col] || null; // null = all selected
      var pop = document.createElement('div');
      pop.className = 'fp-colfilter-pop';
      pop._col = col;

      var search = document.createElement('input');
      search.className = 'fp-colfilter-search';
      search.placeholder = '搜索…';
      pop.appendChild(search);

      var list = document.createElement('div');
      list.className = 'fp-colfilter-list';
      pop.appendChild(list);

      var allCb = document.createElement('input'); allCb.type = 'checkbox'; allCb.checked = !allowed;
      var allLabel = document.createElement('label');
      allLabel.className = 'fp-colfilter-item fp-colfilter-all';
      allLabel.appendChild(allCb); allLabel.appendChild(document.createTextNode('（全选）'));
      list.appendChild(allLabel);

      var itemCbs = [];
      values.forEach(function (v) {
        var cb = document.createElement('input'); cb.type = 'checkbox';
        cb.checked = !allowed || allowed.has(v); cb.value = v;
        var label = document.createElement('label');
        label.className = 'fp-colfilter-item';
        label.appendChild(cb);
        label.appendChild(document.createTextNode(v === '' ? '（空）' : v));
        list.appendChild(label);
        itemCbs.push(cb);
      });

      function commit() {
        var checked = itemCbs.filter(function (c) { return c.checked; });
        if (checked.length === itemCbs.length) { delete filters[col]; btn.classList.remove('active'); }
        else { filters[col] = new Set(checked.map(function (c) { return c.value; })); btn.classList.add('active'); }
        applyFilters();
      }
      itemCbs.forEach(function (c) {
        c.addEventListener('change', function () {
          allCb.checked = itemCbs.every(function (x) { return x.checked; });
          commit();
        });
      });
      allCb.addEventListener('change', function () {
        itemCbs.forEach(function (c) { if (c.parentNode.style.display !== 'none') c.checked = allCb.checked; });
        commit();
      });
      search.addEventListener('input', function () {
        var q = search.value.toLowerCase();
        itemCbs.forEach(function (c) {
          c.parentNode.style.display = c.value.toLowerCase().indexOf(q) >= 0 ? '' : 'none';
        });
      });

      document.body.appendChild(pop);
      var r = btn.getBoundingClientRect();
      pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + 'px';
      pop.style.top = Math.min(r.bottom + 2, window.innerHeight - pop.offsetHeight - 8) + 'px';
      openPop = pop;
      setTimeout(function () { document.addEventListener('mousedown', onDoc, true); }, 0);
      search.focus();
    }

    for (var c = 0; c < header.cells.length; c++) {
      (function (col) {
        var btn = document.createElement('span');
        btn.className = 'fp-colfilter-btn';
        btn.textContent = '▾';
        btn.title = '筛选此列';
        btn.addEventListener('click', function (e) { e.stopPropagation(); openFilter(col, btn); });
        header.cells[col].appendChild(btn);
      })(c);
    }
  }

  function _renderCode(body, content, language, targetLine) {
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

    // Best-effort jump to a target line (from path:line:col). Never let a
    // scroll/measure failure block the file from opening.
    if (targetLine && targetLine > 1) {
      try {
        var per = lineNums.scrollHeight / Math.max(lines.length, 1);
        if (per > 0 && isFinite(per)) {
          wrap.scrollTop = Math.max(0, (targetLine - 1) * per - wrap.clientHeight / 3);
        }
      } catch (_e) { /* ignore */ }
    }
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
              // Pin a system font so mermaid measures text with the SAME
              // always-available font it renders with. Otherwise a late-loading
              // webfont reflows the text after layout is computed, pushing it
              // past the boxes/spacing mermaid already sized — the "overlapping"
              // render. Waiting on document.fonts.ready guards the same hazard.
              window.mermaid.initialize({
                startOnLoad: false,
                theme: 'dark',
                securityLevel: 'loose',
                fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
              });
              var fontsReady = (document.fonts && document.fonts.ready)
                ? document.fonts.ready : Promise.resolve();
              return fontsReady.then(function () {
                var jobs = Array.prototype.map.call(mermaidBlocks, function (block, i) {
                  var code = block.textContent;
                  var container = document.createElement('div');
                  container.className = 'mermaid';
                  block.parentElement.replaceWith(container);
                  // render() lays out in mermaid's own sandbox (deterministic),
                  // then we inject the finished SVG.
                  var id = 'fp-mmd-' + Date.now() + '-' + i;
                  return window.mermaid.render(id, code)
                    .then(function (res) { container.innerHTML = res.svg; })
                    .catch(function () {
                      // Render failed — fall back to the raw fenced code.
                      var p = document.createElement('pre');
                      var c = document.createElement('code');
                      c.textContent = code;
                      p.appendChild(c);
                      container.replaceWith(p);
                    });
                });
                return Promise.all(jobs);
              });
            })
            .catch(function () { /* mermaid optional */ });
        }
      })
      .catch(function () {
        _renderCode(body, content, 'markdown');
      });
  }

  // --- Path / URL detection (delegated to the DOM-free LinkDetect core) ---

  // Runs on a single LOGICAL line (wrapped rows already merged); returns
  // matches { text, kind, href, lineRef, startCol, endCol }. All regex logic
  // lives in public/js/link-detect.js (window.LinkDetect) so it is unit-tested.
  //   kind 'web'       -> open href in a new browser tab
  //   kind 'file'      -> open in the file preview (lineRef jumps to a line)
  //   kind 'ambiguous' -> let the user choose web vs file (e.g. example.com)
  function _findLinks(line) {
    if (typeof LinkDetect === 'undefined') return [];
    return LinkDetect.findLinks(line).map(function (m) {
      return { text: m.text, kind: m.kind, href: m.href, lineRef: m.lineRef,
        startCol: m.start, endCol: m.end };
    });
  }

  // --- Wrapped line helpers ---

  // Collect a logical line by merging wrapped buffer lines.
  // Returns { text, startRow, rows } where rows is an array of
  // { line, row, strStart, strLen } for each physical row.
  // A physical row is "full" (reached the right margin) if its last printable
  // cell is non-blank — a strong signal the next line is a forced continuation.
  function _rowIsFull(line) {
    var s = line.translateToString(false);
    return s.length > 0 && !/\s$/.test(s);
  }

  function _hardJoins(above, below) {
    return !!above && !!below && typeof LinkDetect !== 'undefined' &&
      _rowIsFull(above) &&
      LinkDetect.shouldJoinHardWrap(above.translateToString(true), true, below.translateToString(true));
  }

  function _getLogicalLine(buffer, bufRow) {
    // Walk backward to the true start: up the soft-wrap chain always, and
    // across ONE hard-newline join (Fix 10) so that the continuation row
    // resolves to the SAME merged line as the joined row (else its standalone
    // fragment would match as a wrong link / be unclickable).
    var startRow = bufRow;
    var crossedHard = false;
    for (;;) {
      while (startRow > 0) {
        var prev = buffer.getLine(startRow);
        if (!prev || !prev.isWrapped) break;
        startRow--;
      }
      if (crossedHard || startRow === 0) break;
      var above = buffer.getLine(startRow - 1);
      var cur = buffer.getLine(startRow);
      if (cur && !cur.isWrapped && _hardJoins(above, cur)) {
        startRow--;            // cross the hard newline upward
        crossedHard = true;
        continue;              // climb the predecessor's soft-wrap chain
      }
      break;
    }
    // Collect forward: soft-wrapped continuations always; a single hard-newline
    // row only when the conservative heuristic says the token was split.
    var first = buffer.getLine(startRow);
    if (!first) return { text: '', startRow: startRow, rows: [] };
    var lineObjs = [{ line: first, row: startRow }];
    var row = startRow + 1;
    var joinedHard = false;
    while (row < buffer.length) {
      var ln = buffer.getLine(row);
      if (!ln) break;
      if (ln.isWrapped) { lineObjs.push({ line: ln, row: row }); row++; continue; }
      if (joinedHard) break;   // at most one hard-newline join per logical line
      if (!_hardJoins(lineObjs[lineObjs.length - 1].line, ln)) break;
      lineObjs.push({ line: ln, row: row });
      joinedHard = true;
      row++;                   // keep collecting the joined row's soft-wrap chain
    }
    // Build the merged string. Non-final wrapped rows keep a trailing pad space
    // when a wide CJK glyph could not split across the margin; trim it so the
    // URL/path is not severed at the wrap point (D30).
    var text = '';
    var rows = [];
    for (var i = 0; i < lineObjs.length; i++) {
      var l = lineObjs[i].line;
      var rowText = l.translateToString(i < lineObjs.length - 1);
      rows.push({ line: l, row: lineObjs[i].row, strStart: text.length, strLen: rowText.length });
      text += rowText;
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
    // No usable path → open the pane's cwd. '.' is resolved server-side against
    // #{pane_current_path} (resolveInputPath).
    var openCwd = function () { openFile('.', paneId); };
    fetch('/api/files/tmux-buffer', { headers: _authHeaders })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        var p = (res && res.success && res.data && res.data.path) ? res.data.path : '';
        if (!p) { openCwd(); return; }
        // The buffer endpoint hands back its raw text as "path" with no
        // validation, so confirm it resolves to a real file/dir before opening;
        // otherwise (clipboard has no matching path) fall back to the cwd.
        var probe = (typeof LinkDetect !== 'undefined') ? LinkDetect.parseLineRef(p).path : p;
        var qs = '?path=' + encodeURIComponent(probe)
          + (paneId ? '&paneId=' + encodeURIComponent(paneId) : '');
        fetch('/api/files/info' + qs, { headers: _authHeaders })
          .then(function (r) { return r.json(); })
          .then(function (info) {
            if (info && info.success) { openFile(p, paneId); } else { openCwd(); }
          })
          .catch(openCwd);
      })
      .catch(openCwd);
  }

  // --- Link Provider ---

  // Dispatch a matched link by kind. Web opens a browser tab; file opens the
  // preview; ambiguous (e.g. example.com) asks the user which one (project rule:
  // don't guess URL-vs-file — let the user choose).
  function _activateLink(f, paneId) {
    if (f.kind === 'web') { _openWeb(f.href); return; }
    if (f.kind === 'ambiguous') { _showLinkChooser(f, paneId); return; }
    openFile(f.text, paneId, { lineRef: f.lineRef });
  }

  function _openWeb(href) {
    // Only ever open http(s) — defensive gate against a future caller passing a
    // javascript:/data: href (detectors only ever emit http(s) today).
    if (href && /^https?:\/\//i.test(href)) window.open(href, '_blank', 'noopener');
  }

  function _showLinkChooser(f, paneId) {
    var ov = document.createElement('div');
    ov.className = 'fp-overlay fp-chooser';
    ov.addEventListener('click', function (e) { if (e.target === ov) ov.remove(); });
    var box = document.createElement('div');
    box.className = 'fp-chooser-box';
    var q = document.createElement('div');
    q.className = 'fp-chooser-q';
    q.textContent = f.text;
    var sub = document.createElement('div');
    sub.className = 'fp-chooser-sub';
    sub.textContent = '作为网址还是文件打开？';
    var row = document.createElement('div');
    row.className = 'fp-chooser-actions';
    var web = document.createElement('button');
    web.className = 'fp-btn fp-chooser-btn';
    web.textContent = '🌐 网址';
    web.addEventListener('click', function () {
      ov.remove();
      _openWeb(f.href || (typeof LinkDetect !== 'undefined' ? LinkDetect.computeHref(f.text) : 'https://' + f.text));
    });
    var file = document.createElement('button');
    file.className = 'fp-btn fp-chooser-btn';
    file.textContent = '📄 文件';
    file.addEventListener('click', function () { ov.remove(); openFile(f.text, paneId); });
    row.appendChild(web);
    row.appendChild(file);
    box.appendChild(q);
    box.appendChild(sub);
    box.appendChild(row);
    ov.appendChild(box);
    document.body.appendChild(ov);
    web.focus();
    ov.addEventListener('keydown', function (e) { if (e.key === 'Escape') { ov.remove(); e.stopPropagation(); } });
  }

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
          // xterm link ranges are INCLUSIVE, so map the LAST cell (endCol-1),
          // not the exclusive end. Mapping endCol directly lands on the next
          // row when the span ends exactly at a wrap boundary (over-underline).
          var end = _logicalStrOffsetToTermPos(logical.rows, f.endCol - 1);
          return {
            range: { start: start, end: { y: end.y, x: Math.max(end.x, start.x) } },
            text: f.text,
            activate: function () { _activateLink(f, paneId); },
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

  // opts: `true` (legacy keep-dir-context) or { lineRef, keepDirContext }.
  function openFile(filePath, paneId, opts) {
    var keepDir = opts === true || (opts && opts.keepDirContext);
    var targetLine = (opts && opts !== true && opts.lineRef != null) ? opts.lineRef : null;
    // A path may still carry a :line[:col] suffix (e.g. from a mobile tap); split
    // it off so the server gets a clean path and we still know where to jump.
    if (targetLine == null && typeof LinkDetect !== 'undefined') {
      var parsed = LinkDetect.parseLineRef(filePath);
      filePath = parsed.path;
      targetLine = parsed.lineRef;
    }
    _currentPaneId = paneId || _currentPaneId;
    if (!keepDir) _dirContext = null;
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
          isXlsx: info.isXlsx,
          isMarkdown: info.isMarkdown,
          rawContent: null,
        };
        _applyMode('file');

        if (info.isImage) {
          _renderImage(body, rawUrl);
        } else if (info.isPdf) {
          _renderPdf(body, rawUrl);
        } else if (info.isXlsx) {
          _renderXlsx(body, rawUrl);
        } else {
          fetch('/api/files/content?path=' + encodeURIComponent(info.absPath), { headers: _authHeaders })
            .then(function (r) { return r.json(); })
            .then(function (cr) {
              if (!cr.success) { _showError(body, cr.error, info.absPath); return; }
              _currentFile.rawContent = cr.data.content;
              if (info.isMarkdown) {
                _renderMarkdown(body, cr.data.content, info.absPath);
              } else if (_isCsvPath(info.absPath)) {
                _renderCsv(body, cr.data.content, info.absPath);
              } else {
                _renderCode(body, cr.data.content, cr.data.language, targetLine);
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

  // Check if a position falls on a link. Returns the full match object
  // { kind, text, href, lineRef, ... } (dispatch via activateHit) or null.
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
          return links[i];
        }
      }
      return null;
    }
    // Fallback: single-line hit test
    var simpleLinks = _findLinks(lineText);
    for (var j = 0; j < simpleLinks.length; j++) {
      if (col >= simpleLinks[j].startCol && col < simpleLinks[j].endCol) {
        return simpleLinks[j];
      }
    }
    return null;
  }

  return {
    registerLinkProvider: registerLinkProvider, openFile: openFile,
    openFromBuffer: openFromBuffer, close: close, hitTest: hitTest,
    activateHit: _activateLink,
    // Test seam (no DOM): exercised by test/file-preview-links.test.js.
    _test: {
      getLogicalLine: _getLogicalLine,
      strOffsetToTermPos: _logicalStrOffsetToTermPos,
      findLinks: _findLinks,
      buildLinkRange: function (logical, f) {
        var start = _logicalStrOffsetToTermPos(logical.rows, f.startCol);
        var end = _logicalStrOffsetToTermPos(logical.rows, f.endCol - 1);
        return { start: start, end: { y: end.y, x: Math.max(end.x, start.x) } };
      },
    },
  };
})();

if (typeof window !== 'undefined') window.FilePreview = FilePreview;
