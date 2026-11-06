/* global */

// SQLite databases in the file preview, read through /api/sqlite. The preview
// calls Blocks.renderSqlite for them, set here.

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


  Blocks.renderSqlite = renderSqlite;
  Object.assign(Blocks._test, { toCsv: toCsv });
})();
