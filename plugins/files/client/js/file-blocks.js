/* global FilePreview, PanelSlots */

// The file preview's own blocks: patches (.diff, .patch), the editor, and the
// TODO.md board, with the "edit" and "board view" items of its menu
// (registered with the block kit, plugins/ui/client/js/blocks-kit.js).

(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.Blocks) return;

  var ui = Blocks.ui, icon = Blocks.icon;
  var CDN = ui.CDN, loadScript = ui.loadScript, loadCss = ui.loadCss, esc = ui.esc, el = ui.el, button = ui.button,
    iconButton = ui.iconButton, kbd = ui.kbd, keysText = ui.keysText, busy = ui.busy, spinnerLine = ui.spinnerLine,
    toast = ui.toast, errorText = ui.errorText, errorBox = ui.errorBox, confirmAction = ui.confirmAction,
    promptText = ui.promptText, emptyState = ui.emptyState, isDark = ui.isDark, client = ui.client,
    currentContext = ui.currentContext, parseUnifiedDiff = ui.parseUnifiedDiff, renderDiffInto = ui.renderDiffInto,
    downloadText = ui.downloadText;


  // --- .diff / .patch files (diff2html) -----------------------------------------

  function largeText(content) {
    return content.length > 65536 || content.split('\n').some(function (line, i) { return i >= 1000 || line.length > 4000; });
  }

  function renderDiffFile(body, content, info, options) {
    options = options || {};
    var isCurrent = options.isCurrent || function () { return true; };
    var wrap = el('div', 'blk-difffile');
    var bar = el('div', 'blk-toolbar');
    var files = parseUnifiedDiff(content);
    var limited = largeText(content);
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
      if (!isCurrent()) return;
      if (limited || !window.Diff2Html) { renderDiffInto(view, content); return; }
      view.innerHTML = window.Diff2Html.html(content, {
        drawFileList: files.length > 1, matching: 'lines', outputFormat: mode, colorScheme: isDark() ? 'dark' : 'light',
      });
    }
    if (limited) {
      draw();
      segmented.hidden = true;
      return true;
    }
    return Promise.all([loadScript(CDN.diff2html), loadCss(CDN.diff2htmlCss)])
      .catch(function () { /* fall back to the built-in renderer */ })
      .then(function () { draw(); return true; });
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

  function fileActions(file, ctx) {
    var items = [];
    var svgPaths = ui.iconPaths;
    if (!file.isDirectory && file.isText && file.rawContent != null) {
      items.push({ label: '编辑', hint: file.isMarkdown ? '所见即所得的文档编辑' : '直接修改并保存（' + keysText('Mod+S') + '）', icon: svgPaths('edit'),
        run: function () { openEditor(ctx.body, file, ctx.refresh); } });
    }
    if (!file.isDirectory && file.isMarkdown && file.rawContent != null && !largeText(file.rawContent)) {
      items.push({ label: '看板视图', hint: '## 标题作列、列表项作卡片', icon: svgPaths('board'),
        run: function () { renderBoard(ctx.body, file, ctx.refresh); } });
    }
    return items;
  }

  Blocks.registerRenderer({ id: 'patch', order: 20, test: function (path) { return /\.(diff|patch)$/i.test(path); }, render: renderDiffFile });
  Blocks.registerRenderer({ id: 'board', order: 30, test: function (path, readOnly) { return !readOnly && isBoardFile(path) && !_boardOff[path]; }, render: renderBoardFile });
  Blocks.registerPreviewActions({ id: 'file', order: 10, items: fileActions });
  Object.assign(Blocks._test, { parseBoard: parseBoard, serializeBoard: serializeBoard, setCardText: setCardText });
})();
