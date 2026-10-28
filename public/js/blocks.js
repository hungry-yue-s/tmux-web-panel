/* global Api, Store, Router, Theme, FilePreview, state */

// Blocks: built-in tools that sit next to the shell — git, SQLite, notebooks,
// a TODO.md board, an editor, a browser and a theme picker. File-backed blocks
// render inside the file preview (so they dock into the right split like any
// file); the rest open as panels. Every request goes to the server in view
// through Api.activeUrl, so remote machines get the same blocks.

var Blocks = (function () {
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

  function button(label, onclick, className) {
    var b = el('button', 'blk-btn' + (className ? ' ' + className : ''), label);
    b.type = 'button';
    b.addEventListener('click', onclick);
    return b;
  }

  function toast(message, isError) {
    var host = document.getElementById('ms-toast');
    if (!host) { if (isError) console.error(message); return; }
    host.textContent = message;
    host.classList.toggle('is-error', !!isError);
    host.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () { host.classList.remove('show'); }, 3200);
  }

  function url(path) { return Api.activeUrl(path); }
  function qs(params) {
    return Object.keys(params).filter(function (k) { return params[k] != null && params[k] !== ''; })
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
  }
  function apiGet(path, params) { return Api.get(url(path) + (params ? '?' + qs(params) : '')); }
  function apiSend(method, path, body) { return Api.request(method, url(path), body); }

  function isDark() {
    return (document.documentElement.style.colorScheme || '').indexOf('dark') !== -1
      || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches && !document.documentElement.style.colorScheme);
  }

  /** The pane in view: its cwd anchors git, `twp`-style relative paths and new files. */
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

  // --- Panels (git, browser, theme picker) -----------------------------------

  var _panels = [];
  function openPanel(title, options) {
    options = options || {};
    var overlay = el('div', 'blk-overlay' + (options.side ? ' blk-side' : ''));
    var panel = el('section', 'blk-panel' + (options.className ? ' ' + options.className : ''));
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', title);
    var head = el('header', 'blk-head');
    var h = el('h2', 'blk-title', title);
    var tools = el('div', 'blk-head-tools');
    var close = button('×', function () { api.close(); }, 'blk-close');
    close.setAttribute('aria-label', '关闭');
    head.append(h, tools, close);
    var body = el('div', 'blk-body');
    panel.append(head, body);
    overlay.appendChild(panel);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay && !options.side) api.close(); });
    overlay.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); api.close(); }
    });
    document.body.appendChild(overlay);
    var api = {
      overlay: overlay, panel: panel, body: body, tools: tools, titleEl: h,
      close: function () {
        if (!overlay.isConnected) return;
        overlay.remove();
        _panels = _panels.filter(function (p) { return p !== api; });
        if (options.onClose) options.onClose();
      },
    };
    _panels.push(api);
    setTimeout(function () { close.focus({ preventScroll: true }); }, 0);
    return api;
  }

  // --- Unified diff model, shared by the git panel and .diff files ----------

  /** Splits a multi-file unified diff into files with header lines and hunks. */
  function parseUnifiedDiff(text) {
    var files = [];
    var file = null, hunk = null;
    String(text || '').split('\n').forEach(function (line) {
      if (line.indexOf('diff --git ') === 0 || (!file && line.indexOf('--- ') === 0)) {
        file = { header: [line], hunks: [], name: '' };
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
        if (line === '' ) return; // trailing newline of the diff
        hunk.lines.push(line);
      } else {
        file.header.push(line);
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

  function renderDiffInto(container, text, options) {
    options = options || {};
    container.replaceChildren();
    var files = parseUnifiedDiff(text);
    if (!files.length || files.every(function (f) { return !f.hunks.length; })) {
      container.appendChild(el('div', 'blk-empty', options.emptyText || '没有差异（可能是二进制文件或仅模式变化）'));
      return;
    }
    files.forEach(function (file) {
      if (files.length > 1) container.appendChild(el('div', 'blk-diff-file', file.name));
      file.hunks.forEach(function (hunk) {
        var box = el('div', 'blk-hunk');
        var bar = el('div', 'blk-hunk-head');
        bar.appendChild(el('code', '', hunk.header));
        var selected = {};
        var rows = [];
        if (options.actions) {
          var actionsBox = el('div', 'blk-hunk-actions');
          options.actions(file, hunk, function () {
            return Object.keys(selected).some(function (k) { return selected[k]; }) ? selected : null;
          }).forEach(function (b) { actionsBox.appendChild(b); });
          bar.appendChild(actionsBox);
        }
        box.appendChild(bar);
        var pre = el('div', 'blk-hunk-lines');
        var oldNo = 0, newNo = 0;
        var m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(hunk.header);
        if (m) { oldNo = Number(m[1]); newNo = Number(m[2]); }
        hunk.lines.forEach(function (line, i) {
          var kind = line.charAt(0);
          var row = el('div', 'blk-line' + (kind === '+' ? ' is-add' : kind === '-' ? ' is-del' : kind === '\\' ? ' is-meta' : ''));
          var a = kind === '+' || kind === '\\' ? '' : oldNo++;
          var b = kind === '-' || kind === '\\' ? '' : newNo++;
          row.appendChild(el('span', 'blk-ln', String(a)));
          row.appendChild(el('span', 'blk-ln', String(b)));
          row.appendChild(el('span', 'blk-code', line));
          if (options.actions && (kind === '+' || kind === '-')) {
            row.classList.add('is-selectable');
            row.title = '点击选择此行，再用“所选行”按钮暂存/取消暂存';
            row.addEventListener('click', function () {
              selected[i] = !selected[i];
              row.classList.toggle('is-selected', selected[i]);
            });
          }
          rows.push(row);
          pre.appendChild(row);
        });
        box.appendChild(pre);
        container.appendChild(box);
      });
    });
  }

  // --- Git block -------------------------------------------------------------

  var STATUS_LABEL = { M: '修改', A: '新增', D: '删除', R: '重命名', C: '复制', U: '冲突', '?': '未跟踪', T: '类型' };

  function openGit(path, paneId) {
    var target = { path: path || '.', paneId: paneId || currentContext().paneId };
    var panel = openPanel('Git', { className: 'blk-git' });
    var tabs = el('div', 'blk-tabs');
    var changesTab = button('更改', function () { show('changes'); }, 'blk-tab is-active');
    var historyTab = button('历史', function () { show('history'); }, 'blk-tab');
    var refresh = button('刷新', function () { load(); }, 'blk-btn-ghost');
    tabs.append(changesTab, historyTab);
    panel.tools.append(tabs, refresh);

    var changesView = el('div', 'blk-git-changes');
    var historyView = el('div', 'blk-git-history');
    historyView.hidden = true;
    panel.body.append(changesView, historyView);

    var side = el('div', 'blk-git-side');
    var main = el('div', 'blk-git-main');
    changesView.append(side, main);

    var summary = el('div', 'blk-git-summary');
    var lists = el('div', 'blk-git-lists');
    var commitBox = el('div', 'blk-git-commit');
    side.append(summary, lists, commitBox);

    var message = el('textarea', 'blk-input blk-commit-msg');
    message.placeholder = '提交说明（Ctrl+Enter 提交）';
    message.rows = 4;
    var amendLabel = el('label', 'blk-check');
    var amend = el('input');
    amend.type = 'checkbox';
    amendLabel.append(amend, document.createTextNode(' 修改上次提交'));
    var generate = button('生成说明', function () {
      generate.disabled = true;
      generate.textContent = '生成中…';
      apiSend('POST', '/api/git/commit-message', target).then(function (data) {
        message.value = data.message;
        if (data.source !== 'claude') toast('未找到可用的 claude CLI，已按改动文件生成摘要');
      }).catch(function (err) { toast(err.message === 'nothing_staged' ? '请先暂存要提交的改动' : err.message, true); })
        .finally(function () { generate.disabled = false; generate.textContent = '生成说明'; });
    });
    var commit = button('提交', doCommit, 'blk-btn-primary');
    var undo = button('撤销上次提交', function () {
      if (!confirm('撤销上一次提交？改动会保留在暂存区。')) return;
      apiSend('POST', '/api/git/undo-commit', target).then(function (data) {
        message.value = data.message || '';
        toast('已撤销上次提交，改动保留在暂存区');
        load();
      }).catch(function (err) { toast(err.message, true); });
    }, 'blk-btn-ghost');
    var commitActions = el('div', 'blk-row');
    commitActions.append(generate, commit);
    var commitExtra = el('div', 'blk-row');
    commitExtra.append(amendLabel, undo);
    commitBox.append(message, commitActions, commitExtra);
    message.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doCommit(); }
    });

    var status = null;
    var selection = null; // { file, staged }

    function doCommit() {
      if (!message.value.trim()) { toast('请填写提交说明', true); message.focus(); return; }
      commit.disabled = true;
      apiSend('POST', '/api/git/commit', Object.assign({ message: message.value, amend: amend.checked }, target))
        .then(function (data) {
          toast('已提交 ' + data.hash + ' ' + data.subject);
          message.value = '';
          amend.checked = false;
          selection = null;
          load();
        })
        .catch(function (err) { toast(err.message, true); })
        .finally(function () { commit.disabled = false; });
    }

    function act(action, files, extra) {
      return apiSend('POST', '/api/git/' + action, Object.assign({ files: files }, target, extra || {}))
        .then(load).catch(function (err) { toast(err.message, true); });
    }

    function fileRow(file, staged) {
      var row = el('div', 'blk-file' + (selection && selection.file.path === file.path && selection.staged === staged ? ' is-active' : ''));
      var code = staged ? file.index : (file.untracked ? '?' : file.worktree);
      var badge = el('span', 'blk-badge blk-badge-' + (code === '?' ? 'u' : code.toLowerCase()), code === '?' ? 'U' : code);
      badge.title = STATUS_LABEL[code] || code;
      var name = el('span', 'blk-file-name', file.path);
      name.title = (file.from ? file.from + ' → ' : '') + file.path;
      var actions = el('span', 'blk-file-actions');
      if (staged) {
        actions.appendChild(button('−', function (e) { e.stopPropagation(); act('unstage', [file.path]); }, 'blk-icon-btn'));
        actions.lastChild.title = '取消暂存';
      } else {
        var discard = button('↺', function (e) {
          e.stopPropagation();
          if (!confirm((file.untracked ? '删除未跟踪文件 ' : '丢弃对 ') + file.path + (file.untracked ? '？' : ' 的改动？') + '此操作无法撤销。')) return;
          act('discard', [file.path], file.untracked ? { untracked: [file.path] } : null);
        }, 'blk-icon-btn');
        discard.title = file.untracked ? '删除文件' : '丢弃改动';
        var stage = button('+', function (e) { e.stopPropagation(); act('stage', [file.path]); }, 'blk-icon-btn');
        stage.title = '暂存';
        actions.append(discard, stage);
      }
      row.append(badge, name, actions);
      row.addEventListener('click', function () { selection = { file: file, staged: staged }; renderLists(); showDiff(); });
      row.addEventListener('dblclick', function () {
        if (status && window.FilePreview) FilePreview.openFile(status.root.replace(/\/$/, '') + '/' + file.path, target.paneId);
      });
      return row;
    }

    function group(title, files, staged) {
      var box = el('div', 'blk-group');
      var head = el('div', 'blk-group-head');
      head.appendChild(el('span', '', title + ' · ' + files.length));
      if (files.length) {
        var all = button(staged ? '全部取消' : '全部暂存', function () {
          act(staged ? 'unstage' : 'stage', files.map(function (f) { return f.path; }));
        }, 'blk-btn-ghost blk-btn-small');
        head.appendChild(all);
      }
      box.appendChild(head);
      files.forEach(function (f) { box.appendChild(fileRow(f, staged)); });
      return box;
    }

    function renderLists() {
      lists.replaceChildren();
      if (!status) return;
      var staged = status.files.filter(function (f) { return f.staged; });
      var unstaged = status.files.filter(function (f) { return f.unstaged; });
      lists.append(group('已暂存', staged, true), group('未暂存', unstaged, false));
    }

    function showDiff() {
      main.replaceChildren();
      if (!selection) {
        main.appendChild(el('div', 'blk-empty', status && status.files.length ? '选择左侧文件查看差异；点击行可选中，按块或按行暂存。' : '工作区干净。'));
        return;
      }
      var file = selection.file, staged = selection.staged;
      var title = el('div', 'blk-diff-title');
      title.appendChild(el('strong', '', file.path));
      title.appendChild(el('span', 'blk-muted', staged ? ' 已暂存的改动' : ' 未暂存的改动'));
      var openBtn = button('打开文件', function () {
        if (window.FilePreview) FilePreview.openFile(status.root.replace(/\/$/, '') + '/' + file.path, target.paneId);
      }, 'blk-btn-ghost blk-btn-small');
      title.appendChild(openBtn);
      var diffBox = el('div', 'blk-diff');
      diffBox.appendChild(el('div', 'blk-empty', '加载差异…'));
      main.append(title, diffBox);
      apiGet('/api/git/diff', Object.assign({ file: file.path, staged: staged ? '1' : '0', untracked: !staged && file.untracked ? '1' : '0' }, target))
        .then(function (data) {
          renderDiffInto(diffBox, data.diff, {
            actions: file.untracked ? null : function (f, hunk, picked) {
              function apply(reverse, cached, all) {
                var patch = buildPatch(f, hunk, all ? null : picked(), reverse);
                if (!patch) { toast('请先点击选择要处理的行', true); return; }
                apiSend('POST', '/api/git/apply', Object.assign({ patch: patch, cached: cached, reverse: reverse }, target))
                  .then(load).catch(function (err) { toast(err.message, true); });
              }
              if (staged) {
                return [
                  button('取消暂存所选行', function () { apply(true, true, false); }, 'blk-btn-ghost blk-btn-small'),
                  button('取消暂存此块', function () { apply(true, true, true); }, 'blk-btn-small'),
                ];
              }
              return [
                button('丢弃此块', function () {
                  if (confirm('丢弃这一块改动？此操作无法撤销。')) apply(true, false, true);
                }, 'blk-btn-ghost blk-btn-small blk-btn-danger'),
                button('暂存所选行', function () { apply(false, true, false); }, 'blk-btn-ghost blk-btn-small'),
                button('暂存此块', function () { apply(false, true, true); }, 'blk-btn-small'),
              ];
            },
          });
        })
        .catch(function (err) { diffBox.replaceChildren(el('div', 'blk-error', err.message)); });
    }

    function load() {
      return apiGet('/api/git/status', target).then(function (data) {
        status = data;
        panel.titleEl.textContent = 'Git · ' + data.root.split('/').filter(Boolean).pop();
        summary.replaceChildren();
        var branch = el('div', 'blk-branch');
        branch.appendChild(el('strong', '', data.detached ? '(分离 HEAD)' : (data.branch || '—')));
        if (data.upstream) branch.appendChild(el('span', 'blk-muted', ' → ' + data.upstream));
        if (data.ahead) branch.appendChild(el('span', 'blk-pill', '↑' + data.ahead));
        if (data.behind) branch.appendChild(el('span', 'blk-pill', '↓' + data.behind));
        summary.appendChild(branch);
        if (data.head) summary.appendChild(el('div', 'blk-muted blk-ellipsis', data.head.hash + ' ' + data.head.subject));
        if (selection) {
          var still = data.files.find(function (f) {
            return f.path === selection.file.path && (selection.staged ? f.staged : f.unstaged);
          });
          selection = still ? { file: still, staged: selection.staged } : null;
        }
        renderLists();
        showDiff();
        if (!historyView.hidden) loadHistory();
      }).catch(function (err) {
        changesView.replaceChildren(el('div', 'blk-error', err.message === 'not_a_git_repository'
          ? '当前目录不在 Git 仓库中：' + target.path : err.message));
      });
    }

    function loadHistory() {
      historyView.replaceChildren(el('div', 'blk-empty', '加载提交历史…'));
      apiGet('/api/git/log', Object.assign({ limit: 300 }, target)).then(function (data) {
        historyView.replaceChildren();
        var list = el('div', 'blk-log');
        var detail = el('div', 'blk-log-detail');
        detail.appendChild(el('div', 'blk-empty', '选择一个提交查看改动'));
        data.rows.forEach(function (row) {
          var line = el('div', 'blk-log-row' + (row.commit ? ' has-commit' : ''));
          var graph = el('span', 'blk-graph');
          graph.innerHTML = colorGraph(row.graph);
          line.appendChild(graph);
          if (row.commit) {
            line.appendChild(el('span', 'blk-hash', row.commit.short));
            row.commit.refs.forEach(function (ref) { line.appendChild(el('span', 'blk-ref', ref.replace(/^HEAD -> /, '⇢ '))); });
            line.appendChild(el('span', 'blk-subject', row.commit.subject));
            line.appendChild(el('span', 'blk-muted blk-log-meta', row.commit.author + ' · ' + row.commit.date));
            line.addEventListener('click', function () {
              list.querySelectorAll('.is-active').forEach(function (n) { n.classList.remove('is-active'); });
              line.classList.add('is-active');
              detail.replaceChildren(el('div', 'blk-empty', '加载…'));
              apiGet('/api/git/show', Object.assign({ commit: row.commit.hash }, target)).then(function (res) {
                var at = res.diff.indexOf('\ndiff --git ');
                var meta = el('pre', 'blk-commit-meta', at === -1 ? res.diff : res.diff.slice(0, at));
                var diffs = el('div', 'blk-diff');
                renderDiffInto(diffs, at === -1 ? '' : res.diff.slice(at + 1), { emptyText: '此提交没有文本改动' });
                detail.replaceChildren(meta, diffs);
              }).catch(function (err) { detail.replaceChildren(el('div', 'blk-error', err.message)); });
            });
          }
          list.appendChild(line);
        });
        if (!data.rows.length) list.appendChild(el('div', 'blk-empty', '还没有提交'));
        historyView.append(list, detail);
      }).catch(function (err) { historyView.replaceChildren(el('div', 'blk-error', err.message)); });
    }

    function show(which) {
      changesTab.classList.toggle('is-active', which === 'changes');
      historyTab.classList.toggle('is-active', which === 'history');
      changesView.hidden = which !== 'changes';
      historyView.hidden = which !== 'history';
      if (which === 'history') loadHistory();
    }

    load();
    return panel;
  }

  var GRAPH_COLORS = 6;
  function colorGraph(graph) {
    var out = '';
    for (var i = 0; i < graph.length; i++) {
      var c = graph.charAt(i);
      if (c === ' ') { out += ' '; continue; }
      out += '<span class="blk-g' + (Math.floor(i / 2) % GRAPH_COLORS) + '">' + esc(c === '*' ? '●' : c) + '</span>';
    }
    return out;
  }

  // --- Git gutter in the code preview ----------------------------------------

  function decorateGitGutter(body, absPath) {
    apiGet('/api/git/line-changes', { path: absPath }).then(function (data) {
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

  // --- Notebook block ---------------------------------------------------------

  var ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
  function joinSource(src) { return Array.isArray(src) ? src.join('') : String(src || ''); }

  function renderNotebook(body, content, info) {
    var nb;
    try { nb = JSON.parse(content); } catch (err) {
      body.appendChild(el('div', 'blk-error', 'Notebook JSON 解析失败：' + err.message));
      return true;
    }
    var lang = (nb.metadata && (nb.metadata.language_info && nb.metadata.language_info.name
      || nb.metadata.kernelspec && nb.metadata.kernelspec.language)) || 'python';
    var wrap = el('div', 'blk-nb fp-md-wrap');
    var bar = el('div', 'blk-nb-bar');
    var kernel = nb.metadata && nb.metadata.kernelspec ? nb.metadata.kernelspec.display_name : lang;
    bar.appendChild(el('span', 'blk-muted', 'Jupyter Notebook · ' + kernel + ' · ' + (nb.cells || []).length + ' 个单元'));
    var run = button('▶ 运行全部', function () {
      run.disabled = true;
      run.textContent = '运行中…';
      apiSend('POST', '/api/notebook/execute', { path: info.absPath })
        .then(function () { toast('Notebook 已执行，输出已写回文件'); })
        .catch(function (err) {
          toast(err.message === 'jupyter_not_installed' ? '这台机器上没有 jupyter（pip install jupyter）' : err.message, true);
        })
        .finally(function () { run.disabled = false; run.textContent = '▶ 运行全部'; });
    }, 'blk-btn-small');
    run.title = '用 jupyter nbconvert --execute 运行并写回输出';
    bar.appendChild(run);
    wrap.appendChild(bar);
    body.appendChild(wrap);

    return Promise.all([loadScript(CDN.markdownIt), loadScript(CDN.hljs)]).catch(function () {}).then(function () {
      var md = window.markdownit ? window.markdownit({ html: false, linkify: true }) : null;
      (nb.cells || []).forEach(function (cell) {
        var source = joinSource(cell.source);
        var box = el('div', 'blk-cell blk-cell-' + cell.cell_type);
        if (cell.cell_type === 'markdown') {
          var mdBox = el('div', 'blk-cell-md');
          if (md) mdBox.innerHTML = md.render(source); else mdBox.textContent = source;
          box.appendChild(mdBox);
        } else if (cell.cell_type === 'code') {
          var prompt = el('div', 'blk-cell-prompt', '[' + (cell.execution_count == null ? ' ' : cell.execution_count) + ']');
          var pre = el('pre', 'blk-cell-src');
          var code = el('code', '', source);
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
      img.alt = 'output';
      img.src = data['image/png'] ? 'data:image/png;base64,' + joinSource(data['image/png']).trim()
        : 'data:image/jpeg;base64,' + joinSource(data['image/jpeg']).trim();
      box.appendChild(img);
    } else if (data['image/svg+xml'] || data['text/html']) {
      // Rich output runs in an opaque sandbox: no access to the panel or its token.
      var frame = el('iframe', 'blk-out-frame');
      frame.setAttribute('sandbox', '');
      frame.srcdoc = joinSource(data['text/html'] || data['image/svg+xml']);
      frame.addEventListener('load', function () {
        try { frame.style.height = Math.min(frame.contentDocument.body.scrollHeight + 24, 800) + 'px'; } catch (_) { /* opaque */ }
      });
      box.appendChild(frame);
    } else if (data['text/plain']) {
      box.appendChild(el('pre', 'blk-out-text', joinSource(data['text/plain'])));
    }
    return box;
  }

  // --- .diff / .patch files (diff2html) ---------------------------------------

  function renderDiffFile(body, content) {
    var wrap = el('div', 'blk-difffile fp-code-wrap');
    var bar = el('div', 'blk-nb-bar');
    var mode = 'line-by-line';
    var view = el('div', 'blk-difffile-view');
    var toggle = button('并排显示', function () {
      mode = mode === 'line-by-line' ? 'side-by-side' : 'line-by-line';
      toggle.textContent = mode === 'line-by-line' ? '并排显示' : '逐行显示';
      draw();
    }, 'blk-btn-small');
    bar.append(el('span', 'blk-muted', '补丁文件'), toggle);
    wrap.append(bar, view);
    body.appendChild(wrap);
    function draw() {
      if (!window.Diff2Html) { renderDiffInto(view, content); return; }
      view.innerHTML = window.Diff2Html.html(content, {
        drawFileList: true, matching: 'lines', outputFormat: mode, colorScheme: isDark() ? 'dark' : 'light',
      });
    }
    return Promise.all([loadScript(CDN.diff2html), loadCss(CDN.diff2htmlCss)])
      .catch(function () { /* fall back to the built-in renderer */ })
      .then(function () { draw(); return true; });
  }

  // --- SQLite block -----------------------------------------------------------

  function renderSqlite(body, info) {
    var wrap = el('div', 'blk-db');
    // The preview's auto-refresh would rebuild this view after every edit.
    wrap.setAttribute('data-fp-hold-refresh', '');
    var side = el('div', 'blk-db-side');
    var main = el('div', 'blk-db-main');
    wrap.append(side, main);
    body.appendChild(wrap);
    var source = { path: info.absPath };
    var current = null; // { table, offset, order, dir }

    function loadSchema() {
      return apiGet('/api/sqlite/schema', source).then(function (data) {
        side.replaceChildren();
        side.appendChild(el('div', 'blk-group-head', '表与视图 · ' + data.tables.length));
        data.tables.forEach(function (table) {
          var row = el('div', 'blk-file' + (current && current.table.name === table.name ? ' is-active' : ''));
          row.appendChild(el('span', 'blk-badge blk-badge-' + (table.type === 'view' ? 'r' : 'm'), table.type === 'view' ? 'V' : 'T'));
          row.appendChild(el('span', 'blk-file-name', table.name));
          row.appendChild(el('span', 'blk-muted', table.rows == null ? '' : String(table.rows)));
          row.addEventListener('click', function () {
            current = { table: table, offset: 0, order: null, dir: 'asc' };
            side.querySelectorAll('.is-active').forEach(function (n) { n.classList.remove('is-active'); });
            row.classList.add('is-active');
            loadRows();
          });
          side.appendChild(row);
        });
        var sql = el('div', 'blk-file blk-db-sql-link');
        sql.appendChild(el('span', 'blk-badge blk-badge-a', 'Q'));
        sql.appendChild(el('span', 'blk-file-name', 'SQL 查询'));
        sql.addEventListener('click', showQuery);
        side.appendChild(sql);
        if (!current) {
          if (data.tables.length) side.querySelector('.blk-file').click();
          else showQuery();
        }
      }).catch(function (err) { wrap.replaceChildren(el('div', 'blk-error', err.message)); });
    }

    function grid(columns, rows, editable) {
      var table = el('table', 'blk-grid');
      var thead = el('thead');
      var hr = el('tr');
      columns.forEach(function (name) {
        var th = el('th', '', name);
        if (current && current.table && editable !== null) {
          th.classList.add('is-sortable');
          if (current.order === name) th.textContent += current.dir === 'asc' ? ' ▲' : ' ▼';
          th.addEventListener('click', function () {
            current.dir = current.order === name && current.dir === 'asc' ? 'desc' : 'asc';
            current.order = name;
            current.offset = 0;
            loadRows();
          });
        }
        hr.appendChild(th);
      });
      if (editable) hr.appendChild(el('th', 'blk-grid-tools', ''));
      thead.appendChild(hr);
      var tbody = el('tbody');
      rows.forEach(function (row) {
        var tr = el('tr');
        columns.forEach(function (name) {
          var value = row[name];
          var td = el('td');
          setCell(td, value);
          if (editable) {
            td.title = '双击编辑';
            td.addEventListener('dblclick', function () { editCell(td, row, name); });
          }
          tr.appendChild(td);
        });
        if (editable) {
          var tools = el('td', 'blk-grid-tools');
          var del = button('删除', function () {
            if (!confirm('删除这一行？')) return;
            apiSend('DELETE', '/api/sqlite/row', Object.assign({ table: current.table.name, rowid: row.__rowid__ }, source))
              .then(function () { loadRows(); loadSchema(); }).catch(function (err) { toast(err.message, true); });
          }, 'blk-btn-ghost blk-btn-small blk-btn-danger');
          tools.appendChild(del);
          tr.appendChild(tools);
        }
        tbody.appendChild(tr);
      });
      table.append(thead, tbody);
      return table;
    }

    function setCell(td, value) {
      td.classList.toggle('is-null', value === null);
      if (value === null) td.textContent = 'NULL';
      else if (value && typeof value === 'object' && value.$blob != null) td.textContent = '<BLOB ' + value.$blob + ' B>';
      else td.textContent = String(value);
    }

    function editCell(td, row, column) {
      if (td.querySelector('input')) return;
      var original = row[column];
      if (original && typeof original === 'object') { toast('BLOB 不能在这里编辑', true); return; }
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
        apiSend('PATCH', '/api/sqlite/cell', Object.assign({ table: current.table.name, rowid: row.__rowid__, column: column, value: value }, source))
          .then(function () { row[column] = value; setCell(td, value); td.classList.add('is-saved'); })
          .catch(function (err) { setCell(td, original); toast(err.message, true); });
      }
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
      });
      input.addEventListener('blur', function () { finish(true); });
    }

    function loadRows() {
      main.replaceChildren(el('div', 'blk-empty', '加载…'));
      apiGet('/api/sqlite/rows', Object.assign({
        table: current.table.name, offset: current.offset, limit: 100, order: current.order, dir: current.dir,
      }, source)).then(function (data) {
        main.replaceChildren();
        var bar = el('div', 'blk-row blk-db-bar');
        bar.appendChild(el('strong', '', current.table.name));
        var end = Math.min(data.offset + data.rows.length, data.total);
        bar.appendChild(el('span', 'blk-muted', (data.total ? (data.offset + 1) + '–' + end : 0) + ' / ' + data.total + ' 行'));
        var prev = button('上一页', function () { current.offset = Math.max(0, current.offset - data.limit); loadRows(); }, 'blk-btn-ghost blk-btn-small');
        prev.disabled = data.offset === 0;
        var next = button('下一页', function () { current.offset += data.limit; loadRows(); }, 'blk-btn-ghost blk-btn-small');
        next.disabled = end >= data.total;
        bar.append(prev, next);
        if (current.table.type === 'table') {
          bar.appendChild(button('+ 新增行', function () {
            apiSend('POST', '/api/sqlite/row', Object.assign({ table: current.table.name }, source))
              .then(function () { current.offset = Math.max(0, Math.floor(data.total / data.limit) * data.limit); loadRows(); loadSchema(); })
              .catch(function (err) { toast(err.message, true); });
          }, 'blk-btn-small'));
        }
        main.appendChild(bar);
        var scroller = el('div', 'blk-grid-wrap');
        scroller.appendChild(grid(data.columns, data.rows, data.editable));
        main.appendChild(scroller);
      }).catch(function (err) { main.replaceChildren(el('div', 'blk-error', err.message)); });
    }

    function showQuery() {
      current = null;
      side.querySelectorAll('.is-active').forEach(function (n) { n.classList.remove('is-active'); });
      main.replaceChildren();
      var area = el('textarea', 'blk-input blk-sql');
      area.placeholder = 'SELECT * FROM … LIMIT 100\n\nCtrl+Enter 运行';
      area.spellcheck = false;
      var writeLabel = el('label', 'blk-check');
      var write = el('input');
      write.type = 'checkbox';
      writeLabel.append(write, document.createTextNode(' 允许修改数据'));
      var out = el('div', 'blk-grid-wrap');
      function runQuery() {
        out.replaceChildren(el('div', 'blk-empty', '运行中…'));
        apiSend('POST', '/api/sqlite/query', Object.assign({ sql: area.value, write: write.checked }, source)).then(function (data) {
          out.replaceChildren();
          if (data.columns.length) {
            out.appendChild(grid(data.columns, data.rows, null));
            if (data.truncated) out.appendChild(el('div', 'blk-muted', '只显示前 1000 行'));
          } else {
            out.appendChild(el('div', 'blk-empty', '完成，影响 ' + (data.changes || 0) + ' 行'));
            loadSchema();
          }
        }).catch(function (err) {
          out.replaceChildren(el('div', 'blk-error', /readonly|read-only/i.test(err.message) ? err.message + '（勾选“允许修改数据”后再运行）' : err.message));
        });
      }
      area.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runQuery(); }
      });
      var bar = el('div', 'blk-row');
      bar.append(button('运行', runQuery, 'blk-btn-primary blk-btn-small'), writeLabel);
      main.append(area, bar, out);
      area.focus();
    }

    return loadSchema().then(function () { return true; });
  }

  // --- Editor -----------------------------------------------------------------

  function openEditor(body, file, refresh) {
    if (!body || !file || file.rawContent == null) { toast('这个文件不能在这里编辑', true); return; }
    var markdown = !!file.isMarkdown;
    var wrap = el('div', 'blk-editor');
    wrap.setAttribute('data-fp-hold-refresh', '');
    var bar = el('div', 'blk-row blk-editor-bar');
    var status = el('span', 'blk-muted', markdown ? '文档模式 · Ctrl+S 保存' : 'Ctrl+S 保存 · Esc 取消');
    var host = el('div', 'blk-editor-host');
    var getValue;
    var dirty = false;
    var expected = { mtimeMs: file.mtimeMs, size: file.size };

    function save() {
      var content = getValue();
      status.textContent = '保存中…';
      apiSend('PUT', '/api/files/content', {
        path: file.absPath, content: content, expectedMtimeMs: expected.mtimeMs, expectedSize: expected.size,
      }).then(function (data) {
        expected = { mtimeMs: data.mtimeMs, size: data.size };
        dirty = false;
        toast('已保存 ' + file.filename);
        refresh();
      }).catch(function (err) {
        status.textContent = err.message === 'file_changed_on_disk' ? '文件已在磁盘上被修改，未保存。请复制改动后刷新。' : '保存失败：' + err.message;
        status.classList.add('is-error');
      });
    }
    function cancel() {
      if (dirty && !confirm('放弃未保存的修改？')) return;
      refresh();
    }
    bar.append(button('保存', save, 'blk-btn-primary blk-btn-small'), button('取消', cancel, 'blk-btn-ghost blk-btn-small'), status);
    wrap.append(bar, host);
    body.replaceChildren(wrap);
    wrap.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); e.stopPropagation(); save(); }
      if (e.key === 'Escape' && !markdown) { e.preventDefault(); e.stopPropagation(); cancel(); }
    });

    function plain() {
      var area = el('textarea', 'blk-input blk-editor-text');
      area.value = file.rawContent;
      area.spellcheck = false;
      area.addEventListener('input', function () { dirty = true; });
      area.addEventListener('keydown', function (e) {
        if (e.key === 'Tab' && !e.shiftKey) {
          e.preventDefault();
          var start = area.selectionStart;
          area.setRangeText('  ', start, area.selectionEnd, 'end');
          dirty = true;
        }
      });
      host.replaceChildren(area);
      getValue = function () { return area.value; };
      area.focus();
    }

    if (!markdown) { plain(); return; }
    host.appendChild(el('div', 'blk-empty', '加载文档编辑器…'));
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
        events: { change: function () { dirty = true; } },
      });
      getValue = function () { return editor.getMarkdown(); };
    }).catch(function () {
      toast('文档编辑器加载失败，改用纯文本编辑', true);
      plain();
    });
  }

  // --- Board (TODO.md as kanban) ----------------------------------------------

  var LIST_ITEM_RE = /^([-*+]|\d+[.)])\s+/;
  var TASK_RE = /^([-*+]|\d+[.)])\s+\[([ xX])\]\s?/;
  var DONE_TITLE_RE = /^(done|完成|已完成|finished|closed)$/i;

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
      preamble.cards.forEach(function (c) { (/^\S+\s+\[[xX]\]/.test(c.lines[0]) ? done : todo).cards.push(c); });
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
    if (TASK_RE.test(first)) {
      card.lines[0] = first.replace(/^(\S+\s+)\[[ xX]\]/, '$1[' + (done ? 'x' : ' ') + ']');
    }
  }

  function cardText(card) {
    return card.lines[0].replace(TASK_RE, '').replace(LIST_ITEM_RE, '');
  }

  function renderBoard(body, file, refresh) {
    if (!file || file.rawContent == null) return;
    var board = parseBoard(file.rawContent);
    var expected = { mtimeMs: file.mtimeMs, size: file.size };
    var wrap = el('div', 'blk-board');
    wrap.setAttribute('data-fp-hold-refresh', '');
    var bar = el('div', 'blk-row blk-editor-bar');
    var status = el('span', 'blk-muted', '拖动卡片调整状态与顺序，改动直接写回 ' + file.filename);
    bar.append(button('返回文档', function () { refresh(); }, 'blk-btn-ghost blk-btn-small'), status);
    var lanes = el('div', 'blk-lanes');
    wrap.append(bar, lanes);
    body.replaceChildren(wrap);

    function save() {
      var content = serializeBoard(board);
      return apiSend('PUT', '/api/files/content', {
        path: file.absPath, content: content, expectedMtimeMs: expected.mtimeMs, expectedSize: expected.size,
      }).then(function (data) {
        expected = { mtimeMs: data.mtimeMs, size: data.size };
        file.rawContent = content;
        file.mtimeMs = data.mtimeMs;
        file.size = data.size;
        status.textContent = '已保存';
        status.classList.remove('is-error');
      }).catch(function (err) {
        status.textContent = err.message === 'file_changed_on_disk' ? '文件已被其它程序修改，请点“返回文档”后重新打开看板' : '保存失败：' + err.message;
        status.classList.add('is-error');
      });
    }

    function draw() {
      lanes.replaceChildren();
      board.columns.forEach(function (col, colIndex) {
        var lane = el('div', 'blk-lane');
        var head = el('div', 'blk-lane-head');
        head.append(el('strong', '', col.title), el('span', 'blk-pill', String(col.cards.length)));
        var add = button('+', function () {
          var text = prompt('新卡片');
          if (!text || !text.trim()) return;
          var done = DONE_TITLE_RE.test(col.title);
          col.cards.push({ lines: ['- [' + (done ? 'x' : ' ') + '] ' + text.trim()] });
          draw();
          save();
        }, 'blk-icon-btn');
        add.title = '添加卡片';
        head.appendChild(add);
        var list = el('div', 'blk-cards');
        list.dataset.col = String(colIndex);
        col.cards.forEach(function (card) {
          var item = el('div', 'blk-card');
          var done = /^\S+\s+\[[xX]\]/.test(card.lines[0]);
          item.classList.toggle('is-done', done);
          item.appendChild(el('div', 'blk-card-title', cardText(card)));
          if (card.lines.length > 1) item.appendChild(el('div', 'blk-card-notes', card.lines.slice(1).map(function (l) { return l.trim(); }).join('\n')));
          item._card = card;
          list.appendChild(item);
        });
        lane.append(head, list);
        lanes.appendChild(lane);
      });
      loadScript(CDN.sortable).then(function () {
        lanes.querySelectorAll('.blk-cards').forEach(function (list) {
          window.Sortable.create(list, {
            group: 'blk-board', animation: 150, ghostClass: 'is-ghost',
            onEnd: function () {
              // Rebuild every column from the DOM order.
              lanes.querySelectorAll('.blk-cards').forEach(function (l) {
                var col = board.columns[Number(l.dataset.col)];
                col.cards = Array.prototype.map.call(l.children, function (n) { return n._card; }).filter(Boolean);
                var doneLane = board.statusMode ? col.title === '完成' : DONE_TITLE_RE.test(col.title);
                col.cards.forEach(function (card) {
                  if (board.statusMode || doneLane) setCardDone(card, doneLane);
                  else if (/^\S+\s+\[[xX]\]/.test(card.lines[0]) && board.columns.some(function (c) { return DONE_TITLE_RE.test(c.title); })) setCardDone(card, false);
                });
              });
              draw();
              save();
            },
          });
        });
      }).catch(function () { status.textContent = '拖拽组件加载失败，看板只读'; });
    }
    draw();
  }

  function isBoardFile(path) {
    return /(^|\/)(todo|TODO|Todo|kanban|KANBAN|board)\.md$/.test(path || '');
  }

  // --- Browser block ----------------------------------------------------------

  function openBrowser(address) {
    var panel = openPanel('浏览器', { className: 'blk-browser', side: true });
    var form = el('form', 'blk-url');
    var input = el('input', 'blk-input');
    input.type = 'url';
    input.placeholder = 'http://localhost:3000';
    input.value = address || '';
    var go = button('打开', function () {}, 'blk-btn-small');
    go.type = 'submit';
    var reload = button('↻', function () { if (frame.src) frame.src = frame.src; }, 'blk-icon-btn');
    reload.title = '重新加载';
    var external = button('↗', function () { if (frame.src) window.open(frame.src, '_blank', 'noopener'); }, 'blk-icon-btn');
    external.title = '在新标签页打开';
    var wide = button('⇔', function () { panel.overlay.classList.toggle('blk-side-wide'); }, 'blk-icon-btn');
    wide.title = '加宽 / 还原';
    form.append(input, go, reload, external, wide);
    var hint = el('div', 'blk-muted blk-browser-hint', '提示：设置了 X-Frame-Options 的网站无法内嵌，请用 ↗ 在新标签页打开；地址在浏览器所在电脑上解析。');
    var frame = el('iframe', 'blk-browser-frame');
    frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin allow-popups allow-modals allow-downloads');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    panel.body.append(form, hint, frame);
    function navigate() {
      var value = input.value.trim();
      if (!value) return;
      if (!/^https?:\/\//i.test(value)) value = (/^(localhost|127\.|\[::1\])/.test(value) ? 'http://' : 'https://') + value;
      input.value = value;
      frame.src = value;
      panel.titleEl.textContent = '浏览器 · ' + value.replace(/^https?:\/\//, '').split('/')[0];
    }
    form.addEventListener('submit', function (e) { e.preventDefault(); navigate(); });
    if (address) navigate(); else setTimeout(function () { input.focus(); }, 0);
    return panel;
  }

  // --- Theme picker with live preview -----------------------------------------

  function openThemePicker() {
    if (typeof Theme === 'undefined') return;
    var original = Theme.getCurrent();
    var themes = Theme.getThemeList();
    var committed = false;
    var panel = openPanel('切换主题', {
      className: 'blk-themes',
      onClose: function () { if (!committed) Theme.apply(original); },
    });
    panel.body.appendChild(el('div', 'blk-muted', '↑ ↓ 预览 · Enter 使用 · Esc 恢复原主题'));
    var list = el('div', 'blk-theme-list');
    list.setAttribute('role', 'listbox');
    list.tabIndex = 0;
    var index = Math.max(0, themes.findIndex(function (t) { return t.id === original; }));
    themes.forEach(function (theme, i) {
      var row = el('div', 'blk-theme');
      row.setAttribute('role', 'option');
      var swatch = el('span', 'blk-swatch');
      var term = theme.terminal || {};
      [term.background, term.red, term.green, term.yellow, term.blue, term.magenta, term.cyan, term.foreground].forEach(function (color) {
        var dot = el('i');
        dot.style.background = color || 'transparent';
        swatch.appendChild(dot);
      });
      row.append(swatch, el('span', 'blk-theme-name', theme.name), el('span', 'blk-muted', theme.id === original ? '当前' : (theme.colorScheme === 'light' ? '浅色' : '深色')));
      row.addEventListener('mouseenter', function () { select(i); });
      row.addEventListener('click', function () { select(i); commit(); });
      list.appendChild(row);
    });
    panel.body.appendChild(list);
    function select(i) {
      index = (i + themes.length) % themes.length;
      Array.prototype.forEach.call(list.children, function (row, j) {
        row.classList.toggle('is-active', j === index);
        row.setAttribute('aria-selected', String(j === index));
        if (j === index) row.scrollIntoView({ block: 'nearest' });
      });
      Theme.apply(themes[index].id);
    }
    function commit() {
      committed = true;
      panel.close();
      toast('主题：' + themes[index].name);
    }
    panel.overlay.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); select(index + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); select(index - 1); }
      else if (e.key === 'Enter') { e.preventDefault(); commit(); }
    });
    select(index);
    setTimeout(function () { list.focus(); }, 0);
  }

  // --- Commands and shortcuts --------------------------------------------------

  function newShellWindow() {
    var ctx = currentContext();
    if (!ctx.sessionId) { toast('先打开一个会话', true); return; }
    Api.post(Api.workspaceUrl(ctx.serverId, '/sessions/' + encodeURIComponent(ctx.sessionId) + '/windows'), {})
      .then(function (created) {
        if (typeof Router !== 'undefined' && created && created.id) {
          Router.go({ name: 'terminal', params: { serverId: ctx.serverId, sessionId: ctx.sessionId, windowId: created.id } });
        }
      })
      .catch(function (err) { toast(err.message, true); });
  }

  function openFiles() {
    var ctx = currentContext();
    if (window.FilePreview) FilePreview.openFile('.', ctx.paneId);
  }

  function openBoard() {
    var ctx = currentContext();
    if (window.FilePreview) FilePreview.openFile('TODO.md', ctx.paneId);
  }

  function openTaskManager() {
    if (typeof Router !== 'undefined') Router.go({ name: 'server', params: { serverId: currentContext().serverId, section: 'performance' } });
  }

  function switchHost() {
    if (window.CommandPalette) window.CommandPalette.open(null, '服务器');
  }

  var COMMANDS = [
    { id: 'shell', title: '新建 Shell 窗口', keys: 'Alt+Shift+T', code: 'KeyT', run: newShellWindow, keywords: 'new window terminal shell 新窗口' },
    { id: 'git', title: 'Git', keys: 'Alt+Shift+G', code: 'KeyG', run: function () { openGit('.', currentContext().paneId); }, keywords: 'git diff stage commit 提交 暂存 历史' },
    { id: 'files', title: '文件', keys: 'Alt+Shift+O', code: 'KeyO', run: openFiles, keywords: 'files browse 目录 文件' },
    { id: 'board', title: '看板（TODO.md）', keys: 'Alt+Shift+K', code: 'KeyK', run: openBoard, keywords: 'kanban board todo 看板 待办' },
    { id: 'browser', title: '浏览器', keys: 'Alt+Shift+B', code: 'KeyB', run: function () { openBrowser(''); }, keywords: 'browser web url 网页 预览' },
    { id: 'tasks', title: '任务管理器', keys: 'Alt+Shift+M', code: 'KeyM', run: openTaskManager, keywords: 'process cpu memory gpu 进程 性能' },
    { id: 'host', title: '切换主机', keys: 'Alt+Shift+H', code: 'KeyH', run: switchHost, keywords: 'host server switch 服务器 主机' },
    { id: 'theme', title: '切换主题…', keys: 'Alt+Shift+Y', code: 'KeyY', run: openThemePicker, keywords: 'theme color 主题 配色 外观' },
  ];

  function commands() {
    return COMMANDS.map(function (c) {
      return { display: c.title, meta: c.keys, keywords: c.keywords + ' block 块 命令', icon: 'settings', run: c.run, kind: '命令' };
    });
  }

  if (typeof document !== 'undefined') {
    // Capture phase so the shortcut wins over xterm, which would send it to the shell.
    document.addEventListener('keydown', function (e) {
      if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey || e.isComposing) return;
      var command = COMMANDS.find(function (c) { return c.code === e.code; });
      if (!command) return;
      e.preventDefault();
      e.stopPropagation();
      command.run();
    }, true);
  }

  // --- File preview integration ------------------------------------------------

  // TODO.md opens straight into the board. "返回文档" switches that file to the
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
    var icon = function (d) { return '<path d="' + d + '"/>'; };
    if (!file.isDirectory && file.isText && file.rawContent != null) {
      items.push({ label: '编辑', hint: file.isMarkdown ? '所见即所得的文档编辑' : '直接修改并保存', icon: icon('M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z'),
        run: function () { openEditor(ctx.body, file, ctx.refresh); } });
    }
    if (!file.isDirectory && file.isMarkdown && file.rawContent != null) {
      items.push({ label: '看板视图', hint: '## 标题作列、列表项作卡片', icon: icon('M3 4h5v16H3zM10 4h5v10h-5zM17 4h4v7h-4z'),
        run: function () { renderBoard(ctx.body, file, ctx.refresh); } });
    }
    items.push({ label: 'Git', hint: '查看所在仓库的改动与历史', icon: icon('M6 3v12M18 9a3 3 0 1 0 0-.01M6 21a3 3 0 1 0 0-.01M18 12c0 4-6 3-12 6'),
      run: function () { openGit(file.absPath, ctx.paneId); } });
    return items;
  }

  /** `twp open` pushed from a pane on the server in view. */
  function handleOpenEvent(event) {
    if (event.type === 'open-url') { openBrowser(event.url); return; }
    if (event.type === 'open-file' && window.FilePreview) {
      FilePreview.openFile(event.path, event.paneId || currentContext().paneId);
    }
  }

  return {
    rendererFor: rendererFor,
    renderSqlite: renderSqlite,
    decorateGitGutter: decorateGitGutter,
    previewActions: previewActions,
    handleOpenEvent: handleOpenEvent,
    openGit: openGit,
    openBrowser: openBrowser,
    openThemePicker: openThemePicker,
    commands: commands,
    _test: {
      parseUnifiedDiff: parseUnifiedDiff,
      buildPatch: buildPatch,
      parseBoard: parseBoard,
      serializeBoard: serializeBoard,
      colorGraph: colorGraph,
    },
  };
})();

if (typeof window !== 'undefined') window.Blocks = Blocks;
