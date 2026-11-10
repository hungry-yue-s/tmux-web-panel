/* global Api, Store, state, FilePreview */

// The block kit: the shared UI of the tools beside the shell (icons, keys,
// spinners, dialogs, toasts, request merging, unified diffs), used by the
// blocks, the file preview's renderers, the workspace pickers and the palette.
// The renderers and actions of the file preview are registered here by the
// plugins that own them (Blocks.registerRenderer, Blocks.registerPreviewActions):
// notebooks, SQLite, the TODO.md board, the Git gutter.

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
    document: '<path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z"/><path d="M14 3v5h5"/><path d="M8.5 13h7M8.5 16.5h5"/>',
    markdown: '<rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M6 15V9l2.5 3L11 9v6"/><path d="M16 9v6m-2-2 2 2 2-2"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m21 16-5-5L5 20"/>',
    video: '<rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3"/>',
    archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9"/><path d="M10 13h4"/>',
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

  // Reads in flight, by address: the same read asked for again joins the one under
  // way. A write that finishes on a server starts a new generation there, so a read
  // asked for after it never gets an answer from before it. Joined callers share the
  // result and must not change it.
  var _readsInFlight = {};
  var _writeGeneration = {};

  /** Requests to one server's node; `serverId` defaults to the server in view. */
  function client(serverId) {
    function server() {
      return serverId || Api.activeServerId();
    }
    function url(path) {
      return Api.nodeUrl(server(), path);
    }
    function qs(params) {
      return Object.keys(params || {}).filter(function (k) { return params[k] != null && params[k] !== ''; })
        .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
    }
    return {
      url: url,
      get: function (path, params) {
        var q = qs(params);
        var address = url(path) + (q ? '?' + q : '');
        var key = (_writeGeneration[server()] || 0) + ' ' + address;
        if (_readsInFlight[key]) return _readsInFlight[key];
        var read = Api.get(address);
        _readsInFlight[key] = read;
        var forget = function () { if (_readsInFlight[key] === read) delete _readsInFlight[key]; };
        read.then(forget, forget);
        return read;
      },
      send: function (method, path, body) {
        var sid = server();
        var sent = Api.request(method, url(path), body);
        // Before the caller hears of it, so the read it asks for next is a new one.
        var done = function () { _writeGeneration[sid] = (_writeGeneration[sid] || 0) + 1; };
        sent.then(done, done);
        return sent;
      },
    };
  }

  /** The pane in view: its cwd anchors quick-open and new files. Git follows focus instead. */
  function currentContext() {
    var view = terminalView();
    if (view) return view.currentContext();
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

  /**
   * The pane selected in the terminal in view. The route only says which pane it
   * opened with, and pane pills leave it behind. Until the terminal has caught up
   * with a new route there is no answer: all it knows is about the window being left.
   * `key` changes whenever an answer found for this one no longer applies.
   */
  function selectedContext() {
    var view = terminalView();
    if (view) return view.currentContext();
    var snapshot = typeof Store !== 'undefined' && Store.getState ? Store.getState() : null;
    var route = (snapshot && snapshot.route) || {};
    var params = route.params || {};
    var target = window.TerminalTarget;
    var legacy = typeof state !== 'undefined' ? state : {};
    var settled = !!target && !!target.windowId
      && (!params.serverId || params.serverId === target.serverId)
      && (!params.sessionId || params.sessionId === target.sessionId)
      && (!params.windowId || params.windowId === target.windowId);
    var paneId = settled ? legacy.currentPane || null : null;
    var serverId = Api.activeServerId();
    var followsTmux = typeof _focusFollowsTmux === 'function' && _focusFollowsTmux();
    return {
      serverId: serverId,
      paneId: paneId,
      onTerminal: route.name === 'terminal',
      key: [route.name, serverId, params.serverId, params.sessionId, params.windowId, paneId, followsTmux].join('\u0000'),
    };
  }

  /**
   * The same, for what has to follow where the user is working: in a native split tmux
   * moves focus with neither the route nor state.currentPane knowing. Rejects when tmux
   * cannot say, as the pane the terminal attached with would be the wrong answer.
   */
  function focusedContext() {
    var view = terminalView();
    if (view) return Promise.resolve().then(function () { return view.focusedContext(); });
    var ctx = selectedContext();
    if (!ctx.paneId || typeof _resolveFocusedPaneId !== 'function') return Promise.resolve(ctx);
    return _resolveFocusedPaneId().then(function (paneId) {
      return Object.assign({}, ctx, { paneId: paneId });
    });
  }

  // --- unified diffs -----------------------------------------------------------
  function terminalView() {
    var route = typeof Store !== 'undefined' && Store.getState ? Store.getState().route : null;
    return window.PanelSlots?.terminalViews && route ? window.PanelSlots.terminalViews.get(route.name) : null;
  }

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

  // Lines drawn at once. A diff of tens of thousands of lines would hold the page for
  // seconds; the rest is drawn when asked for, from where it stopped.
  var DIFF_RENDER_LINES = 1000;

  /**
   * Renders a unified diff. `options.actions(file, hunk, selection)` returns
   * buttons for each hunk header and makes changed lines selectable.
   * `options.maxLines` is how many lines are drawn at first and per "show more".
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
    var budget = options.maxLines || DIFF_RENDER_LINES;
    var total = files.reduce(function (n, f) {
      return n + f.hunks.reduce(function (m, h) { return m + h.lines.length; }, 0);
    }, 0);
    var drawn = 0;

    function openFile(file) {
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
      fileBox.appendChild(el('div', 'blk-diff-filebody'));
      container.appendChild(fileBox);
      return fileBox;
    }

    function openHunk(fileBox, file, hunk) {
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
      box.appendChild(rows);
      fileBox.querySelector('.blk-diff-filebody').appendChild(box);
      var m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(hunk.header);
      return {
        hunk: hunk, box: box, rows: rows, selected: selected, pairs: pairChanges(hunk.lines),
        oldNo: m ? Number(m[1]) : 0, newNo: m ? Number(m[2]) : 0,
      };
    }

    function addRows(h, from, to) {
      for (var i = from; i < to; i++) addRow(h, i);
    }

    function addRow(h, i) {
      var line = h.hunk.lines[i];
      var kind = line.charAt(0);
      var row = el('div', 'blk-line' + (kind === '+' ? ' is-add' : kind === '-' ? ' is-del' : kind === '\\' ? ' is-meta' : ''));
      var a = kind === '+' || kind === '\\' ? '' : h.oldNo++;
      var b = kind === '-' || kind === '\\' ? '' : h.newNo++;
      row.appendChild(el('span', 'blk-ln', String(a)));
      row.appendChild(el('span', 'blk-ln', String(b)));
      row.appendChild(codeWithSpan(line, h.pairs[i]));
      if (options.actions && (kind === '+' || kind === '-')) {
        row.classList.add('is-selectable');
        row.addEventListener('click', function () {
          h.selected[i] = !h.selected[i];
          row.classList.toggle('is-selected', h.selected[i]);
          h.box.classList.toggle('has-selection', Object.keys(h.selected).some(function (k) { return h.selected[k]; }));
        });
      }
      h.rows.appendChild(row);
    }

    // Where drawing stopped: which file, which hunk, which line.
    var fileIndex = 0, hunkIndex = 0, lineIndex = 0;
    var fileBox = null, current = null, more = null;
    function draw(limit) {
      if (more) { more.remove(); more = null; }
      var used = 0;
      while (fileIndex < files.length && used < limit) {
        var file = files[fileIndex];
        if (!fileBox) fileBox = openFile(file);
        if (hunkIndex >= file.hunks.length) {
          fileIndex++;
          hunkIndex = 0;
          fileBox = null;
          continue;
        }
        if (!current) current = openHunk(fileBox, file, file.hunks[hunkIndex]);
        var end = Math.min(current.hunk.lines.length, lineIndex + limit - used);
        addRows(current, lineIndex, end);
        used += end - lineIndex;
        drawn += end - lineIndex;
        lineIndex = end;
        if (lineIndex >= current.hunk.lines.length) {
          hunkIndex++;
          lineIndex = 0;
          current = null;
        }
      }
      // Files after the last line drawn that have nothing to draw still get their box.
      while (fileIndex < files.length && drawn >= total) {
        if (!fileBox) openFile(files[fileIndex]);
        fileIndex++;
        fileBox = null;
      }
      if (fileIndex < files.length) {
        more = button('显示剩余 ' + (total - drawn) + ' 行', function () { draw(budget); }, { className: 'blk-btn-ghost blk-btn-small blk-diff-more' });
        container.appendChild(more);
      }
    }
    draw(budget);
    return files;
  }

  // --- generic pieces ---------------------------------------------------------

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

  function downloadText(name, text, type) {
    var blob = new Blob(['﻿' + text], { type: type || 'text/csv;charset=utf-8' });
    var link = el('a');
    link.href = URL.createObjectURL(blob);
    link.download = name;
    document.body.appendChild(link);
    link.click();
    setTimeout(function () { URL.revokeObjectURL(link.href); link.remove(); }, 0);
  }

  function errorBox(err, hint) {
    var box = el('div', 'blk-error');
    box.setAttribute('role', 'alert');
    box.appendChild(el('strong', '', '出错了'));
    box.appendChild(el('pre', '', errorText(err)));
    if (hint) box.appendChild(el('span', 'blk-muted', hint));
    return box;
  }

  // --- file preview hooks ---------------------------------------------------------

  function byOrder(a, b) { return (a.order || 0) - (b.order || 0); }
  var _renderers = [];
  var _previewActionSources = [];

  /** A renderer for some files: { id, order, test(path, readOnly), render(body, content, info) }. */
  function registerRenderer(renderer) {
    _renderers = _renderers.filter(function (r) { return r.id !== renderer.id; }).concat(renderer).sort(byOrder);
  }

  /** The render function of the first renderer that takes this path, or null. */
  function rendererFor(path, readOnly) {
    for (var i = 0; i < _renderers.length; i++) if (_renderers[i].test(path, readOnly)) return _renderers[i].render;
    return null;
  }

  /** Items for the preview's "more" menu: { id, order, items(file, ctx) → [{ label, hint, icon, run }] }. */
  function registerPreviewActions(source) {
    _previewActionSources = _previewActionSources.filter(function (s) { return s.id !== source.id; }).concat(source).sort(byOrder);
  }

  function previewActions(file, ctx) {
    return _previewActionSources.reduce(function (all, source) { return all.concat(source.items(file, ctx) || []); }, []);
  }

  return {
    // file preview hooks; renderSqlite and decorateGitGutter come with their plugins
    registerRenderer: registerRenderer,
    rendererFor: rendererFor,
    registerPreviewActions: registerPreviewActions,
    previewActions: previewActions,
    icon: icon,
    ui: {
      CDN: CDN, loadScript: loadScript, loadCss: loadCss, esc: esc, el: el, button: button, iconButton: iconButton,
      kbd: kbd, keysText: keysText, keyParts: keyParts, isMac: IS_MAC, busy: busy, spinnerLine: spinnerLine,
      toast: toast, errorText: errorText, errorBox: errorBox, confirmAction: confirmAction, promptText: promptText,
      emptyState: emptyState, isDark: isDark, client: client, currentContext: currentContext,
      selectedContext: selectedContext, focusedContext: focusedContext,
      renderDiffInto: renderDiffInto, buildPatch: buildPatch, parseUnifiedDiff: parseUnifiedDiff, downloadText: downloadText,
      iconPaths: function (name) { return ICONS[name]; },
    },
    _test: {
      parseUnifiedDiff: parseUnifiedDiff,
      buildPatch: buildPatch,
      wordSpan: wordSpan,
      pairChanges: pairChanges,
      keyParts: keyParts,
    },
  };
})();

if (typeof window !== 'undefined') window.Blocks = Blocks;
