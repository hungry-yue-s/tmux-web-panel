/* global Api, Blocks, BlockHost, Router, Theme, FilePreview, AppShell */

// Workspace blocks and pickers: the Git and browser blocks (hosted by
// BlockHost), the theme picker with live preview, the hosts panel, the
// keyboard shortcut sheet, the git status chip in the top bar, and the
// commands/shortcuts that open all of them.

(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.Blocks || !window.BlockHost) return;

  var ui = Blocks.ui;
  var el = ui.el, button = ui.button, iconButton = ui.iconButton, icon = Blocks.icon;
  var toast = ui.toast, errorText = ui.errorText;

  function relativeBranchName(name) { return String(name || '').replace(/^origin\//, ''); }

  function splitPath(path) {
    var at = path.lastIndexOf('/');
    return at === -1 ? { dir: '', name: path } : { dir: path.slice(0, at + 1), name: path.slice(at + 1) };
  }

  // ===========================================================================
  // Git block
  // ===========================================================================

  var STATUS_LABEL = { M: '已修改', A: '新增', D: '已删除', R: '重命名', C: '复制', U: '冲突', '?': '未跟踪', T: '类型变化' };

  var RESTORED_LOAD_DELAY_MS = 800;

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
    var left = el('div', 'blk-row git-bar-left');
    left.append(branchBtn, trackBox);
    var segmented = el('div', 'blk-segmented');
    var changesTab = button('更改', function () { show('changes'); }, { icon: 'changes', className: 'is-active' });
    var historyTab = button('历史', function () { show('history'); }, { icon: 'history' });
    segmented.append(changesTab, historyTab);
    var fetchBtn = iconButton('fetch', '获取远程更新（fetch）', function () { sync('fetch', fetchBtn); });
    var pullBtn = iconButton('down', '拉取（pull --ff-only）', function () { sync('pull', pullBtn); });
    var pushBtn = iconButton('up', '推送（push）', function () { sync('push', pushBtn); });
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
    var loading = null;
    var historyLoaded = false;
    var pollTimer = null;

    function rootPath(rel) { return status.root.replace(/\/$/, '') + '/' + rel; }

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
    function load(force) {
      if (loading) return loading;
      loading = c.get('/api/git/status', target).then(function (data) {
        var json = JSON.stringify(data);
        var changed = json !== statusJson;
        status = data;
        statusJson = json;
        stateBox.hidden = true;
        changesView.hidden = historyTab.classList.contains('is-active');
        if (target.path !== data.root) {
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
      }).catch(function (err) {
        status = null;
        stateBox.hidden = false;
        changesView.hidden = true;
        historyView.hidden = true;
        var notRepo = err.message === 'not_a_git_repository';
        stateBox.replaceChildren(notRepo
          ? ui.emptyState('git', '这里不是 Git 仓库', '在仓库目录里的窗格中打开 Git，或者先运行 git init。')
          : ui.errorBox(err));
        api.setSubtitle('');
      }).finally(function () { loading = null; });
      return loading;
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
        main.replaceChildren(ui.emptyState('changes', status && status.files.length ? '选择一个文件查看差异' : '没有改动', status && status.files.length ? '点击行可以选中，按块或按行暂存。' : ''));
        lastDiffKey = '';
        return;
      }
      var file = status.files.find(function (f) { return f.path === selection.path; });
      if (!file) return;
      var staged = selection.staged;
      var query = Object.assign({ file: file.path, staged: staged ? '1' : '0', untracked: !staged && file.untracked ? '1' : '0' }, target);
      c.get('/api/git/diff', query).then(function (data) {
        var key = file.path + '\u0000' + staged + '\u0000' + data.diff;
        if (!force && key === lastDiffKey) return; // keep line selections across background refreshes
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
        head.append(title, stats, scope, iconButton('file', '打开文件', function () {
          if (window.FilePreview) FilePreview.openFile(rootPath(file.path), null);
        }));
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
      }).catch(function (err) { main.replaceChildren(ui.errorBox(err)); });
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
    function graphNode(graph) {
      var node = el('span', 'git-graph');
      for (var i = 0; i < graph.length; i++) {
        var ch = graph.charAt(i);
        if (ch === ' ') { node.appendChild(document.createTextNode(' ')); continue; }
        node.appendChild(el('span', 'git-g' + (Math.floor(i / 2) % GRAPH_COLORS), ch === '*' ? '●' : ch));
      }
      return node;
    }

    function loadHistory(limit) {
      historyLoaded = true;
      limit = limit || 300;
      if (!historyView.firstChild) historyView.appendChild(ui.spinnerLine('读取提交历史'));
      c.get('/api/git/log', Object.assign({ limit: limit }, target)).then(function (data) {
        var log = el('div', 'git-log');
        log.setAttribute('role', 'listbox');
        log.tabIndex = 0;
        var detail = el('div', 'git-log-detail');
        detail.appendChild(ui.emptyState('commit', '选择一个提交', '查看它的说明和改动。'));
        var commitRows = [];
        data.rows.forEach(function (row) {
          var line = el('div', 'git-log-row' + (row.commit ? ' has-commit' : ''));
          line.appendChild(graphNode(row.graph));
          if (row.commit) {
            commitRows.push(line);
            line.setAttribute('role', 'option');
            line.appendChild(el('span', 'git-hash', row.commit.short));
            row.commit.refs.forEach(function (ref) {
              var head = ref.indexOf('HEAD -> ') === 0;
              var kind = head ? ' is-head' : ref.indexOf('tag: ') === 0 ? ' is-tag' : ref.indexOf('/') !== -1 ? ' is-remote' : '';
              line.appendChild(el('span', 'git-ref' + kind, ref.replace(/^HEAD -> /, '').replace(/^tag: /, '')));
            });
            line.appendChild(el('span', 'git-subject', row.commit.subject));
            line.appendChild(el('span', 'git-log-meta', row.commit.author + ' · ' + row.commit.date));
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
        historyView.replaceChildren(log, detail);

        function openCommit(commit, line) {
          commitRows.forEach(function (r) { r.classList.toggle('is-active', r === line); });
          detail.replaceChildren(ui.spinnerLine('读取提交'));
          c.get('/api/git/show', Object.assign({ commit: commit.hash }, target)).then(function (res) {
            var at = res.diff.indexOf('\ndiff --git ');
            var headText = at === -1 ? res.diff : res.diff.slice(0, at);
            var lines = headText.split('\n');
            var card = el('header', 'git-commit-card');
            var bodyText = lines.slice(4).join('\n').trim();
            var subject = bodyText.split('\n')[0] || commit.subject;
            card.appendChild(el('h3', '', subject));
            var rest = bodyText.split('\n').slice(1).join('\n').trim();
            if (rest) card.appendChild(el('pre', 'git-commit-body', rest));
            var metaRow = el('div', 'git-commit-meta');
            metaRow.appendChild(el('span', '', lines[1] || commit.author));
            metaRow.appendChild(el('span', 'blk-muted', lines[2] || commit.date));
            var hash = button(commit.short, function () {
              if (navigator.clipboard) navigator.clipboard.writeText(commit.hash).then(function () { toast('已复制 ' + commit.hash); });
            }, { icon: 'copy', className: 'blk-btn-ghost blk-btn-small git-hash-btn', title: '复制完整哈希' });
            metaRow.appendChild(hash);
            card.appendChild(metaRow);
            var diffs = el('div', 'git-commit-diffs');
            ui.renderDiffInto(diffs, at === -1 ? '' : res.diff.slice(at + 1), { emptyTitle: '没有文本改动', emptyText: '这个提交只改了二进制文件或文件权限。' });
            detail.replaceChildren(card, diffs);
            detail.scrollTop = 0;
          }).catch(function (err) { detail.replaceChildren(ui.errorBox(err)); });
        }
      }).catch(function (err) { historyView.replaceChildren(ui.errorBox(err)); });
    }

    function show(which) {
      changesTab.classList.toggle('is-active', which === 'changes');
      historyTab.classList.toggle('is-active', which === 'history');
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
        window.removeEventListener('focus', onFocus);
        closeBranchMenu();
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
  // Browser block
  // ===========================================================================

  function detectedPorts() {
    var data = window.__twpStatus;
    var seen = {};
    var out = [];
    ((data && data.sessions) || []).forEach(function (session) {
      (session.windowDetails || []).forEach(function (win) {
        (win.panes || []).forEach(function (pane) {
          (pane.ports || []).forEach(function (port) {
            if (seen[port]) return;
            seen[port] = true;
            out.push({ port: port, command: pane.command || '', window: win.name || '', session: session.name || '' });
          });
        });
      });
    });
    return out.sort(function (a, b) { return a.port - b.port; });
  }

  function browserBlock(api) {
    var root = el('div', 'browser-block');
    var bar = el('form', 'blk-toolbar browser-bar');
    var back = iconButton('chevronLeft', '后退', function () { go(index - 1); });
    var forward = iconButton('chevronRight', '前进', function () { go(index + 1); });
    var reload = iconButton('refresh', '重新加载', function () { if (frame.src) frame.src = frame.src; });
    var field = el('div', 'browser-url');
    field.innerHTML = icon('browser');
    var input = el('input', 'browser-input');
    input.type = 'text';
    input.placeholder = '输入网址或端口，例如 3000';
    input.setAttribute('aria-label', '网址');
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('data-autofocus', '');
    field.appendChild(input);
    var external = iconButton('external', '在新标签页打开', function () { if (frame.src) window.open(frame.src, '_blank', 'noopener'); });
    bar.append(back, forward, reload, field, external);
    var stage = el('div', 'browser-stage');
    var frame = el('iframe', 'browser-frame');
    frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin allow-popups allow-modals allow-downloads');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.title = '网页';
    var start = el('div', 'browser-start');
    stage.append(start, frame);
    root.append(bar, stage);

    var history = [];
    var index = -1;

    function normalize(value) {
      value = value.trim();
      if (!value) return '';
      if (/^\d{2,5}$/.test(value)) return 'http://localhost:' + value;
      if (/^https?:\/\//i.test(value)) return value;
      if (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(value)) return 'http://' + value;
      return 'https://' + value;
    }
    function render() {
      back.disabled = index <= 0;
      forward.disabled = index >= history.length - 1;
      reload.disabled = external.disabled = index < 0;
      var current = history[index];
      start.hidden = !!current;
      frame.hidden = !current;
      if (current) {
        input.value = current;
        var host = current.replace(/^https?:\/\//, '').split('/')[0];
        api.setTitle(host);
        api.setSubtitle('');
      } else {
        api.setTitle('浏览器');
        renderStart();
      }
    }
    function go(next) {
      if (next < 0 || next >= history.length) return;
      index = next;
      frame.src = history[index];
      render();
    }
    function navigate(value) {
      var target = normalize(value);
      if (!target) return;
      history = history.slice(0, index + 1);
      history.push(target);
      index = history.length - 1;
      frame.src = target;
      api.setParams({ url: target });
      render();
    }
    function renderStart() {
      start.replaceChildren();
      var head = ui.emptyState('browser', '在终端旁边预览网页', '输入网址或端口号。适合看本地开发服务、文档和仪表盘。');
      start.appendChild(head);
      var ports = detectedPorts();
      if (ports.length) {
        var box = el('div', 'browser-ports');
        box.appendChild(el('div', 'blk-menu-section', '检测到的本地服务'));
        ports.forEach(function (p) {
          var chip = button('localhost:' + p.port, function () { navigate(String(p.port)); }, { icon: 'plug', className: 'browser-port' });
          chip.appendChild(el('span', 'blk-muted', p.command + (p.window ? ' · ' + p.window : '')));
          box.appendChild(chip);
        });
        start.appendChild(box);
      }
      start.appendChild(el('p', 'browser-hint', '提示：设置了 X-Frame-Options 的网站不能内嵌，用右上角“在新标签页打开”。地址在你这台电脑的浏览器里解析。'));
    }
    bar.addEventListener('submit', function (e) { e.preventDefault(); navigate(input.value); });
    input.addEventListener('focus', function () { input.select(); });

    if (api.params.url) navigate(api.params.url); else render();
    return {
      el: root,
      update: function (params) { if (params && params.url) navigate(params.url); },
      onShow: function () { if (index < 0) renderStart(); },
    };
  }

  BlockHost.register('browser', {
    title: '浏览器',
    icon: 'browser',
    key: function () { return 'browser'; },
    create: browserBlock,
  });

  // ===========================================================================
  // Overlay pickers: theme, hosts, shortcuts
  // ===========================================================================

  var _picker = null;

  function openPicker(options) {
    if (_picker) _picker.close();
    var previous = document.activeElement;
    var overlay = el('div', 'blk-picker-overlay');
    var box = el('div', 'blk-picker' + (options.className ? ' ' + options.className : ''));
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', options.title);
    var head = el('div', 'blk-picker-head');
    var mark = el('span', 'blk-picker-icon');
    mark.innerHTML = icon(options.icon);
    head.appendChild(mark);
    var input = null;
    if (options.filter) {
      input = el('input', 'blk-picker-input');
      input.placeholder = options.filter;
      input.setAttribute('aria-label', options.filter);
      input.spellcheck = false;
      input.autocomplete = 'off';
      head.appendChild(input);
    } else {
      head.appendChild(el('strong', 'blk-picker-title', options.title));
    }
    var esc = el('button', 'blk-picker-esc', 'esc');
    esc.type = 'button';
    esc.setAttribute('aria-label', '关闭');
    head.appendChild(esc);
    var body = el('div', 'blk-picker-body');
    var foot = el('div', 'blk-picker-foot');
    (options.hints || []).forEach(function (hint) {
      var item = el('span', 'blk-picker-hint');
      item.appendChild(ui.kbd(hint[0]));
      item.appendChild(document.createTextNode(hint[1]));
      foot.appendChild(item);
    });
    box.append(head, body, foot);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    var picker = {
      overlay: overlay, box: box, body: body, input: input,
      close: function (reason) {
        if (!overlay.isConnected) return;
        overlay.remove();
        _picker = null;
        if (options.onClose) options.onClose(reason || 'dismiss');
        if (previous && previous.focus && previous.isConnected) previous.focus({ preventScroll: true });
      },
    };
    esc.addEventListener('click', function () { picker.close('dismiss'); });
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) picker.close('dismiss'); });
    overlay.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); picker.close('dismiss'); return; }
      if (options.onKey) options.onKey(e);
    });
    _picker = picker;
    setTimeout(function () { (input || esc).focus(); }, 0);
    return picker;
  }

  /** Arrow/Enter navigation over `.blk-option` rows inside a picker body. */
  function listNavigation(picker, onActivate, onSelectChange) {
    var activeIndex = 0;
    function options() { return Array.prototype.slice.call(picker.body.querySelectorAll('.blk-option')); }
    function set(index, scroll) {
      var all = options();
      if (!all.length) return;
      activeIndex = (index + all.length) % all.length;
      all.forEach(function (n, i) {
        n.classList.toggle('is-active', i === activeIndex);
        n.setAttribute('aria-selected', String(i === activeIndex));
      });
      if (scroll !== false) all[activeIndex].scrollIntoView({ block: 'nearest' });
      if (onSelectChange) onSelectChange(all[activeIndex]);
    }
    return {
      set: set,
      index: function () { return activeIndex; },
      bind: function () {
        options().forEach(function (n, i) {
          n.addEventListener('mousemove', function () { if (i !== activeIndex) set(i, false); });
          n.addEventListener('click', function () { set(i, false); onActivate(n); });
        });
      },
      key: function (e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); set(activeIndex + 1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); set(activeIndex - 1); }
        else if (e.key === 'Enter' && !e.isComposing) {
          var all = options();
          if (all[activeIndex]) { e.preventDefault(); onActivate(all[activeIndex]); }
        }
      },
    };
  }

  // --- theme picker -------------------------------------------------------------

  function themePreview(theme) {
    var t = theme.terminal || {};
    var box = el('div', 'theme-preview');
    box.style.background = t.background;
    box.style.color = t.foreground;
    function line(parts) {
      var row = el('div', 'theme-preview-line');
      parts.forEach(function (part) {
        var span = el('span', '', part[0]);
        if (part[1]) span.style.color = t[part[1]] || part[1];
        if (part[2]) span.style.fontWeight = '600';
        row.appendChild(span);
      });
      box.appendChild(row);
    }
    line([['➜ ', 'green', true], ['~/work/stencil ', 'cyan', true], ['main ', 'magenta'], ['●3 ↑1', 'yellow']]);
    line([['$ ', 'brightBlack'], ['git status --short']]);
    line([[' M ', 'yellow'], ['src/terminal.ts']]);
    line([['?? ', 'red'], ['notes/plan.md']]);
    line([['$ ', 'brightBlack'], ['npm test']]);
    line([['✓ ', 'green'], ['42 passed ', 'green'], ['✗ ', 'red'], ['1 failed ', 'red'], ['(1.2s)', 'brightBlack']]);
    var cursor = el('span', 'theme-preview-cursor');
    cursor.style.background = t.cursor || t.foreground;
    var last = el('div', 'theme-preview-line');
    last.appendChild(el('span', '', '$ '));
    last.firstChild.style.color = t.brightBlack;
    last.appendChild(cursor);
    box.appendChild(last);
    var palette = el('div', 'theme-preview-palette');
    ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'].forEach(function (name) {
      var dot = el('i');
      dot.style.background = t[name];
      dot.title = name;
      palette.appendChild(dot);
    });
    box.appendChild(palette);
    return box;
  }

  function openThemePicker() {
    if (typeof Theme === 'undefined') return;
    var original = Theme.getCurrent();
    var themes = Theme.getThemeList();
    var committed = false;
    var previewing = original;
    var picker = openPicker({
      title: '主题', icon: 'theme', filter: '筛选主题…', className: 'theme-picker',
      hints: [['Up+Down', '预览'], ['Enter', '使用'], ['Escape', '恢复']],
      onClose: function () { if (!committed && previewing !== original) Theme.apply(original); },
      onKey: function (e) { nav.key(e); },
    });
    var layoutBox = el('div', 'theme-layout');
    var list = el('div', 'theme-list');
    list.setAttribute('role', 'listbox');
    var previewHost = el('div', 'theme-preview-host');
    layoutBox.append(list, previewHost);
    picker.body.appendChild(layoutBox);

    var nav = listNavigation(picker, function (node) {
      committed = true;
      Theme.apply(node.dataset.theme);
      picker.close('commit');
      toast('主题：' + node.dataset.name);
    }, function (node) {
      if (node.dataset.theme !== previewing) {
        previewing = node.dataset.theme;
        Theme.apply(previewing);
      }
      var theme = themes.find(function (t) { return t.id === node.dataset.theme; });
      previewHost.replaceChildren(themePreview(theme));
    });

    function draw() {
      var q = picker.input.value.trim().toLowerCase();
      list.replaceChildren();
      var groups = [['dark', '深色'], ['light', '浅色']];
      var activeId = previewing;
      var startIndex = 0, count = 0;
      groups.forEach(function (group) {
        var members = themes.filter(function (t) {
          return (t.colorScheme === 'light' ? 'light' : 'dark') === group[0]
            && (!q || (t.name + ' ' + t.id + ' ' + (t.description || '')).toLowerCase().indexOf(q) !== -1);
        });
        if (!members.length) return;
        list.appendChild(el('div', 'blk-menu-section', group[1]));
        members.forEach(function (theme) {
          var t = theme.terminal || {};
          var row = el('div', 'blk-option theme-option');
          row.setAttribute('role', 'option');
          row.dataset.theme = theme.id;
          row.dataset.name = theme.name;
          var aa = el('span', 'theme-aa', 'Aa');
          aa.style.background = t.background;
          aa.style.color = t.foreground;
          aa.style.borderColor = theme.colors && theme.colors['--border'] ? theme.colors['--border'] : 'transparent';
          var name = el('span', 'theme-name', theme.name);
          var dots = el('span', 'theme-dots');
          ['red', 'green', 'yellow', 'blue', 'magenta'].forEach(function (k) {
            var d = el('i');
            d.style.background = t[k];
            dots.appendChild(d);
          });
          row.append(aa, name, dots);
          if (theme.id === original) row.appendChild(el('span', 'theme-current', '当前'));
          if (theme.id === activeId) startIndex = count;
          count++;
          list.appendChild(row);
        });
      });
      if (!count) list.appendChild(el('div', 'blk-menu-empty', '没有匹配的主题'));
      nav.bind();
      if (count) nav.set(q ? 0 : startIndex);
    }
    picker.input.addEventListener('input', draw);
    draw();
  }

  // --- hosts panel ---------------------------------------------------------------

  function hostStatus(server, health, current) {
    var workspace = AppShell.workspace(server.id);
    var sessions = workspace && Array.isArray(workspace.sessions) ? workspace.sessions.length : null;
    var sessionText = sessions == null ? '' : sessions + ' 个会话';
    var latency = health.latencyMs != null ? health.latencyMs + 'ms' : '';
    var stateText;
    switch (health.state) {
      case 'online': stateText = server.kind === 'local' ? '本机' : '已连接'; break;
      case 'degraded': stateText = '连接不稳定'; break;
      case 'checking': stateText = '正在连接…'; break;
      case 'offline': stateText = '连接中断 · 自动重连中'; break;
      case 'auth_required': stateText = '认证失败'; break;
      case 'host_key_error': stateText = '主机指纹变化'; break;
      case 'disabled': stateText = '已停用'; break;
      default: stateText = server.kind === 'local' ? '本机' : '尚未检测';
    }
    return [stateText, sessionText, server.kind === 'local' ? '' : latency, current ? '当前' : ''].filter(Boolean).join(' · ');
  }

  function openHosts() {
    if (typeof AppShell === 'undefined') return;
    var currentId = Api.activeServerId();
    var picker = openPicker({
      title: '主机', icon: 'server', filter: '查找主机…', className: 'hosts-picker',
      hints: [['Up+Down', '选择'], ['Enter', '切换'], ['Escape', '关闭']],
      onKey: function (e) { nav.key(e); },
      onClose: function () { clearInterval(timer); },
    });
    var list = el('div', 'hosts-list');
    list.setAttribute('role', 'listbox');
    picker.body.appendChild(list);
    var nav = listNavigation(picker, function (node) {
      picker.close('commit');
      if (node.dataset.action === 'add') {
        if (window.MsApp && typeof window.MsApp.openAddServer === 'function') window.MsApp.openAddServer();
        else Router.go({ name: 'servers', params: {} });
        return;
      }
      var server = AppShell.server(node.dataset.server);
      var health = AppShell.health(node.dataset.server);
      var broken = ['offline', 'auth_required', 'host_key_error'].indexOf(health.state) !== -1;
      Router.go(broken
        ? { name: 'server', params: { serverId: server.id, section: 'connection' } }
        : { name: 'terminal', params: { serverId: server.id } });
    });
    var lastSignature = '';
    function draw(force) {
      var q = picker.input.value.trim().toLowerCase();
      var servers = AppShell.servers().filter(function (s) {
        return !q || (s.name + ' ' + s.id + ' ' + AppShell._addressOf(s)).toLowerCase().indexOf(q) !== -1;
      });
      var signature = q + '|' + servers.map(function (s) {
        var h = AppShell.health(s.id);
        return s.id + ':' + h.state + ':' + h.latencyMs + ':' + hostStatus(s, h, s.id === currentId);
      }).join(',');
      if (!force && signature === lastSignature) return;
      lastSignature = signature;
      var keep = nav.index();
      list.replaceChildren();
      servers.forEach(function (server) {
        var health = AppShell.health(server.id);
        var row = el('div', 'blk-option host-option' + (server.id === currentId ? ' is-current' : ''));
        row.setAttribute('role', 'option');
        row.dataset.server = server.id;
        var dot = el('span', 'host-dot is-' + (health.state || 'unknown'));
        var text = el('span', 'host-text');
        text.appendChild(el('strong', '', server.name || server.id));
        text.appendChild(el('span', 'host-address', AppShell._addressOf(server)));
        row.append(dot, text, el('span', 'host-status', hostStatus(server, health, server.id === currentId)));
        list.appendChild(row);
      });
      if (!servers.length) list.appendChild(el('div', 'blk-menu-empty', '没有匹配的主机'));
      var add = el('div', 'blk-option host-option host-add');
      add.dataset.action = 'add';
      add.setAttribute('role', 'option');
      var plus = el('span', 'host-dot is-add');
      plus.innerHTML = icon('plus');
      add.append(plus, el('span', 'host-text', '添加远程主机…'));
      list.appendChild(add);
      nav.bind();
      nav.set(force ? Math.max(0, servers.findIndex(function (s) { return s.id === currentId; })) : Math.min(keep, servers.length), false);
    }
    picker.input.addEventListener('input', function () { draw(true); nav.set(0); });
    draw(true);
    // Health changes arrive over the status socket; keep the list live while open.
    var timer = setInterval(function () { draw(false); }, 1000);
  }

  // --- keyboard shortcuts sheet ------------------------------------------------------

  function shortcutGroups() {
    return [
      ['导航', [
        ['Mod+K', '快速切换：窗口、命令、主机'],
        ['Alt+Shift+P', '快速打开文件'],
        ['Alt+Shift+H', '切换主机'],
        ['Alt+Shift+/', '键盘快捷键'],
      ]],
      ['Blocks', COMMANDS.filter(function (c) { return c.group === 'block'; }).map(function (c) { return [c.keys, c.title]; })],
      ['窗口', [
        ['Alt+Shift+W', '关闭当前 block'],
        ['Alt+Shift+F', '浮动 / 停靠'],
        ['Alt+Shift+Enter', '最大化 / 还原'],
        ['Escape', '还原最大化的 block'],
      ]],
      ['终端', [
        ['Mod+L', '窗格布局'],
        ['Ctrl+Shift+O', '打开剪贴板里的路径'],
      ]],
      ['编辑与提交', [
        ['Mod+S', '保存文件'],
        ['Mod+Enter', '提交 / 执行 SQL'],
        ['Space', 'Git 列表里暂存或取消暂存'],
      ]],
    ];
  }

  function openShortcuts() {
    var picker = openPicker({ title: '键盘快捷键', icon: 'keyboard', className: 'shortcuts-picker', hints: [['Escape', '关闭']] });
    var grid = el('div', 'shortcuts-grid');
    shortcutGroups().forEach(function (group) {
      var section = el('section', 'shortcuts-group');
      section.appendChild(el('h4', '', group[0]));
      group[1].forEach(function (entry) {
        var row = el('div', 'shortcuts-row');
        row.append(el('span', '', entry[1]), ui.kbd(entry[0]));
        section.appendChild(row);
      });
      grid.appendChild(section);
    });
    picker.body.appendChild(grid);
    if (!ui.isMac) picker.body.appendChild(el('p', 'blk-muted shortcuts-note', 'Mod 在 macOS 上是 ⌘，其它系统上是 Ctrl。'));
  }

  // ===========================================================================
  // Git status chip in the top bar
  // ===========================================================================

  var chip = null;
  var chipBusy = false;
  var chipData = null;

  function ensureChip() {
    var crumbs = document.querySelector('.ms-topbar .crumbs');
    if (!crumbs) return null;
    if (!chip) {
      chip = el('button', 'pane-git-chip');
      chip.type = 'button';
      chip.hidden = true;
      chip.addEventListener('click', function () {
        if (chipData) BlockHost.open('git', { path: chipData.root });
      });
    }
    if (chip.parentNode !== crumbs) crumbs.appendChild(chip);
    return chip;
  }

  function refreshChip() {
    var node = ensureChip();
    if (!node) return;
    var terminal = document.querySelector('.ms-app.mode-terminal');
    var ctx = ui.currentContext();
    if (!terminal || !ctx.paneId || document.visibilityState !== 'visible') {
      if (!terminal) node.hidden = true;
      return;
    }
    if (chipBusy) return;
    chipBusy = true;
    var isStale = function () {
      var now = ui.currentContext();
      return now.serverId !== ctx.serverId || now.paneId !== ctx.paneId;
    };
    ui.client(ctx.serverId).get('/api/git/status', { path: '.', paneId: ctx.paneId }).then(function (data) {
      // The user moved on while this was running: it describes another repository.
      if (isStale()) return;
      chipData = data;
      node.replaceChildren();
      node.innerHTML = icon('branch');
      node.appendChild(el('span', 'pane-git-branch', data.detached ? 'HEAD' : (data.branch || '—')));
      if (data.files.length) node.appendChild(el('span', 'pane-git-dirty', '●' + data.files.length));
      if (data.ahead) node.appendChild(el('span', 'pane-git-track', '↑' + data.ahead));
      if (data.behind) node.appendChild(el('span', 'pane-git-track', '↓' + data.behind));
      node.title = data.root + (data.files.length ? ' · ' + data.files.length + ' 个改动' : ' · 干净') + '\n点击打开 Git (' + ui.keysText('Alt+Shift+G') + ')';
      node.setAttribute('aria-label', 'Git 分支 ' + (data.branch || '') + '，' + data.files.length + ' 个改动，打开 Git');
      node.hidden = false;
    }).catch(function () {
      if (isStale()) return;
      chipData = null;
      node.hidden = true;
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

  // ===========================================================================
  // Commands, shortcuts and palette providers
  // ===========================================================================

  function newShellWindow() {
    var ctx = ui.currentContext();
    if (!ctx.sessionId) { toast('先打开一个会话', { error: true }); return; }
    Api.post(Api.workspaceUrl(ctx.serverId, '/sessions/' + encodeURIComponent(ctx.sessionId) + '/windows'), {})
      .then(function (created) {
        if (created && created.id) Router.go({ name: 'terminal', params: { serverId: ctx.serverId, sessionId: ctx.sessionId, windowId: created.id } });
      })
      .catch(function (err) { toast(errorText(err), { error: true }); });
  }

  function openGit() {
    var ctx = ui.currentContext();
    BlockHost.open('git', chipData && chipData.root ? { path: chipData.root } : { path: '.', paneId: ctx.paneId });
  }

  function openPalette(prefix) {
    if (window.CommandPalette) window.CommandPalette.open(null, prefix);
  }

  var COMMANDS = [
    { id: 'shell', group: 'block', title: '新建 Shell 窗口', icon: 'terminal', keys: 'Alt+Shift+T', code: 'KeyT', run: newShellWindow, keywords: 'new window terminal shell 新窗口' },
    { id: 'git', group: 'block', title: 'Git', icon: 'git', keys: 'Alt+Shift+G', code: 'KeyG', run: openGit, keywords: 'git diff stage commit branch push pull 提交 暂存 分支 历史' },
    { id: 'files', group: 'block', title: '文件', icon: 'folder', keys: 'Alt+Shift+O', code: 'KeyO', run: function () { if (window.FilePreview) FilePreview.openFile('.', ui.currentContext().paneId); }, keywords: 'files browse folder 目录 文件 浏览' },
    { id: 'quick-open', group: 'nav', title: '快速打开文件…', icon: 'search', keys: 'Alt+Shift+P', code: 'KeyP', run: function () { openPalette('/'); }, keywords: 'open file find goto 文件 查找 打开' },
    { id: 'board', group: 'block', title: '看板（TODO.md）', icon: 'board', keys: 'Alt+Shift+K', code: 'KeyK', run: function () { if (window.FilePreview) FilePreview.openFile('TODO.md', ui.currentContext().paneId); }, keywords: 'kanban board todo 看板 待办' },
    { id: 'browser', group: 'block', title: '浏览器', icon: 'browser', keys: 'Alt+Shift+B', code: 'KeyB', run: function () { BlockHost.open('browser', {}); }, keywords: 'browser web url localhost 网页 预览' },
    { id: 'tasks', group: 'block', title: '任务管理器', icon: 'activity', keys: 'Alt+Shift+M', code: 'KeyM', run: function () { Router.go({ name: 'server', params: { serverId: Api.activeServerId(), section: 'performance' } }); }, keywords: 'process cpu memory 进程 性能 资源' },
    { id: 'hosts', group: 'nav', title: '切换主机…', icon: 'server', keys: 'Alt+Shift+H', code: 'KeyH', run: openHosts, keywords: 'host server switch 服务器 主机 远程' },
    { id: 'theme', group: 'block', title: '主题…', icon: 'theme', keys: 'Alt+Shift+Y', code: 'KeyY', run: openThemePicker, keywords: 'theme color 主题 配色 外观' },
    { id: 'shortcuts', group: 'nav', title: '键盘快捷键', icon: 'keyboard', keys: 'Alt+Shift+/', code: 'Slash', run: openShortcuts, keywords: 'keyboard shortcuts help 快捷键 帮助' },
    { id: 'close-block', group: 'window', title: '关闭当前 block', icon: 'close', keys: 'Alt+Shift+W', code: 'KeyW', run: function () { if (!BlockHost.closeFocused()) toast('没有打开的 block'); }, keywords: 'close block 关闭' },
    { id: 'float-block', group: 'window', title: 'Block：浮动 / 停靠', icon: 'float', keys: 'Alt+Shift+F', code: 'KeyF', run: function () { if (!BlockHost.toggleFloatFocused()) toast('没有打开的 block'); }, keywords: 'float dock window 浮动 停靠' },
    { id: 'max-block', group: 'window', title: 'Block：最大化 / 还原', icon: 'max', keys: 'Alt+Shift+Enter', code: 'Enter', run: function () { if (!BlockHost.toggleMaxFocused()) toast('没有打开的 block'); }, keywords: 'maximize zoom 最大化 全屏' },
  ];

  function commands() {
    return COMMANDS.map(function (c) {
      return { id: c.id, display: c.title, meta: '', keys: c.keys, keywords: c.keywords, icon: c.icon, run: c.run, kind: '命令' };
    });
  }

  function hosts() {
    if (typeof AppShell === 'undefined') return [];
    var currentId = Api.activeServerId();
    return AppShell.servers().map(function (server) {
      var health = AppShell.health(server.id);
      return {
        display: server.name || server.id,
        meta: hostStatus(server, health, server.id === currentId),
        keywords: server.id + ' ' + AppShell._addressOf(server),
        icon: 'server', kind: '主机', state: health.state,
        run: function () {
          var broken = ['offline', 'auth_required', 'host_key_error'].indexOf(health.state) !== -1;
          Router.go(broken ? { name: 'server', params: { serverId: server.id, section: 'connection' } } : { name: 'terminal', params: { serverId: server.id } });
        },
      };
    });
  }

  var _fileIndex = { key: '', promise: null, at: 0 };
  /** Files under the pane's cwd for quick-open, cached for 30s per pane. */
  function fileIndex() {
    var ctx = ui.currentContext();
    var key = ctx.serverId + '|' + (ctx.paneId || '');
    if (_fileIndex.promise && _fileIndex.key === key && Date.now() - _fileIndex.at < 30000) return _fileIndex.promise;
    _fileIndex.key = key;
    _fileIndex.at = Date.now();
    _fileIndex.promise = ui.client(ctx.serverId).get('/api/files/index', { path: '.', paneId: ctx.paneId }).then(function (data) {
      return {
        root: data.root, truncated: data.truncated, source: data.source,
        files: data.files,
        open: function (rel) { if (window.FilePreview) FilePreview.openFile(data.root.replace(/\/$/, '') + '/' + rel, ctx.paneId); },
      };
    });
    _fileIndex.promise.catch(function () { _fileIndex.promise = null; });
    return _fileIndex.promise;
  }

  // Capture phase so the shortcut wins over xterm, which would send it to the shell.
  document.addEventListener('keydown', function (e) {
    if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey || e.isComposing) return;
    var command = COMMANDS.find(function (c) { return c.code === e.code; });
    if (!command) return;
    e.preventDefault();
    e.stopPropagation();
    command.run();
  }, true);

  /** `twp open` pushed from a pane on the server in view. */
  function handleOpenEvent(event) {
    if (event.type === 'open-url') { BlockHost.open('browser', { url: event.url }); return; }
    if (event.type === 'open-file' && window.FilePreview) FilePreview.openFile(event.path, event.paneId || ui.currentContext().paneId);
  }

  Blocks.commands = commands;
  Blocks.hosts = hosts;
  Blocks.fileIndex = fileIndex;
  Blocks.handleOpenEvent = handleOpenEvent;
  Blocks.openThemePicker = openThemePicker;
  Blocks.openHosts = openHosts;
  Blocks.openShortcuts = openShortcuts;
  Blocks.openGit = openGit;
  Blocks.openBrowser = function (url) { return BlockHost.open('browser', url ? { url: url } : {}); };

  // --- boot ---
  function boot() {
    BlockHost.render();
    scheduleChip();
  }
  window.addEventListener('hashchange', scheduleChip);
  window.addEventListener('terminal-target-server', function () { chipData = null; scheduleChip(); });
  document.addEventListener('visibilitychange', refreshChip);
  setInterval(refreshChip, 15000);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else setTimeout(boot, 0);
})();
