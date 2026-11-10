/* global */

// Notebooks (.ipynb) in the file preview, with running them through
// /api/notebook (registered with the block kit, plugins/ui/client/js/blocks-kit.js).

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
          if (window.hljs && window.hljs.getLanguage(lang)) {
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


  Blocks.registerRenderer({ id: 'notebook', order: 10, test: function (path) { return /\.ipynb$/i.test(path); }, render: renderNotebook });
})();
