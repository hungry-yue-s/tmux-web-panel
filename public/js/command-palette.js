/* global Store, Router, AppShell, state, navigate */

var CommandPalette = (function () {
  var _overlay, _input, _results, _status, _opener;
  var _all = [], _items = [], _selectedIndex = 0;
  var SEARCH_ICON = '<svg class="ms-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>';

  function normalized(value) {
    return String(value || '').normalize('NFKC').toLocaleLowerCase();
  }

  function destinations() {
    var snapshot = typeof Store !== 'undefined' && Store.getState ? Store.getState() : null;
    var entities = snapshot && snapshot.entities;
    var modern = !!(entities && entities.workspaceByServerId && entities.serversById);
    var current = snapshot && snapshot.route && snapshot.route.params && snapshot.route.params.serverId || 'local';
    var recents = typeof AppShell !== 'undefined' && AppShell.recentTargets ? AppShell.recentTargets() : [];
    if (!Array.isArray(recents)) recents = [];
    var items = [], seen = {};
    function add(item) {
      var key = item.route && typeof Router !== 'undefined' ? Router.serialize(item.route) : JSON.stringify(item.legacy);
      if (seen[key]) return;
      seen[key] = true;
      item.key = key;
      item.search = normalized(item.display + ' ' + item.meta + ' ' + (item.keywords || ''));
      item.recent = recents.findIndex(function (entry) {
        return entry && entry.serverId === item.serverId && entry.windowId === item.windowId;
      });
      items.push(item);
    }
    if (modern) {
      Object.keys(entities.serversById).forEach(function (id) {
        var server = entities.serversById[id], label = server.name || id;
        add({ display: label + ' · 终端', meta: '服务器', icon: 'server', serverId: id,
          keywords: id + ' 工作区 terminal', route: { name: 'terminal', params: { serverId: id } } });
        var workspace = entities.workspaceByServerId[id];
        (workspace && workspace.sessions || []).forEach(function (session) {
          (session.windows || []).forEach(function (win) {
            var panes = win.panes || [], pane = panes.find(function (item) { return item.active; }) || panes[0];
            add({ display: label + ' / ' + session.name + ' / ' + (win.name || '窗口 ' + win.index),
              meta: panes.length + ' 窗格' + (pane && pane.command ? ' · ' + pane.command : ''), icon: 'terminal',
              serverId: id, windowId: win.id, keywords: '终端 窗口 ' + win.index,
              route: { name: 'terminal', params: { serverId: id, sessionId: session.id || session.name,
                windowId: win.id, paneId: pane ? pane.id : undefined } } });
          });
        });
      });
    } else {
      (typeof state !== 'undefined' && state.sessions || []).forEach(function (session) {
        (session.windowDetails || []).forEach(function (win) {
          var panes = win.panes || [], pane = panes.find(function (item) { return item.active; }) || panes[0];
          add({ display: session.name + ' / ' + (win.name || '窗口 ' + win.index), icon: 'terminal',
            meta: panes.length + ' 窗格' + (pane && pane.command ? ' · ' + pane.command : ''),
            keywords: '终端 窗口 ' + win.index, serverId: current,
            legacy: { currentSession: session.name, currentWindow: win.index, currentPane: pane ? pane.id : null } });
        });
      });
    }
    if (typeof Router !== 'undefined') {
      if (!modern) add({ display: '终端', meta: '当前服务器', icon: 'terminal', serverId: current,
        route: { name: 'terminal', params: { serverId: current } } });
      add({ display: '运行状态', meta: '当前服务器 · 性能', keywords: 'status performance 监控', icon: 'gauge',
        serverId: current, route: { name: 'server', params: { serverId: current, section: 'performance' } } });
      add({ display: '设置', meta: '外观与偏好', keywords: 'settings 主题', icon: 'settings', route: { name: 'settings', params: {} } });
    }
    return items.sort(function (a, b) {
      var serverOrder = Number(b.serverId === current) - Number(a.serverId === current);
      if (serverOrder) return serverOrder;
      var recentOrder = (a.recent < 0 ? 100 : a.recent) - (b.recent < 0 ? 100 : b.recent);
      return recentOrder || a.display.localeCompare(b.display, 'zh-CN');
    });
  }

  function open(opener) {
    if (_overlay) { _input.focus(); return; }
    _opener = opener && typeof opener.focus === 'function' ? opener : document.activeElement;
    _all = destinations();
    _overlay = document.createElement('div');
    _overlay.className = 'cmd-palette-overlay';
    _overlay.innerHTML = '<div class="cmd-palette-modal' + (window.innerWidth < 768 ? ' cmd-palette-mobile' : '') + '" role="dialog" aria-modal="true" aria-label="快速切换">'
      + '<div class="cmd-palette-input-wrap"><span class="cmd-palette-icon">' + SEARCH_ICON + '</span>'
      + '<input class="cmd-palette-input" type="text" placeholder="搜索服务器、会话或窗口…" aria-label="搜索服务器、会话或窗口" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="cmd-palette-listbox" autocomplete="off">'
      + '<button class="cmd-palette-close" type="button" aria-label="关闭快速切换">Esc</button></div>'
      + '<div class="cmd-palette-results" id="cmd-palette-listbox" role="listbox" aria-label="目的地"></div>'
      + '<div class="cmd-palette-status" role="status" aria-live="polite"></div>'
      + '<div class="cmd-palette-footer">↑ ↓ 选择 · Enter 打开 · Esc 关闭</div></div>';
    document.body.appendChild(_overlay);
    _input = _overlay.querySelector('input');
    _results = _overlay.querySelector('.cmd-palette-results');
    _status = _overlay.querySelector('.cmd-palette-status');
    _input.addEventListener('input', function () { search(_input.value); });
    _overlay.querySelector('.cmd-palette-close').onclick = function () { close(); };
    _overlay.addEventListener('click', function (event) { if (event.target === _overlay) close(); });
    _overlay.addEventListener('keydown', function (event) {
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      else if (event.key === 'Tab') {
        event.preventDefault(); event.stopPropagation();
        var button = _overlay.querySelector('.cmd-palette-close');
        (document.activeElement === _input ? button : _input).focus();
      } else if (event.target === _input && ['ArrowDown', 'ArrowUp', 'Enter'].indexOf(event.key) !== -1) {
        event.preventDefault(); event.stopPropagation();
        if (event.key === 'Enter') { if (_items[_selectedIndex]) select(_items[_selectedIndex]); }
        else {
          _selectedIndex = Math.max(0, Math.min(_items.length - 1, _selectedIndex + (event.key === 'ArrowDown' ? 1 : -1)));
          highlight();
        }
      }
    });
    document.addEventListener('focusin', trapFocus);
    search('');
    _input.focus();
  }

  function trapFocus(event) {
    if (_overlay && !_overlay.contains(event.target)) _input.focus();
  }

  function close(restoreFocus) {
    if (!_overlay) return;
    var opener = _opener;
    document.removeEventListener('focusin', trapFocus);
    _overlay.remove();
    _overlay = _input = _results = _status = _opener = null;
    _all = _items = [];
    _selectedIndex = 0;
    if (restoreFocus !== false && opener && opener.isConnected && !opener.disabled) opener.focus({ preventScroll: true });
  }

  function search(query) {
    var words = normalized(query).trim().split(/\s+/).filter(Boolean);
    _items = _all.filter(function (item) { return words.every(function (word) { return item.search.indexOf(word) !== -1; }); });
    _selectedIndex = 0;
    _results.replaceChildren();
    _status.textContent = _items.length ? _items.length + ' 个目的地' : '没有匹配的服务器、会话或窗口';
    if (!_items.length) {
      var empty = document.createElement('div');
      empty.className = 'cmd-palette-empty';
      empty.textContent = '无匹配结果';
      empty.setAttribute('role', 'presentation');
      _results.appendChild(empty);
    }
    _items.forEach(function (item, index) {
      var row = document.createElement('div');
      row.className = 'cmd-palette-item'; row.id = 'cmd-palette-option-' + index;
      row.setAttribute('role', 'option'); row.dataset.route = item.key;
      var icon = document.createElement('span'); icon.className = 'cmd-palette-item-icon'; icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = typeof AppShell !== 'undefined' && AppShell.icon ? AppShell.icon(item.icon) : SEARCH_ICON;
      var name = document.createElement('span'); name.className = 'cmd-palette-item-name'; name.textContent = item.display;
      var meta = document.createElement('span'); meta.className = 'cmd-palette-item-meta'; meta.textContent = item.meta;
      row.append(icon, name, meta);
      row.onclick = function () { select(item); };
      _results.appendChild(row);
    });
    highlight();
  }

  function highlight() {
    _results.querySelectorAll('[role="option"]').forEach(function (row, index) {
      var selected = index === _selectedIndex;
      row.classList.toggle('cmd-palette-item-active', selected);
      row.setAttribute('aria-selected', String(selected));
      if (selected) {
        _input.setAttribute('aria-activedescendant', row.id);
        if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
      }
    });
    if (!_items.length) _input.removeAttribute('aria-activedescendant');
  }

  function select(item) {
    close(false);
    // A route selection dismisses a transient file modal, including when the
    // selected destination is the current route and Router.go is a no-op.
    // A docked inspector is separate workspace state and must be retained.
    if (window.FilePreview && window.FilePreview.closeModal) window.FilePreview.closeModal();
    if (item.route && typeof Router !== 'undefined') Router.go(item.route);
    else if (item.legacy && typeof navigate === 'function') navigate('terminal', item.legacy);
  }

  return { open: open, close: close, isOpen: function () { return !!_overlay; } };
})();
