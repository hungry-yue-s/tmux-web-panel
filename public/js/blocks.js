/* global Api, Store, state, FilePreview */

// Blocks: built-in tools next to the shell. This file holds the shared UI kit
// (icons, keys, spinners, dialogs, toasts, diffs) and the blocks that render
// inside the file preview: SQLite, notebooks, patches, the TODO.md board and
// the editor. Tool blocks that live in BlockHost (git, browser) and the
// pickers are in blocks-workspace.js.

var Blocks = (function () {
  'use strict';

  var CDN = {
    markdownIt: 'https://unpkg.com/markdown-it@14.1.0/dist/markdown-it.min.js',
    hljs: 'https://unpkg.com/@highlightjs/cdn-assets@11.11.1/highlight.min.js',
    diff2html: 'https://unpkg.com/diff2html@3.4.48/bundles/js/diff2html.min.js',
    diff2htmlCss: 'https://unpkg.com/diff2html@3.4.48/bundles/css/diff2html.min.css',
    sortable: 'https://unpkg.com/sortablejs@1.15.6/Sortable.min.js',
    toastEditor: 'https://unpkg.com/@toast-ui/editor@3.2.2/dist/toastui-editor-all.min.js',
    toastEditorCss: 'https://unpkg.com/@toast-ui/editor@3.2.2/dist/toastui-editor.min.css',
    toastEditorDarkCss: 'https://unpkg.com/@toast-ui/editor@3.2.2/dist/theme/toastui-editor-dark.min.css',
  };

  // --- loading ---------------------------------------------------------------

  var _loaded = {};
  function loadScript(url) {
    if (!_loaded[url]) {
      _loaded[url] = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = url;
        s.onload = resolve;
        s.onerror = function () { delete _loaded[url]; reject(new Error('无法加载 ' + url)); };
        document.head.appendChild(s);
      });
    }
    return _loaded[url];
  }
  function loadCss(url) {
    if (!_loaded[url]) {
      _loaded[url] = Promise.resolve();
      var l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = url;
      document.head.appendChild(l);
    }
    return _loaded[url];
  }

  // --- DOM kit -----------------------------------------------------------------

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  var ICONS = {
    git: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7"/><path d="M18 10.5c0 4-5 3.5-10.2 6.2"/>',
    branch: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7"/><path d="M18 10.5c0 4-5 3.5-10.2 6.2"/>',
    commit: '<circle cx="12" cy="12" r="3.5"/><path d="M3 12h5.5M15.5 12H21"/>',
    browser: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z"/>',
    database: '<ellipse cx="12" cy="5.5" rx="8" ry="2.8"/><path d="M4 5.5v13c0 1.5 3.6 2.8 8 2.8s8-1.3 8-2.8v-13"/><path d="M4 12c0 1.5 3.6 2.8 8 2.8s8-1.3 8-2.8"/>',
    board: '<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="11" rx="1.5"/><rect x="17" y="4" width="4" height="7" rx="1.5"/>',
    notebook: '<path d="M6 3h11a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6z"/><path d="M9.5 3v18M13 8h3M13 12h3"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    file: '<path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z"/><path d="M14 3v5h5"/>',
    activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    server: '<rect x="3" y="4" width="18" height="6.5" rx="2"/><rect x="3" y="13.5" width="18" height="6.5" rx="2"/><path d="M7 7.2h.01M7 16.8h.01"/>',
    theme: '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.8 1.8-1.8 0-.5-.2-.9-.5-1.3-.3-.3-.5-.8-.5-1.2 0-1 .8-1.8 1.8-1.8h2.2A4.2 4.2 0 0 0 21 10.7C21 6.4 17 3 12 3z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7" r="1"/>',
    keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M7.5 14h9"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
    up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
    fetch: '<path d="M4 12a8 8 0 0 1 13.7-5.7L20 8.5"/><path d="M20 4v4.5h-4.5"/><path d="M20 12a8 8 0 0 1-13.7 5.7L4 15.5"/><path d="M4 20v-4.5h4.5"/>',
    external: '<path d="M14 4h6v6M10 14 20 4M18 14v5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 19V7.5A1.5 1.5 0 0 1 5.5 6H10"/>',
    play: '<path d="M7 4.5v15l12.5-7.5z"/>',
    sparkles: '<path d="M11 3.5 12.6 8l4.4 1.6-4.4 1.6L11 15.7l-1.6-4.5L5 9.6 9.4 8z"/><path d="m18.5 14 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    chevronLeft: '<path d="m15 18-6-6 6-6"/>',
    chevronRight: '<path d="m9 18 6-6-6-6"/>',
    history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5"/><path d="M3.5 3.5v5h5M12 7.5V12l3 2"/>',
    changes: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
    table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9.5 4v16"/>',
    code: '<path d="m8 7-5 5 5 5M16 7l5 5-5 5"/>',
    structure: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><path d="M6.5 10v4.5a2 2 0 0 0 2 2H14"/>',
    download: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>',
    edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>',
    plug: '<path d="M9 3v5M15 3v5M6 8h12v3.5a6 6 0 0 1-12 0z"/><path d="M12 17.5V21"/>',
    command: '<path d="M9 6.5A2.5 2.5 0 1 0 6.5 9H17.5A2.5 2.5 0 1 0 15 6.5v11A2.5 2.5 0 1 0 17.5 15h-11A2.5 2.5 0 1 0 9 17.5z"/>',
    dot: '<circle cx="12" cy="12" r="4"/>',
    float: '<rect x="3" y="4" width="18" height="16" rx="2"/><rect x="11" y="11" width="8" height="6" rx="1"/>',
    max: '<path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/>',
  };

  function icon(name) {
    var paths = ICONS[name];
    if (!paths) return '';
    return '<svg class="blk-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"'
      + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + paths + '</svg>';
  }

  /** Button with an optional icon; `label` is visible text unless iconOnly. */
  function button(label, onclick, options) {
    options = options || {};
    var b = el('button', 'blk-btn' + (options.className ? ' ' + options.className : ''));
    b.type = 'button';
    if (options.icon) b.innerHTML = icon(options.icon);
    if (options.iconOnly) {
      b.classList.add('blk-icon-btn');
      b.setAttribute('aria-label', label);
      b.title = options.title || label;
    } else {
      b.appendChild(el('span', 'blk-btn-label', label));
      if (options.title) b.title = options.title;
    }
    if (options.kbd) {
      b.appendChild(kbd(options.kbd));
      if (!b.title) b.title = label + ' (' + keysText(options.kbd) + ')';
    }
    if (onclick) b.addEventListener('click', onclick);
    return b;
  }

  function iconButton(name, label, onclick, className) {
    return button(label, onclick, { icon: name, iconOnly: true, className: className });
  }

  // --- keys ------------------------------------------------------------------

  var IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
  var MAC_SYMBOLS = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Mod: '⌘', Cmd: '⌘', Enter: '↵', Escape: 'esc', Up: '↑', Down: '↓' };

  /** "Alt+Shift+G" → ["⌥","⇧","G"] on a Mac, ["Alt","Shift","G"] elsewhere. Mod is ⌘ or Ctrl. */
  function keyParts(combo) {
    return String(combo).split('+').map(function (part) {
      if (part === 'Mod') return IS_MAC ? '⌘' : 'Ctrl';
      if (IS_MAC && MAC_SYMBOLS[part]) return MAC_SYMBOLS[part];
      if (part === 'Up') return '↑';
      if (part === 'Down') return '↓';
      if (part === 'Enter') return '↵';
      if (part === 'Escape') return 'Esc';
      return part;
    });
  }

  function keysText(combo) {
    var parts = keyParts(combo);
    return IS_MAC ? parts.join('') : parts.join('+');
  }

  function kbd(combo) {
    var wrap = el('span', 'blk-kbd');
    keyParts(combo).forEach(function (part) { wrap.appendChild(el('kbd', '', part)); });
    return wrap;
  }

  // --- feedback ----------------------------------------------------------------

  var BRAILLE = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

  /** Puts a button into a working state with a braille spinner and elapsed seconds. */
  function busy(target, label) {
    var original = Array.prototype.slice.call(target.childNodes);
    var wasDisabled = target.disabled;
    var started = Date.now();
    var frame = 0;
    var text = el('span', 'blk-spin');
    target.replaceChildren(text);
    target.disabled = true;
    target.classList.add('is-busy');
    function tick() {
      var seconds = Math.floor((Date.now() - started) / 1000);
      text.textContent = BRAILLE[frame++ % BRAILLE.length] + ' ' + label + (seconds >= 1 ? ' ' + seconds + 's' : '');
    }
    tick();
    var timer = setInterval(tick, 80);
    return function done() {
      clearInterval(timer);
      target.replaceChildren.apply(target, original);
      target.disabled = wasDisabled;
      target.classList.remove('is-busy');
    };
  }

  function spinnerLine(label) {
    var node = el('div', 'blk-loading');
    var frame = 0;
    var started = Date.now();
    function tick() {
      if (!node.isConnected && frame > 2) { clearInterval(timer); return; }
      var seconds = Math.floor((Date.now() - started) / 1000);
      node.textContent = BRAILLE[frame++ % BRAILLE.length] + ' ' + label + (seconds >= 2 ? ' ' + seconds + 's' : '');
    }
    var timer = setInterval(tick, 80);
    tick();
    return node;
  }

  var _toastTimer = null;
  /** Bottom toast; `options.action` adds a button (e.g. 撤销), `options.error` the error tone. */
  function toast(message, options) {
    if (typeof options === 'boolean') options = { error: options };
    options = options || {};
    var host = document.getElementById('ms-toast');
    if (!host) {
      if (options.error) console.error(message);
      return;
    }
    host.replaceChildren(el('span', 'blk-toast-text', message));
    if (options.action) {
      var action = el('button', 'blk-toast-action', options.action.label);
      action.type = 'button';
      action.addEventListener('click', function () {
        host.classList.remove('show');
        options.action.run();
      });
      host.appendChild(action);
    }
    host.classList.toggle('is-error', !!options.error);
    host.classList.add('show');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(function () { host.classList.remove('show'); }, options.action ? 6000 : 3200);
  }

  function errorText(err) {
    var message = err && err.message ? err.message : String(err || '未知错误');
    var known = {
      not_a_git_repository: '当前目录不在 Git 仓库中',
      nothing_staged: '还没有暂存任何改动',
      git_not_installed: '这台机器上没有安装 git',
      file_changed_on_disk: '文件已被其它程序修改',
      jupyter_not_installed: '这台机器上没有 Jupyter（pip install jupyter）',
      no_parent_commit: '这是第一个提交，无法撤销',
      empty_commit_message: '请填写提交说明',
      invalid_branch: '分支名不合法',
      detached_head: '当前不在任何分支上',
      sqlite_unavailable: '这台机器的 Node 不支持 node:sqlite（需要 22.5 以上）',
    };
    if (known[message]) return known[message];
    return message.split('\n').filter(Boolean).slice(-3).join('\n');
  }

  // Small modal used for confirmations and one-line inputs. Replaces the
  // browser's confirm()/prompt(), which block the page and ignore the theme.
  function dialog(options) {
    return new Promise(function (resolve) {
      var previous = document.activeElement;
      var overlay = el('div', 'blk-dialog-overlay');
      var box = el('div', 'blk-dialog' + (options.danger ? ' is-danger' : ''));
      box.setAttribute('role', 'alertdialog');
      box.setAttribute('aria-modal', 'true');
      var title = el('h3', 'blk-dialog-title', options.title);
      title.id = 'blk-dialog-title-' + Date.now();
      box.setAttribute('aria-labelledby', title.id);
      box.appendChild(title);
      if (options.message) box.appendChild(el('p', 'blk-dialog-message', options.message));
      var input = null;
      var hint = null;
      if (options.input) {
        input = el('input', 'blk-input blk-dialog-input');
        input.value = options.value || '';
        input.placeholder = options.placeholder || '';
        input.spellcheck = false;
        input.autocomplete = 'off';
        box.appendChild(input);
        hint = el('div', 'blk-dialog-hint');
        box.appendChild(hint);
      }
      var row = el('div', 'blk-dialog-actions');
      var cancel = button(options.cancelLabel || '取消', function () { finish(null); }, { className: 'blk-btn-ghost' });
      var ok = button(options.confirmLabel || '确定', function () { submit(); }, { className: options.danger ? 'blk-btn-danger-solid' : 'blk-btn-primary' });
      row.append(cancel, ok);
      box.appendChild(row);
      overlay.appendChild(box);
      document.body.appendChild(overlay);

      function validate() {
        if (!input || !options.validate) return true;
        var problem = options.validate(input.value);
        hint.textContent = problem || '';
        ok.disabled = !!problem;
        return !problem;
      }
      function submit() {
        if (!validate()) return;
        finish(input ? input.value : true);
      }
      function finish(value) {
        overlay.remove();
        if (previous && previous.focus && previous.isConnected) previous.focus({ preventScroll: true });
        resolve(value === null ? (input ? null : false) : value);
      }
      if (input) input.addEventListener('input', validate);
      overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) finish(null); });
      overlay.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); }
        else if (e.key === 'Enter' && !e.isComposing && (input ? e.target === input : true)) { e.preventDefault(); submit(); }
        else if (e.key === 'Tab') {
          var controls = Array.prototype.filter.call(box.querySelectorAll('input,button'), function (n) { return !n.disabled; });
          var index = controls.indexOf(document.activeElement);
          e.preventDefault();
          controls[(index + (e.shiftKey ? controls.length - 1 : 1)) % controls.length].focus();
        }
      });
      validate();
      setTimeout(function () { (input || (options.danger ? cancel : ok)).focus(); if (input) input.select(); }, 0);
    });
  }

  function confirmAction(options) { return dialog(options).then(function (value) { return value === true; }); }
  function promptText(options) { return dialog(Object.assign({ input: true }, options)); }

  function isDark() {
    var scheme = document.documentElement.style.colorScheme || '';
    if (scheme) return scheme.indexOf('dark') !== -1;
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  // --- requests ---------------------------------------------------------------

  /** Requests to one server's node; `serverId` defaults to the server in view. */
  function client(serverId) {
    function url(path) {
      var sid = serverId || Api.activeServerId();
      return Api.nodeUrl(sid, path);
    }
    function qs(params) {
      return Object.keys(params || {}).filter(function (k) { return params[k] != null && params[k] !== ''; })
        .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
    }
    return {
      url: url,
      get: function (path, params) { var q = qs(params); return Api.get(url(path) + (q ? '?' + q : '')); },
      send: function (method, path, body) { return Api.request(method, url(path), body); },
    };
  }

  /** The pane in view: its cwd anchors git, quick-open and new files. */
  function currentContext() {
    var snapshot = typeof Store !== 'undefined' && Store.getState ? Store.getState() : null;
    var params = (snapshot && snapshot.route && snapshot.route.params) || {};
    var legacy = typeof state !== 'undefined' ? state : {};
    return {
      serverId: Api.activeServerId(),
      sessionId: params.sessionId || legacy.currentSession || null,
      windowId: params.windowId || null,
      paneId: params.paneId || legacy.currentPane || null,
    };
  }

  // --- unified diffs -----------------------------------------------------------

  /** Splits a multi-file unified diff into files with header lines and hunks. */
  function parseUnifiedDiff(text) {
    var files = [];
    var file = null, hunk = null;
    String(text || '').split('\n').forEach(function (line) {
      if (line.indexOf('diff --git ') === 0 || (!file && line.indexOf('--- ') === 0)) {
        file = { header: [line], hunks: [], name: '', added: 0, removed: 0, binary: false };
        files.push(file);
        hunk = null;
        if (line.indexOf('diff --git ') === 0) {
          var m = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(line);
          if (m) file.name = m[2];
        }
        return;
      }
      if (!file) return;
      if (line.indexOf('@@') === 0) {
        hunk = { header: line, lines: [] };
        file.hunks.push(hunk);
        return;
      }
      if (hunk) {
        if (line === '') return; // the diff's trailing newline
        hunk.lines.push(line);
        if (line.charAt(0) === '+') file.added++;
        else if (line.charAt(0) === '-') file.removed++;
      } else {
        file.header.push(line);
        if (line.indexOf('Binary files') === 0) file.binary = true;
        if (line.indexOf('+++ ') === 0 && !file.name) file.name = line.slice(4).replace(/^b\//, '');
      }
    });
    return files;
  }

  /**
   * Patch for the selected lines of one hunk. Forward (staging from the
   * worktree): unselected additions vanish and unselected deletions become
   * context. Reverse (unstaging a staged hunk with `apply --reverse`): the
   * opposite, since the index already has those lines.
   */
  function buildPatch(file, hunk, selected, reverse) {
    var out = [];
    var any = false;
    hunk.lines.forEach(function (line, i) {
      var kind = line.charAt(0);
      var picked = !selected || selected[i];
      if (kind === '+' || kind === '-') {
        if (picked) { out.push(line); any = true; return; }
        var keepAsContext = reverse ? kind === '+' : kind === '-';
        if (keepAsContext) out.push(' ' + line.slice(1));
        return;
      }
      out.push(line);
    });
    if (!any) return null;
    return file.header.join('\n') + '\n' + hunk.header + '\n' + out.join('\n') + '\n';
  }

  /** Changed span between an old and a new line, or null when most of the line changed. */
  function wordSpan(a, b) {
    var p = 0;
    while (p < a.length && p < b.length && a.charAt(p) === b.charAt(p)) p++;
    var s = 0;
    while (s < a.length - p && s < b.length - p && a.charAt(a.length - 1 - s) === b.charAt(b.length - 1 - s)) s++;
    var aMid = a.length - p - s;
    var bMid = b.length - p - s;
    var longest = Math.max(a.length, b.length) || 1;
    if (Math.max(aMid, bMid) / longest > 0.7) return null;
    return { start: p, aEnd: a.length - s, bEnd: b.length - s };
  }

  /** Pairs each run of deletions with the additions right after it. */
  function pairChanges(lines) {
    var pairs = {};
    var i = 0;
    while (i < lines.length) {
      if (lines[i].charAt(0) !== '-') { i++; continue; }
      var delStart = i;
      while (i < lines.length && lines[i].charAt(0) === '-') i++;
      var addStart = i;
      while (i < lines.length && lines[i].charAt(0) === '+') i++;
      var count = Math.min(addStart - delStart, i - addStart);
      for (var k = 0; k < count; k++) {
        var span = wordSpan(lines[delStart + k].slice(1), lines[addStart + k].slice(1));
        if (span) {
          pairs[delStart + k] = { start: span.start, end: span.aEnd };
          pairs[addStart + k] = { start: span.start, end: span.bEnd };
        }
      }
    }
    return pairs;
  }

  function codeWithSpan(text, span) {
    var code = el('span', 'blk-code');
    code.appendChild(document.createTextNode(text.charAt(0)));
    var body = text.slice(1);
    if (!span) {
      code.appendChild(document.createTextNode(body));
      return code;
    }
    code.appendChild(document.createTextNode(body.slice(0, span.start)));
    code.appendChild(el('span', 'blk-wd', body.slice(span.start, span.end)));
    code.appendChild(document.createTextNode(body.slice(span.end)));
    return code;
  }

  /**
   * Renders a unified diff. `options.actions(file, hunk, selection)` returns
   * buttons for each hunk header and makes changed lines selectable.
   */
  function renderDiffInto(container, text, options) {
    options = options || {};
    container.replaceChildren();
    var files = parseUnifiedDiff(text);
    if (!files.length || files.every(function (f) { return !f.hunks.length; })) {
      var empty = el('div', 'blk-empty');
      empty.appendChild(el('strong', '', options.emptyTitle || '没有文本差异'));
      empty.appendChild(el('span', '', options.emptyText || '可能是二进制文件，或只改了文件权限。'));
      container.appendChild(empty);
      return files;
    }
    files.forEach(function (file) {
      var fileBox = el('section', 'blk-diff-filebox');
      if (options.fileHeaders !== false && files.length > 1) {
        var head = el('button', 'blk-diff-filehead');
        head.type = 'button';
        head.innerHTML = icon('chevronDown');
        head.appendChild(el('span', 'blk-diff-filename', file.name));
        var stats = el('span', 'blk-diff-stats');
        stats.append(el('span', 'is-add', '+' + file.added), el('span', 'is-del', '−' + file.removed));
        head.appendChild(stats);
        head.setAttribute('aria-expanded', 'true');
        head.addEventListener('click', function () {
          var open = fileBox.classList.toggle('is-collapsed');
          head.setAttribute('aria-expanded', String(!open));
        });
        fileBox.appendChild(head);
      }
      file.hunks.forEach(function (hunk) {
        var box = el('div', 'blk-hunk');
        var bar = el('div', 'blk-hunk-head');
        var range = /^(@@[^@]*@@)(.*)$/.exec(hunk.header);
        bar.appendChild(el('code', 'blk-hunk-range', range ? range[1] : hunk.header));
        if (range && range[2].trim()) bar.appendChild(el('span', 'blk-hunk-context', range[2].trim()));
        var selected = {};
        if (options.actions) {
          var actionsBox = el('div', 'blk-hunk-actions');
          options.actions(file, hunk, function () {
            return Object.keys(selected).some(function (k) { return selected[k]; }) ? selected : null;
          }).forEach(function (b) { actionsBox.appendChild(b); });
          bar.appendChild(actionsBox);
        }
        box.appendChild(bar);
        var rows = el('div', 'blk-hunk-lines');
        var oldNo = 0, newNo = 0;
        var m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(hunk.header);
        if (m) { oldNo = Number(m[1]); newNo = Number(m[2]); }
        var pairs = pairChanges(hunk.lines);
        hunk.lines.forEach(function (line, i) {
          var kind = line.charAt(0);
          var row = el('div', 'blk-line' + (kind === '+' ? ' is-add' : kind === '-' ? ' is-del' : kind === '\\' ? ' is-meta' : ''));
          var a = kind === '+' || kind === '\\' ? '' : oldNo++;
          var b = kind === '-' || kind === '\\' ? '' : newNo++;
          row.appendChild(el('span', 'blk-ln', String(a)));
          row.appendChild(el('span', 'blk-ln', String(b)));
          row.appendChild(codeWithSpan(line, pairs[i]));
          if (options.actions && (kind === '+' || kind === '-')) {
            row.classList.add('is-selectable');
            row.addEventListener('click', function () {
              selected[i] = !selected[i];
              row.classList.toggle('is-selected', selected[i]);
              box.classList.toggle('has-selection', Object.keys(selected).some(function (k) { return selected[k]; }));
            });
          }
          rows.appendChild(row);
        });
        box.appendChild(rows);
        fileBox.appendChild(box);
      });
      container.appendChild(fileBox);
    });
    return files;
  }

  // --- notebook -----------------------------------------------------------------

  var ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
  function joinSource(src) { return Array.isArray(src) ? src.join('') : String(src || ''); }

  function renderNotebook(body, content, info) {
    var nb;
    try { nb = JSON.parse(content); } catch (err) {
      body.appendChild(el('div', 'blk-error', 'Notebook JSON 解析失败：' + err.message));
      return true;
    }
    var meta = nb.metadata || {};
    var lang = (meta.language_info && meta.language_info.name) || (meta.kernelspec && meta.kernelspec.language) || 'python';
    var cells = nb.cells || [];
    var wrap = el('div', 'blk-nb fp-md-wrap');
    var bar = el('div', 'blk-toolbar blk-nb-bar');
    var label = el('div', 'blk-toolbar-title');
    label.innerHTML = icon('notebook');
    label.appendChild(el('strong', '', (meta.kernelspec && meta.kernelspec.display_name) || lang));
    label.appendChild(el('span', 'blk-muted', cells.length + ' 个单元 · ' + cells.filter(function (c) { return c.cell_type === 'code'; }).length + ' 段代码'));
    var run = button('运行全部', function () {
      var done = busy(run, '运行中');
      client().send('POST', '/api/notebook/execute', { path: info.absPath })
        .then(function () { toast('执行完成，输出已写回 Notebook'); })
        .catch(function (err) { toast(errorText(err), { error: true }); })
        .finally(done);
    }, { icon: 'play', className: 'blk-btn-small', title: '用 jupyter nbconvert --execute 运行并写回输出' });
    bar.append(label, run);
    wrap.appendChild(bar);
    body.appendChild(wrap);

    return Promise.all([loadScript(CDN.markdownIt), loadScript(CDN.hljs)]).catch(function () {}).then(function () {
      var md = window.markdownit ? window.markdownit({ html: false, linkify: true }) : null;
      cells.forEach(function (cell) {
        var source = joinSource(cell.source);
        var box = el('div', 'blk-cell blk-cell-' + cell.cell_type);
        if (cell.cell_type === 'markdown') {
          var mdBox = el('div', 'blk-cell-md');
          if (md) mdBox.innerHTML = md.render(source); else mdBox.textContent = source;
          box.appendChild(mdBox);
        } else if (cell.cell_type === 'code') {
          var prompt = el('div', 'blk-cell-prompt', cell.execution_count == null ? '[ ]' : '[' + cell.execution_count + ']');
          var pre = el('pre', 'blk-cell-src');
          var code = el('code', 'hljs', source);
          if (window.hljs) {
            try { code.innerHTML = window.hljs.highlight(source, { language: lang, ignoreIllegals: true }).value; } catch (_) { /* plain */ }
          }
          pre.appendChild(code);
          box.append(prompt, pre);
          (cell.outputs || []).forEach(function (output) { box.appendChild(renderOutput(output)); });
        } else {
          box.appendChild(el('pre', 'blk-cell-src', source));
        }
        wrap.appendChild(box);
      });
      if (!cells.length) wrap.appendChild(emptyState('notebook', '空白 Notebook', '这个文件还没有任何单元。'));
      return true;
    });
  }

  function renderOutput(output) {
    var box = el('div', 'blk-out');
    if (output.output_type === 'stream') {
      box.appendChild(el('pre', 'blk-out-text' + (output.name === 'stderr' ? ' is-stderr' : ''), joinSource(output.text)));
      return box;
    }
    if (output.output_type === 'error') {
      box.appendChild(el('pre', 'blk-out-text is-stderr', (output.traceback || []).join('\n').replace(ANSI_RE, '')));
      return box;
    }
    var data = output.data || {};
    if (data['image/png'] || data['image/jpeg']) {
      var img = el('img', 'blk-out-img');
      img.alt = '输出图像';
      img.src = data['image/png'] ? 'data:image/png;base64,' + joinSource(data['image/png']).trim()
        : 'data:image/jpeg;base64,' + joinSource(data['image/jpeg']).trim();
      box.appendChild(img);
    } else if (data['image/svg+xml'] || data['text/html']) {
      // Rich output runs in an opaque sandbox: no access to the panel or its token.
      var frame = el('iframe', 'blk-out-frame');
      frame.setAttribute('sandbox', '');
      frame.title = '富文本输出';
      frame.srcdoc = joinSource(data['text/html'] || data['image/svg+xml']);
      box.appendChild(frame);
    } else if (data['text/plain']) {
      box.appendChild(el('pre', 'blk-out-text', joinSource(data['text/plain'])));
    }
    return box;
  }

  function emptyState(iconName, title, text) {
    var box = el('div', 'blk-empty');
    if (iconName) {
      var mark = el('span', 'blk-empty-icon');
      mark.innerHTML = icon(iconName);
      box.appendChild(mark);
    }
    box.appendChild(el('strong', '', title));
    if (text) box.appendChild(el('span', '', text));
    return box;
  }

  // --- .diff / .patch files (diff2html) -----------------------------------------

  function renderDiffFile(body, content) {
    var wrap = el('div', 'blk-difffile');
    var bar = el('div', 'blk-toolbar');
    var files = parseUnifiedDiff(content);
    var added = files.reduce(function (n, f) { return n + f.added; }, 0);
    var removed = files.reduce(function (n, f) { return n + f.removed; }, 0);
    var title = el('div', 'blk-toolbar-title');
    title.innerHTML = icon('changes');
    title.appendChild(el('strong', '', files.length + ' 个文件'));
    var stats = el('span', 'blk-diff-stats');
    stats.append(el('span', 'is-add', '+' + added), el('span', 'is-del', '−' + removed));
    title.appendChild(stats);
    var mode = 'line-by-line';
    var segmented = el('div', 'blk-segmented');
    var unified = button('逐行', function () { setMode('line-by-line'); }, { className: 'is-active' });
    var split = button('并排', function () { setMode('side-by-side'); });
    segmented.append(unified, split);
    bar.append(title, segmented);
    var view = el('div', 'blk-difffile-view');
    wrap.append(bar, view);
    body.appendChild(wrap);
    function setMode(next) {
      mode = next;
      unified.classList.toggle('is-active', mode === 'line-by-line');
      split.classList.toggle('is-active', mode === 'side-by-side');
      draw();
    }
    function draw() {
      if (!window.Diff2Html) { renderDiffInto(view, content); return; }
      view.innerHTML = window.Diff2Html.html(content, {
        drawFileList: files.length > 1, matching: 'lines', outputFormat: mode, colorScheme: isDark() ? 'dark' : 'light',
      });
    }
    return Promise.all([loadScript(CDN.diff2html), loadCss(CDN.diff2htmlCss)])
      .catch(function () { /* fall back to the built-in renderer */ })
      .then(function () { draw(); return true; });
  }

  // --- SQLite -----------------------------------------------------------------

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function toCsv(columns, rows) {
    function cell(value) {
      if (value === null || value === undefined) return '';
      if (typeof value === 'object') value = value.$blob != null ? '<BLOB ' + value.$blob + ' B>' : JSON.stringify(value);
      var text = String(value);
      return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    }
    return [columns.map(cell).join(',')].concat(rows.map(function (row) {
      return columns.map(function (c) { return cell(row[c]); }).join(',');
    })).join('\r\n') + '\r\n';
  }

  function downloadText(name, text, type) {
    var blob = new Blob(['﻿' + text], { type: type || 'text/csv;charset=utf-8' });
    var link = el('a');
    link.href = URL.createObjectURL(blob);
    link.download = name;
    document.body.appendChild(link);
    link.click();
    setTimeout(function () { URL.revokeObjectURL(link.href); link.remove(); }, 0);
  }

  function renderSqlite(body, info) {
    var api = client();
    var source = { path: info.absPath };
    var wrap = el('div', 'blk-db');
    // The preview's auto-refresh would rebuild this view after every edit.
    wrap.setAttribute('data-fp-hold-refresh', '');
    var bar = el('div', 'blk-toolbar');
    var title = el('div', 'blk-toolbar-title');
    title.innerHTML = icon('database');
    var name = el('strong', '', info.absPath.split('/').pop());
    var meta = el('span', 'blk-muted', '');
    title.append(name, meta);
    var tabs = el('div', 'blk-segmented');
    tabs.setAttribute('role', 'tablist');
    var views = {
      structure: { label: '结构', icon: 'structure' },
      browse: { label: '浏览', icon: 'table' },
      execute: { label: '执行', icon: 'code' },
    };
    Object.keys(views).forEach(function (key) {
      var tab = button(views[key].label, function () { show(key); }, { icon: views[key].icon });
      tab.setAttribute('role', 'tab');
      views[key].tab = tab;
      tabs.appendChild(tab);
    });
    bar.append(title, tabs);
    var stage = el('div', 'blk-db-stage');
    wrap.append(bar, stage);
    body.appendChild(wrap);

    var schema = null;
    var current = null; // browse state: { table, offset, order, dir }
    var lastQuery = { sql: '', write: false, result: null };
    var active = 'browse';

    function show(key) {
      active = key;
      Object.keys(views).forEach(function (k) {
        views[k].tab.classList.toggle('is-active', k === key);
        views[k].tab.setAttribute('aria-selected', String(k === key));
      });
      stage.replaceChildren();
      if (!schema) { stage.appendChild(spinnerLine('读取数据库')); return; }
      if (key === 'structure') showStructure();
      else if (key === 'browse') showBrowse();
      else showExecute();
    }

    function loadSchema() {
      return api.get('/api/sqlite/schema', source).then(function (data) {
        schema = data;
        var p = data.pragmas || {};
        // Only a non-default journal mode (WAL…) is worth a word in the title.
        var journal = String(p.journalMode || '').toLowerCase();
        meta.textContent = data.tables.length + ' 张表' + (p.pageCount && p.pageSize ? ' · ' + formatBytes(p.pageCount * p.pageSize) : '')
          + (journal && journal !== 'delete' ? ' · ' + journal.toUpperCase() : '');
        if (!current && data.tables.length) current = { table: data.tables[0], offset: 0, order: null, dir: 'asc' };
        if (current) {
          var fresh = data.tables.find(function (t) { return t.name === current.table.name; });
          if (fresh) current.table = fresh;
        }
        show(data.tables.length ? active : 'execute');
      }).catch(function (err) {
        stage.replaceChildren(errorBox(err));
      });
    }

    function showStructure() {
      var box = el('div', 'blk-db-structure');
      if (!schema.tables.length) box.appendChild(emptyState('database', '空数据库', '这个文件里还没有表。去“执行”页用 CREATE TABLE 建一张。'));
      schema.tables.forEach(function (table) {
        var card = el('section', 'blk-db-card');
        var head = el('header', 'blk-db-card-head');
        head.innerHTML = icon(table.type === 'view' ? 'search' : 'table');
        head.appendChild(el('strong', '', table.name));
        head.appendChild(el('span', 'blk-pill', table.type === 'view' ? '视图' : (table.rows == null ? '—' : table.rows + ' 行')));
        var browse = button('浏览', function () {
          current = { table: table, offset: 0, order: null, dir: 'asc' };
          show('browse');
        }, { className: 'blk-btn-ghost blk-btn-small' });
        head.appendChild(browse);
        card.appendChild(head);
        var cols = el('div', 'blk-db-cols');
        table.columns.forEach(function (col) {
          var row = el('div', 'blk-db-col');
          row.appendChild(el('span', 'blk-db-col-name', col.name));
          row.appendChild(el('span', 'blk-db-col-type', col.type || 'ANY'));
          if (col.pk) row.appendChild(el('span', 'blk-tag is-key', 'PK'));
          if (col.notnull) row.appendChild(el('span', 'blk-tag', 'NOT NULL'));
          cols.appendChild(row);
        });
        card.appendChild(cols);
        if (table.sql) card.appendChild(sqlBlock(table.sql));
        (table.indexes || []).forEach(function (index) {
          if (index.sql) card.appendChild(sqlBlock(index.sql));
        });
        box.appendChild(card);
      });
      var p = schema.pragmas || {};
      var pragmas = el('section', 'blk-db-card');
      var ph = el('header', 'blk-db-card-head');
      ph.innerHTML = icon('structure');
      ph.appendChild(el('strong', '', 'Pragmas'));
      pragmas.appendChild(ph);
      var list = el('div', 'blk-db-cols');
      [['journal_mode', p.journalMode], ['encoding', p.encoding], ['page_size', p.pageSize], ['page_count', p.pageCount],
        ['user_version', p.userVersion], ['foreign_keys', p.foreignKeys ? 'ON' : 'OFF']].forEach(function (pair) {
        var row = el('div', 'blk-db-col');
        row.append(el('span', 'blk-db-col-name', pair[0]), el('span', 'blk-db-col-type', String(pair[1])));
        list.appendChild(row);
      });
      pragmas.appendChild(list);
      box.appendChild(pragmas);
      stage.appendChild(box);
      highlightSql(box);
    }

    function sqlBlock(sql) {
      var pre = el('pre', 'blk-sql-block');
      pre.appendChild(el('code', 'language-sql', sql));
      return pre;
    }

    function highlightSql(root) {
      loadScript(CDN.hljs).then(function () {
        root.querySelectorAll('code.language-sql').forEach(function (code) {
          try { code.innerHTML = window.hljs.highlight(code.textContent, { language: 'sql', ignoreIllegals: true }).value; } catch (_) { /* plain */ }
        });
      }).catch(function () {});
    }

    function showBrowse() {
      var layoutBox = el('div', 'blk-db-browse');
      var side = el('nav', 'blk-db-side');
      side.setAttribute('aria-label', '表');
      schema.tables.forEach(function (table) {
        var row = el('button', 'blk-list-row' + (current && current.table.name === table.name ? ' is-active' : ''));
        row.type = 'button';
        row.innerHTML = icon(table.type === 'view' ? 'search' : 'table');
        row.appendChild(el('span', 'blk-list-name', table.name));
        row.appendChild(el('span', 'blk-list-count', table.rows == null ? '' : String(table.rows)));
        row.addEventListener('click', function () {
          current = { table: table, offset: 0, order: null, dir: 'asc' };
          showBrowse();
        });
        side.appendChild(row);
      });
      var main = el('div', 'blk-db-main');
      layoutBox.append(side, main);
      stage.replaceChildren(layoutBox);
      if (!current) { main.appendChild(emptyState('table', '没有可浏览的表', '')); return; }
      main.appendChild(spinnerLine('读取 ' + current.table.name));
      api.get('/api/sqlite/rows', Object.assign({
        table: current.table.name, offset: current.offset, limit: 100, order: current.order, dir: current.dir,
      }, source)).then(function (data) {
        main.replaceChildren();
        var tools = el('div', 'blk-toolbar blk-toolbar-sub');
        var end = Math.min(data.offset + data.rows.length, data.total);
        var label = el('div', 'blk-toolbar-title');
        label.appendChild(el('strong', '', current.table.name));
        label.appendChild(el('span', 'blk-muted', (data.total ? (data.offset + 1) + '–' + end : '0') + ' / ' + data.total + ' 行'));
        var pager = el('div', 'blk-row');
        var prev = iconButton('chevronLeft', '上一页', function () { current.offset = Math.max(0, current.offset - data.limit); showBrowse(); });
        prev.disabled = data.offset === 0;
        var next = iconButton('chevronRight', '下一页', function () { current.offset += data.limit; showBrowse(); });
        next.disabled = end >= data.total;
        pager.append(prev, next);
        if (current.table.type === 'table') {
          pager.appendChild(button('新记录', function () {
            api.send('POST', '/api/sqlite/row', Object.assign({ table: current.table.name }, source))
              .then(function () {
                current.offset = Math.max(0, Math.floor(data.total / data.limit) * data.limit);
                return loadSchema();
              })
              .catch(function (err) { toast(errorText(err), { error: true }); });
          }, { icon: 'plus', className: 'blk-btn-small' }));
        }
        tools.append(label, pager);
        main.appendChild(tools);
        var scroller = el('div', 'blk-grid-wrap');
        scroller.appendChild(grid(data.columns, data.rows, data.editable, true));
        main.appendChild(scroller);
        if (!data.rows.length) main.appendChild(emptyState(null, '这张表是空的', data.editable ? '点“新记录”添加一行，双击单元格编辑。' : ''));
      }).catch(function (err) { main.replaceChildren(errorBox(err)); });
    }

    function grid(columns, rows, editable, sortable) {
      var table = el('table', 'blk-grid');
      var thead = el('thead');
      var hr = el('tr');
      columns.forEach(function (colName) {
        var th = el('th', '', colName);
        if (sortable && current) {
          th.classList.add('is-sortable');
          th.tabIndex = 0;
          if (current.order === colName) {
            th.classList.add('is-sorted');
            th.setAttribute('aria-sort', current.dir === 'asc' ? 'ascending' : 'descending');
            th.appendChild(el('span', 'blk-sort', current.dir === 'asc' ? '▲' : '▼'));
          }
          var sort = function () {
            current.dir = current.order === colName && current.dir === 'asc' ? 'desc' : 'asc';
            current.order = colName;
            current.offset = 0;
            showBrowse();
          };
          th.addEventListener('click', sort);
          th.addEventListener('keydown', function (e) { if (e.key === 'Enter') sort(); });
        }
        hr.appendChild(th);
      });
      if (editable) hr.appendChild(el('th', 'blk-grid-tools', ''));
      thead.appendChild(hr);
      var tbody = el('tbody');
      rows.forEach(function (row) {
        var tr = el('tr');
        columns.forEach(function (colName) {
          var td = el('td');
          setCell(td, row[colName]);
          if (editable) {
            td.title = '双击编辑';
            td.addEventListener('dblclick', function () { editCell(td, row, colName); });
          }
          tr.appendChild(td);
        });
        if (editable) {
          var tools = el('td', 'blk-grid-tools');
          tools.appendChild(iconButton('trash', '删除这一行', function () {
            confirmAction({ title: '删除这一行？', message: '会立即写入数据库，无法撤销。', confirmLabel: '删除', danger: true }).then(function (ok) {
              if (!ok) return;
              api.send('DELETE', '/api/sqlite/row', Object.assign({ table: current.table.name, rowid: row.__rowid__ }, source))
                .then(loadSchema).catch(function (err) { toast(errorText(err), { error: true }); });
            });
          }, 'blk-btn-danger'));
          tr.appendChild(tools);
        }
        tbody.appendChild(tr);
      });
      table.append(thead, tbody);
      return table;
    }

    function setCell(td, value) {
      td.classList.toggle('is-null', value === null);
      td.classList.toggle('is-num', typeof value === 'number');
      if (value === null) td.textContent = 'NULL';
      else if (value && typeof value === 'object' && value.$blob != null) td.textContent = 'BLOB · ' + formatBytes(value.$blob);
      else td.textContent = String(value);
    }

    function editCell(td, row, colName) {
      if (td.querySelector('input')) return;
      var original = row[colName];
      if (original && typeof original === 'object') { toast('BLOB 不能在这里编辑', { error: true }); return; }
      var input = el('input', 'blk-input blk-cell-input');
      input.value = original === null ? '' : String(original);
      input.placeholder = 'NULL';
      td.replaceChildren(input);
      input.focus();
      input.select();
      var done = false;
      function finish(save) {
        if (done) return;
        done = true;
        if (!save || input.value === (original === null ? '' : String(original))) { setCell(td, original); return; }
        var value = input.value === '' && original === null ? null
          : (typeof original === 'number' && input.value.trim() !== '' && !isNaN(Number(input.value)) ? Number(input.value) : input.value);
        api.send('PATCH', '/api/sqlite/cell', Object.assign({ table: current.table.name, rowid: row.__rowid__, column: colName, value: value }, source))
          .then(function () {
            row[colName] = value;
            setCell(td, value);
            td.classList.add('is-saved');
            setTimeout(function () { td.classList.remove('is-saved'); }, 1200);
          })
          .catch(function (err) { setCell(td, original); toast(errorText(err), { error: true }); });
      }
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
      });
      input.addEventListener('blur', function () { finish(true); });
    }

    function showExecute() {
      var box = el('div', 'blk-db-exec');
      var area = el('textarea', 'blk-input blk-sql');
      area.value = lastQuery.sql || (current ? 'SELECT * FROM "' + current.table.name.replace(/"/g, '""') + '" LIMIT 100;' : '');
      area.spellcheck = false;
      area.setAttribute('aria-label', 'SQL');
      var tools = el('div', 'blk-toolbar blk-toolbar-sub');
      var run = button('执行', runQuery, { icon: 'play', className: 'blk-btn-primary blk-btn-small', kbd: 'Mod+Enter' });
      var writeLabel = el('label', 'blk-switch');
      var write = el('input');
      write.type = 'checkbox';
      write.checked = lastQuery.write;
      writeLabel.append(write, el('span', 'blk-switch-track'), el('span', '', '允许修改数据'));
      var save = button('保存结果', function () {
        var r = lastQuery.result;
        if (!r || !r.columns.length) return;
        downloadText((current ? current.table.name : 'query') + '.csv', toCsv(r.columns, r.rows));
      }, { icon: 'download', className: 'blk-btn-ghost blk-btn-small' });
      save.disabled = !(lastQuery.result && lastQuery.result.columns.length);
      var left = el('div', 'blk-row');
      left.append(run, writeLabel);
      tools.append(left, save);
      var out = el('div', 'blk-db-result');
      box.append(area, tools, out);
      stage.replaceChildren(box);
      renderResult(lastQuery.result, lastQuery.error);
      area.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runQuery(); }
      });
      area.focus();

      function renderResult(result, error) {
        out.replaceChildren();
        if (error) { out.appendChild(errorBox(error, /readonly|read-only/i.test(error.message || '') ? '这是只读执行。勾选“允许修改数据”后再运行。' : null)); return; }
        if (!result) {
          out.appendChild(emptyState('code', '还没有结果', '返回行的语句会在这里显示结果。'));
          return;
        }
        var status = el('div', 'blk-db-status');
        status.innerHTML = icon('check');
        status.appendChild(el('span', '', result.columns.length
          ? '返回 ' + result.rows.length + (result.truncated ? '+（只显示前 1000 行）' : '') + ' 行'
          : '执行完成，没有错误 · 影响 ' + (result.changes || 0) + ' 行'));
        if (result.ms != null) status.appendChild(el('span', 'blk-muted', result.ms < 1 ? '<1 ms' : result.ms.toFixed(1) + ' ms'));
        out.appendChild(status);
        if (result.columns.length) {
          var scroller = el('div', 'blk-grid-wrap');
          scroller.appendChild(grid(result.columns, result.rows, false, false));
          out.appendChild(scroller);
        }
      }

      function runQuery() {
        if (!area.value.trim()) { area.focus(); return; }
        lastQuery.sql = area.value;
        lastQuery.write = write.checked;
        var done = busy(run, '执行中');
        api.send('POST', '/api/sqlite/query', Object.assign({ sql: area.value, write: write.checked }, source)).then(function (data) {
          lastQuery.result = data;
          lastQuery.error = null;
          save.disabled = !data.columns.length;
          renderResult(data);
          if (!data.columns.length) loadSchema().then(function () { show('execute'); });
        }).catch(function (err) {
          lastQuery.result = null;
          lastQuery.error = err;
          save.disabled = true;
          renderResult(null, err);
        }).finally(done);
      }
    }

    show('browse');
    return loadSchema().then(function () { return true; });
  }

  function errorBox(err, hint) {
    var box = el('div', 'blk-error');
    box.setAttribute('role', 'alert');
    box.appendChild(el('strong', '', '出错了'));
    box.appendChild(el('pre', '', errorText(err)));
    if (hint) box.appendChild(el('span', 'blk-muted', hint));
    return box;
  }

  // --- editor ------------------------------------------------------------------

  function openEditor(body, file, refresh) {
    if (!body || !file || file.rawContent == null) { toast('这个文件不能在这里编辑', { error: true }); return; }
    var markdown = !!file.isMarkdown;
    var wrap = el('div', 'blk-editor');
    wrap.setAttribute('data-fp-hold-refresh', '');
    var bar = el('div', 'blk-toolbar');
    var title = el('div', 'blk-toolbar-title');
    title.innerHTML = icon('edit');
    title.appendChild(el('strong', '', file.filename || file.absPath.split('/').pop()));
    var status = el('span', 'blk-muted', markdown ? '文档模式' : '纯文本');
    title.appendChild(status);
    var host = el('div', 'blk-editor-host');
    var getValue = function () { return file.rawContent; };
    var dirty = false;
    var expected = { mtimeMs: file.mtimeMs, size: file.size };

    function markDirty() {
      if (dirty) return;
      dirty = true;
      status.textContent = '● 未保存';
      status.classList.add('is-dirty');
    }
    function save() {
      var content = getValue();
      var done = busy(saveBtn, '保存中');
      client().send('PUT', '/api/files/content', {
        path: file.absPath, content: content, expectedMtimeMs: expected.mtimeMs, expectedSize: expected.size,
      }).then(function (data) {
        expected = { mtimeMs: data.mtimeMs, size: data.size };
        dirty = false;
        done();
        toast('已保存 ' + (file.filename || ''));
        refresh();
      }).catch(function (err) {
        done();
        status.textContent = err.message === 'file_changed_on_disk' ? '磁盘上的文件已变化，未保存（复制你的改动后刷新）' : '保存失败：' + errorText(err);
        status.classList.add('is-error');
      });
    }
    function cancel() {
      if (!dirty) { refresh(); return; }
      confirmAction({ title: '放弃未保存的修改？', confirmLabel: '放弃', danger: true }).then(function (ok) { if (ok) refresh(); });
    }
    var saveBtn = button('保存', save, { className: 'blk-btn-primary blk-btn-small', kbd: 'Mod+S' });
    var actions = el('div', 'blk-row');
    actions.append(button('取消', cancel, { className: 'blk-btn-ghost blk-btn-small' }), saveBtn);
    bar.append(title, actions);
    wrap.append(bar, host);
    body.replaceChildren(wrap);
    wrap.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); save(); }
      if (e.key === 'Escape' && !markdown) { e.preventDefault(); e.stopPropagation(); cancel(); }
    });

    function plain() {
      var area = el('textarea', 'blk-input blk-editor-text');
      area.value = file.rawContent;
      area.spellcheck = false;
      area.setAttribute('aria-label', '编辑 ' + (file.filename || ''));
      area.addEventListener('input', markDirty);
      area.addEventListener('keydown', function (e) {
        if (e.key === 'Tab' && !e.shiftKey) {
          e.preventDefault();
          area.setRangeText('  ', area.selectionStart, area.selectionEnd, 'end');
          markDirty();
        }
      });
      host.replaceChildren(area);
      getValue = function () { return area.value; };
      area.focus();
    }

    if (!markdown) { plain(); return; }
    host.appendChild(spinnerLine('加载文档编辑器'));
    var loads = [loadScript(CDN.toastEditor), loadCss(CDN.toastEditorCss)];
    if (isDark()) loads.push(loadCss(CDN.toastEditorDarkCss));
    Promise.all(loads).then(function () {
      host.replaceChildren();
      var editor = new window.toastui.Editor({
        el: host,
        height: '100%',
        initialEditType: 'wysiwyg',
        previewStyle: 'vertical',
        initialValue: file.rawContent,
        usageStatistics: false,
        theme: isDark() ? 'dark' : 'light',
        events: { change: markDirty },
      });
      getValue = function () { return editor.getMarkdown(); };
      editor.focus();
    }).catch(function () {
      toast('文档编辑器加载失败，改用纯文本编辑', { error: true });
      plain();
    });
  }

  // --- board (TODO.md as kanban) -------------------------------------------------

  var LIST_ITEM_RE = /^([-*+]|\d+[.)])\s+/;
  var TASK_RE = /^([-*+]|\d+[.)])\s+\[([ xX])\]\s?/;
  var DONE_TITLE_RE = /^(done|完成|已完成|finished|closed)$/i;
  var CHECKED_RE = /^\S+\s+\[[xX]\]/;

  /** Columns from `##` sections (or todo/done when there are none); cards are top-level list items. */
  function parseBoard(text) {
    var lines = String(text).replace(/\r\n/g, '\n').split('\n');
    var preamble = { lines: [], prose: [], cards: [] }; // everything before the first `##`
    var columns = [];
    var col = null, card = null;
    lines.forEach(function (line) {
      if (/^##\s+/.test(line)) {
        col = { heading: line, title: line.replace(/^##\s+/, '').trim(), notes: [], cards: [] };
        columns.push(col);
        card = null;
        return;
      }
      if (!col) preamble.lines.push(line);
      if (LIST_ITEM_RE.test(line)) {
        card = { lines: [line] };
        (col ? col.cards : preamble.cards).push(card);
        return;
      }
      // Indented lines belong to the card above (sub-items, notes).
      if (card && /^\s+\S/.test(line)) { card.lines.push(line); return; }
      card = null;
      if (col) col.notes.push(line); else preamble.prose.push(line);
    });
    if (!columns.length) {
      // No sections: split the list by checkbox state.
      var todo = { title: '待办', heading: null, notes: [], cards: [] };
      var done = { title: '完成', heading: null, notes: [], cards: [] };
      preamble.cards.forEach(function (c) { (CHECKED_RE.test(c.lines[0]) ? done : todo).cards.push(c); });
      return { preamble: preamble, columns: [todo, done], statusMode: true };
    }
    return { preamble: preamble, columns: columns, statusMode: false };
  }

  function trimBlankEnd(lines) {
    var out = lines.slice();
    while (out.length && out[out.length - 1].trim() === '') out.pop();
    return out;
  }

  function serializeBoard(board) {
    if (board.statusMode) {
      var cards = [];
      board.columns.forEach(function (c) { c.cards.forEach(function (card) { cards.push(card); }); });
      // Keep the prose and write the list after it.
      var head = trimBlankEnd(board.preamble.prose);
      var body = cards.map(function (c) { return c.lines.join('\n'); }).join('\n');
      return (head.length ? head.join('\n') + '\n\n' : '') + body + '\n';
    }
    // Text before the first column is not on the board: keep it verbatim.
    var out = trimBlankEnd(board.preamble.lines);
    var parts = out.length ? [out.join('\n')] : [];
    board.columns.forEach(function (col) {
      var section = [col.heading];
      var notes = trimBlankEnd(col.notes);
      while (notes.length && notes[0].trim() === '') notes.shift();
      if (notes.length) section.push('', notes.join('\n'));
      if (col.cards.length) section.push('', col.cards.map(function (c) { return c.lines.join('\n'); }).join('\n'));
      parts.push(section.join('\n'));
    });
    return parts.join('\n\n') + '\n';
  }

  function setCardDone(card, done) {
    var first = card.lines[0];
    if (TASK_RE.test(first)) card.lines[0] = first.replace(/^(\S+\s+)\[[ xX]\]/, '$1[' + (done ? 'x' : ' ') + ']');
  }

  function cardText(card) {
    return card.lines[0].replace(TASK_RE, '').replace(LIST_ITEM_RE, '');
  }

  function setCardText(card, text) {
    var marker = TASK_RE.exec(card.lines[0]);
    card.lines[0] = marker ? marker[0].replace(/\s?$/, ' ') + text : card.lines[0].replace(/^(\S+\s+).*$/, '$1') + text;
  }

  function isDoneColumn(board, col) {
    return board.statusMode ? col === board.columns[1] : DONE_TITLE_RE.test(col.title);
  }

  function renderBoard(body, file, refresh) {
    if (!file || file.rawContent == null) return;
    var board = parseBoard(file.rawContent);
    var expected = { mtimeMs: file.mtimeMs, size: file.size };
    var wrap = el('div', 'blk-board');
    wrap.setAttribute('data-fp-hold-refresh', '');
    var bar = el('div', 'blk-toolbar');
    var title = el('div', 'blk-toolbar-title');
    title.innerHTML = icon('board');
    title.appendChild(el('strong', '', file.filename || 'TODO.md'));
    var status = el('span', 'blk-muted', '');
    title.appendChild(status);
    var actions = el('div', 'blk-row');
    if (!board.statusMode) {
      actions.appendChild(button('添加列', function () {
        promptText({ title: '添加列', placeholder: '例如：进行中', confirmLabel: '添加', validate: function (v) { return v.trim() ? '' : '请输入列名'; } })
          .then(function (name) {
            if (!name) return;
            board.columns.push({ heading: '## ' + name.trim(), title: name.trim(), notes: [], cards: [] });
            draw();
            save();
          });
      }, { icon: 'plus', className: 'blk-btn-ghost blk-btn-small' }));
    }
    actions.appendChild(button('文档', function () { refresh(); }, { icon: 'file', className: 'blk-btn-ghost blk-btn-small', title: '返回文档视图' }));
    bar.append(title, actions);
    var lanes = el('div', 'blk-lanes');
    wrap.append(bar, lanes);
    body.replaceChildren(wrap);
    updateStatus();

    function updateStatus(text) {
      var total = 0, done = 0;
      board.columns.forEach(function (col) {
        total += col.cards.length;
        col.cards.forEach(function (card) { if (CHECKED_RE.test(card.lines[0])) done++; });
      });
      status.textContent = text || (total + ' 张卡片' + (done ? ' · 已完成 ' + done : ''));
      status.classList.toggle('is-error', false);
    }

    function save() {
      var content = serializeBoard(board);
      status.textContent = '保存中…';
      return client().send('PUT', '/api/files/content', {
        path: file.absPath, content: content, expectedMtimeMs: expected.mtimeMs, expectedSize: expected.size,
      }).then(function (data) {
        expected = { mtimeMs: data.mtimeMs, size: data.size };
        file.rawContent = content;
        file.mtimeMs = data.mtimeMs;
        file.size = data.size;
        updateStatus();
      }).catch(function (err) {
        status.textContent = err.message === 'file_changed_on_disk' ? '文件已被其它程序修改，点“文档”重新打开' : '保存失败：' + errorText(err);
        status.classList.add('is-error');
      });
    }

    function removeCard(col, card) {
      var index = col.cards.indexOf(card);
      if (index === -1) return;
      col.cards.splice(index, 1);
      draw();
      save();
      toast('已删除卡片', { action: { label: '撤销', run: function () {
        col.cards.splice(index, 0, card);
        draw();
        save();
      } } });
    }

    function cardNode(col, card) {
      var item = el('article', 'blk-card');
      item.tabIndex = 0;
      item.classList.toggle('is-done', CHECKED_RE.test(card.lines[0]));
      var text = el('div', 'blk-card-title', cardText(card));
      item.appendChild(text);
      if (card.lines.length > 1) {
        item.appendChild(el('div', 'blk-card-notes', card.lines.slice(1).map(function (l) { return l.trim().replace(/^[-*+]\s+/, '· '); }).join('\n')));
      }
      var tools = el('div', 'blk-card-tools');
      tools.appendChild(iconButton('edit', '编辑', function () { editCard(); }));
      tools.appendChild(iconButton('trash', '删除', function () { removeCard(col, card); }, 'blk-btn-danger'));
      item.appendChild(tools);
      item._card = card;
      function editCard() {
        var input = el('textarea', 'blk-input blk-card-input');
        input.value = cardText(card);
        input.rows = 2;
        item.replaceChildren(input);
        input.focus();
        input.select();
        var finished = false;
        function finish(commit) {
          if (finished) return;
          finished = true;
          var value = input.value.replace(/\s+/g, ' ').trim();
          if (commit && value && value !== cardText(card)) {
            setCardText(card, value);
            save();
          }
          draw();
        }
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); finish(true); }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
        });
        input.addEventListener('blur', function () { finish(true); });
      }
      text.addEventListener('dblclick', editCard);
      item.addEventListener('keydown', function (e) {
        if (e.target !== item) return;
        if (e.key === 'Enter') { e.preventDefault(); editCard(); }
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeCard(col, card); }
      });
      return item;
    }

    function addComposer(lane, col) {
      var add = button('添加卡片', function () {
        var input = el('textarea', 'blk-input blk-card-input');
        input.rows = 2;
        input.placeholder = '写点什么… Enter 添加，Esc 取消';
        add.replaceWith(input);
        input.focus();
        var finished = false;
        function finish(commit) {
          if (finished) return;
          finished = true;
          var value = input.value.replace(/\s+/g, ' ').trim();
          if (commit && value) {
            col.cards.push({ lines: ['- [' + (isDoneColumn(board, col) ? 'x' : ' ') + '] ' + value] });
            save();
            draw();
            // Keep composing in the same column, like a list editor.
            var again = lanes.querySelector('[data-col="' + board.columns.indexOf(col) + '"] .blk-lane-add');
            if (again) again.click();
            return;
          }
          draw();
        }
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); finish(true); }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
        });
        input.addEventListener('blur', function () { finish(!!input.value.trim()); });
      }, { icon: 'plus', className: 'blk-btn-ghost blk-lane-add' });
      lane.appendChild(add);
    }

    function draw() {
      lanes.replaceChildren();
      board.columns.forEach(function (col, colIndex) {
        var lane = el('section', 'blk-lane');
        lane.dataset.col = String(colIndex);
        var head = el('header', 'blk-lane-head');
        var dot = el('span', 'blk-lane-dot' + (isDoneColumn(board, col) ? ' is-done' : colIndex === 0 ? ' is-todo' : ' is-doing'));
        head.append(dot, el('strong', '', col.title), el('span', 'blk-pill', String(col.cards.length)));
        var list = el('div', 'blk-cards');
        list.dataset.col = String(colIndex);
        col.cards.forEach(function (card) { list.appendChild(cardNode(col, card)); });
        if (!col.cards.length) list.appendChild(el('div', 'blk-lane-empty', '拖到这里'));
        lane.append(head, list);
        addComposer(lane, col);
        lanes.appendChild(lane);
      });
      loadScript(CDN.sortable).then(function () {
        lanes.querySelectorAll('.blk-cards').forEach(function (list) {
          window.Sortable.create(list, {
            group: 'blk-board', animation: 160, ghostClass: 'is-ghost', chosenClass: 'is-chosen', dragClass: 'is-dragging',
            filter: '.blk-lane-empty, .blk-card-tools, textarea', preventOnFilter: false,
            onEnd: function () {
              lanes.querySelectorAll('.blk-cards').forEach(function (l) {
                var col = board.columns[Number(l.dataset.col)];
                col.cards = Array.prototype.map.call(l.children, function (n) { return n._card; }).filter(Boolean);
                var doneLane = isDoneColumn(board, col);
                var hasDoneLane = board.statusMode || board.columns.some(function (c) { return DONE_TITLE_RE.test(c.title); });
                col.cards.forEach(function (card) { if (hasDoneLane) setCardDone(card, doneLane); });
              });
              draw();
              save();
            },
          });
        });
      }).catch(function () { updateStatus('拖拽组件加载失败，看板只能编辑不能拖动'); });
    }
    draw();
  }

  function isBoardFile(path) {
    return /(^|\/)(todo|TODO|Todo|kanban|KANBAN|board)\.md$/.test(path || '');
  }

  // --- git gutter in the code preview ---------------------------------------------

  function decorateGitGutter(body, absPath) {
    client().get('/api/git/line-changes', { path: absPath }).then(function (data) {
      var gutter = body.querySelector('.fp-line-numbers');
      if (!gutter) return;
      var count = gutter.textContent.split('\n').length;
      var marks = new Array(count + 1);
      if (!data.tracked && data.untracked) {
        for (var n = 1; n <= count; n++) marks[n] = 'added';
      }
      (data.changes || []).forEach(function (change) {
        for (var line = change.start; line <= Math.min(change.end, count); line++) marks[line] = change.type;
      });
      if (!marks.some(Boolean)) return;
      var html = [];
      for (var i = 1; i <= count; i++) {
        html.push(marks[i] ? '<span class="fp-git-' + marks[i] + '">' + i + '</span>' : String(i));
      }
      gutter.innerHTML = html.join('\n');
      gutter.classList.add('fp-has-git');
    }).catch(function () { /* not a repository: plain gutter */ });
  }

  // --- file preview integration ------------------------------------------------------

  // TODO.md opens straight into the board. "文档" switches that file to the
  // plain rendering for the rest of the page's life; the menu brings the board back.
  var _boardOff = {};

  function renderBoardFile(body, content, info) {
    var file = { absPath: info.absPath, filename: info.absPath.split('/').pop(), rawContent: content,
      mtimeMs: info.mtimeMs, size: info.size, isMarkdown: true };
    renderBoard(body, file, function () {
      _boardOff[info.absPath] = true;
      if (window.FilePreview) FilePreview.openFile(info.absPath, currentContext().paneId);
    });
    return true;
  }

  function rendererFor(path) {
    if (/\.ipynb$/i.test(path)) return renderNotebook;
    if (/\.(diff|patch)$/i.test(path)) return function (body, content) { return renderDiffFile(body, content); };
    if (isBoardFile(path) && !_boardOff[path]) return renderBoardFile;
    return null;
  }

  function previewActions(file, ctx) {
    var items = [];
    var svgPaths = function (name) { return ICONS[name]; };
    if (!file.isDirectory && file.isText && file.rawContent != null) {
      items.push({ label: '编辑', hint: file.isMarkdown ? '所见即所得的文档编辑' : '直接修改并保存（' + keysText('Mod+S') + '）', icon: svgPaths('edit'),
        run: function () { openEditor(ctx.body, file, ctx.refresh); } });
    }
    if (!file.isDirectory && file.isMarkdown && file.rawContent != null) {
      items.push({ label: '看板视图', hint: '## 标题作列、列表项作卡片', icon: svgPaths('board'),
        run: function () { renderBoard(ctx.body, file, ctx.refresh); } });
    }
    if (window.BlockHost) {
      items.push({ label: 'Git', hint: '查看所在仓库的改动与历史', icon: svgPaths('git'),
        run: function () { window.BlockHost.open('git', { path: file.isDirectory ? file.absPath : file.absPath.replace(/\/[^/]+$/, '') || '/', paneId: ctx.paneId }); } });
    }
    return items;
  }

  return {
    // file preview hooks
    rendererFor: rendererFor,
    renderSqlite: renderSqlite,
    decorateGitGutter: decorateGitGutter,
    previewActions: previewActions,
    // shared kit for blocks-workspace.js and the palette
    icon: icon,
    ui: {
      CDN: CDN, loadScript: loadScript, loadCss: loadCss, esc: esc, el: el, button: button, iconButton: iconButton,
      kbd: kbd, keysText: keysText, keyParts: keyParts, isMac: IS_MAC, busy: busy, spinnerLine: spinnerLine,
      toast: toast, errorText: errorText, errorBox: errorBox, confirmAction: confirmAction, promptText: promptText,
      emptyState: emptyState, isDark: isDark, client: client, currentContext: currentContext,
      renderDiffInto: renderDiffInto, buildPatch: buildPatch, parseUnifiedDiff: parseUnifiedDiff, downloadText: downloadText,
    },
    _test: {
      parseUnifiedDiff: parseUnifiedDiff,
      buildPatch: buildPatch,
      parseBoard: parseBoard,
      serializeBoard: serializeBoard,
      setCardText: setCardText,
      wordSpan: wordSpan,
      pairChanges: pairChanges,
      toCsv: toCsv,
      keyParts: keyParts,
    },
  };
})();

if (typeof window !== 'undefined') window.Blocks = Blocks;
