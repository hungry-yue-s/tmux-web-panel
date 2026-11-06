/* global Api, Blocks, BlockHost, Router, FilePreview, PanelSlots */

// The Git block (hosted by BlockHost, plugins/ui), the git status chip in the
// top bar, and the Git command (Alt+Shift+G, the palette). Root CLAUDE.md,
// 文件预览分窗契约, has the rules they keep. Loaded only with the git plugin.

(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.Blocks || !window.BlockHost || !window.PanelSlots) return;

  var ui = Blocks.ui;
  var el = ui.el, button = ui.button, iconButton = ui.iconButton, icon = Blocks.icon;
  var toast = ui.toast, errorText = ui.errorText;

  function relativeBranchName(name) { return String(name || '').replace(/^origin\//, ''); }

  function splitPath(path) {
    var at = path.lastIndexOf('/');
    return at === -1 ? { dir: '', name: path } : { dir: path.slice(0, at + 1), name: path.slice(at + 1) };
  }

  function queryString(params) {
    return Object.keys(params).filter(function (k) { return params[k] != null && params[k] !== ''; })
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
  }

  /** A diff that names files but has nothing to show for them: binary files. */
  function isBinaryDiff(text) {
    var files = ui.parseUnifiedDiff(text);
    return files.length > 0 && files.every(function (f) { return f.binary && !f.hunks.length; });
  }

  /** One file's part of a multi-file diff. */
  function fileDiff(text, path) {
    return String(text || '').split(/\n(?=diff --git )/).find(function (part) {
      var parsed = ui.parseUnifiedDiff(part)[0];
      return parsed && parsed.name === path;
    }) || '';
  }

  function disposePreviews(node) {
    if (!window.FilePreview || !FilePreview.disposeRendered) return;
    node.querySelectorAll('.fp-embedded').forEach(function (box) { FilePreview.disposeRendered(box); });
  }

  // ===========================================================================
  // Git block
  // ===========================================================================

  var STATUS_LABEL = { M: '已修改', A: '新增', D: '已删除', R: '重命名', C: '复制', U: '冲突', '?': '未跟踪', T: '类型变化' };

  var RESTORED_LOAD_DELAY_MS = 800;
  // A large commit, drawn as lazygit would: only what is near the screen, a little at a time.
  var LAZY_DIFFS_AT_ONCE = 3;
  var LAZY_DIFF_LINES = 400;
  var INLINE_DIFF_LINES = 600;
  var LAZY_DIFF_ASK_LINES = 2000;
  var FILE_LIST_SHOWN = 300;
  var DIFF_LINE_PX = 20;

  // Pending parents keep their lane and color until reached. Empty lanes can be
  // reused, but live lanes never jump sideways when another branch ends.
  function commitGraph(commits) {
    var lanes = [], colors = 0, width = 1;
    var byHash = new Map(commits.map(function (commit) { return [commit.hash, commit]; }));
    var main = new Set();
    var head = commits.find(function (commit) { return commit.refs.some(function (ref) { return ref === 'HEAD' || ref.indexOf('HEAD -> ') === 0; }); });
    var mainHash = head && head.hash;
    while (mainHash && !main.has(mainHash)) {
      main.add(mainHash);
      var ancestor = byHash.get(mainHash);
      mainHash = ancestor && ancestor.parents[0];
    }
    var rows = commits.map(function (commit, index) {
      var column = lanes.findIndex(function (lane) { return lane && lane.to === commit.hash; });
      var incoming = column !== -1;
      if (!incoming) {
        column = lanes.findIndex(function (lane) { return !lane; });
        if (column === -1) column = lanes.length;
      }
      var color = main.has(commit.hash) ? 0 : incoming ? lanes[column].color : 1 + colors++ % 5;
      var edges = [];
      lanes.forEach(function (lane, at) {
        if (lane) edges.push({ from: lane.from, to: lane.to, color: lane.color, x1: at, x2: at, y1: 0, y2: at === column ? 50 : 100,
          boundary: index === commits.length - 1 && at !== column });
      });
      lanes[column] = null;
      commit.parents.forEach(function (parent, parentIndex) {
        var at = lanes.findIndex(function (lane) { return lane && lane.to === parent; });
        if (at === -1) {
          at = parentIndex === 0 ? column : lanes.findIndex(function (lane) { return !lane; });
          if (at === -1) at = lanes.length;
          lanes[at] = { from: [commit.hash], to: parent, color: main.has(parent) ? 0 : parentIndex === 0 ? color : 1 + colors++ % 5 };
        } else lanes[at].from = lanes[at].from.concat(commit.hash);
        edges.push({ from: [commit.hash], to: parent, color: lanes[at].color, x1: column, x2: at, y1: 50, y2: 100,
          boundary: index === commits.length - 1 });
      });
      width = Math.max(width, column + 1, lanes.length);
      var rightmost = edges.reduce(function (at, edge) { return Math.max(at, edge.x1, edge.x2); }, column);
      return { column: column, color: color, merge: commit.parents.length > 1, edges: edges, width: (rightmost + 1) * 14 + 4 };
    });
    return { width: width * 14 + 4, rows: rows };
  }

  function gitBlock(api) {
    var c = ui.client(api.serverId);
    var target = { path: api.params.path || '.', paneId: api.params.paneId || undefined };
    var root = el('div', 'git-block');

    // --- top bar ---
    var bar = el('div', 'blk-toolbar git-bar');
    var branchBtn = button('…', function () { toggleBranchMenu(); }, { icon: 'branch', className: 'git-branch-btn blk-btn-ghost' });
    branchBtn.setAttribute('aria-haspopup', 'listbox');
    branchBtn.appendChild(el('span', 'git-branch-caret')).innerHTML = icon('chevronDown');
    var trackBox = el('span', 'git-track');
    // A refresh that failed leaves what was there and says so here; the next one that works clears it.
    var refreshFailed = button('刷新失败', function () { load(true); }, { icon: 'refresh', className: 'blk-btn-ghost blk-btn-small git-refresh-failed' });
    refreshFailed.hidden = true;
    var left = el('div', 'blk-row git-bar-left');
    left.append(branchBtn, trackBox, refreshFailed);
    var segmented = el('div', 'blk-segmented');
    var changesTab = button('更改', function () { show('changes'); }, { icon: 'changes', className: 'is-active' });
    var historyTab = button('历史', function () { show('history'); }, { icon: 'history' });
    changesTab.setAttribute('aria-label', '更改');
    historyTab.setAttribute('aria-label', '历史');
    changesTab.setAttribute('aria-pressed', 'true');
    historyTab.setAttribute('aria-pressed', 'false');
    segmented.append(changesTab, historyTab);
    var fetchBtn = iconButton('fetch', '获取远程更新（fetch）', function () { sync('fetch', fetchBtn); });
    var pullBtn = button('拉取', function () { sync('pull', pullBtn); }, { icon: 'down', className: 'blk-btn-ghost git-sync-btn', title: '拉取（pull --ff-only）' });
    var pushBtn = button('推送', function () { sync('push', pushBtn); }, { icon: 'up', className: 'blk-btn-ghost git-sync-btn', title: '推送（push）' });
    pullBtn.setAttribute('aria-label', '拉取（pull --ff-only）');
    pushBtn.setAttribute('aria-label', '推送（push）');
    var refreshBtn = iconButton('refresh', '刷新', function () { load(true); });
    var right = el('div', 'blk-row git-bar-right');
    right.append(segmented, fetchBtn, pullBtn, pushBtn, refreshBtn);
    bar.append(left, right);

    var changesView = el('div', 'git-changes');
    var historyView = el('div', 'git-history');
    historyView.hidden = true;
    var stateBox = el('div', 'git-state');
    root.append(bar, stateBox, changesView, historyView);
    stateBox.appendChild(ui.spinnerLine('读取仓库'));
    changesView.hidden = true;

    var historyWidth = Number(api.params.historyWidth) || 38;
    var fitGraphGutter = function () {};
    var graphFrame = null;
    var historyGrip = el('div', 'git-history-resizer');
    historyGrip.tabIndex = 0;
    historyGrip.setAttribute('role', 'separator');
    historyGrip.setAttribute('aria-label', '历史列表宽度');
    historyGrip.setAttribute('aria-orientation', 'vertical');
    function resizeHistory(value, save) {
      var width = historyView.clientWidth;
      var min = width > 760 ? 240 / width * 100 : 0;
      var max = width > 760 ? (width - 328) / width * 100 : 100;
      historyWidth = Math.max(min, Math.min(max, value));
      historyView.style.setProperty('--git-history-width', historyWidth + '%');
      historyGrip.setAttribute('aria-valuemin', String(Math.round(min)));
      historyGrip.setAttribute('aria-valuemax', String(Math.round(max)));
      historyGrip.setAttribute('aria-valuenow', String(Math.round(historyWidth)));
      if (save) api.setParams({ historyWidth: historyWidth });
    }
    resizeHistory(historyWidth, false);
    var historyResize = window.ResizeObserver ? new ResizeObserver(function () {
      if (historyView.clientWidth > 760) resizeHistory(historyWidth, false);
      fitGraphGutter();
    }) : null;
    if (historyResize) historyResize.observe(historyView);
    historyGrip.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      historyGrip.setPointerCapture(e.pointerId);
      historyView.classList.add('is-resizing');
    });
    historyGrip.addEventListener('pointermove', function (e) {
      if (!historyGrip.hasPointerCapture(e.pointerId)) return;
      var rect = historyView.getBoundingClientRect();
      resizeHistory((e.clientX - rect.left) / rect.width * 100, false);
    });
    historyGrip.addEventListener('lostpointercapture', function () {
      historyView.classList.remove('is-resizing');
      resizeHistory(historyWidth, true);
    });
    historyGrip.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home') return;
      e.preventDefault();
      resizeHistory(e.key === 'Home' ? 38 : historyWidth + (e.key === 'ArrowLeft' ? -2 : 2), true);
    });

    var wrapDiff = api.params.wrapDiff !== false;
    root.classList.toggle('is-wrap-diff', wrapDiff);
    function wrapToggle() {
      var toggle = button('自动换行', function () {
        wrapDiff = !wrapDiff;
        root.classList.toggle('is-wrap-diff', wrapDiff);
        root.querySelectorAll('.git-wrap-toggle').forEach(function (b) { b.setAttribute('aria-pressed', String(wrapDiff)); });
        api.setParams({ wrapDiff: wrapDiff });
      }, { className: 'blk-btn-ghost blk-btn-small git-wrap-toggle' });
      toggle.setAttribute('aria-pressed', String(wrapDiff));
      return toggle;
    }

    // --- changes: list + commit on the left, diff on the right ---
    var side = el('div', 'git-side');
    var list = el('div', 'git-list');
    list.tabIndex = 0;
    list.setAttribute('data-autofocus', '');
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', '改动的文件');
    var commitBox = el('div', 'git-commit');
    side.append(list, commitBox);
    var main = el('div', 'git-main');
    changesView.append(side, main);

    var message = el('textarea', 'blk-input git-message');
    message.placeholder = '提交说明';
    message.rows = 3;
    message.setAttribute('aria-label', '提交说明');
    var counter = el('span', 'git-counter');
    var messageWrap = el('div', 'git-message-wrap');
    messageWrap.append(message, counter);
    var generate = button('生成说明', function () { generateMessage(); }, { icon: 'sparkles', className: 'blk-btn-ghost blk-btn-small', title: '根据已暂存的改动生成提交说明' });
    var amendLabel = el('label', 'blk-switch');
    var amend = el('input');
    amend.type = 'checkbox';
    amendLabel.append(amend, el('span', 'blk-switch-track'), el('span', '', '修改上次提交'));
    var commitBtn = button('提交', function () { doCommit(); }, { icon: 'check', className: 'blk-btn-primary git-commit-btn', kbd: 'Mod+Enter' });
    var undoBtn = button('撤销上次提交', function () { undoCommit(); }, { icon: 'undo', className: 'blk-btn-ghost blk-btn-small' });
    var commitTools = el('div', 'blk-row git-commit-tools');
    commitTools.append(generate, amendLabel);
    var commitFoot = el('div', 'blk-row git-commit-foot');
    commitFoot.append(undoBtn, commitBtn);
    commitBox.append(messageWrap, commitTools, commitFoot);

    var status = null;
    var statusJson = '';
    var selection = null; // { path, staged }
    var lastDiffKey = '';
    var loading = null; // { writes, force, promise }
    var diffAsked = null;
    var historyLoading = null;
    var historyJson = '';
    var historyLoaded = false;
    // Writes finished so far: a read from before one is no answer after it.
    var writes = 0;
    var send = c.send;
    c = Object.assign({}, c, {
      send: function () {
        var sent = send.apply(null, arguments);
        var done = function () { writes += 1; };
        sent.then(done, done);
        return sent;
      },
    });

    var failures = {};
    function refreshFailedFor(kind, err) {
      if (err) failures[kind] = errorText(err);
      else delete failures[kind];
      var reasons = Object.keys(failures).map(function (k) { return failures[k]; });
      refreshFailed.hidden = reasons.length === 0;
      refreshFailed.title = reasons.length ? '刷新失败，显示的是上次的内容：' + reasons.join('；') + '\n点击重试' : '';
      refreshFailed.setAttribute('aria-label', refreshFailed.title);
    }
    var pollTimer = null;
    // A file is shown as its diff or as the file itself, the way the file preview
    // shows it, before or after the change. The choice carries over to the next file.
    var viewMode = 'diff';
    var viewSide = 'after';
    // Binary files have no diff worth reading and open as the file, unless asked.
    var diffAskedFor = null;
    // A large commit's per-file diffs, loaded as they come near the screen.
    var lazyObserver = null;

    function stopLazyDiffs() {
      if (lazyObserver) lazyObserver.disconnect();
      lazyObserver = null;
    }

    function rootPath(rel) { return status.root.replace(/\/$/, '') + '/' + rel; }

    function modeFor(binary, key) {
      return binary && viewMode === 'diff' && diffAskedFor !== key ? 'preview' : viewMode;
    }

    function sideFor(versions) {
      return versions[viewSide] ? viewSide : (versions.after ? 'after' : 'before');
    }

    /** 差异 | 预览, and when previewing, which version. */
    function viewSwitch(versions, mode, side, key, rerender) {
      var box = el('div', 'git-view-switch');
      var modes = el('div', 'blk-segmented');
      modes.setAttribute('aria-label', '显示方式');
      [['diff', '差异'], ['preview', '预览']].forEach(function (pair) {
        modes.appendChild(button(pair[1], function () {
          viewMode = pair[0];
          diffAskedFor = pair[0] === 'diff' ? key : null;
          rerender();
        }, { className: mode === pair[0] ? 'is-active' : '', title: pair[0] === 'diff' ? '按行查看改动' : '像文件预览一样显示这个文件' }));
      });
      box.appendChild(modes);
      if (mode === 'diff') box.appendChild(wrapToggle());
      if (mode === 'preview') {
        var sides = el('div', 'blk-segmented');
        sides.setAttribute('aria-label', '版本');
        [['before', '改动前'], ['after', '改动后']].forEach(function (pair) {
          var b = button(pair[1], function () { viewSide = pair[0]; rerender(); }, { className: side === pair[0] ? 'is-active' : '' });
          b.disabled = !versions[pair[0]];
          if (b.disabled) b.title = pair[0] === 'before' ? '这是新文件' : '这个文件被删除了';
          sides.appendChild(b);
        });
        box.appendChild(sides);
      }
      return box;
    }

    /**
     * A file as one version has it: WORKTREE (on disk), INDEX, or a commit, rendered
     * by the file preview. Anything but the disk comes through /api/git/file and /raw.
     */
    function versionSource(version) {
      var name = rootPath(version.path);
      if (version.rev === 'WORKTREE') return Promise.resolve({ path: name, machine: api.url('') });
      var query = Object.assign({ rev: version.rev, file: version.path }, target);
      return c.get('/api/git/file', query).then(function (answer) {
        if (answer.tooLarge) throw new Error('文件太大，无法预览（' + (answer.size / 1048576).toFixed(1) + ' MB）');
        // A copy: the answer may be shared with another caller that asked the same.
        var info = Object.assign({}, answer, { absPath: name });
        var token = window.Auth && Auth.wsTokenParam ? Auth.wsTokenParam() : '';
        return {
          info: info, name: name, content: info.content, language: info.language, versioned: true,
          rawUrl: c.url('/api/git/raw') + '?' + queryString(query) + (token ? '&' + token : ''),
        };
      });
    }

    function renderVersion(box, version) {
      var missing = function () { box.replaceChildren(ui.emptyState('file', '这个版本里没有这个文件', '')); };
      if (!version) { missing(); return; }
      if (!window.FilePreview || !FilePreview.renderInto) {
        box.replaceChildren(ui.emptyState('file', '预览不可用', ''));
        return;
      }
      var asked = {};
      box.__gitVersion = asked;
      box.replaceChildren(ui.spinnerLine('读取文件'));
      versionSource(version).then(function (source) {
        if (box.__gitVersion === asked) return FilePreview.renderInto(box, source);
        return null;
      }).catch(function (err) {
        if (box.__gitVersion !== asked) return;
        if (err.message === 'not_in_revision') missing();
        else box.replaceChildren(ui.errorBox(err));
      });
    }

    /** Before and after for a file in the change list; null where there is none. */
    function changeVersions(file, staged) {
      if (staged) {
        return {
          before: file.index === 'A' ? null : { rev: 'HEAD', path: file.from || file.path },
          after: file.index === 'D' ? null : { rev: 'INDEX', path: file.path },
        };
      }
      return {
        before: file.untracked ? null : { rev: 'INDEX', path: file.path },
        after: file.worktree === 'D' ? null : { rev: 'WORKTREE', path: file.path },
      };
    }

    function syncCounter() {
      var subject = message.value.split('\n')[0];
      counter.textContent = subject.length ? String(subject.length) : '';
      counter.classList.toggle('is-warn', subject.length > 50 && subject.length <= 72);
      counter.classList.toggle('is-over', subject.length > 72);
      counter.title = subject.length > 72 ? '标题建议不超过 72 个字符' : '';
      syncCommitButton();
    }
    message.addEventListener('input', syncCounter);
    message.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doCommit(); }
    });
    amend.addEventListener('change', function () {
      if (amend.checked && !message.value.trim() && status && status.head) message.value = status.head.subject;
      syncCounter();
    });

    function stagedCount() { return status ? status.files.filter(function (f) { return f.staged; }).length : 0; }

    function syncCommitButton() {
      var n = stagedCount();
      var label = commitBtn.querySelector('.blk-btn-label');
      if (!label) return; // busy
      if (amend.checked) label.textContent = n ? '修改上次提交（+' + n + ' 个文件）' : '修改上次提交';
      else label.textContent = n ? '提交 ' + n + ' 个文件' : '提交';
      commitBtn.disabled = !amend.checked && n === 0;
      commitBtn.title = commitBtn.disabled ? '先暂存要提交的改动' : '提交 (' + ui.keysText('Mod+Enter') + ')';
      undoBtn.disabled = !(status && status.head);
    }

    // --- loading ---
    /**
     * One status read at a time. Asked for again while one is under way, it joins it,
     * as a forced refresh if this one is; unless a write has finished since that one
     * began, in which case a new read follows it.
     */
    function load(force) {
      if (loading && loading.writes === writes) {
        if (force) loading.force = true;
        return loading.promise;
      }
      if (loading) return loading.promise.then(function () { return load(force); });
      var entry = { writes: writes, force: !!force, promise: null };
      loading = entry;
      var diagnostic = window.Diagnostics && window.Diagnostics.beginGit(api.serverId);
      var rendering = false, renderAt = 0;
      entry.promise = c.get('/api/git/status', target).then(function (data) {
        force = entry.force;
        rendering = true;
        if (diagnostic) renderAt = performance.now();
        refreshFailedFor('status', null);
        var json = JSON.stringify(data);
        var changed = json !== statusJson;
        status = data;
        statusJson = json;
        stateBox.hidden = true;
        changesView.hidden = historyTab.classList.contains('is-active');
        if (target.path !== data.root) {
          // That repository already has its block here, maybe with a draft in it.
          if (api.yieldToTwin({ path: data.root })) return;
          target = { path: data.root };
          api.setParams({ path: data.root, paneId: null });
        }
        api.setTitle(data.root.split('/').filter(Boolean).pop() || 'Git');
        api.setSubtitle(data.detached ? '分离 HEAD' : (data.branch || ''));
        renderBar();
        if (changed || force) {
          if (selection) {
            var still = data.files.find(function (f) { return f.path === selection.path && (selection.staged ? f.staged : f.unstaged); });
            if (!still) {
              var other = data.files.find(function (f) { return f.path === selection.path; });
              selection = other ? { path: other.path, staged: other.staged && !other.unstaged } : null;
            }
          }
          if (!selection && data.files.length) selection = { path: data.files[0].path, staged: !data.files[0].unstaged };
          renderList();
          showDiff(force);
        }
        syncCommitButton();
        if (!historyView.hidden && (force || changed)) loadHistory();
        if (diagnostic) diagnostic({ code: 'GIT_LOAD_OK', renderMs: performance.now() - renderAt, count: data.files.length });
      }).catch(function (err) {
        var notRepo = err.message === 'not_a_git_repository';
        if (diagnostic) diagnostic({ code: rendering ? 'GIT_RENDER_ERROR' : (notRepo ? 'GIT_NOT_REPO' : 'GIT_API_ERROR'), status: err.status });
        // Something is already on screen: it stays, and the bar says the refresh failed.
        if (status) {
          refreshFailedFor('status', notRepo ? new Error('这里已经不是 Git 仓库') : err);
          return;
        }
        stateBox.hidden = false;
        changesView.hidden = true;
        historyView.hidden = true;
        stateBox.replaceChildren(notRepo
          ? ui.emptyState('git', '这里不是 Git 仓库', '在仓库目录里的窗格中打开 Git，或者先运行 git init。')
          : ui.errorBox(err));
        api.setSubtitle('');
      }).finally(function () { if (loading === entry) loading = null; });
      return entry.promise;
    }

    function renderBar() {
      var label = branchBtn.querySelector('.blk-btn-label');
      if (label) label.textContent = status.detached ? '分离 HEAD' : (status.branch || '—');
      branchBtn.title = status.upstream ? status.branch + ' → ' + status.upstream : '没有上游分支';
      trackBox.replaceChildren();
      if (status.ahead) trackBox.appendChild(el('span', 'blk-pill is-ahead', '↑' + status.ahead));
      if (status.behind) trackBox.appendChild(el('span', 'blk-pill is-behind', '↓' + status.behind));
      if (!status.upstream && !status.detached) trackBox.appendChild(el('span', 'blk-muted', '未发布'));
      pushBtn.classList.toggle('has-badge', status.ahead > 0 || (!status.upstream && !!status.branch));
      pullBtn.classList.toggle('has-badge', status.behind > 0);
      var changesLabel = changesTab.querySelector('.blk-btn-label');
      if (changesLabel) changesLabel.textContent = status.files.length ? '更改 ' + status.files.length : '更改';
    }

    // --- file list ---
    function rows() { return Array.prototype.slice.call(list.querySelectorAll('.git-file')); }

    function renderList() {
      var focusInList = list.contains(document.activeElement);
      var scroll = list.scrollTop;
      list.replaceChildren();
      var staged = status.files.filter(function (f) { return f.staged; });
      var unstaged = status.files.filter(function (f) { return f.unstaged; });
      if (!status.files.length) {
        list.appendChild(ui.emptyState('check', '工作区是干净的', status.head ? '最新提交：' + status.head.hash + ' ' + status.head.subject : '还没有任何提交'));
        return;
      }
      if (staged.length) list.appendChild(group('已暂存', staged, true));
      if (unstaged.length) list.appendChild(group('更改', unstaged, false));
      list.scrollTop = scroll;
      if (focusInList) list.focus({ preventScroll: true });
    }

    function group(title, files, staged) {
      var box = el('div', 'git-group');
      var head = el('div', 'git-group-head');
      head.appendChild(el('span', '', title));
      head.appendChild(el('span', 'blk-pill', String(files.length)));
      var all = button(staged ? '全部取消暂存' : '全部暂存', function () {
        act(staged ? 'unstage' : 'stage', files.map(function (f) { return f.path; }));
      }, { className: 'blk-btn-ghost blk-btn-small' });
      head.appendChild(all);
      box.appendChild(head);
      files.forEach(function (f) { box.appendChild(fileRow(f, staged)); });
      return box;
    }

    function fileRow(file, staged) {
      var active = selection && selection.path === file.path && selection.staged === staged;
      var row = el('div', 'git-file' + (active ? ' is-active' : ''));
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(!!active));
      row.dataset.path = file.path;
      row.dataset.staged = staged ? '1' : '0';
      var code = file.conflicted ? 'U' : staged ? file.index : (file.untracked ? '?' : file.worktree);
      var badge = el('span', 'git-badge git-badge-' + (code === '?' ? 'u' : code.toLowerCase()), code === '?' ? 'U' : code);
      badge.title = file.conflicted ? '冲突' : (STATUS_LABEL[code] || code);
      var parts = splitPath(file.path);
      var name = el('span', 'git-file-name');
      name.appendChild(el('span', 'git-file-base', parts.name));
      if (parts.dir) name.appendChild(el('span', 'git-file-dir', parts.dir.replace(/\/$/, '')));
      name.title = (file.from ? file.from + ' → ' : '') + file.path;
      var actions = el('span', 'git-file-actions');
      if (staged) {
        actions.appendChild(iconButton('minus', '取消暂存', function (e) { e.stopPropagation(); act('unstage', [file.path]); }));
      } else {
        actions.appendChild(iconButton(file.untracked ? 'trash' : 'undo', file.untracked ? '删除文件' : '丢弃改动', function (e) {
          e.stopPropagation();
          discard(file);
        }, 'blk-btn-danger'));
        actions.appendChild(iconButton('plus', '暂存', function (e) { e.stopPropagation(); act('stage', [file.path]); }));
      }
      actions.appendChild(iconButton('file', '打开文件', function (e) {
        e.stopPropagation();
        if (window.FilePreview) FilePreview.openFile(rootPath(file.path), null);
      }));
      row.append(badge, name, actions);
      row.addEventListener('click', function () { select(file.path, staged); });
      row.addEventListener('dblclick', function () { act(staged ? 'unstage' : 'stage', [file.path]); });
      return row;
    }

    function select(path, staged) {
      if (!selection || selection.path !== path || selection.staged !== staged) viewSide = 'after';
      selection = { path: path, staged: staged };
      rows().forEach(function (r) {
        var on = r.dataset.path === path && (r.dataset.staged === '1') === staged;
        r.classList.toggle('is-active', on);
        r.setAttribute('aria-selected', String(on));
        if (on) r.scrollIntoView({ block: 'nearest' });
      });
      showDiff();
    }

    list.addEventListener('keydown', function (e) {
      var all = rows();
      if (!all.length) return;
      var index = all.findIndex(function (r) { return r.classList.contains('is-active'); });
      var current = all[index];
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        var next = all[Math.min(all.length - 1, index + 1)];
        select(next.dataset.path, next.dataset.staged === '1');
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        var prev = all[Math.max(0, index - 1)];
        select(prev.dataset.path, prev.dataset.staged === '1');
      } else if ((e.key === ' ' || e.key === 'Enter') && current) {
        e.preventDefault();
        act(current.dataset.staged === '1' ? 'unstage' : 'stage', [current.dataset.path]);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && current && current.dataset.staged === '0') {
        e.preventDefault();
        var file = status.files.find(function (f) { return f.path === current.dataset.path; });
        if (file) discard(file);
      }
    });

    function act(action, files, extra) {
      return c.send('POST', '/api/git/' + action, Object.assign({ files: files }, target, extra || {}))
        .then(function () { return load(true); })
        .catch(function (err) { toast(errorText(err), { error: true }); });
    }

    function discard(file) {
      ui.confirmAction({
        title: file.untracked ? '删除 ' + file.path + '？' : '丢弃对 ' + file.path + ' 的改动？',
        message: file.untracked ? '这个文件还没被 Git 跟踪，删除后无法找回。' : '工作区里的改动会被还原到暂存区或最新提交的版本，无法撤销。',
        confirmLabel: file.untracked ? '删除文件' : '丢弃改动',
        danger: true,
      }).then(function (ok) {
        if (ok) act('discard', [file.path], file.untracked ? { untracked: [file.path] } : null);
      });
    }

    // --- diff ---
    function showDiff(force) {
      if (!selection) {
        disposePreviews(main);
        main.replaceChildren(ui.emptyState('changes', status && status.files.length ? '选择一个文件查看差异' : '没有改动', status && status.files.length ? '点击行可以选中，按块或按行暂存。' : ''));
        lastDiffKey = '';
        return;
      }
      var file = status.files.find(function (f) { return f.path === selection.path; });
      if (!file) return;
      var staged = selection.staged;
      var query = Object.assign({ file: file.path, staged: staged ? '1' : '0', untracked: !staged && file.untracked ? '1' : '0' }, target);
      var diagnostic = window.Diagnostics && window.Diagnostics.beginGit(api.serverId);
      var rendering = false, renderAt = 0;
      var fileKey = file.path + '\u0000' + staged;
      // Only the latest file asked for lands: another one picked meanwhile wins.
      var asked = {};
      diffAsked = asked;
      c.get('/api/git/diff', query).then(function (data) {
        if (diffAsked !== asked) return;
        rendering = true;
        if (diagnostic) renderAt = performance.now();
        refreshFailedFor('diff', null);
        var mode = modeFor(isBinaryDiff(data.diff), fileKey);
        var versions = changeVersions(file, staged);
        var side = sideFor(versions);
        // The diff stands in for the file's content: unchanged, nothing is redrawn.
        var key = [fileKey, mode, side, data.diff].join('\u0000');
        if (!force && key === lastDiffKey) return; // keep line selections and the preview across background refreshes
        lastDiffKey = key;
        var scroll = main.querySelector('.git-diff-scroll');
        var top = scroll ? scroll.scrollTop : 0;
        var head = el('div', 'git-diff-head');
        var parts = splitPath(file.path);
        var title = el('div', 'git-diff-title');
        title.appendChild(el('strong', '', parts.name));
        if (parts.dir) title.appendChild(el('span', 'blk-muted', parts.dir.replace(/\/$/, '')));
        var stats = el('span', 'blk-diff-stats');
        var scope = el('span', 'blk-pill', staged ? '已暂存' : (file.untracked ? '新文件' : '工作区'));
        head.append(title, stats, scope, viewSwitch(versions, mode, side, fileKey, function () { showDiff(true); }), iconButton('file', '打开文件', function () {
          if (window.FilePreview) FilePreview.openFile(rootPath(file.path), null);
        }));
        disposePreviews(main);
        if (mode === 'preview') {
          var preview = el('div', 'git-preview');
          main.replaceChildren(head, preview);
          renderVersion(preview, versions[side]);
          return;
        }
        var box = el('div', 'git-diff-scroll');
        var files = ui.renderDiffInto(box, data.diff, {
          fileHeaders: false,
          actions: file.untracked ? null : function (f, hunk, picked) {
            function apply(reverse, cached, all) {
              var patch = ui.buildPatch(f, hunk, all ? null : picked(), reverse);
              if (!patch) { toast('先点击选择要处理的行', { error: true }); return; }
              c.send('POST', '/api/git/apply', Object.assign({ patch: patch, cached: cached, reverse: reverse }, target))
                .then(function () { return load(true); }).catch(function (err) { toast(errorText(err), { error: true }); });
            }
            if (staged) {
              return [
                button('取消暂存所选行', function () { apply(true, true, false); }, { className: 'blk-btn-ghost blk-btn-small needs-selection' }),
                button('取消暂存此块', function () { apply(true, true, true); }, { icon: 'minus', className: 'blk-btn-small' }),
              ];
            }
            return [
              button('丢弃此块', function () {
                ui.confirmAction({ title: '丢弃这一块改动？', message: '这些行会被还原，无法撤销。', confirmLabel: '丢弃', danger: true })
                  .then(function (ok) { if (ok) apply(true, false, true); });
              }, { icon: 'undo', className: 'blk-btn-ghost blk-btn-small blk-btn-danger' }),
              button('暂存所选行', function () { apply(false, true, false); }, { className: 'blk-btn-ghost blk-btn-small needs-selection' }),
              button('暂存此块', function () { apply(false, true, true); }, { icon: 'plus', className: 'blk-btn-small' }),
            ];
          },
        });
        var added = files.reduce(function (n, f) { return n + f.added; }, 0);
        var removed = files.reduce(function (n, f) { return n + f.removed; }, 0);
        stats.append(el('span', 'is-add', '+' + added), el('span', 'is-del', '−' + removed));
        main.replaceChildren(head, box);
        box.scrollTop = top;
        if (diagnostic) diagnostic({ code: 'GIT_DIFF_OK', renderMs: performance.now() - renderAt });
      }).catch(function (err) {
        if (diffAsked !== asked) return;
        if (diagnostic) diagnostic({ code: rendering ? 'GIT_RENDER_ERROR' : 'GIT_DIFF_ERROR', status: err.status });
        // This file is already on screen: it stays, and the bar says the refresh failed.
        if (lastDiffKey.indexOf(fileKey + '\u0000') === 0) {
          refreshFailedFor('diff', err);
          return;
        }
        lastDiffKey = '';
        main.replaceChildren(ui.errorBox(err));
      });
    }

    // --- commit ---
    function doCommit() {
      if (commitBtn.disabled) return;
      if (!message.value.trim()) {
        toast('请填写提交说明，或点“生成说明”', { error: true });
        message.focus();
        return;
      }
      var done = ui.busy(commitBtn, '提交中');
      c.send('POST', '/api/git/commit', Object.assign({ message: message.value, amend: amend.checked }, target))
        .then(function (data) {
          message.value = '';
          amend.checked = false;
          selection = null;
          done();
          syncCounter();
          toast('已提交 ' + data.hash + ' · ' + data.subject, { action: { label: '撤销', run: function () { undoCommit(true); } } });
          return load(true);
        })
        .catch(function (err) { done(); syncCommitButton(); toast(errorText(err), { error: true }); });
    }

    function undoCommit(skipConfirm) {
      var go = skipConfirm ? Promise.resolve(true) : ui.confirmAction({
        title: '撤销上一次提交？', message: '提交会被移除，改动保留在暂存区，提交说明会填回输入框。', confirmLabel: '撤销提交',
      });
      go.then(function (ok) {
        if (!ok) return;
        c.send('POST', '/api/git/undo-commit', target).then(function (data) {
          message.value = data.message || '';
          syncCounter();
          toast('已撤销上次提交，改动保留在暂存区');
          return load(true);
        }).catch(function (err) { toast(errorText(err), { error: true }); });
      });
    }

    function generateMessage() {
      var done = ui.busy(generate, '生成中');
      c.send('POST', '/api/git/commit-message', target).then(function (data) {
        message.value = data.message;
        syncCounter();
        message.focus();
        if (data.source !== 'claude') toast('没有找到可用的 claude CLI，已按改动文件生成摘要');
      }).catch(function (err) { toast(errorText(err), { error: true }); }).finally(done);
    }

    // --- sync and branches ---
    function sync(action, btn) {
      var labels = { fetch: '获取中', pull: '拉取中', push: '推送中' };
      var done = ui.busy(btn, labels[action]);
      c.send('POST', '/api/git/sync', Object.assign({ action: action }, target)).then(function (data) {
        var summary = { fetch: '已获取远程更新', pull: '已拉取到最新', push: '已推送' }[action];
        var lastLine = (data.output || '').split('\n').filter(Boolean).pop();
        toast(summary + (lastLine && action !== 'fetch' ? ' · ' + lastLine : ''));
        return load(true);
      }).catch(function (err) { toast(errorText(err), { error: true }); }).finally(done);
    }

    var branchMenu = null;
    function closeBranchMenu() {
      if (!branchMenu) return;
      branchMenu.remove();
      branchMenu = null;
      branchBtn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('mousedown', onOutside, true);
    }
    function onOutside(e) {
      if (branchMenu && !branchMenu.contains(e.target) && !branchBtn.contains(e.target)) closeBranchMenu();
    }
    function toggleBranchMenu() {
      if (branchMenu) { closeBranchMenu(); return; }
      if (!status) return;
      branchMenu = el('div', 'blk-menu git-branch-menu');
      branchBtn.setAttribute('aria-expanded', 'true');
      var input = el('input', 'blk-input');
      input.placeholder = '切换或新建分支…';
      input.setAttribute('aria-label', '筛选分支');
      var results = el('div', 'blk-menu-list');
      results.setAttribute('role', 'listbox');
      branchMenu.append(input, results);
      results.appendChild(ui.spinnerLine('读取分支'));
      root.appendChild(branchMenu);
      document.addEventListener('mousedown', onOutside, true);
      input.focus();
      var branches = [];
      var items = [];
      var activeIndex = 0;
      c.get('/api/git/branches', target).then(function (data) {
        branches = data.branches;
        draw();
      }).catch(function (err) { results.replaceChildren(ui.errorBox(err)); });

      function draw() {
        var q = input.value.trim().toLowerCase();
        results.replaceChildren();
        items = [];
        var matching = branches.filter(function (b) { return !q || b.name.toLowerCase().indexOf(q) !== -1; });
        var exact = branches.some(function (b) { return !b.remote && b.name === input.value.trim(); });
        if (q && !exact) {
          items.push({ create: input.value.trim() });
        }
        var local = matching.filter(function (b) { return !b.remote; });
        var remoteOnly = matching.filter(function (b) {
          return b.remote && !branches.some(function (l) { return !l.remote && l.name === relativeBranchName(b.name); });
        });
        local.forEach(function (b) { items.push({ branch: b }); });
        remoteOnly.forEach(function (b) { items.push({ branch: b }); });
        var lastSection = null;
        items.forEach(function (item, index) {
          var section = item.create ? '新建' : item.branch.remote ? '远程' : '本地';
          if (section !== lastSection && !item.create) {
            results.appendChild(el('div', 'blk-menu-section', section));
            lastSection = section;
          }
          var row = el('button', 'blk-menu-item' + (index === activeIndex ? ' is-active' : ''));
          row.type = 'button';
          row.setAttribute('role', 'option');
          if (item.create) {
            row.innerHTML = icon('plus');
            row.appendChild(el('span', 'blk-menu-label', '新建分支 “' + item.create + '”'));
            row.appendChild(el('span', 'blk-muted', '基于 ' + (status.branch || 'HEAD')));
          } else {
            var b = item.branch;
            row.innerHTML = b.current ? icon('check') : icon(b.remote ? 'browser' : 'branch');
            row.appendChild(el('span', 'blk-menu-label', b.name));
            var metaText = [];
            if (b.ahead) metaText.push('↑' + b.ahead);
            if (b.behind) metaText.push('↓' + b.behind);
            if (b.gone) metaText.push('上游已删除');
            metaText.push(b.date);
            row.appendChild(el('span', 'blk-muted', metaText.join(' · ')));
            row.title = b.subject || '';
          }
          row.addEventListener('mouseenter', function () { activeIndex = index; highlight(); });
          row.addEventListener('click', function () { choose(item); });
          results.appendChild(row);
        });
        if (!items.length) results.appendChild(el('div', 'blk-menu-empty', '没有匹配的分支'));
      }
      function highlight() {
        Array.prototype.forEach.call(results.querySelectorAll('.blk-menu-item'), function (n, i) {
          n.classList.toggle('is-active', i === activeIndex);
          if (i === activeIndex) n.scrollIntoView({ block: 'nearest' });
        });
      }
      function choose(item) {
        closeBranchMenu();
        if (item.branch && item.branch.current) return;
        var body = item.create ? { branch: item.create, create: true } : { branch: item.branch.name, remote: item.branch.remote };
        var done = ui.busy(branchBtn, item.create ? '新建分支' : '切换中');
        c.send('POST', '/api/git/checkout', Object.assign(body, target)).then(function () {
          toast(item.create ? '已新建并切换到 ' + item.create : '已切换到 ' + relativeBranchName(item.branch.name));
          selection = null;
          historyLoaded = false;
          done();
          return load(true);
        }).catch(function (err) { done(); toast(errorText(err), { error: true }); });
      }
      input.addEventListener('input', function () { activeIndex = 0; draw(); });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); activeIndex = Math.min(items.length - 1, activeIndex + 1); highlight(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); activeIndex = Math.max(0, activeIndex - 1); highlight(); }
        else if (e.key === 'Enter' && items[activeIndex]) { e.preventDefault(); choose(items[activeIndex]); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeBranchMenu(); branchBtn.focus(); }
      });
    }

    // --- history ---
    var GRAPH_COLORS = 6;
    function graphNode(graph, layout, width) {
      var node = el('span', 'git-graph');
      node.setAttribute('aria-hidden', 'true');
      if (layout) {
        node.classList.add('is-drawn');
        node.style.width = 'var(--git-graph-width, ' + width + 'px)';
        var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 ' + width + ' 100');
        svg.setAttribute('preserveAspectRatio', 'none');
        // Keep track coordinates fixed when the text gutter becomes narrower.
        svg.style.width = width + 'px';
        layout.edges.forEach(function (edge) {
          var path = document.createElementNS(svg.namespaceURI, 'path');
          var x1 = edge.x1 * 14 + 8, x2 = edge.x2 * 14 + 8;
          path.setAttribute('d', 'M' + x1 + ' ' + edge.y1 + (x1 === x2 ? 'V' + edge.y2 : 'C' + x1 + ' 80 ' + x2 + ' 70 ' + x2 + ' ' + edge.y2));
          path.setAttribute('class', 'git-graph-edge git-g' + edge.color + (edge.boundary ? ' is-boundary' : ''));
          path.setAttribute('data-from', edge.from.join(' '));
          path.setAttribute('data-to', edge.to);
          path.setAttribute('vector-effect', 'non-scaling-stroke');
          svg.appendChild(path);
        });
        var dot = el('span', 'git-graph-dot git-g' + layout.color + (layout.merge ? ' is-merge' : ''));
        dot.style.left = (layout.column * 14 + 8) + 'px';
        node.append(svg, dot);
        return node;
      }
      // Older Nodes do not yet return parents: preserve their graph rather than
      // guessing relationships from the visible order of commits.
      for (var i = 0; i < graph.length; i++) {
        var ch = graph.charAt(i);
        if (ch === ' ') { node.appendChild(document.createTextNode(' ')); continue; }
        node.appendChild(el('span', 'git-g' + (Math.floor(i / 2) % GRAPH_COLORS), ch === '*' ? '●' : ch));
      }
      return node;
    }

    /**
     * One history read at a time; asked again for the same, it joins it. The same
     * history again draws nothing, so a commit open in it stays open, and a failed
     * refresh leaves it on screen.
     */
    function loadHistory(limit) {
      historyLoaded = true;
      limit = limit || 300;
      if (historyLoading && historyLoading.limit === limit && historyLoading.writes === writes) return historyLoading.promise;
      if (!historyView.firstChild) historyView.appendChild(ui.spinnerLine('读取提交历史'));
      var entry = { limit: limit, writes: writes, promise: null };
      historyLoading = entry;
      entry.promise = c.get('/api/git/log', Object.assign({ limit: limit }, target)).then(function (data) {
        if (historyLoading !== entry) return;
        refreshFailedFor('history', null);
        var json = limit + '\u0000' + JSON.stringify(data.rows);
        if (json === historyJson && historyView.querySelector('.git-log')) return;
        historyJson = json;
        var log = el('div', 'git-log');
        log.setAttribute('role', 'listbox');
        log.setAttribute('aria-label', '提交历史');
        log.tabIndex = 0;
        var detail = el('div', 'git-log-detail');
        detail.appendChild(ui.emptyState('commit', '选择一个提交', '查看它的说明和改动。'));
        // A commit open before stays open, as it was, while it is still in the history:
        // its detail is kept rather than read and drawn again. So is where the list was.
        var previousLog = historyView.querySelector('.git-log');
        if (previousLog && historyResize) historyResize.unobserve(previousLog);
        var previousDetail = historyView.querySelector('.git-log-detail');
        var listTop = previousLog ? previousLog.scrollTop : 0;
        var openHash = previousDetail && previousDetail.__openCommit;
        if (openHash && data.rows.some(function (row) { return row.commit && row.commit.hash === openHash; })) detail = previousDetail;
        else openHash = null;
        var commitRows = [];
        var commits = data.rows.filter(function (row) { return row.commit; }).map(function (row) { return row.commit; });
        var graph = commits.every(function (commit) { return Array.isArray(commit.parents); }) ? commitGraph(commits) : null;
        var drawnIndex = 0;
        if (!graph) log.classList.add('is-legacy-graph');
        function traceGraph(hash) {
          log.classList.toggle('is-tracing', !!hash);
          log.querySelectorAll('.git-graph-edge').forEach(function (edge) {
            edge.classList.toggle('is-traced', edge.getAttribute('data-from').split(' ').indexOf(hash) !== -1 || edge.getAttribute('data-to') === hash);
          });
        }
        data.rows.forEach(function (row, rowIndex) {
          if (graph && !row.commit) return;
          var line = el('div', 'git-log-row' + (row.commit ? ' has-commit' : ''));
          var layout = graph && graph.rows[drawnIndex++];
          line.appendChild(graphNode(row.graph, layout, graph && graph.width));
          line.__graphWidth = layout && layout.width;
          if (row.commit) {
            commitRows.push(line);
            if (row.commit.hash === openHash) line.classList.add('is-active');
            line.setAttribute('role', 'option');
            line.id = api.id + '-commit-' + row.commit.hash;
            line.setAttribute('aria-selected', String(row.commit.hash === openHash));
            line.setAttribute('aria-label', row.commit.subject + '，' + row.commit.author + '，' + row.commit.date + (row.commit.parents && row.commit.parents.length > 1 ? '，合并提交' : ''));
            line.title = row.commit.subject;
            var subject = el('span', 'git-subject', row.commit.subject);
            var labels = el('span', 'git-log-labels');
            var refs = row.commit.refs.slice().sort(function (a, b) {
              function rank(ref) { return ref.indexOf('HEAD -> ') === 0 ? 0 : ref.indexOf('/') === -1 ? 1 : 2; }
              return rank(a) - rank(b);
            });
            function refBadge(ref) {
              var head = ref.indexOf('HEAD -> ') === 0;
              var kind = head ? ' is-head' : ref.indexOf('tag: ') === 0 ? ' is-tag' : ref.indexOf('/') !== -1 ? ' is-remote' : '';
              var badge = el('span', 'git-ref' + kind, ref.replace(/^HEAD -> /, '').replace(/^tag: /, ''));
              badge.title = ref;
              return badge;
            }
            if (refs.length) labels.appendChild(refBadge(refs[0]));
            if (refs.length > 1) {
              var refMenu = el('div', 'blk-menu git-ref-menu');
              refMenu.id = api.id + '-refs-' + rowIndex;
              refMenu.setAttribute('popover', 'auto');
              refMenu.addEventListener('click', function (e) { e.stopPropagation(); });
              refs.forEach(function (ref) { refMenu.appendChild(refBadge(ref)); });
              var moreRefs = button('+' + (refs.length - 1), function (e) {
                e.stopPropagation();
                var rect = moreRefs.getBoundingClientRect();
                refMenu.style.left = Math.max(12, Math.min(rect.left, window.innerWidth - 332)) + 'px';
                refMenu.style.top = Math.max(12, Math.min(rect.bottom + 4, window.innerHeight - 180)) + 'px';
                refMenu.togglePopover();
              }, { className: 'blk-btn-ghost blk-btn-small git-ref-more', title: refs.join('\n') });
              moreRefs.setAttribute('aria-label', '查看全部 ' + refs.length + ' 个引用');
              moreRefs.setAttribute('aria-controls', refMenu.id);
              moreRefs.setAttribute('aria-haspopup', 'true');
              labels.append(moreRefs, refMenu);
            }
            var meta = el('span', 'git-log-meta');
            meta.append(el('span', 'git-hash', row.commit.short), el('span', 'git-log-author', row.commit.author), el('span', '', row.commit.date));
            line.append(subject, labels, meta);
            line.addEventListener('mouseenter', function () { traceGraph(row.commit.hash); });
            line.addEventListener('click', function () { openCommit(row.commit, line); });
          }
          log.appendChild(line);
        });
        if (!data.rows.length) log.appendChild(ui.emptyState('commit', '还没有提交', ''));
        if (data.rows.length >= limit) {
          log.appendChild(button('加载更多', function () { loadHistory(limit + 500); }, { className: 'blk-btn-ghost blk-btn-small git-more' }));
        }
        log.addEventListener('keydown', function (e) {
          var index = commitRows.findIndex(function (r) { return r.classList.contains('is-active'); });
          var next = null;
          if (e.key === 'ArrowDown' || e.key === 'j') next = commitRows[Math.min(commitRows.length - 1, index + 1)];
          else if (e.key === 'ArrowUp' || e.key === 'k') next = commitRows[Math.max(0, index - 1)];
          if (next) { e.preventDefault(); next.click(); next.scrollIntoView({ block: 'nearest' }); }
        });
        log.addEventListener('mouseleave', function () { traceGraph(detail.__openCommit); });
        log.addEventListener('focus', function () { traceGraph(detail.__openCommit); });
        historyView.replaceChildren(log, historyGrip, detail);
        traceGraph(openHash);
        if (openHash) log.setAttribute('aria-activedescendant', api.id + '-commit-' + openHash);
        log.scrollTop = listTop;
        // Only visible tracks reserve space beside the text. A complicated merge
        // hundreds of rows below must not indent the entire commit list.
        fitGraphGutter = function () {
          if (!graph || !log.clientHeight) return;
          var top = log.scrollTop, bottom = top + log.clientHeight;
          var width = 18;
          for (var i = 0; i < commitRows.length; i++) {
            var row = commitRows[i], rowTop = row.offsetTop;
            if (rowTop > bottom) break;
            if (rowTop + row.offsetHeight > top) width = Math.max(width, row.__graphWidth);
          }
          log.style.setProperty('--git-graph-width', width + 'px');
        };
        log.addEventListener('scroll', function () {
          if (graphFrame !== null) return;
          graphFrame = requestAnimationFrame(function () { graphFrame = null; fitGraphGutter(); });
        }, { passive: true });
        if (historyResize) historyResize.observe(log);
        fitGraphGutter();

        function openCommit(commit, line) {
          commitRows.forEach(function (r) {
            r.classList.toggle('is-active', r === line);
            r.setAttribute('aria-selected', String(r === line));
          });
          traceGraph(commit.hash);
          log.setAttribute('aria-activedescendant', line.id);
          stopLazyDiffs();
          // A large commit can answer after the next one was picked: only the latest lands.
          var asked = {};
          detail.__commit = asked;
          detail.__openCommit = commit.hash;
          detail.replaceChildren(ui.spinnerLine('读取提交'));
          c.get('/api/git/show', Object.assign({ commit: commit.hash }, target)).then(function (res) {
            if (detail.__commit !== asked) return;
            var at = res.diff.indexOf('\ndiff --git ');
            var headText = at === -1 ? res.diff : res.diff.slice(0, at);
            var lines = headText.split('\n');
            var card = el('header', 'git-commit-card');
            var bodyText = lines.slice(4).join('\n').trim();
            var subject = bodyText.split('\n')[0] || commit.subject;
            card.appendChild(el('h3', '', subject));
            var rest = bodyText.split('\n').slice(1).join('\n').trim();
            var metaRow = el('div', 'git-commit-meta');
            metaRow.appendChild(el('span', '', lines[1] || commit.author));
            metaRow.appendChild(el('span', 'blk-muted', lines[2] || commit.date));
            var hash = button(commit.short, function () {
              if (navigator.clipboard) navigator.clipboard.writeText(commit.hash).then(function () { toast('已复制 ' + commit.hash); });
            }, { icon: 'copy', className: 'blk-btn-ghost blk-btn-small git-hash-btn', title: '复制完整哈希' });
            metaRow.appendChild(hash);
            card.appendChild(metaRow);
            if (rest) {
              var messageDetails = el('details', 'git-commit-message');
              var summary = el('summary');
              summary.append(el('span', 'git-message-preview', rest), el('span', 'git-message-expand', '展开说明'), el('span', 'git-message-collapse', '收起说明'));
              messageDetails.append(summary, el('pre', 'git-commit-body', rest));
              card.appendChild(messageDetails);
            }
            var diffText = at === -1 ? '' : res.diff.slice(at + 1);
            var files = res.files || [];
            var fileRows = [];
            var diffs = el('div', 'git-commit-diffs');

            function markFile(picked) {
              fileRows.forEach(function (r) {
                var on = r.file === picked;
                r.row.classList.toggle('is-active', on);
                r.row.setAttribute('aria-selected', String(on));
              });
            }

            // The file goes to the top of the detail, and a preview takes the height left there.
            function bringUp(bar, preview) {
              detail.scrollTop += bar.getBoundingClientRect().top - detail.getBoundingClientRect().top - 8;
              if (preview) preview.style.height = Math.max(320, detail.clientHeight - bar.offsetHeight - 28) + 'px';
            }

            // A file's part of the diff: cut from the whole one when it came along, otherwise
            // asked for, once.
            var fileDiffs = {};
            function loadFileDiff(file) {
              if (!res.diffOmitted) return Promise.resolve(fileDiff(diffText, file.path));
              if (!fileDiffs[file.path]) {
                var query = Object.assign({ commit: commit.hash, file: file.path, from: file.from || null }, target);
                fileDiffs[file.path] = c.get('/api/git/show-file', query).then(function (data) { return data.diff; });
                fileDiffs[file.path].catch(function () { delete fileDiffs[file.path]; });
              }
              return fileDiffs[file.path];
            }

            function showAll() {
              markFile(null);
              stopLazyDiffs();
              disposePreviews(diffs);
              if (res.diffOmitted) {
                showAllLazily();
                return;
              }
              ui.renderDiffInto(diffs, diffText, {
                maxLines: INLINE_DIFF_LINES,
                emptyTitle: '没有文本改动', emptyText: '这个提交只改了二进制文件或文件权限。',
              });
            }

            /**
             * A commit too large to draw at once: a section per file, each filled in as it
             * comes near the screen, a few at a time. A file with a great many changed
             * lines waits to be asked for, and a binary one has nothing to show here.
             */
            function showAllLazily() {
              diffs.replaceChildren();
              var waiting = [];
              var running = 0;
              var pump = function () {
                while (running < LAZY_DIFFS_AT_ONCE && waiting.length) {
                  running += 1;
                  waiting.shift()().then(function () { running -= 1; pump(); });
                }
              };
              var want = function (load) { waiting.push(load); pump(); };
              var observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(function (entries) {
                entries.forEach(function (entry) {
                  if (!entry.isIntersecting) return;
                  observer.unobserve(entry.target);
                  want(entry.target.__loadDiff);
                });
              }, { root: detail, rootMargin: '800px 0px' }) : null;
              lazyObserver = observer;
              files.forEach(function (file) {
                var section = el('section', 'blk-diff-filebox git-lazy-file');
                var head = el('button', 'blk-diff-filehead');
                head.type = 'button';
                head.title = '单独查看这个文件';
                head.appendChild(el('span', 'blk-diff-filename', file.path));
                var stats = el('span', 'blk-diff-stats');
                if (file.binary) stats.appendChild(el('span', 'blk-muted', '二进制'));
                else stats.append(el('span', 'is-add', '+' + file.added), el('span', 'is-del', '−' + file.removed));
                head.appendChild(stats);
                head.addEventListener('click', function () { showFile(file); });
                var body = el('div', 'git-lazy-body');
                section.append(head, body);
                diffs.appendChild(section);
                var load = function () {
                  body.replaceChildren(ui.spinnerLine('读取差异'));
                  return loadFileDiff(file).then(function (text) {
                    if (!body.isConnected) return;
                    body.style.minHeight = '';
                    ui.renderDiffInto(body, text, {
                      fileHeaders: false, maxLines: LAZY_DIFF_LINES,
                      emptyTitle: '没有文本差异', emptyText: '只改了文件名或权限。',
                    });
                  }, function (err) {
                    if (body.isConnected) body.replaceChildren(ui.errorBox(err));
                  });
                };
                if (file.binary) {
                  body.appendChild(el('div', 'blk-muted git-lazy-note', '二进制文件，单独查看时可以预览。'));
                } else if (file.added + file.removed > LAZY_DIFF_ASK_LINES) {
                  body.appendChild(button('改动较多（+' + file.added + ' −' + file.removed + '），点击加载', function () { want(load); }, { className: 'blk-btn-ghost blk-btn-small git-lazy-note' }));
                } else if (observer) {
                  // Roughly the room it will take, so only sections near the screen are
                  // near the screen: a column of empty ones would all load at once.
                  body.style.minHeight = (Math.min(file.added + file.removed + 8, LAZY_DIFF_LINES) * DIFF_LINE_PX + 44) + 'px';
                  section.__loadDiff = load;
                  observer.observe(section);
                } else {
                  want(load);
                }
              });
            }

            function showFile(file) {
              markFile(file);
              stopLazyDiffs();
              var fileKey = commit.hash + '\u0000' + file.path;
              var versions = {
                before: file.status === 'A' ? null : { rev: commit.hash + '^', path: file.from || file.path },
                after: file.status === 'D' ? null : { rev: commit.hash, path: file.path },
              };
              var mode = modeFor(file.binary, fileKey);
              var side = sideFor(versions);
              var bar = el('div', 'git-commit-file-bar');
              var parts = splitPath(file.path);
              var title = el('div', 'git-diff-title');
              title.appendChild(el('strong', '', parts.name));
              if (parts.dir) title.appendChild(el('span', 'blk-muted', parts.dir.replace(/\/$/, '')));
              if (file.from) title.title = file.from + ' → ' + file.path;
              bar.append(
                button('全部文件', showAll, { icon: 'chevronLeft', className: 'blk-btn-ghost blk-btn-small' }),
                title,
                viewSwitch(versions, mode, side, fileKey, function () { showFile(file); }),
                iconButton('file', '打开磁盘上的这个文件', function () {
                  if (window.FilePreview) FilePreview.openFile(rootPath(file.path), null);
                })
              );
              if (mode === 'diff') bar.classList.add('is-diff');
              disposePreviews(diffs);
              if (mode === 'preview') {
                var preview = el('div', 'git-preview');
                diffs.replaceChildren(bar, preview);
                bringUp(bar, preview);
                renderVersion(preview, versions[side]);
                return;
              }
              var one = el('div', 'git-commit-file-diff');
              var draw = function (text) {
                ui.renderDiffInto(one, text, {
                  fileHeaders: false,
                  emptyTitle: '没有文本差异',
                  emptyText: file.binary ? '这是二进制文件，切到“预览”查看。' : '只改了文件名或权限。',
                });
              };
              // Already here with the commit: drawn now, with no flash of loading.
              if (!res.diffOmitted) draw(fileDiff(diffText, file.path));
              else one.appendChild(ui.spinnerLine('读取差异'));
              diffs.replaceChildren(bar, one);
              bringUp(bar, null);
              if (!res.diffOmitted) return;
              loadFileDiff(file).then(function (text) {
                if (one.isConnected) draw(text);
              }, function (err) {
                if (one.isConnected) one.replaceChildren(ui.errorBox(err));
              });
            }

            var list = el('div', 'git-commit-files');
            if (files.length) {
              var listHead = el('div', 'git-group-head');
              listHead.append(el('span', '', '改动的文件'), el('span', 'blk-pill', String(files.length)));
              var totals = el('span', 'blk-diff-stats git-total-stats');
              totals.append(el('span', 'is-add', '+' + files.reduce(function (n, f) { return n + (f.added || 0); }, 0)),
                el('span', 'is-del', '−' + files.reduce(function (n, f) { return n + (f.removed || 0); }, 0)));
              listHead.append(totals, wrapToggle());
              list.appendChild(listHead);
              var rowsBox = el('div', 'git-commit-file-list');
              rowsBox.setAttribute('role', 'listbox');
              rowsBox.setAttribute('aria-label', '这个提交改动的文件');
              var addRow = function (file) {
                var row = el('div', 'git-file');
                row.setAttribute('role', 'option');
                row.setAttribute('aria-selected', 'false');
                var badge = el('span', 'git-badge git-badge-' + file.status.toLowerCase(), file.status);
                badge.title = STATUS_LABEL[file.status] || file.status;
                var parts = splitPath(file.path);
                var name = el('span', 'git-file-name');
                name.appendChild(el('span', 'git-file-base', parts.name));
                if (parts.dir) name.appendChild(el('span', 'git-file-dir', parts.dir.replace(/\/$/, '')));
                name.title = (file.from ? file.from + ' → ' : '') + file.path;
                var stats = el('span', 'blk-diff-stats git-file-stats');
                if (file.binary) stats.appendChild(el('span', 'blk-muted', '二进制'));
                else stats.append(el('span', 'is-add', '+' + file.added), el('span', 'is-del', '−' + file.removed));
                row.append(badge, name, stats);
                row.addEventListener('click', function () { showFile(file); });
                fileRows.push({ row: row, file: file });
                rowsBox.appendChild(row);
              };
              // Thousands of rows cost as much as a diff: the rest come when asked for.
              files.slice(0, FILE_LIST_SHOWN).forEach(addRow);
              list.appendChild(rowsBox);
              if (files.length > FILE_LIST_SHOWN) {
                var restOfFiles = button('显示其余 ' + (files.length - FILE_LIST_SHOWN) + ' 个文件', function () {
                  restOfFiles.remove();
                  files.slice(FILE_LIST_SHOWN).forEach(addRow);
                }, { className: 'blk-btn-ghost blk-btn-small git-more' });
                list.appendChild(restOfFiles);
              }
            }
            detail.replaceChildren(card, list, diffs);
            showAll();
            detail.scrollTop = 0;
          }).catch(function (err) { detail.replaceChildren(ui.errorBox(err)); });
        }
      }).catch(function (err) {
        if (historyLoading !== entry) return;
        if (historyView.querySelector('.git-log')) {
          refreshFailedFor('history', err);
          return;
        }
        historyView.replaceChildren(ui.errorBox(err));
      }).finally(function () {
        if (historyLoading === entry) historyLoading = null;
      });
      return entry.promise;
    }

    function show(which) {
      changesTab.classList.toggle('is-active', which === 'changes');
      historyTab.classList.toggle('is-active', which === 'history');
      changesTab.setAttribute('aria-pressed', String(which === 'changes'));
      historyTab.setAttribute('aria-pressed', String(which === 'history'));
      if (!status) return;
      changesView.hidden = which !== 'changes';
      historyView.hidden = which !== 'history';
      if (which === 'history' && !historyLoaded) loadHistory();
    }

    // Background refresh while the block is on screen.
    function poll() {
      if (api.isVisible() && document.visibilityState === 'visible' && !document.querySelector('.blk-dialog-overlay')) load(false);
    }
    pollTimer = setInterval(poll, 4000);
    function onFocus() { poll(); }
    window.addEventListener('focus', onFocus);

    // Restored along with its window: the terminal coming up goes first.
    var firstLoad = null;
    if (api.restored) {
      firstLoad = setTimeout(function () {
        firstLoad = null;
        load(true);
      }, RESTORED_LOAD_DELAY_MS);
    } else {
      load(true);
    }
    syncCounter();

    return {
      el: root,
      onShow: function () { if (!firstLoad) load(false); },
      update: function (params) {
        if (params && params.path && params.path !== target.path && params.path !== '.') {
          target = { path: params.path, paneId: params.paneId || undefined };
          selection = null;
          historyLoaded = false;
          load(true);
        }
      },
      dispose: function () {
        clearInterval(pollTimer);
        clearTimeout(firstLoad);
        if (graphFrame !== null) cancelAnimationFrame(graphFrame);
        if (historyResize) historyResize.disconnect();
        window.removeEventListener('focus', onFocus);
        closeBranchMenu();
        stopLazyDiffs();
        disposePreviews(root);
      },
    };
  }

  BlockHost.register('git', {
    title: 'Git',
    icon: 'git',
    perWindow: true,
    // One Git block per repository root in a window; before the first status it is keyed by the path asked for.
    key: function (params) { return params.path && params.path !== '.' ? params.path : 'pane:' + (params.paneId || ''); },
    create: gitBlock,
  });

  // ===========================================================================
  // Git status chip in the top bar
  // ===========================================================================

  var chip = null;
  var chipBusy = false;
  // Only the newest answer may be shown: opening Git asks too, and can overtake a refresh.
  var chipAsked = 0;

  function ensureChip() {
    var crumbs = document.querySelector('.ms-topbar .crumbs');
    if (!crumbs) return null;
    if (!chip) {
      chip = el('button', 'pane-git-chip');
      chip.type = 'button';
      chip.hidden = true;
      // What it shows can be 15 seconds old, so it is not what gets opened.
      chip.addEventListener('click', function () { openGit(); });
    }
    if (chip.parentNode !== crumbs) crumbs.appendChild(chip);
    return chip;
  }

  function showChip(data) {
    var node = ensureChip();
    if (!node) return;
    var project = data.root.split(/[\\/]/).filter(Boolean).pop() || data.root;
    var branch = data.detached ? 'HEAD' : (data.branch || '—');
    node.replaceChildren();
    node.innerHTML = icon('branch');
    node.appendChild(el('span', 'pane-git-project', project));
    var separator = el('span', 'pane-git-separator', '/');
    separator.setAttribute('aria-hidden', 'true');
    node.appendChild(separator);
    node.appendChild(el('span', 'pane-git-branch', branch));
    if (data.files.length) node.appendChild(el('span', 'pane-git-dirty', '●' + data.files.length));
    if (data.ahead) node.appendChild(el('span', 'pane-git-track', '↑' + data.ahead));
    if (data.behind) node.appendChild(el('span', 'pane-git-track', '↓' + data.behind));
    node.title = data.root + (data.files.length ? ' · ' + data.files.length + ' 个改动' : ' · 干净') + '\n点击打开 Git (' + ui.keysText('Alt+Shift+G') + ')';
    node.setAttribute('aria-label', 'Git 项目 ' + project + '，分支 ' + branch + '，' + data.files.length + ' 个改动，打开 Git');
    node.dataset.title = node.title;
    node.classList.remove('is-stale');
    node.hidden = false;
  }

  /**
   * Outside a repository the chip goes. Any other failure is likely to pass: what it
   * showed stays, dimmed, and says why it may be out of date.
   */
  function chipRefreshFailed(err) {
    if (err && err.message === 'not_a_git_repository') {
      hideChip();
      return;
    }
    if (!chip || chip.hidden) return;
    chip.classList.add('is-stale');
    chip.title = '刷新失败，显示的是上次的状态：' + errorText(err) + '\n' + (chip.dataset.title || '');
  }

  function hideChip() {
    if (chip) chip.hidden = true;
  }

  function refreshChip() {
    var node = ensureChip();
    if (!node) return;
    var terminal = document.querySelector('.ms-app.mode-terminal');
    var selected = ui.selectedContext();
    if (!terminal || !selected.paneId || document.visibilityState !== 'visible') {
      if (!terminal) node.hidden = true;
      return;
    }
    if (chipBusy) return;
    chipBusy = true;
    var asked = ++chipAsked;
    var isStale = function () { return ui.selectedContext().key !== selected.key; };
    ui.focusedContext().then(function (ctx) {
      if (isStale()) return null;
      return ui.client(ctx.serverId).get('/api/git/status', { path: '.', paneId: ctx.paneId }).then(function (data) {
        // The user moved on while this was running: it describes another repository.
        if (!isStale() && asked === chipAsked) showChip(data);
      }, function (err) {
        if (!isStale() && asked === chipAsked) chipRefreshFailed(err);
      });
    }).catch(function () {
      // tmux could not say which pane: what the chip shows may be another pane's.
      if (!isStale() && asked === chipAsked) hideChip();
    }).finally(function () {
      chipBusy = false;
      if (isStale()) scheduleChip();
    });
  }

  // The chip never competes with a terminal coming up, and a navigation that
  // changes both the route and the server asks only once.
  var CHIP_DELAY_MS = 800;
  var chipTimer = null;
  function scheduleChip() {
    clearTimeout(chipTimer);
    chipTimer = setTimeout(refreshChip, CHIP_DELAY_MS);
  }

  var gitOpens = 0;

  /**
   * Git for the pane in focus, as it is now: focus and the pane's directory both move
   * without telling anyone, so this asks every time. The repository is found first and
   * opened by its root, so a block already showing it comes up with its draft, and a
   * block showing another repository is never pointed somewhere else.
   */
  function openGit() {
    var open = ++gitOpens;
    var selected = ui.selectedContext();
    var moved = function () { return open !== gitOpens || ui.selectedContext().key !== selected.key; };
    var diagnostic = window.Diagnostics && window.Diagnostics.beginGit(selected.serverId);
    var phase = 'focus';
    if (!selected.paneId) {
      if (selected.onTerminal) toast('这个窗口还没打开好，稍后再试');
      else BlockHost.open('git', { path: '.' });
      return;
    }
    ui.focusedContext().then(function (ctx) {
      if (moved()) { if (diagnostic) diagnostic({ code: 'GIT_STALE' }); return null; }
      phase = 'status';
      var asked = ++chipAsked;
      return ui.client(ctx.serverId).get('/api/git/status', { path: '.', paneId: ctx.paneId }).then(function (data) {
        if (moved()) { if (diagnostic) diagnostic({ code: 'GIT_STALE' }); return; }
        if (asked === chipAsked) showChip(data);
        phase = 'render';
        BlockHost.open('git', { path: data.root });
      }, function (err) {
        if (moved()) return;
        if (asked === chipAsked) chipRefreshFailed(err);
        // Keyed by the pane, and it says itself that this is not a repository, or what went wrong.
        BlockHost.open('git', { path: '.', paneId: ctx.paneId });
      });
    }).catch(function (err) {
      if (diagnostic) diagnostic({ code: phase === 'focus' ? 'GIT_FOCUS_ERROR' : (phase === 'render' ? 'GIT_RENDER_ERROR' : 'GIT_API_ERROR'), status: err.status });
      if (!moved()) toast('无法确定当前窗格：' + errorText(err), { error: true });
    });
  }

  PanelSlots.commands.register({ id: 'git', order: 20, group: 'block', title: 'Git', icon: 'git', keys: 'Alt+Shift+G', code: 'KeyG', run: openGit, keywords: 'git diff stage commit branch push pull 提交 暂存 分支 历史' });
  Blocks.openGit = openGit;

  // --- git gutter in the code preview ---------------------------------------------

  function decorateGitGutter(body, absPath) {
    ui.client().get('/api/git/line-changes', { path: absPath }).then(function (data) {
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

  Blocks.decorateGitGutter = decorateGitGutter;

  // The file preview's "more" menu: Git for the repository the file is in.
  Blocks.registerPreviewActions({ id: 'git', order: 30, items: function (file, ctx) {
    var svgPaths = ui.iconPaths;
    var items = [];
    if (window.BlockHost) {
      items.push({ label: 'Git', hint: '查看所在仓库的改动与历史', icon: svgPaths('git'),
        run: function () { window.BlockHost.open('git', { path: file.isDirectory ? file.absPath : file.absPath.replace(/\/[^/]+$/, '') || '/', paneId: ctx.paneId }); } });
    }
    return items;
  } });

  // --- boot ---
  window.addEventListener('hashchange', scheduleChip);
  // Another machine: what is on the chip and on its way to it is about the last one.
  window.addEventListener('terminal-target-server', function () {
    chipAsked += 1;
    hideChip();
    scheduleChip();
  });
  window.addEventListener('terminal-pane-selected', scheduleChip);
  document.addEventListener('visibilitychange', refreshChip);
  setInterval(refreshChip, 15000);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scheduleChip);
  else setTimeout(scheduleChip, 0);
})();
