/* global state, navigate, escapeHtml, api */

var CommandPalette = (function () {
  var _overlay = null;
  var _input = null;
  var _results = null;
  var _items = [];
  var _selectedIndex = 0;

  function open() {
    if (_overlay) return;
    _overlay = document.createElement('div');
    _overlay.className = 'cmd-palette-overlay';
    var isMobile = window.innerWidth < 768;
    var modalClass = isMobile ? 'cmd-palette-modal cmd-palette-mobile' : 'cmd-palette-modal';
    _overlay.innerHTML =
      '<div class="' + modalClass + '">' +
        '<div class="cmd-palette-input-wrap">' +
          '<span class="cmd-palette-icon">🔍</span>' +
          '<input class="cmd-palette-input" type="text" placeholder="搜索 session / window...">' +
        '</div>' +
        '<div class="cmd-palette-results"></div>' +
      '</div>';
    document.body.appendChild(_overlay);
    _input = _overlay.querySelector('.cmd-palette-input');
    _results = _overlay.querySelector('.cmd-palette-results');
    _input.addEventListener('input', function () { _search(_input.value); });
    _input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); _selectedIndex = Math.min(_selectedIndex + 1, _items.length - 1); _highlightSelected(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); _selectedIndex = Math.max(_selectedIndex - 1, 0); _highlightSelected(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (_items[_selectedIndex]) _selectItem(_items[_selectedIndex]); }
      else if (e.key === 'Escape') { close(); }
    });
    _overlay.addEventListener('click', function (e) { if (e.target === _overlay) close(); });
    _input.focus();
    _search('');
  }

  function close() {
    if (_overlay) { _overlay.remove(); _overlay = null; _input = null; _results = null; _items = []; _selectedIndex = 0; }
  }

  function _search(query) {
    _items = [];
    _selectedIndex = 0;
    var q = query.toLowerCase().trim();
    (state.sessions || []).forEach(function (session) {
      var details = session.windowDetails || [];
      details.forEach(function (w) {
        var display = session.name + ' / ' + (w.name || 'window ' + w.index);
        if (!q || display.toLowerCase().indexOf(q) !== -1 || String(w.index).indexOf(q) !== -1) {
          _items.push({
            session: session.name,
            windowIndex: w.index,
            windowName: w.name || 'window ' + w.index,
            display: display,
            paneCount: w.panes ? w.panes.length : 0,
            command: w.panes && w.panes.length > 0 ? w.panes[0].command : '',
          });
        }
      });
    });
    _renderResults();
  }

  function _renderResults() {
    if (!_results) return;
    if (_items.length === 0) { _results.innerHTML = '<div class="cmd-palette-empty">无匹配结果</div>'; return; }
    var html = '';
    _items.forEach(function (item, i) {
      var activeClass = i === _selectedIndex ? ' cmd-palette-item-active' : '';
      html += '<div class="cmd-palette-item' + activeClass + '" data-index="' + i + '">';
      html += '<span class="cmd-palette-item-name">' + escapeHtml(item.display) + '</span>';
      html += '<span class="cmd-palette-item-meta">' + item.paneCount + 'p' + (item.command ? ' · ' + escapeHtml(item.command) : '') + '</span>';
      html += '</div>';
    });
    _results.innerHTML = html;
    _results.querySelectorAll('.cmd-palette-item').forEach(function (el) {
      el.addEventListener('click', function () {
        var idx = Number(el.getAttribute('data-index'));
        if (_items[idx]) _selectItem(_items[idx]);
      });
    });
  }

  function _highlightSelected() {
    if (!_results) return;
    _results.querySelectorAll('.cmd-palette-item').forEach(function (el, i) {
      el.classList.toggle('cmd-palette-item-active', i === _selectedIndex);
    });
    var active = _results.querySelector('.cmd-palette-item-active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  function _selectItem(item) {
    close();
    api.get('/api/sessions/' + encodeURIComponent(item.session) + '/windows/' + encodeURIComponent(item.windowIndex) + '/panes')
      .then(function (result) {
        var panes = result.data || [];
        var firstPaneId = panes.length > 0 ? panes[0].id : null;
        navigate('terminal', { currentSession: item.session, currentWindow: item.windowIndex, currentPane: firstPaneId });
      })
      .catch(function () {
        navigate('terminal', { currentSession: item.session, currentWindow: item.windowIndex, currentPane: null });
      });
  }

  return { open: open, close: close };
})();
