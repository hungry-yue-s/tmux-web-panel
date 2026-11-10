/* global Blocks, FilePreview, CommandPalette, PanelSlots */

// File commands (the palette and Alt+Shift shortcuts: browse, quick open, the
// TODO.md board), the file index quick open searches, and `anymux open <file>`
// from a pane. Loaded only with the files plugin.

(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.Blocks || !window.BlockHost || !window.PanelSlots) return;

  var ui = Blocks.ui;
  var el = ui.el, button = ui.button, iconButton = ui.iconButton, icon = Blocks.icon;
  var toast = ui.toast, errorText = ui.errorText;

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

  Blocks.fileIndex = fileIndex;

  function openFile(path, paneId) {
    if (window.FilePreview) FilePreview.openFile(path, paneId || ui.currentContext().paneId);
  }

  PanelSlots.commands.register({ id: 'files', order: 30, group: 'block', title: '文件', icon: 'folder', keys: 'Alt+Shift+O', code: 'KeyO', run: function () { openFile('.'); }, keywords: 'files browse folder 目录 文件 浏览' });
  PanelSlots.commands.register({ id: 'quick-open', order: 40, group: 'nav', title: '快速打开文件…', icon: 'search', keys: 'Alt+Shift+P', code: 'KeyP', run: function () { if (window.CommandPalette) CommandPalette.open(null, '/'); }, keywords: 'open file find goto 文件 查找 打开' });
  PanelSlots.commands.register({ id: 'board', order: 50, group: 'block', title: '看板（TODO.md）', icon: 'board', keys: 'Alt+Shift+K', code: 'KeyK', run: function () { openFile('TODO.md'); }, keywords: 'kanban board todo 看板 待办' });
  PanelSlots.openers.register({ id: 'open-file', run: function (event) { openFile(event.path, event.paneId); } });
})();
