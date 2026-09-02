/* global state */
var FilePreview = (function () {
  'use strict';

  var _overlay = null;
  var _maximized = false;
  var _currentFile = null;
  var _currentPaneId = null;
  var _dirContext = null; // parent dir abs path, set when a file is opened from the dir browser
  var _placement = 'modal';
  var _placementButton = null;
  var _maximizeButton = null;
  var _sideResizeCleanup = null;
  var _dockOverlay = null;
  var _dockTabs = [];
  var _activeDockTabId = null;
  var _nextDockTabId = 1;
  var _dockHidden = false;
  var _dockRestoreButton = null;
  var _currentOpenPath = null;
  var _refreshButton = null;
  var _autoRefreshTimer = null;
  var _refreshPromise = null;
  var _previewGeneration = 0;
  var _mermaidThemeGeneration = 0;
  var _previewReady = false;
  var _restorePromise = null;
  var _restoreContextKey = null;
  var _restoringDock = false;
  var _persistenceSuspended = false;
  var _dockContextKey = null;
  var _dockContextGeneration = 0;
  var AUTO_REFRESH_MS = 1500;
  var DOCK_STATE_PREFIX = 'tmux_file_preview_dock_v2:';
  var LEGACY_DOCK_STATE_KEY = 'tmux_file_preview_dock_v1';
  var LEGACY_DOCK_WIDTH_KEY = 'tmux_file_preview_side_width';
  var DOCK_STATE_VERSION = 1;
  var MAX_PERSISTED_DOCK_TABS = 12;

  /**
   * Identifies one window's dock state.
   *
   * The serverId belongs in the key because session names and window indices
   * repeat across machines. Keyed on those alone, two servers shared a context,
   * so switching machines saw an unchanged key and kept the previous machine's
   * dock — and both wrote the same localStorage snapshot.
   */
  function _makeDockContextKey(serverId, sessionName, windowIndex) {
    if (typeof serverId !== 'string' || !serverId) return null;
    if (typeof sessionName !== 'string' || !sessionName) return null;
    if (!((typeof windowIndex === 'number' && Number.isInteger(windowIndex) && windowIndex >= 0)
      || (typeof windowIndex === 'string' && /^\d+$/.test(windowIndex)))) return null;
    return serverId + '\u0000' + sessionName + '\u0000' + String(windowIndex);
  }

  function _dockStateStorageKey(contextKey) {
    return contextKey ? DOCK_STATE_PREFIX + encodeURIComponent(contextKey) : null;
  }

  function _currentDockStateKey() {
    return _dockStateStorageKey(_dockContextKey);
  }

  function _clearPersistedDock() {
    var key = _currentDockStateKey();
    if (!key) return;
    try { window.localStorage.removeItem(key); } catch (_) {}
  }

  function _loadDockState() {
    var key = _currentDockStateKey();
    if (!key) return null;
    var raw;
    try { raw = window.localStorage.getItem(key); } catch (_) { return null; }
    if (!raw) return null;
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== DOCK_STATE_VERSION || !Array.isArray(parsed.tabs)) {
        _clearPersistedDock();
        return null;
      }
      var seen = {};
      var tabs = parsed.tabs.filter(function (tab) {
        if (!tab || typeof tab.path !== 'string' || tab.path.charAt(0) !== '/') return false;
        if (seen[tab.path]) return false;
        seen[tab.path] = true;
        return true;
      }).slice(0, MAX_PERSISTED_DOCK_TABS).map(function (tab) {
        return {
          path: tab.path,
          paneId: typeof tab.paneId === 'string' && /^%\d+$/.test(tab.paneId) ? tab.paneId : null,
        };
      });
      if (tabs.length === 0) {
        _clearPersistedDock();
        return null;
      }
      var width = Number(parsed.width);
      return {
        tabs: tabs,
        activePath: typeof parsed.activePath === 'string' ? parsed.activePath : tabs[0].path,
        hidden: parsed.hidden === true,
        width: isFinite(width) && width > 0 ? width : 0,
      };
    } catch (_) {
      _clearPersistedDock();
      return null;
    }
  }

  function _persistDockState(widthOverride) {
    var key = _currentDockStateKey();
    if (_persistenceSuspended || !key) return;
    if (_dockTabs.length === 0) {
      _clearPersistedDock();
      return;
    }
    var active = _activeDockTab();
    var width = Number(widthOverride) || 0;
    if (!width && _dockOverlay) {
      width = parseFloat(_dockOverlay.style.flexBasis)
        || (_dockOverlay.isConnected ? _dockOverlay.getBoundingClientRect().width : 0);
    }
    var state = {
      version: DOCK_STATE_VERSION,
      tabs: _dockTabs.slice(0, MAX_PERSISTED_DOCK_TABS).map(function (tab) {
        return { path: tab.path, paneId: tab.paneId || null };
      }).filter(function (tab) { return typeof tab.path === 'string' && tab.path.charAt(0) === '/'; }),
      activePath: active ? active.path : null,
      hidden: _dockHidden,
      width: width > 0 ? Math.round(width) : 0,
    };
    if (state.tabs.length === 0) {
      _clearPersistedDock();
      return;
    }
    try { window.localStorage.setItem(key, JSON.stringify(state)); } catch (_) {}
  }

  function _migrateLegacyDockState() {
    var key = _currentDockStateKey();
    if (!key) return;
    try {
      if (window.localStorage.getItem(key) != null) return;
      var raw = window.localStorage.getItem(LEGACY_DOCK_STATE_KEY);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      if ((!parsed.width || Number(parsed.width) <= 0)) {
        var legacyWidth = parseFloat(window.localStorage.getItem(LEGACY_DOCK_WIDTH_KEY)) || 0;
        if (legacyWidth > 0) parsed.width = legacyWidth;
      }
      window.localStorage.setItem(key, JSON.stringify(parsed));
      window.localStorage.removeItem(LEGACY_DOCK_STATE_KEY);
    } catch (_) {
      try { window.localStorage.removeItem(LEGACY_DOCK_STATE_KEY); } catch (_ignored) {}
    }
  }

  function _dockLayout() {
    return document.querySelector('.ms-app.mode-terminal .ms-main')
      || document.getElementById('main-layout');
  }

  function _canDockRight() {
    var bounds = _sideWidthBounds();
    return window.innerWidth >= 900
      && !!_dockContextKey
      && !!_dockLayout()
      && !!document.querySelector('.terminal-view')
      && bounds.max >= bounds.min;
  }

  function _sideWidthBounds() {
    var layout = _dockLayout();
    var layoutWidth = layout ? layout.getBoundingClientRect().width : 0;
    if (!layoutWidth) layoutWidth = window.innerWidth || 0;

    var sidebar = layout ? layout.querySelector('#sidebar') : null;
    var sidebarWidth = 0;
    if (sidebar && window.getComputedStyle(sidebar).display !== 'none') {
      sidebarWidth = sidebar.getBoundingClientRect().width || sidebar.offsetWidth || 0;
    }

    var available = Math.max(0, layoutWidth - sidebarWidth);
    var min = 320;
    // Dragging left may grow the dock to at most 70% of the space it shares
    // with the terminal, keeping a usable terminal strip beside it.
    var max = Math.floor(available * 0.7);
    var preferred = Math.min(max, Math.max(min, Math.round(available * 0.44)));
    return { min: min, max: max, preferred: Math.min(preferred, max) };
  }

  function _clampSideWidth(width) {
    var bounds = _sideWidthBounds();
    var candidate = width || bounds.preferred;
    return Math.max(bounds.min, Math.min(bounds.max, candidate));
  }

  function _cleanupSideResize() {
    if (_sideResizeCleanup) {
      _sideResizeCleanup();
      _sideResizeCleanup = null;
    }
  }

  function _installSideResize() {
    _cleanupSideResize();
    if (!_overlay || _placement !== 'side') return;
    var sideOverlay = _overlay;
    var grip = document.createElement('div');
    grip.className = 'fp-side-resizer';
    grip.setAttribute('role', 'separator');
    grip.setAttribute('aria-label', '\u8C03\u6574\u53F3\u4FA7\u9884\u89C8\u5BBD\u5EA6');
    grip.setAttribute('aria-orientation', 'vertical');
    sideOverlay.insertBefore(grip, sideOverlay.firstChild);

    var startX = 0, startWidth = 0;
    function onMove(e) {
      var next = _clampSideWidth(startWidth + startX - e.clientX);
      sideOverlay.style.flexBasis = next + 'px';
      sideOverlay.style.width = next + 'px';
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.classList.remove('fp-side-resizing');
      var width = Math.round(sideOverlay.getBoundingClientRect().width);
      _persistDockState(width);
    }
    function onDown(e) {
      e.preventDefault();
      startX = e.clientX;
      startWidth = sideOverlay.getBoundingClientRect().width;
      document.body.classList.add('fp-side-resizing');
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    }
    grip.addEventListener('pointerdown', onDown);

    function onLayoutResize() {
      if (!sideOverlay.isConnected) return;
      if (!_canDockRight()) {
        _hideDock();
        return;
      }
      var current = parseFloat(sideOverlay.style.flexBasis) || sideOverlay.getBoundingClientRect().width;
      var next = _clampSideWidth(current);
      sideOverlay.style.flexBasis = next + 'px';
      sideOverlay.style.width = next + 'px';
    }
    window.addEventListener('resize', onLayoutResize);
    var layoutObserver = null;
    if (typeof ResizeObserver !== 'undefined') {
      layoutObserver = new ResizeObserver(onLayoutResize);
      var mainLayout = document.getElementById('main-layout');
      if (mainLayout) layoutObserver.observe(mainLayout);
    }
    _sideResizeCleanup = function () {
      grip.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('resize', onLayoutResize);
      if (layoutObserver) layoutObserver.disconnect();
      document.body.classList.remove('fp-side-resizing');
      if (grip.parentNode) grip.parentNode.removeChild(grip);
    };
  }

  function _syncPlacementButton() {
    if (!_placementButton) return;
    var side = _placement === 'side';
    _setSvgIcon(_placementButton, side
      ? '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/><path d="m18 9-3 3 3 3"/>'
      : '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/><path d="m10 9 3 3-3 3"/>');
    _placementButton.setAttribute('aria-label', side ? '\u9690\u85CF\u53F3\u4FA7\u9884\u89C8' : '\u5728\u53F3\u4FA7\u5206\u680F\u6253\u5F00');
    _placementButton.setAttribute('aria-pressed', side ? 'true' : 'false');
    _placementButton.classList.toggle('is-active', side);
    _placementButton.title = side ? '\u9690\u85CF\u53F3\u4FA7\u9884\u89C8' : '\u5728\u53F3\u4FA7\u5206\u680F\u6253\u5F00';
  }

  function _syncMaximizeButton() {
    if (!_maximizeButton) return;
    _setSvgIcon(_maximizeButton, _maximized
      ? '<path d="M8 3v5H3"/><path d="M16 3v5h5"/><path d="M8 21v-5H3"/><path d="M16 21v-5h5"/>'
      : '<path d="M8 3H3v5"/><path d="M16 3h5v5"/><path d="M8 21H3v-5"/><path d="M16 21h5v-5"/>');
    _maximizeButton.setAttribute('aria-label', _maximized ? 'Restore' : 'Maximize');
    _maximizeButton.setAttribute('aria-pressed', _maximized ? 'true' : 'false');
    _maximizeButton.classList.toggle('is-active', _maximized);
    _maximizeButton.title = _maximized ? '\u6062\u590D\u9884\u89C8' : '\u6700\u5927\u5316\u9884\u89C8';
  }

  function _stopAutoRefresh() {
    if (_autoRefreshTimer != null) {
      window.clearTimeout(_autoRefreshTimer);
      _autoRefreshTimer = null;
    }
  }

  function _canAutoRefresh() {
    return !document.hidden
      && !_dockHidden
      && _previewReady
      && !!(_overlay && _overlay.isConnected)
      && !!(_currentFile && _currentFile.absPath);
  }

  function _syncAutoRefresh() {
    _stopAutoRefresh();
    if (!_canAutoRefresh()) return;
    _autoRefreshTimer = window.setTimeout(function () {
      _autoRefreshTimer = null;
      _refreshCurrent(false).finally(_syncAutoRefresh);
    }, AUTO_REFRESH_MS);
  }

  function _setRefreshBusy(button, body, busy) {
    if (button) {
      button.classList.toggle('is-refreshing', busy);
      button.setAttribute('aria-busy', busy ? 'true' : 'false');
    }
    if (body) body.classList.toggle('fp-refreshing', busy);
  }

  function _clearRefreshError(button) {
    if (!button) return;
    button.classList.remove('has-error');
    button.title = '\u5237\u65B0\u9884\u89C8\uFF08\u6BCF 1.5 \u79D2\u81EA\u52A8\u68C0\u67E5\uFF09';
  }

  function _capturePreviewScroll(body) {
    var selectors = [
      '.fp-md-wrap', '.fp-code-wrap', '.fp-code-wrap pre > code',
      '.fp-image-wrap', '.fp-xlsx-wrap', '.fp-dir-wrap',
    ];
    var state = [{ selector: null, top: body.scrollTop, left: body.scrollLeft }];
    selectors.forEach(function (selector) {
      var el = body.querySelector(selector);
      if (el) state.push({ selector: selector, top: el.scrollTop, left: el.scrollLeft });
    });
    return state;
  }

  function _restorePreviewScroll(body, state) {
    function apply() {
      if (!body || !body.isConnected) return;
      state.forEach(function (item) {
        var el = item.selector ? body.querySelector(item.selector) : body;
        if (!el) return;
        el.scrollTop = item.top;
        el.scrollLeft = item.left;
      });
    }
    apply();
    if (window.requestAnimationFrame) window.requestAnimationFrame(apply);
  }

  function _isPreviewRequestCurrent(requestId, body, expectedFile, expectedPath) {
    return requestId === _previewGeneration
      && !!(body && body.isConnected)
      && (!expectedFile || _currentFile === expectedFile)
      && (!expectedPath || (_currentFile && _currentFile.absPath === expectedPath));
  }

  function _replacePreviewBody(body, renderedBody) {
    _disposeMermaid(body);
    body.innerHTML = '';
    while (renderedBody.firstChild) body.appendChild(renderedBody.firstChild);
  }

  function _setPreviewTitle(path) {
    if (!_overlay) return;
    var titleEl = _overlay.querySelector('.fp-title');
    if (!titleEl) return;
    titleEl.textContent = path;
    titleEl.title = path;
  }

  function _refreshCurrent(force) {
    if (_refreshPromise) return _refreshPromise;
    if (!_overlay || !_overlay.isConnected || !_currentFile || !_currentFile.absPath) {
      return Promise.resolve(false);
    }

    var fileAtStart = _currentFile;
    var pathAtStart = fileAtStart.absPath;
    var requestId = _previewGeneration;
    var body = _overlay.querySelector('.fp-body');
    if (!body) return Promise.resolve(false);
    var button = _refreshButton;
    var scroll = _capturePreviewScroll(body);
    var headers = typeof Auth !== 'undefined' ? Auth.headers() : {};
    var qs = '?path=' + encodeURIComponent(fileAtStart.absPath);
    if (_currentPaneId) qs += '&paneId=' + encodeURIComponent(_currentPaneId);

    _clearRefreshError(button);
    _setRefreshBusy(button, body, true);
    _refreshPromise = fetch('/api/files/info' + qs, {
      headers: headers, cache: 'no-store',
    })
      .then(function (r) {
        if (!_isPreviewRequestCurrent(requestId, body, fileAtStart, pathAtStart)) return null;
        if (r.status === 401) { close(); return null; }
        return r.json();
      })
      .then(function (res) {
        if (!res) return false;
        if (!res.success) throw new Error(res.error || '\u5237\u65B0\u5931\u8D25');
        if (!_isPreviewRequestCurrent(requestId, body, fileAtStart, pathAtStart)) return false;
        var info = res.data;
        var changed = force
          || fileAtStart.isDirectory
          || !!info.isDirectory !== !!fileAtStart.isDirectory
          || Number(info.mtimeMs || 0) !== Number(fileAtStart.mtimeMs || 0)
          || Number(info.size || 0) !== Number(fileAtStart.size || 0);
        if (!changed) return false;
        return Promise.resolve(_renderResolvedPreview(body, info, null, {
          reuseCurrent: true,
          requestId: requestId,
          expectedFile: fileAtStart,
          expectedPath: pathAtStart,
        })).then(function () {
          if (!_isPreviewRequestCurrent(requestId, body, fileAtStart, pathAtStart)) return false;
          _saveActiveDockTab();
          _restorePreviewScroll(body, scroll);
          return true;
        });
      })
      .catch(function (err) {
        if (_isPreviewRequestCurrent(requestId, body, fileAtStart, pathAtStart) && button) {
          button.classList.add('has-error');
          button.title = '\u5237\u65B0\u5931\u8D25\uFF1A' + (err && err.message ? err.message : err);
        }
        return false;
      })
      .finally(function () {
        _setRefreshBusy(button, body, false);
        _refreshPromise = null;
      });
    return _refreshPromise;
  }

  function _tabTitle(tab) {
    var path = tab.path || '';
    return path.split('/').filter(Boolean).pop() || path || 'Preview';
  }

  function _activeDockTab() {
    for (var i = 0; i < _dockTabs.length; i++) {
      if (_dockTabs[i].id === _activeDockTabId) return _dockTabs[i];
    }
    return null;
  }

  function _saveActiveDockTab() {
    if (_placement !== 'side') return;
    var tab = _activeDockTab();
    if (!tab) return;
    tab.currentFile = _currentFile;
    tab.paneId = _currentPaneId;
    tab.dirContext = _dirContext;
    tab.placementButton = _placementButton;
    tab.maximizeButton = _maximizeButton;
    tab.refreshButton = _refreshButton;
    tab.previewReady = _previewReady;
    tab.maximized = _maximized;
    tab.modeDir = _dockOverlay && _dockOverlay.classList.contains('fp-mode-dir');
    tab.hasBack = _dockOverlay && _dockOverlay.classList.contains('fp-has-back');
    if (_currentFile && _currentFile.absPath) tab.path = _currentFile.absPath;
    _persistDockState();
  }

  function _renderDockTabs() {
    if (!_dockOverlay) return;
    var bar = _dockOverlay.querySelector('.fp-dock-tabs');
    if (!bar) return;
    bar.innerHTML = '';
    _dockTabs.forEach(function (tab) {
      var item = document.createElement('div');
      item.className = 'fp-dock-tab-item' + (tab.id === _activeDockTabId ? ' active' : '');
      var select = document.createElement('button');
      select.className = 'fp-dock-tab';
      select.setAttribute('role', 'tab');
      select.setAttribute('aria-selected', tab.id === _activeDockTabId ? 'true' : 'false');
      select.title = tab.path || _tabTitle(tab);
      select.textContent = _tabTitle(tab);
      select.addEventListener('click', function () { _activateDockTab(tab.id); });
      var closeTab = document.createElement('button');
      closeTab.className = 'fp-dock-tab-close';
      closeTab.setAttribute('aria-label', '\u5173\u95ED ' + _tabTitle(tab));
      closeTab.textContent = '\u00D7';
      closeTab.addEventListener('click', function (e) {
        e.stopPropagation();
        _closeDockTab(tab.id);
      });
      item.appendChild(select);
      item.appendChild(closeTab);
      bar.appendChild(item);
    });
  }

  function _ensureDockOverlay() {
    if (_dockOverlay) return;
    _dockOverlay = document.createElement('div');
    _dockOverlay.className = 'fp-overlay fp-side fp-dock';
    var tabs = document.createElement('div');
    tabs.className = 'fp-dock-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', '\u6587\u4EF6\u9884\u89C8\u6807\u7B7E');
    var panels = document.createElement('div');
    panels.className = 'fp-dock-panels';
    _dockOverlay.appendChild(tabs);
    _dockOverlay.appendChild(panels);
  }

  function _removeDockRestoreButton() {
    if (_dockRestoreButton) _dockRestoreButton.remove();
    _dockRestoreButton = null;
  }

  function _showDock(preserveRequest) {
    if (!_dockOverlay || _dockTabs.length === 0 || !_canDockRight()) return;
    _dockHidden = false;
    _removeDockRestoreButton();
    var layout = _dockLayout();
    if (layout) layout.appendChild(_dockOverlay);
    var savedWidth = 0;
    var persisted = _loadDockState();
    if (persisted) savedWidth = persisted.width;
    var dockWidth = _clampSideWidth(savedWidth);
    _dockOverlay.style.flexBasis = dockWidth + 'px';
    _dockOverlay.style.width = dockWidth + 'px';
    _dockOverlay.classList.toggle('fp-restoring', _restoringDock);
    document.body.classList.add('fp-side-open');
    _activateDockTab(_activeDockTabId || _dockTabs[0].id, preserveRequest);
    _installSideResize();
    _persistDockState(dockWidth);
  }

  function _hideDock(persistHidden) {
    if (!_dockOverlay) return;
    if (document.__fpActiveMermaidDialogClose) document.__fpActiveMermaidDialogClose();
    _previewGeneration++;
    _stopAutoRefresh();
    _saveActiveDockTab();
    _dockHidden = true;
    _cleanupSideResize();
    _dockOverlay.remove();
    document.body.classList.remove('fp-side-open');
    _placement = 'modal';
    _overlay = null;
    _currentFile = null;
    _currentPaneId = null;
    _dirContext = null;
    if (!_dockRestoreButton) {
      _dockRestoreButton = document.createElement('button');
      _dockRestoreButton.className = 'fp-dock-restore';
      _dockRestoreButton.setAttribute('aria-label', '\u5C55\u5F00\u53F3\u4FA7\u6587\u4EF6\u9884\u89C8');
      _dockRestoreButton.addEventListener('click', function () { _showDock(); });
      var layout = _dockLayout();
      if (layout) layout.appendChild(_dockRestoreButton);
    }
    _dockRestoreButton.textContent = '\u25E7 ' + _dockTabs.length;
    if (persistHidden !== false) _persistDockState();
  }

  function _activateDockTab(tabId, preserveRequest) {
    if (!_dockOverlay) return;
    if (document.__fpActiveMermaidDialogClose) document.__fpActiveMermaidDialogClose();
    if (_placement === 'side') _saveActiveDockTab();
    var tab = null;
    for (var i = 0; i < _dockTabs.length; i++) {
      if (_dockTabs[i].id === tabId) { tab = _dockTabs[i]; break; }
    }
    if (!tab) return;
    if (!preserveRequest) _previewGeneration++;
    _activeDockTabId = tab.id;
    var panels = _dockOverlay.querySelector('.fp-dock-panels');
    if (panels) {
      panels.innerHTML = '';
      panels.appendChild(tab.modal);
    }
    _overlay = _dockOverlay;
    _placement = 'side';
    _currentFile = tab.currentFile;
    _currentPaneId = tab.paneId;
    _dirContext = tab.dirContext;
    _placementButton = tab.placementButton;
    _maximizeButton = tab.maximizeButton;
    _refreshButton = tab.refreshButton;
    _previewReady = tab.previewReady !== false;
    _maximized = !!tab.maximized;
    _dockOverlay.classList.toggle('fp-mode-dir', !!tab.modeDir);
    _dockOverlay.classList.toggle('fp-has-back', !!tab.hasBack);
    _dockOverlay.classList.toggle('fp-side-maximized', _maximized);
    _syncPlacementButton();
    _syncMaximizeButton();
    _renderDockTabs();
    _syncAutoRefresh();
    _persistDockState();
  }

  function _closeDockTab(tabId) {
    var index = -1;
    for (var i = 0; i < _dockTabs.length; i++) {
      if (_dockTabs[i].id === tabId) { index = i; break; }
    }
    if (index < 0) return;
    var wasActive = _activeDockTabId === tabId;
    _disposeMermaid(_dockTabs[index].modal);
    _dockTabs[index].modal.remove();
    _dockTabs.splice(index, 1);
    if (_dockTabs.length === 0) {
      _destroyDock();
      return;
    }
    if (wasActive) {
      var next = _dockTabs[Math.min(index, _dockTabs.length - 1)];
      _activeDockTabId = next.id;
      if (!_dockHidden) {
        // The old active tab has already been removed; do not save its globals
        // into the replacement tab when activating the neighbour.
        _placement = 'modal';
        _activateDockTab(next.id);
      }
    }
    _renderDockTabs();
    if (_dockRestoreButton) _dockRestoreButton.textContent = '\u25E7 ' + _dockTabs.length;
    _persistDockState();
  }

  function _destroyDock(preservePersisted) {
    _previewGeneration++;
    _previewReady = false;
    _stopAutoRefresh();
    _cleanupSideResize();
    var separateOverlay = _overlay && _overlay !== _dockOverlay ? _overlay : null;
    _disposeMermaid(separateOverlay);
    if (separateOverlay) separateOverlay.remove();
    _dockTabs.forEach(function (tab) { _disposeMermaid(tab.modal); });
    _disposeMermaid(_dockOverlay);
    if (_dockOverlay) _dockOverlay.remove();
    _removeDockRestoreButton();
    _dockOverlay = null;
    _dockTabs = [];
    _activeDockTabId = null;
    _dockHidden = false;
    if (!preservePersisted) _clearPersistedDock();
    document.body.classList.remove('fp-side-open');
    _overlay = null;
    _placement = 'modal';
    _currentFile = null;
    _currentPaneId = null;
    _dirContext = null;
    _currentOpenPath = null;
    _placementButton = null;
    _maximizeButton = null;
    _refreshButton = null;
    _maximized = false;
  }

  function _dockCurrentPreview() {
    if (!_overlay || _placement === 'side' || !_canDockRight()) return false;
    var modalOverlay = _overlay;
    var modal = modalOverlay.querySelector('.fp-modal');
    if (!modal) return false;
    var path = (_currentFile && _currentFile.absPath) || _currentOpenPath || '';
    for (var i = 0; i < _dockTabs.length; i++) {
      if (path && _dockTabs[i].path === path) {
        _disposeMermaid(modalOverlay);
        modalOverlay.remove();
        _activeDockTabId = _dockTabs[i].id;
        _showDock();
        _persistDockState();
        return true;
      }
    }
    _ensureDockOverlay();
    modal.remove();
    modalOverlay.remove();
    var tab = {
      id: _nextDockTabId++, path: path, modal: modal,
      currentFile: _currentFile, paneId: _currentPaneId, dirContext: _dirContext,
      placementButton: _placementButton, maximizeButton: _maximizeButton,
      refreshButton: _refreshButton,
      previewReady: _previewReady,
      maximized: false,
      modeDir: modalOverlay.classList.contains('fp-mode-dir'),
      hasBack: modalOverlay.classList.contains('fp-has-back'),
    };
    modal.classList.remove('fp-maximized');
    _dockTabs.push(tab);
    _activeDockTabId = tab.id;
    _showDock(true);
    _persistDockState();
    return true;
  }

  function _isDockContextCurrent(contextKey, generation) {
    return !!contextKey
      && contextKey === _dockContextKey
      && generation === _dockContextGeneration;
  }

  function switchDockContext(serverId, sessionName, windowIndex) {
    var nextContextKey = _makeDockContextKey(serverId, sessionName, windowIndex);
    if (nextContextKey === _dockContextKey) {
      if (!nextContextKey) return Promise.resolve(false);
      if (_dockTabs.length > 0) return Promise.resolve(true);
      return restoreDocked();
    }

    _dockContextGeneration++;
    if (_dockContextKey) _persistDockState();
    _persistenceSuspended = true;
    _destroyDock(true);
    _restorePromise = null;
    _restoreContextKey = null;
    _restoringDock = false;
    _persistenceSuspended = false;
    _dockContextKey = nextContextKey;

    if (!nextContextKey) return Promise.resolve(false);
    _migrateLegacyDockState();
    return restoreDocked(_dockContextGeneration);
  }

  function restoreDocked(expectedGeneration) {
    var contextKey = _dockContextKey;
    var generation = expectedGeneration == null ? _dockContextGeneration : expectedGeneration;
    if (!contextKey || !_isDockContextCurrent(contextKey, generation)) return Promise.resolve(false);
    if (_restorePromise && _restoreContextKey === contextKey) return _restorePromise;
    if (_dockTabs.length > 0) {
      if (_dockHidden) _hideDock();
      else _showDock();
      return Promise.resolve(true);
    }
    var saved = _loadDockState();
    if (!saved || !_canDockRight()) return Promise.resolve(false);

    _restoringDock = true;
    _persistenceSuspended = true;
    var chain = Promise.resolve();
    saved.tabs.forEach(function (tab) {
      chain = chain.then(function () {
        if (!_isDockContextCurrent(contextKey, generation)) return false;
        return openFile(tab.path, tab.paneId, { restoring: true });
      }).then(function (opened) {
        if (!_isDockContextCurrent(contextKey, generation)) return;
        if (opened === true) {
          _dockCurrentPreview();
          return;
        }
        if (_placement !== 'side' && _overlay) close();
      });
    });

    _restoreContextKey = contextKey;
    _restorePromise = chain.then(function () {
      if (!_isDockContextCurrent(contextKey, generation)) return false;
      if (_dockTabs.length === 0) {
        _destroyDock();
        return false;
      }
      var active = null;
      for (var i = 0; i < _dockTabs.length; i++) {
        if (_dockTabs[i].path === saved.activePath) { active = _dockTabs[i]; break; }
      }
      _restoringDock = false;
      if (_dockOverlay) _dockOverlay.classList.remove('fp-restoring');
      _activateDockTab((active || _dockTabs[0]).id);
      if (saved.hidden) _hideDock();
      else _showDock();
      return true;
    }).catch(function () {
      if (_isDockContextCurrent(contextKey, generation)) _destroyDock();
      return false;
    }).finally(function () {
      if (!_isDockContextCurrent(contextKey, generation)) return;
      _restoringDock = false;
      _persistenceSuspended = false;
      _restorePromise = null;
      _restoreContextKey = null;
      _persistDockState();
    });
    return _restorePromise;
  }

  // --- Lazy loading ---
  var _loaded = {};

  function _loadScript(url) {
    if (_loaded[url]) return _loaded[url];
    var p = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = url;
      var timer = setTimeout(function () { reject(new Error('Timeout loading: ' + url)); }, 10000);
      s.onload = function () { clearTimeout(timer); resolve(); };
      s.onerror = function () { clearTimeout(timer); reject(new Error('Failed to load: ' + url)); };
      document.head.appendChild(s);
    });
    _loaded[url] = p.catch(function (err) { delete _loaded[url]; throw err; });
    return _loaded[url];
  }

  function _loadCSS(url) {
    if (_loaded[url]) return _loaded[url];
    _loaded[url] = new Promise(function (resolve) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = url;
      link.onload = resolve;
      link.onerror = resolve;
      document.head.appendChild(link);
    });
    return _loaded[url];
  }

  var CDN = {
    hljs: 'https://unpkg.com/@highlightjs/cdn-assets@11.11.1/highlight.min.js',
    hljsCss: 'https://unpkg.com/@highlightjs/cdn-assets@11.11.1/styles/github-dark.min.css',
    markdownIt: 'https://unpkg.com/markdown-it@14.1.0/dist/markdown-it.min.js',
    katexCss: 'https://unpkg.com/katex@0.16.21/dist/katex.min.css',
    katexJs: 'https://unpkg.com/katex@0.16.21/dist/katex.min.js',
    markdownItKatex: 'https://unpkg.com/@iktakahiro/markdown-it-katex@4.0.1/dist/markdown-it-katex.min.js',
    mermaid: 'https://unpkg.com/mermaid@11.6.0/dist/mermaid.min.js',
    exceljs: 'https://unpkg.com/exceljs@4.4.0/dist/exceljs.min.js',
  };

  // --- Modal ---

  function _createModal(title) {
    _stopAutoRefresh();
    if (document.__fpActiveMermaidDialogClose) document.__fpActiveMermaidDialogClose();
    if (_placement === 'side') {
      _saveActiveDockTab();
    } else if (_overlay) {
      _disposeMermaid(_overlay);
      _overlay.remove();
    }
    _maximized = false;
    _placement = 'modal';

    _overlay = document.createElement('div');
    _overlay.className = 'fp-overlay' + (_restoringDock ? ' fp-restoring' : '');
    _overlay.addEventListener('click', function (e) {
      if (e.target === _overlay) close();
    });

    var modal = document.createElement('div');
    modal.className = 'fp-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-label', 'File Preview');

    var header = document.createElement('div');
    header.className = 'fp-header';

    var titleEl = document.createElement('span');
    titleEl.className = 'fp-title';
    titleEl.textContent = title;
    titleEl.title = title;

    var actions = document.createElement('div');
    actions.className = 'fp-actions';

    var btnBack = _btn('', 'Back to parent directory', function () {
      if (_dirContext) {
        var parent = _dirContext;
        _dirContext = null;
        openFile(parent, _currentPaneId);
      }
    });
    btnBack.className += ' fp-btn-back';
    _setSvgIcon(btnBack, '<path d="m15 18-6-6 6-6"/><path d="M9 12h10"/>');

    var btnMaximize = _btn('', 'Maximize', function () {
      _maximized = !_maximized;
      modal.classList.toggle('fp-maximized', _maximized);
      _overlay.classList.toggle('fp-side-maximized', _maximized && _placement === 'side');
      _syncMaximizeButton();
    });
    btnMaximize.className += ' fp-btn-maximize';
    _maximizeButton = btnMaximize;
    var btnPlacement = _btn('', '\u5728\u53F3\u4FA7\u5206\u680F\u6253\u5F00', function () {
      if (_placement === 'side') _hideDock();
      else _dockCurrentPreview();
    });
    btnPlacement.className += ' fp-btn-placement';
    var btnRefresh = _btn('', 'Refresh preview', function () { _refreshCurrent(true); });
    _setSvgIcon(btnRefresh,
      '<path d="M20 6v5h-5"/><path d="M4 18v-5h5"/>'
      + '<path d="M6.1 9a7 7 0 0 1 11.5-2.6L20 9"/>'
      + '<path d="m4 15 2.4 2.6A7 7 0 0 0 17.9 15"/>');
    btnRefresh.className += ' fp-btn-refresh is-live';
    btnRefresh.title = '刷新预览（每 1.5 秒自动检查）';
    _refreshButton = btnRefresh;
    _placementButton = btnPlacement;
    var btnNewTab = _btn('', 'Open in new tab', function () { _openNewTab(); });
    _setSvgIcon(btnNewTab,
      '<path d="M15 3h6v6"/><path d="m10 14 11-11"/>'
      + '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>');
    btnNewTab.className += ' fp-btn-file-only fp-btn-newtab';
    var btnExport = _btn('', '\u5BFC\u51FA\u6E32\u67D3\u540E\u7684 HTML', function () { _exportHtml(); });
    _setSvgIcon(btnExport,
      '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>'
      + '<path d="M14 2v6h6"/><path d="M12 11v7"/><path d="m9 15 3 3 3-3"/>');
    btnExport.className += ' fp-btn-file-only';
    var btnShare = _btn('', '\u751F\u6210\u5185\u7F51\u5206\u4EAB\u94FE\u63A5', function () { _openShareDialog(); });
    _setSvgIcon(btnShare,
      '<path d="M10 13a5 5 0 0 0 7.54.54l2-2a5 5 0 0 0-7.07-7.07l-1.15 1.15"/>'
      + '<path d="M14 11a5 5 0 0 0-7.54-.54l-2 2a5 5 0 0 0 7.07 7.07l1.14-1.14"/>');
    btnShare.className += ' fp-btn-file-only';
    var btnDownload = _btn('', 'Download', function () { _download(); });
    _setSvgIcon(btnDownload,
      '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>');
    btnDownload.className += ' fp-btn-file-only fp-btn-download';
    var btnClose = _btn('', 'Close', close);
    _setSvgIcon(btnClose, '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>');
    btnClose.className += ' fp-btn-close';

    actions.appendChild(btnRefresh);
    actions.appendChild(btnPlacement);
    actions.appendChild(btnMaximize);
    actions.appendChild(btnNewTab);
    actions.appendChild(btnExport);
    actions.appendChild(btnShare);
    actions.appendChild(btnDownload);
    actions.appendChild(btnClose);
    header.appendChild(btnBack);
    header.appendChild(titleEl);
    header.appendChild(actions);

    var body = document.createElement('div');
    body.className = 'fp-body';
    body.innerHTML = '<div class="fp-loading">Loading\u2026</div>';

    modal.appendChild(header);
    modal.appendChild(body);
    _overlay.appendChild(modal);
    document.body.appendChild(_overlay);
    _syncPlacementButton();
    _syncMaximizeButton();

    btnClose.focus();
    _overlay.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { close(); e.stopPropagation(); }
      if (e.key === 'Tab') {
        var focusable = modal.querySelectorAll('button, [tabindex]');
        if (focusable.length === 0) return;
        var first = focusable[0], last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });

    return body;
  }

  function _btn(text, label, onclick) {
    var b = document.createElement('button');
    b.className = 'fp-btn';
    b.type = 'button';
    b.textContent = text;
    b.setAttribute('aria-label', label);
    b.title = label;
    b.addEventListener('click', onclick);
    return b;
  }

  function _setSvgIcon(button, paths) {
    button.classList.add('fp-btn-svg');
    button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"'
      + ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'
      + ' aria-hidden="true" focusable="false">' + paths + '</svg>';
  }

  function _mermaidHex(value, fallback) {
    var color = String(value || '').trim();
    var shortHex = /^#([0-9a-f]{3})$/i.exec(color);
    if (shortHex) {
      return '#' + shortHex[1].split('').map(function (ch) { return ch + ch; }).join('');
    }
    if (/^#[0-9a-f]{6}$/i.test(color)) return color;
    var rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(color);
    if (rgb) {
      return '#' + rgb.slice(1, 4).map(function (channel) {
        return Math.max(0, Math.min(255, Number(channel))).toString(16).padStart(2, '0');
      }).join('');
    }
    return fallback;
  }

  function _mermaidThemeValue(styles, name, fallback) {
    return _mermaidHex(styles.getPropertyValue(name), fallback);
  }

  function _isDarkMermaidColor(hex) {
    var value = parseInt(hex.slice(1), 16);
    var red = (value >> 16) & 255;
    var green = (value >> 8) & 255;
    var blue = value & 255;
    return (red * 299 + green * 587 + blue * 114) / 1000 < 128;
  }

  function _mermaidThemeConfig() {
    var styles = window.getComputedStyle(document.documentElement);
    var background = _mermaidThemeValue(styles, '--bg-primary', '#1a1b26');
    var deep = _mermaidThemeValue(styles, '--bg-deep', '#16161e');
    var card = _mermaidThemeValue(styles, '--bg-card', '#24283b');
    var hover = _mermaidThemeValue(styles, '--bg-hover', '#292e42');
    var border = _mermaidThemeValue(styles, '--border', '#3b4261');
    var subtleBorder = _mermaidThemeValue(styles, '--border-subtle', '#2f3450');
    var text = _mermaidThemeValue(styles, '--text-primary', '#c0caf5');
    var secondaryText = _mermaidThemeValue(styles, '--text-secondary', '#a9b1d6');
    var accent = _mermaidThemeValue(styles, '--accent-blue', '#7aa2f7');

    return {
      startOnLoad: false,
      theme: 'base',
      securityLevel: 'loose',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      themeVariables: {
        darkMode: _isDarkMermaidColor(background),
        background: background,
        primaryColor: card,
        primaryTextColor: text,
        primaryBorderColor: accent,
        secondaryColor: hover,
        secondaryTextColor: text,
        secondaryBorderColor: border,
        tertiaryColor: deep,
        tertiaryTextColor: text,
        tertiaryBorderColor: subtleBorder,
        lineColor: accent,
        textColor: text,
        mainBkg: card,
        nodeBorder: accent,
        clusterBkg: deep,
        clusterBorder: border,
        defaultLinkColor: accent,
        titleColor: text,
        edgeLabelBackground: background,
        nodeTextColor: text,
        noteBkgColor: hover,
        noteTextColor: text,
        noteBorderColor: border,
        actorBkg: card,
        actorBorder: accent,
        actorTextColor: text,
        signalColor: secondaryText,
        signalTextColor: text,
        labelBoxBkgColor: hover,
        labelBoxBorderColor: border,
        labelTextColor: text,
      },
      // Reserve vertical room below subgraph titles. Mermaid only sizes for a
      // single-line title, so a long wrapped title needs extra bottom room.
      flowchart: { subGraphTitleMargin: { top: 6, bottom: 24 } },
    };
  }

  function _initializeMermaidTheme() {
    window.mermaid.initialize(_mermaidThemeConfig());
  }

  // Turn Mermaid's responsive SVG into a readable, scrollable embed. Mermaid
  // emits width="100%" plus a max-width, which is useful for small diagrams but
  // makes a wide flowchart's labels unreadably tiny. Keep at least 75% of the
  // intrinsic SVG size and let the embed scroll horizontally instead.
  function _prepareMermaid(container) {
    var svg = container.querySelector('svg');
    if (!svg) return false;
    var viewBox = (svg.getAttribute('viewBox') || '').trim().split(/[ ,]+/).map(Number);
    var width = viewBox.length === 4 && viewBox[2] > 0 ? viewBox[2]
      : parseFloat(svg.getAttribute('width')) || 800;
    var height = viewBox.length === 4 && viewBox[3] > 0 ? viewBox[3]
      : parseFloat(svg.getAttribute('height')) || 450;

    container.classList.add('fp-mermaid-embed');
    container.setAttribute('data-fp-width', String(width));
    container.setAttribute('data-fp-height', String(height));

    var scroll = document.createElement('div');
    scroll.className = 'fp-mermaid-scroll';
    scroll.setAttribute('aria-label', '\u53EF\u6EDA\u52A8\u7684 Mermaid \u56FE\u8868');
    var canvas = document.createElement('div');
    canvas.className = 'fp-mermaid-canvas';
    canvas.title = '\u70B9\u51FB\u653E\u5927\u67E5\u770B';
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.style.maxWidth = 'none';
    svg.style.height = 'auto';
    canvas.appendChild(svg);
    scroll.appendChild(canvas);

    var open = document.createElement('button');
    open.type = 'button';
    open.className = 'fp-mermaid-open';
    open.setAttribute('aria-label', '\u653E\u5927\u67E5\u770B Mermaid \u56FE\u8868');
    open.title = '\u653E\u5927\u67E5\u770B';
    open.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"'
      + ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'
      + ' aria-hidden="true"><path d="M8 3H3v5"/><path d="M16 3h5v5"/>'
      + '<path d="M8 21H3v-5"/><path d="M16 21h5v-5"/></svg>';

    container.innerHTML = '';
    container.appendChild(scroll);
    container.appendChild(open);
    return true;
  }

  // Self-contained on purpose: its source is also embedded into exported/new-
  // tab HTML, so graph behavior stays the same outside the panel document.
  function _installMermaidInteractions(root) {
    var doc = root.nodeType === 9 ? root : root.ownerDocument;
    var win = doc.defaultView || window;
    var MIN_READABLE = 0.75, MIN_ZOOM = 0.2, MAX_ZOOM = 4;

    function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
    function graphSize(embed) {
      return {
        width: parseFloat(embed.getAttribute('data-fp-width')) || 800,
        height: parseFloat(embed.getAttribute('data-fp-height')) || 450,
      };
    }
    function graphEmbeds(scope) {
      var list = Array.prototype.slice.call(scope.querySelectorAll('.fp-mermaid-embed'));
      if (scope.matches && scope.matches('.fp-mermaid-embed')) list.unshift(scope);
      return list;
    }
    function textButton(className, label, text) {
      var button = doc.createElement('button');
      button.type = 'button';
      button.className = 'fp-mermaid-tool ' + className;
      button.setAttribute('aria-label', label);
      button.title = label;
      button.textContent = text;
      return button;
    }
    function renderPng(svg, size) {
      return new Promise(function (resolve, reject) {
        var settled = false;
        var timer = win.setTimeout(function () {
          finish(new Error('PNG 生成超时'));
        }, 10000);
        function finish(error, blob) {
          if (settled) return;
          settled = true;
          win.clearTimeout(timer);
          if (error) reject(error); else resolve(blob);
        }
        var copy = svg.cloneNode(true);
        copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        copy.setAttribute('width', String(size.width));
        copy.setAttribute('height', String(size.height));
        copy.style.width = size.width + 'px';
        copy.style.height = size.height + 'px';

        var svgText = new win.XMLSerializer().serializeToString(copy);
        var image = new win.Image();
        image.onerror = function () {
          finish(new Error('SVG 转换失败'));
        };
        image.onload = function () {
          try {
            var outputScale = Math.min(2, 8192 / Math.max(size.width, size.height));
            var canvas = doc.createElement('canvas');
            canvas.width = Math.max(1, Math.round(size.width * outputScale));
            canvas.height = Math.max(1, Math.round(size.height * outputScale));
            var context = canvas.getContext('2d');
            if (!context) { finish(new Error('浏览器不支持图片导出')); return; }
            context.fillStyle = win.getComputedStyle(doc.documentElement)
              .getPropertyValue('--bg-primary').trim() || '#ffffff';
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            canvas.toBlob(function (blob) {
              finish(blob ? null : new Error('PNG 生成失败'), blob);
            }, 'image/png');
          } catch (error) {
            finish(error);
          }
        };
        image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
      });
    }
    function downloadPng(blob, filename) {
      var pngUrl = win.URL.createObjectURL(blob);
      var link = doc.createElement('a');
      link.href = pngUrl;
      link.download = filename;
      link.rel = 'noopener';
      doc.body.appendChild(link);
      link.click();
      link.remove();
      win.setTimeout(function () { win.URL.revokeObjectURL(pngUrl); }, 60000);
    }
    function copyPng(blobPromise) {
      var handlers = win.webkit && win.webkit.messageHandlers;
      if (handlers && handlers.tmuxPanelClipboard) {
        return blobPromise.then(function (blob) {
          if (blob.size > 16 * 1024 * 1024) throw new Error('图片超过 16 MB');
          return new Promise(function (resolve, reject) {
            var reader = new win.FileReader();
            reader.onerror = function () { reject(new Error('读取 PNG 失败')); };
            reader.onload = function () {
              var result = String(reader.result || '');
              var comma = result.indexOf(',');
              if (comma < 0) { reject(new Error('PNG 编码失败')); return; }
              handlers.tmuxPanelClipboard.postMessage({ pngBase64: result.slice(comma + 1) });
              resolve();
            };
            reader.readAsDataURL(blob);
          });
        });
      }
      if (win.navigator.clipboard && typeof win.navigator.clipboard.write === 'function'
          && typeof win.ClipboardItem === 'function') {
        return win.navigator.clipboard.write([
          new win.ClipboardItem({ 'image/png': blobPromise }),
        ]);
      }
      return Promise.reject(new Error('当前环境不支持图片剪贴板'));
    }

    graphEmbeds(root).forEach(function (embed) {
      if (embed.__fpMermaidBound) return;
      embed.__fpMermaidBound = true;
      var scroll = embed.querySelector('.fp-mermaid-scroll');
      var canvas = embed.querySelector('.fp-mermaid-canvas');
      var sourceSvg = embed.querySelector('svg');
      var openButton = embed.querySelector('.fp-mermaid-open');
      if (!scroll || !canvas || !sourceSvg || !openButton) return;
      var size = graphSize(embed);
      var observer = null;

      function layoutInline() {
        var available = (scroll.clientWidth || embed.clientWidth || win.innerWidth || size.width) - 32;
        var fit = available > 0 ? available / size.width : 1;
        var scale = fit >= MIN_READABLE ? Math.min(1, fit) : MIN_READABLE;
        sourceSvg.style.width = Math.round(size.width * scale) + 'px';
        sourceSvg.style.height = Math.round(size.height * scale) + 'px';
        embed.setAttribute('data-fp-scale', String(scale));
        embed.classList.toggle('is-wide', scale === MIN_READABLE && fit < MIN_READABLE);
      }

      function openViewer() {
        if (doc.__fpActiveMermaidDialogClose) doc.__fpActiveMermaidDialogClose();
        var overlay = doc.createElement('div');
        overlay.className = 'fp-mermaid-dialog';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', 'Mermaid \u56FE\u8868\u67E5\u770B\u5668');

        var panel = doc.createElement('div');
        panel.className = 'fp-mermaid-dialog-panel';
        var header = doc.createElement('div');
        header.className = 'fp-mermaid-dialog-header';
        var title = doc.createElement('strong');
        title.className = 'fp-mermaid-dialog-title';
        title.textContent = 'Mermaid \u56FE\u8868';
        var tools = doc.createElement('div');
        tools.className = 'fp-mermaid-dialog-tools';
        tools.setAttribute('role', 'toolbar');
        tools.setAttribute('aria-label', '\u56FE\u8868\u5DE5\u5177');
        var minus = textButton('fp-mermaid-zoom-out', '\u7F29\u5C0F\u56FE\u8868', '\u2212');
        var percent = textButton('fp-mermaid-percent', '\u5F53\u524D\u7F29\u653E\u6BD4\u4F8B', '100%');
        percent.disabled = true;
        var plus = textButton('fp-mermaid-zoom-in', '\u653E\u5927\u56FE\u8868', '+');
        var fitButton = textButton('fp-mermaid-fit', '\u9002\u5E94\u7A97\u53E3', '\u9002\u5E94');
        var actual = textButton('fp-mermaid-actual', '\u6062\u590D 100%', '1:1');
        var exportButton = textButton('fp-mermaid-export', '\u4E0B\u8F7D PNG \u56FE\u7247', '\u4E0B\u8F7D');
        var copyButton = textButton('fp-mermaid-copy', '\u590D\u5236 PNG \u5230\u526A\u8D34\u677F', '\u590D\u5236');
        var fullscreen = textButton('fp-mermaid-fullscreen', '\u5168\u5C4F\u67E5\u770B', '\u5168\u5C4F');
        var closeButton = textButton('fp-mermaid-close', '\u5173\u95ED\u56FE\u8868\u67E5\u770B\u5668', '\u00D7');
        [minus, percent, plus, fitButton, actual, exportButton, copyButton, fullscreen, closeButton]
          .forEach(function (button) { tools.appendChild(button); });
        header.appendChild(title);
        header.appendChild(tools);

        var viewport = doc.createElement('div');
        viewport.className = 'fp-mermaid-dialog-viewport';
        viewport.setAttribute('tabindex', '0');
        viewport.setAttribute('aria-label', '\u62D6\u52A8\u67E5\u770B\u56FE\u8868\uFF0CCtrl \u6216 Command \u52A0\u6EDA\u8F6E\u53EF\u7F29\u653E');
        var dialogCanvas = doc.createElement('div');
        dialogCanvas.className = 'fp-mermaid-dialog-canvas';
        var svg = sourceSvg.cloneNode(true);
        svg.style.maxWidth = 'none';
        svg.style.height = 'auto';
        dialogCanvas.appendChild(svg);
        viewport.appendChild(dialogCanvas);
        panel.appendChild(header);
        panel.appendChild(viewport);
        overlay.appendChild(panel);
        doc.body.appendChild(overlay);

        var scale = 1;
        var closed = false;
        var drag = null;

        function applyScale(next, anchorX, anchorY) {
          var oldWidth = Math.max(1, size.width * scale);
          var oldHeight = Math.max(1, size.height * scale);
          var viewWidth = viewport.clientWidth || win.innerWidth || 1200;
          var viewHeight = viewport.clientHeight || win.innerHeight || 760;
          var x = anchorX == null ? viewWidth / 2 : anchorX;
          var y = anchorY == null ? viewHeight / 2 : anchorY;
          var contentX = (viewport.scrollLeft + x) / oldWidth;
          var contentY = (viewport.scrollTop + y) / oldHeight;
          scale = clamp(next, MIN_ZOOM, MAX_ZOOM);
          var scaledWidth = Math.round(size.width * scale);
          var scaledHeight = Math.round(size.height * scale);
          svg.style.width = scaledWidth + 'px';
          svg.style.height = scaledHeight + 'px';
          dialogCanvas.style.width = Math.max(scaledWidth, viewWidth - 32) + 'px';
          dialogCanvas.style.height = Math.max(scaledHeight, viewHeight - 32) + 'px';
          percent.textContent = Math.round(scale * 100) + '%';
          viewport.scrollLeft = Math.max(0, contentX * scaledWidth - x);
          viewport.scrollTop = Math.max(0, contentY * scaledHeight - y);
        }

        function fitScale() {
          var viewWidth = viewport.clientWidth || win.innerWidth || 1200;
          var viewHeight = viewport.clientHeight || win.innerHeight || 760;
          return clamp(Math.min((viewWidth - 48) / size.width,
            (viewHeight - 48) / size.height), MIN_ZOOM, MAX_ZOOM);
        }
        function readableScale() { return Math.max(MIN_READABLE, Math.min(1, fitScale())); }
        function onKey(e) {
          if (e.key !== 'Escape' || doc.fullscreenElement) return;
          e.preventDefault();
          closeViewer();
        }
        function onFullscreenChange() {
          fullscreen.textContent = doc.fullscreenElement === panel ? '\u9000\u51FA\u5168\u5C4F' : '\u5168\u5C4F';
          fullscreen.setAttribute('aria-label', doc.fullscreenElement === panel ? '\u9000\u51FA\u5168\u5C4F' : '\u5168\u5C4F\u67E5\u770B');
        }
        function stopDrag() {
          drag = null;
          viewport.classList.remove('is-dragging');
          win.removeEventListener('pointermove', onPointerMove);
          win.removeEventListener('pointerup', stopDrag);
          win.removeEventListener('pointercancel', stopDrag);
        }
        function onPointerMove(e) {
          if (!drag) return;
          viewport.scrollLeft = drag.left - (e.clientX - drag.x);
          viewport.scrollTop = drag.top - (e.clientY - drag.y);
        }
        function closeViewer() {
          if (closed) return;
          closed = true;
          stopDrag();
          doc.removeEventListener('keydown', onKey, true);
          doc.removeEventListener('fullscreenchange', onFullscreenChange);
          if (doc.fullscreenElement === panel && doc.exitFullscreen) {
            try { doc.exitFullscreen(); } catch (_) { /* best effort */ }
          }
          overlay.remove();
          embed.__fpMermaidClose = null;
          if (doc.__fpActiveMermaidDialogClose === closeViewer) doc.__fpActiveMermaidDialogClose = null;
        }

        minus.addEventListener('click', function () { applyScale(scale / 1.2); });
        plus.addEventListener('click', function () { applyScale(scale * 1.2); });
        fitButton.addEventListener('click', function () { applyScale(fitScale()); });
        actual.addEventListener('click', function () { applyScale(1); });
        exportButton.addEventListener('click', function () {
          exportButton.disabled = true;
          exportButton.textContent = '\u4E0B\u8F7D\u4E2D\u2026';
          renderPng(sourceSvg, size)
            .then(function (blob) {
              downloadPng(blob,
                embed.getAttribute('data-fp-export-name') || 'mermaid-diagram.png');
            })
            .catch(function (err) {
              win.alert('\u4E0B\u8F7D\u5931\u8D25: ' + (err && err.message ? err.message : err));
            })
            .finally(function () {
              exportButton.disabled = false;
              exportButton.textContent = '\u4E0B\u8F7D';
            });
        });
        copyButton.addEventListener('click', function () {
          copyButton.disabled = true;
          copyButton.textContent = '\u590D\u5236\u4E2D\u2026';
          copyPng(renderPng(sourceSvg, size))
            .then(function () {
              copyButton.textContent = '\u5DF2\u590D\u5236';
              win.setTimeout(function () { copyButton.textContent = '\u590D\u5236'; }, 1200);
            })
            .catch(function (err) {
              copyButton.textContent = '\u590D\u5236';
              win.alert('\u590D\u5236\u5931\u8D25: ' + (err && err.message ? err.message : err));
            })
            .finally(function () { copyButton.disabled = false; });
        });
        fullscreen.addEventListener('click', function () {
          if (doc.fullscreenElement === panel) {
            if (doc.exitFullscreen) doc.exitFullscreen();
          } else if (panel.requestFullscreen) panel.requestFullscreen();
        });
        closeButton.addEventListener('click', closeViewer);
        overlay.addEventListener('click', function (e) { if (e.target === overlay) closeViewer(); });
        viewport.addEventListener('pointerdown', function (e) {
          if (e.button != null && e.button !== 0) return;
          drag = { x: e.clientX, y: e.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
          viewport.classList.add('is-dragging');
          win.addEventListener('pointermove', onPointerMove);
          win.addEventListener('pointerup', stopDrag);
          win.addEventListener('pointercancel', stopDrag);
        });
        viewport.addEventListener('wheel', function (e) {
          if (!e.ctrlKey && !e.metaKey) return;
          e.preventDefault();
          var rect = viewport.getBoundingClientRect();
          applyScale(scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12),
            e.clientX - rect.left, e.clientY - rect.top);
        }, { passive: false });
        doc.addEventListener('keydown', onKey, true);
        doc.addEventListener('fullscreenchange', onFullscreenChange);
        doc.__fpActiveMermaidDialogClose = closeViewer;
        embed.__fpMermaidClose = closeViewer;
        applyScale(readableScale());
        closeButton.focus();
      }

      function openFromGraph(e) {
        if (e && e.target && e.target.closest && e.target.closest('a')) return;
        openViewer();
      }
      openButton.addEventListener('click', openViewer);
      canvas.addEventListener('click', openFromGraph);
      if (win.ResizeObserver) {
        observer = new win.ResizeObserver(layoutInline);
        observer.observe(scroll);
      }
      layoutInline();
      if (win.requestAnimationFrame) win.requestAnimationFrame(layoutInline);
      embed.__fpMermaidCleanup = function () {
        if (observer) observer.disconnect();
        if (embed.__fpMermaidClose) embed.__fpMermaidClose();
        openButton.removeEventListener('click', openViewer);
        canvas.removeEventListener('click', openFromGraph);
        embed.__fpMermaidBound = false;
      };
    });
  }

  function _disposeMermaid(root) {
    if (!root || !root.querySelectorAll) return;
    var embeds = Array.prototype.slice.call(root.querySelectorAll('.fp-mermaid-embed'));
    if (root.matches && root.matches('.fp-mermaid-embed')) embeds.unshift(root);
    embeds.forEach(function (embed) {
      if (embed.__fpMermaidCleanup) embed.__fpMermaidCleanup();
    });
  }

  function _refreshMermaidTheme() {
    if (!window.mermaid || typeof window.mermaid.render !== 'function') {
      return Promise.resolve([]);
    }
    var embeds = Array.prototype.slice.call(document.querySelectorAll('.fp-mermaid-embed'));
    if (embeds.length === 0) return Promise.resolve([]);

    var generation = ++_mermaidThemeGeneration;
    _initializeMermaidTheme();
    return Promise.all(embeds.map(function (container, i) {
      var code = container.__fpMermaidSource;
      if (!code) return Promise.resolve(null);
      var id = 'fp-mmd-theme-' + Date.now() + '-' + generation + '-' + i;
      return window.mermaid.render(id, code)
        .then(function (res) {
          if (generation !== _mermaidThemeGeneration || !container.isConnected) return null;
          _disposeMermaid(container);
          container.className = 'mermaid';
          container.removeAttribute('data-fp-width');
          container.removeAttribute('data-fp-height');
          container.innerHTML = res.svg;
          container.__fpMermaidSource = code;
          _prepareMermaid(container);
          _installMermaidInteractions(container);
          return container;
        })
        .catch(function () { return null; });
    }));
  }

  function _mermaidStandaloneScript() {
    return '<script>(' + _installMermaidInteractions.toString() + ')(document);<\/script>';
  }

  // Snapshot the theme vars the main window currently has applied (Theme.apply
  // writes these onto documentElement), so the standalone tab follows whatever
  // theme — including light themes — the user has switched to.
  function _rootVars() {
    var keys = ['--bg-primary', '--bg-secondary', '--bg-card', '--bg-deep', '--bg-hover', '--border-subtle',
      '--text-primary', '--text-secondary', '--text-muted', '--accent-blue', '--accent-red'];
    var cs = getComputedStyle(document.documentElement);
    var out = ':root{';
    keys.forEach(function (k) {
      var v = (cs.getPropertyValue(k) || '').trim();
      if (v) out += k + ':' + v + ';';
    });
    return out + '}';
  }

  // Inline theme so the standalone tab matches the in-modal preview (the new
  // document has none of the page's stylesheets). Mirrors the .fp-* rules in
  // public/css/style.css; keep them in sync.
  function _standaloneCss() {
    return [
      _rootVars(),
      'html,body{margin:0;background:var(--bg-card);color:var(--text-primary);',
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;}",
      '.fp-code-wrap,.fp-md-wrap{height:auto;min-height:100vh;box-sizing:border-box;}',
      ".fp-code-wrap pre{margin:0;padding:14px;font-size:0.82rem;line-height:1.5;font-family:'JetBrains Mono',monospace;tab-size:4;display:flex;align-items:flex-start;}",
      '.fp-code-wrap .fp-line-numbers{flex:0 0 auto;padding-right:14px;border-right:1px solid var(--border-subtle);margin-right:14px;text-align:right;color:var(--text-muted);user-select:none;white-space:pre;}',
      '.fp-code-wrap pre > code{flex:1 1 auto;min-width:0;white-space:pre;overflow-x:auto;}',
      '.fp-code-wrap pre > code.hljs{padding:0;}',
      '.fp-md-wrap{padding:20px 28px;font-size:0.9rem;line-height:1.7;color:var(--text-primary);}',
      '.fp-md-wrap h1,.fp-md-wrap h2,.fp-md-wrap h3{margin:1em 0 0.5em;}',
      '.fp-md-wrap h1{font-size:1.5rem;border-bottom:1px solid var(--border-subtle);padding-bottom:6px;}',
      '.fp-md-wrap h2{font-size:1.25rem;}.fp-md-wrap h3{font-size:1.1rem;}',
      '.fp-md-wrap pre{background:var(--bg-primary);border-radius:6px;padding:12px;overflow-x:auto;}',
      ".fp-md-wrap code{font-family:'JetBrains Mono',monospace;font-size:0.82rem;}",
      '.fp-md-wrap :not(pre) > code{background:var(--bg-primary);padding:2px 5px;border-radius:3px;}',
      '.fp-md-wrap img{max-width:100%;border-radius:6px;}',
      '.fp-md-wrap table{border-collapse:collapse;width:100%;margin:1em 0;}',
      '.fp-md-wrap th,.fp-md-wrap td{border:1px solid var(--border-subtle);padding:6px 10px;text-align:left;}',
      '.fp-md-wrap th{background:var(--bg-primary);}',
      '.fp-md-wrap blockquote{border-left:3px solid var(--accent-blue);margin:1em 0;padding:4px 16px;color:var(--text-muted);}',
      '.fp-md-wrap a{color:var(--accent-blue);}',
      '.fp-md-wrap .fp-frontmatter{margin:0 0 1.2em;padding:10px 14px;border:1px solid var(--border-subtle);border-radius:8px;background:var(--bg-primary);font-size:0.84rem;}',
      '.fp-md-wrap .fp-fm-row{display:flex;gap:10px;padding:3px 0;align-items:baseline;}',
      '.fp-md-wrap .fp-fm-row+.fp-fm-row{border-top:1px solid var(--border-subtle);}',
      '.fp-md-wrap .fp-fm-key{flex:0 0 110px;color:var(--text-muted);font-weight:600;}',
      '.fp-md-wrap .fp-fm-val{flex:1 1 auto;min-width:0;word-break:break-word;}',
      '.fp-md-wrap mark.fp-hl{background:rgba(255,213,0,0.28);color:inherit;padding:0 2px;border-radius:2px;}',
      '.fp-md-wrap .fp-wikilink{color:var(--accent-blue);border-bottom:1px dashed var(--accent-blue);}',
      '.fp-md-wrap .fp-embed{color:var(--text-muted);font-style:italic;}',
      '.fp-md-wrap .fp-embed-img{max-width:100%;border-radius:6px;}',
      '.fp-md-wrap .fp-tag{display:inline-block;background:var(--bg-primary);color:var(--accent-blue);font-size:0.78rem;padding:0 7px;border-radius:10px;border:1px solid var(--border-subtle);line-height:1.5;white-space:nowrap;}',
      '.fp-md-wrap .fp-callout{border-left:4px solid var(--accent-blue);border-radius:6px;margin:1em 0;padding:10px 16px;color:var(--text-primary);background:color-mix(in srgb,var(--accent-blue) 10%,transparent);}',
      '.fp-md-wrap .fp-callout>p:last-child{margin-bottom:0;}',
      '.fp-md-wrap .fp-callout-title{display:flex;align-items:center;gap:8px;font-weight:600;margin-bottom:6px;}',
      '.fp-md-wrap .fp-callout-tip,.fp-md-wrap .fp-callout-success,.fp-md-wrap .fp-callout-done{border-left-color:#3fb950;background:color-mix(in srgb,#3fb950 10%,transparent);}',
      '.fp-md-wrap .fp-callout-warning,.fp-md-wrap .fp-callout-caution,.fp-md-wrap .fp-callout-important{border-left-color:#d29922;background:color-mix(in srgb,#d29922 12%,transparent);}',
      '.fp-md-wrap .fp-callout-danger,.fp-md-wrap .fp-callout-error,.fp-md-wrap .fp-callout-bug,.fp-md-wrap .fp-callout-failure{border-left-color:#f85149;background:color-mix(in srgb,#f85149 12%,transparent);}',
      '.fp-md-wrap .fp-callout-question,.fp-md-wrap .fp-callout-help,.fp-md-wrap .fp-callout-example{border-left-color:#a371f7;background:color-mix(in srgb,#a371f7 12%,transparent);}',
      '.fp-md-wrap .katex-display{overflow-x:auto;padding:4px 0;}',
      '.fp-mermaid-embed{position:relative;margin:1.2em 0;border:1px solid var(--border-subtle);border-radius:10px;background:var(--bg-primary);overflow:hidden;}',
      '.fp-mermaid-scroll{overflow:auto;padding:16px;scrollbar-gutter:stable;}',
      '.fp-mermaid-canvas{display:flex;width:max-content;min-width:100%;justify-content:center;align-items:flex-start;cursor:zoom-in;}',
      '.fp-mermaid-embed svg{display:block;max-width:none!important;height:auto;flex:none;}',
      '.fp-mermaid-open{position:absolute;top:8px;right:8px;width:32px;height:32px;display:flex;align-items:center;justify-content:center;border:1px solid var(--border-subtle);border-radius:7px;background:var(--bg-card);color:var(--text-secondary);cursor:pointer;opacity:.72;}',
      '.fp-mermaid-open:hover{opacity:1;color:var(--text-primary);}.fp-mermaid-open svg{width:17px;height:17px;}',
      '.fp-mermaid-dialog{position:fixed;inset:0;z-index:12000;display:flex;align-items:center;justify-content:center;padding:2vh 2vw;background:rgba(0,0,0,.72);}',
      '.fp-mermaid-dialog-panel{width:96vw;height:94vh;display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--border-subtle);border-radius:12px;background:var(--bg-card);box-shadow:0 24px 80px rgba(0,0,0,.58);}',
      '.fp-mermaid-dialog-panel:fullscreen{width:100vw;height:100vh;border:0;border-radius:0;}',
      '.fp-mermaid-dialog-header{display:flex;align-items:center;gap:14px;min-height:54px;padding:8px 10px 8px 16px;border-bottom:1px solid var(--border-subtle);background:var(--bg-primary);}',
      '.fp-mermaid-dialog-title{flex:1;min-width:0;font-size:.9rem;}.fp-mermaid-dialog-tools{display:flex;align-items:center;gap:4px;}',
      '.fp-mermaid-tool{height:34px;min-width:34px;padding:0 10px;border:1px solid var(--border-subtle);border-radius:7px;background:var(--bg-card);color:var(--text-secondary);cursor:pointer;font-size:.8rem;}',
      '.fp-mermaid-tool:hover{color:var(--text-primary);background:var(--bg-secondary);}.fp-mermaid-percent{min-width:58px;color:var(--text-primary);cursor:default;}',
      '.fp-mermaid-close{font-size:1.2rem;}.fp-mermaid-dialog-viewport{flex:1;overflow:auto;padding:16px;cursor:grab;outline:none;touch-action:none;background:var(--bg-primary);}',
      '.fp-mermaid-dialog-viewport.is-dragging{cursor:grabbing;user-select:none;}.fp-mermaid-dialog-canvas{display:flex;align-items:center;justify-content:center;min-width:100%;min-height:100%;}.fp-mermaid-dialog-canvas svg{display:block;max-width:none!important;flex:none;}',
      '.fp-xlsx-wrap{min-height:100vh;}',
      '.fp-xlsx-tabs{display:flex;gap:2px;padding:6px 8px 0;overflow-x:auto;border-bottom:1px solid var(--border-subtle);background:var(--bg-primary);position:sticky;top:0;}',
      '.fp-xlsx-tab{flex:0 0 auto;padding:5px 12px;border:1px solid var(--border-subtle);border-bottom:none;border-radius:6px 6px 0 0;cursor:pointer;background:transparent;color:var(--text-muted);font-size:0.82rem;white-space:nowrap;}',
      '.fp-xlsx-tab.active{color:var(--text-primary);background:var(--bg-card);}',
      '.fp-xlsx-pane{display:none;}.fp-xlsx-pane.active{display:block;}',
      '.fp-xlsx-table{border-collapse:collapse;font-size:0.82rem;background:var(--bg-card);color:var(--text-primary);}',
      '.fp-xlsx-table td{border:1px solid var(--border-subtle);padding:3px 8px;white-space:nowrap;max-width:480px;overflow:hidden;text-overflow:ellipsis;vertical-align:top;}',
      '.fp-fs-btn{position:fixed;top:12px;right:12px;z-index:9999;width:34px;height:34px;',
      'display:flex;align-items:center;justify-content:center;font-size:16px;line-height:1;',
      'background:var(--bg-card);color:var(--text-primary);border:1px solid var(--border-subtle);',
      'border-radius:6px;cursor:pointer;opacity:0.5;transition:opacity 0.15s;}',
      '.fp-fs-btn:hover{opacity:1;}',
      ':fullscreen .fp-md-wrap,:fullscreen .fp-code-wrap{min-height:100vh;}',
    ].join('');
  }

  // Floating fullscreen toggle injected into the standalone tab. The inline
  // script runs because blob: text/html documents execute their own scripts.
  function _fullscreenWidget() {
    return '<button class="fp-fs-btn" id="fpFs" title="全屏 / Fullscreen" aria-label="Toggle fullscreen">⛶</button>'
      + '<script>(function(){var b=document.getElementById("fpFs");if(!b)return;'
      + 'function sync(){b.textContent=document.fullscreenElement?"\\u00d7":"\\u26f6";}'
      + 'b.addEventListener("click",function(){'
      + 'if(document.fullscreenElement){document.exitFullscreen();}'
      + 'else{var el=document.documentElement;if(el.requestFullscreen)el.requestFullscreen();}});'
      + 'document.addEventListener("fullscreenchange",sync);})();<\/script>';
  }

  // Re-wire xlsx sheet tabs in the standalone tab — the modal's addEventListener
  // handlers don't survive outerHTML serialization, so delegate by index.
  function _xlsxTabScript() {
    return '<script>document.addEventListener("click",function(e){'
      + 'var t=e.target.closest&&e.target.closest(".fp-xlsx-tab");if(!t)return;'
      + 'var w=t.closest(".fp-xlsx-wrap");if(!w)return;'
      + 'var tabs=w.querySelectorAll(".fp-xlsx-tab"),panes=w.querySelectorAll(".fp-xlsx-pane");'
      + 'var i=Array.prototype.indexOf.call(tabs,t);'
      + 'for(var k=0;k<tabs.length;k++){tabs[k].classList.remove("active");}'
      + 'for(var j=0;j<panes.length;j++){panes[j].classList.remove("active");}'
      + 't.classList.add("active");if(panes[i])panes[i].classList.add("active");'
      + '});<\/script>';
  }

  function _escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // Inline <img src="/api/files/raw…"> as data URIs on a CLONED subtree so the
  // standalone snapshot is fully self-contained — no auth token, no live file
  // access. Returns a promise; failures leave the original src (broken image is
  // better than a failed export).
  function _inlineAssets(root) {
    var imgs = root.querySelectorAll ? root.querySelectorAll('img') : [];
    var headers = typeof Auth !== 'undefined' ? Auth.headers() : {};
    var jobs = Array.prototype.map.call(imgs, function (img) {
      var src = img.getAttribute('src') || '';
      if (src.indexOf('/api/files/raw') < 0 || src.indexOf('data:') === 0) return Promise.resolve();
      return fetch(src, { headers: headers, credentials: 'same-origin' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
        .then(function (blob) {
          return new Promise(function (resolve) {
            var fr = new FileReader();
            fr.onload = function () { img.setAttribute('src', fr.result); resolve(); };
            fr.onerror = function () { resolve(); };
            fr.readAsDataURL(blob);
          });
        })
        .catch(function () { /* keep original src */ });
    });
    return Promise.all(jobs);
  }

  // Build a self-contained HTML document from the current rendered preview.
  // Resolves to { html, filename } or null when there's nothing to snapshot
  // (e.g. a binary file). Shared by "open in new tab", "export HTML", "share".
  function _buildStandaloneDoc() {
    if (!_currentFile || _currentFile.isDirectory) return Promise.resolve(null);
    var rendered = _overlay && _overlay.querySelector('.fp-md-wrap, .fp-code-wrap, .fp-xlsx-wrap');
    if (!rendered) return Promise.resolve(null);
    // Always clone: we strip interactive bits and inline images without
    // mutating what's on screen.
    var capture = rendered.cloneNode(true);
    capture.querySelectorAll('.fp-colfilter-btn, .fp-table-search').forEach(function (b) { b.remove(); });
    var base = (_currentFile.filename || 'preview').replace(/\.[^.]+$/, '');
    return _inlineAssets(capture).then(function () {
      var title = _escapeHtml(_currentFile.filename || 'preview');
      var doc = '<!DOCTYPE html><html><head><meta charset="utf-8">'
        + '<meta name="viewport" content="width=device-width, initial-scale=1">'
        + '<title>' + title + '</title>'
        + '<link rel="stylesheet" href="' + CDN.hljsCss + '">'
        + '<link rel="stylesheet" href="' + CDN.katexCss + '">'
        + '<style>' + _standaloneCss() + '</style></head><body>'
        + _fullscreenWidget()
        + capture.outerHTML
        + _xlsxTabScript() + _mermaidStandaloneScript() + '</body></html>';
      return { html: doc, filename: base + '.html' };
    });
  }

  function _openNewTab() {
    if (!_currentFile || _currentFile.isDirectory) return;
    var nativeWindow = null;
    try {
      var handlers = window.webkit && window.webkit.messageHandlers;
      nativeWindow = handlers && handlers.tmuxPanelOpenWindow;
    } catch (_) { /* browser path below */ }
    if (_currentFile.isText || _currentFile.isMarkdown || _currentFile.isXlsx) {
      // Open the tab synchronously (popup blockers require a user-gesture-time
      // window.open), then fill it once the self-contained doc is built.
      var rendered = _overlay && _overlay.querySelector('.fp-md-wrap, .fp-code-wrap, .fp-xlsx-wrap');
      if (rendered) {
        if (nativeWindow && typeof nativeWindow.postMessage === 'function') {
          _buildStandaloneDoc().then(function (out) {
            if (out) nativeWindow.postMessage({
              html: out.html, title: _currentFile.filename || 'Preview', width: 1100, height: 760,
            });
          });
          return;
        }
        var win = window.open('', '_blank');
        _buildStandaloneDoc().then(function (out) {
          if (!out) { if (win) win.close(); return; }
          var blobUrl = URL.createObjectURL(new Blob([out.html], { type: 'text/html;charset=utf-8' }));
          if (win) { win.location = blobUrl; } else { window.open(blobUrl, '_blank'); }
        });
        return;
      }
      if (nativeWindow && typeof nativeWindow.postMessage === 'function') {
        nativeWindow.postMessage({
          url: _currentFile.rawUrl, title: _currentFile.filename || 'Preview', width: 1100, height: 760,
        });
        return;
      }
      // Not rendered yet — xlsx has no text content, hand off the raw file.
      if (_currentFile.isXlsx) { window.open(_currentFile.rawUrl, '_blank'); return; }
      // Otherwise fall back to raw text (still UTF-8 to avoid 乱码).
      var blob = new Blob([_currentFile.rawContent || ''], { type: 'text/plain;charset=utf-8' });
      window.open(URL.createObjectURL(blob), '_blank');
    } else {
      window.open(_currentFile.rawUrl, '_blank');
    }
  }

  // Download the rendered preview as a self-contained .html file.
  function _exportHtml() {
    _buildStandaloneDoc().then(function (out) {
      if (!out) { alert('当前文件无法导出渲染结果'); return; }
      var blobUrl = URL.createObjectURL(new Blob([out.html], { type: 'text/html;charset=utf-8' }));
      var a = document.createElement('a');
      a.href = blobUrl; a.download = out.filename; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 60000);
    }).catch(function (err) {
      alert('导出失败: ' + (err && err.message ? err.message : err));
    });
  }

  // --- Share link (server-stored snapshot with expiry) ---

  var _HOUR = 3600 * 1000, _DAY = 24 * _HOUR, _MAX_TTL = 90 * _DAY;

  function _shareApi(method, pathSuffix, body) {
    var headers = typeof Auth !== 'undefined' ? Auth.headers() : {};
    var opts = { method: method, headers: Object.assign({}, headers), credentials: 'same-origin' };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch('/api/share' + (pathSuffix || ''), opts).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok || !j.success) throw new Error((j && j.error) || ('HTTP ' + r.status));
        return j.data;
      });
    });
  }

  function _copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () { _copyFallback(text); });
    }
    _copyFallback(text);
    return Promise.resolve();
  }
  function _copyFallback(text) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (_) {}
    ta.remove();
  }

  function _fmtExpiry(ts) {
    try { return new Date(ts).toLocaleString(); } catch (_) { return String(ts); }
  }

  function _openShareDialog() {
    if (!_currentFile || _currentFile.isDirectory) return;

    var ov = document.createElement('div');
    ov.className = 'fp-share-overlay';
    var box = document.createElement('div');
    box.className = 'fp-share-box';
    ov.appendChild(box);

    box.innerHTML =
      '<div class="fp-share-title">生成内网分享链接</div>'
      + '<div class="fp-share-sub">把当前渲染结果冻结成一份快照,内网任何人凭链接即可查看(无需登录),到期自动失效。</div>'
      + '<div class="fp-share-row">'
      + '  <label class="fp-share-label">有效期</label>'
      + '  <select class="fp-share-select" id="fpShareTtl">'
      + '    <option value="' + _HOUR + '">1 小时</option>'
      + '    <option value="' + _DAY + '" selected>1 天</option>'
      + '    <option value="' + (7 * _DAY) + '">7 天</option>'
      + '    <option value="' + (30 * _DAY) + '">30 天</option>'
      + '    <option value="custom">自定义…</option>'
      + '  </select>'
      + '  <span class="fp-share-custom" id="fpShareCustom" style="display:none">'
      + '    <input class="fp-share-num" id="fpShareNum" type="number" min="1" value="3">'
      + '    <select class="fp-share-select" id="fpShareUnit"><option value="' + _HOUR + '">小时</option><option value="' + _DAY + '" selected>天</option></select>'
      + '  </span>'
      + '</div>'
      + '<div class="fp-share-actions">'
      + '  <button class="fp-share-btn" id="fpShareCancel">关闭</button>'
      + '  <button class="fp-share-btn fp-share-primary" id="fpShareGen">生成链接</button>'
      + '</div>'
      + '<div class="fp-share-result" id="fpShareResult" style="display:none"></div>'
      + '<div class="fp-share-listwrap"><div class="fp-share-listtitle">我的分享</div><div class="fp-share-list" id="fpShareList">加载中…</div></div>';

    document.body.appendChild(ov);

    var ttlSel = box.querySelector('#fpShareTtl');
    var customWrap = box.querySelector('#fpShareCustom');
    var numEl = box.querySelector('#fpShareNum');
    var unitEl = box.querySelector('#fpShareUnit');
    var resultEl = box.querySelector('#fpShareResult');
    var listEl = box.querySelector('#fpShareList');
    var genBtn = box.querySelector('#fpShareGen');

    function closeDlg() { ov.remove(); }
    box.querySelector('#fpShareCancel').addEventListener('click', closeDlg);
    ov.addEventListener('click', function (e) { if (e.target === ov) closeDlg(); });

    ttlSel.addEventListener('change', function () {
      customWrap.style.display = ttlSel.value === 'custom' ? 'inline-flex' : 'none';
    });

    function chosenTtl() {
      var ms = ttlSel.value === 'custom'
        ? (Number(numEl.value) || 0) * (Number(unitEl.value) || _DAY)
        : Number(ttlSel.value);
      return ms;
    }

    function renderList() {
      _shareApi('GET', '').then(function (data) {
        var shares = (data && data.shares) || [];
        if (!shares.length) { listEl.innerHTML = '<div class="fp-share-empty">暂无有效分享</div>'; return; }
        listEl.innerHTML = '';
        shares.forEach(function (s) {
          var url = location.origin + '/s/' + s.id;
          var row = document.createElement('div');
          row.className = 'fp-share-item';
          row.innerHTML = '<div class="fp-share-item-main">'
            + '<div class="fp-share-item-name">' + _escapeHtml(s.filename) + '</div>'
            + '<div class="fp-share-item-meta">到期 ' + _escapeHtml(_fmtExpiry(s.expiresAt)) + '</div></div>'
            + '<button class="fp-share-mini" data-act="copy">复制</button>'
            + '<button class="fp-share-mini fp-share-danger" data-act="revoke">回收</button>';
          row.querySelector('[data-act="copy"]').addEventListener('click', function () {
            _copyText(url); this.textContent = '已复制'; var b = this;
            setTimeout(function () { b.textContent = '复制'; }, 1200);
          });
          row.querySelector('[data-act="revoke"]').addEventListener('click', function () {
            _shareApi('DELETE', '/' + encodeURIComponent(s.id)).then(renderList);
          });
          listEl.appendChild(row);
        });
      }).catch(function (err) {
        listEl.innerHTML = '<div class="fp-share-empty">列表加载失败: ' + _escapeHtml(err.message) + '</div>';
      });
    }

    genBtn.addEventListener('click', function () {
      var ttl = chosenTtl();
      if (!ttl || ttl <= 0) { alert('请输入有效的有效期'); return; }
      if (ttl > _MAX_TTL) { alert('有效期最长 90 天'); return; }
      genBtn.disabled = true; genBtn.textContent = '生成中…';
      _buildStandaloneDoc().then(function (out) {
        if (!out) throw new Error('当前文件无法生成快照');
        return _shareApi('POST', '', { html: out.html, filename: _currentFile.filename || 'preview', ttlMs: ttl });
      }).then(function (data) {
        var url = location.origin + data.url;
        resultEl.style.display = 'block';
        resultEl.innerHTML = '<div class="fp-share-ok">✅ 链接已生成(到期 ' + _escapeHtml(_fmtExpiry(data.expiresAt)) + ')</div>'
          + '<div class="fp-share-linkrow"><input class="fp-share-link" id="fpShareLink" readonly value="' + _escapeHtml(url) + '">'
          + '<button class="fp-share-btn fp-share-primary" id="fpShareCopy">复制</button></div>';
        var linkInput = resultEl.querySelector('#fpShareLink');
        linkInput.focus(); linkInput.select();
        resultEl.querySelector('#fpShareCopy').addEventListener('click', function () {
          _copyText(url); this.textContent = '已复制'; var b = this;
          setTimeout(function () { b.textContent = '复制'; }, 1200);
        });
        renderList();
      }).catch(function (err) {
        alert('生成失败: ' + (err && err.message ? err.message : err));
      }).finally(function () {
        genBtn.disabled = false; genBtn.textContent = '生成链接';
      });
    });

    renderList();
  }

  // Fetch authenticated bytes from the page's origin and trigger a local
  // Blob download. Avoids handing the URL to the system download manager
  // (which on Android/iOS doesn't share the browser's TLS-trust nor cookies,
  // and fails with "请检查互联网连接状况" on self-signed certs).
  function _blobDownload(url, filename) {
    var headers = typeof Auth !== 'undefined' ? Auth.headers() : {};
    return fetch(url, { headers: headers, credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.blob();
      })
      .then(function (blob) {
        var blobUrl = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename || 'download';
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 60000);
      });
  }

  function _download() {
    if (!_currentFile || _currentFile.isDirectory) return;
    _blobDownload(_currentFile.rawUrl, _currentFile.filename)
      .catch(function (err) {
        alert('下载失败: ' + (err && err.message ? err.message : err));
      });
  }

  function close() {
    if (_placement === 'side') {
      _closeDockTab(_activeDockTabId);
      return;
    }
    _previewGeneration++;
    _previewReady = false;
    _stopAutoRefresh();
    _disposeMermaid(_overlay);
    if (_overlay) _overlay.remove();
    _overlay = null;
    _maximized = false;
    _placement = 'modal';
    _placementButton = null;
    _maximizeButton = null;
    _refreshButton = null;
    _currentFile = null;
    _dirContext = null;
    _currentPaneId = null;
    _currentOpenPath = null;
    if (_dockOverlay && !_dockHidden && _dockTabs.length > 0) {
      _activateDockTab(_activeDockTabId || _dockTabs[0].id);
      document.body.classList.add('fp-side-open');
    } else if (!_dockOverlay) {
      document.body.classList.remove('fp-side-open');
    }
  }

  function closeDocked() {
    _destroyDock();
  }

  function _showError(body, message, absPath) {
    body.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.className = 'fp-error';
    var msg = document.createElement('div');
    msg.textContent = message;
    wrap.appendChild(msg);
    if (absPath) {
      var btn = document.createElement('button');
      btn.className = 'fp-error-download';
      btn.textContent = 'Download';
      btn.addEventListener('click', function () {
        var _tp = typeof Auth !== 'undefined' ? Auth.wsTokenParam() : '';
        var url = '/api/files/raw?path=' + encodeURIComponent(absPath)
          + (_tp ? '&' + _tp : '');
        var filename = absPath.split('/').pop();
        _blobDownload(url, filename).catch(function (err) {
          alert('下载失败: ' + (err && err.message ? err.message : err));
        });
      });
      wrap.appendChild(btn);
    }
    body.appendChild(wrap);
  }

  // --- Renderers ---

  function _renderImage(body, url) {
    body.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.className = 'fp-image-wrap';
    var img = document.createElement('img');
    img.src = url;
    img.alt = 'Preview';
    var scale = 1;
    img.addEventListener('wheel', function (e) {
      e.preventDefault();
      scale = Math.max(0.1, Math.min(10, scale + (e.deltaY > 0 ? -0.1 : 0.1)));
      img.style.transform = 'scale(' + scale + ')';
    });
    wrap.appendChild(img);
    body.appendChild(wrap);
  }

  function _renderPdf(body, url) {
    body.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.className = 'fp-pdf-wrap';
    var iframe = document.createElement('iframe');
    iframe.src = url;
    iframe.title = 'PDF Preview';
    wrap.appendChild(iframe);
    body.appendChild(wrap);
  }

  // --- xlsx (ExcelJS → styled HTML tables) ---

  function _argbToCss(argb) {
    // ExcelJS colors are 'AARRGGBB'. Theme/indexed colors lack argb → skip.
    if (!argb || typeof argb !== 'string' || argb.length < 6) return null;
    var hex = argb.length === 8 ? argb.slice(2) : argb;
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
    return '#' + hex;
  }

  function _xlsxColStyle(width) {
    // ExcelJS width ≈ character units; ~7px per char is a decent approximation.
    if (!width || !isFinite(width)) return '';
    return ' style="width:' + Math.round(width * 7) + 'px"';
  }

  // Pick black/white text for a given background so a fill never hides its text.
  function _contrastText(hex) {
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);
    var lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.55 ? '#1f2328' : '#f5f5f5';
  }

  function _xlsxCellStyle(cell) {
    var s = [];
    var f = cell.font || {};
    if (f.bold) s.push('font-weight:600');
    if (f.italic) s.push('font-style:italic');
    if (f.underline) s.push('text-decoration:underline');
    if (f.size) s.push('font-size:' + f.size + 'px');
    var fill = cell.fill;
    var bg = (fill && fill.type === 'pattern' && fill.fgColor)
      ? _argbToCss(fill.fgColor.argb) : null;
    if (bg) s.push('background:' + bg);
    var fc = f.color && _argbToCss(f.color.argb);
    if (fc) {
      s.push('color:' + fc);
    } else if (bg) {
      // Cell has a fill but no explicit font color (Excel "auto" = black on a
      // white sheet). On our table the fill could be light or dark, so derive a
      // contrasting color from its luminance instead of inheriting the default.
      s.push('color:' + _contrastText(bg));
    }
    var a = cell.alignment || {};
    if (a.horizontal) s.push('text-align:' + a.horizontal);
    if (a.vertical) s.push('vertical-align:' + (a.vertical === 'middle' ? 'middle' : a.vertical));
    if (a.wrapText) s.push('white-space:normal');
    return s.length ? ' style="' + s.join(';') + '"' : '';
  }

  // Build a lookup of merged ranges so we emit rowspan/colspan on the
  // top-left cell and skip the cells it covers.
  function _xlsxMerges(ws) {
    var masters = {}; // "r,c" -> {rowspan, colspan}
    var covered = {}; // "r,c" -> true (non-master cells inside a merge)
    var ranges = (ws.model && ws.model.merges) || [];
    ranges.forEach(function (range) {
      var m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);
      if (!m) return;
      var c1 = _colToNum(m[1]), r1 = +m[2], c2 = _colToNum(m[3]), r2 = +m[4];
      masters[r1 + ',' + c1] = { rowspan: r2 - r1 + 1, colspan: c2 - c1 + 1 };
      for (var r = r1; r <= r2; r++) {
        for (var c = c1; c <= c2; c++) {
          if (r === r1 && c === c1) continue;
          covered[r + ',' + c] = true;
        }
      }
    });
    return { masters: masters, covered: covered };
  }

  function _colToNum(letters) {
    var n = 0;
    for (var i = 0; i < letters.length; i++) {
      n = n * 26 + (letters.charCodeAt(i) - 64);
    }
    return n;
  }

  function _xlsxSheetTable(ws) {
    var merges = _xlsxMerges(ws);
    var colCount = ws.actualColumnCount || ws.columnCount || 0;
    var html = '<table class="fp-xlsx-table"><colgroup>';
    for (var c = 1; c <= colCount; c++) {
      var col = ws.getColumn(c);
      html += '<col' + _xlsxColStyle(col && col.width) + '>';
    }
    html += '</colgroup><tbody>';
    var rowCount = ws.actualRowCount || ws.rowCount || 0;
    for (var r = 1; r <= rowCount; r++) {
      var row = ws.getRow(r);
      html += '<tr>';
      for (var cc = 1; cc <= colCount; cc++) {
        var key = r + ',' + cc;
        if (merges.covered[key]) continue;
        var cell = row.getCell(cc);
        var span = merges.masters[key];
        var attrs = _xlsxCellStyle(cell);
        if (span) {
          if (span.rowspan > 1) attrs += ' rowspan="' + span.rowspan + '"';
          if (span.colspan > 1) attrs += ' colspan="' + span.colspan + '"';
        }
        var text = cell.text != null ? String(cell.text) : '';
        html += '<td' + attrs + '>' + _escapeHtml(text) + '</td>';
      }
      html += '</tr>';
    }
    return html + '</tbody></table>';
  }

  function _renderXlsx(body, rawUrl) {
    body.innerHTML = '<div class="fp-loading">Loading spreadsheet…</div>';
    var headers = typeof Auth !== 'undefined' ? Auth.headers() : {};
    return Promise.all([
      _loadScript(CDN.exceljs),
      fetch(rawUrl, { headers: headers, cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      }),
    ])
      .then(function (results) {
        var buf = results[1];
        var wb = new window.ExcelJS.Workbook();
        return wb.xlsx.load(buf);
      })
      .then(function (wb) {
        var sheets = [];
        wb.eachSheet(function (ws) { sheets.push(ws); });
        if (!sheets.length) throw new Error('空工作簿');

        body.innerHTML = '';
        var wrap = document.createElement('div');
        wrap.className = 'fp-xlsx-wrap';

        var tabs = document.createElement('div');
        tabs.className = 'fp-xlsx-tabs';
        var panes = document.createElement('div');
        panes.className = 'fp-xlsx-panes';

        sheets.forEach(function (ws, i) {
          var tab = document.createElement('button');
          tab.className = 'fp-xlsx-tab' + (i === 0 ? ' active' : '');
          tab.textContent = ws.name || ('Sheet' + (i + 1));
          var pane = document.createElement('div');
          pane.className = 'fp-xlsx-pane' + (i === 0 ? ' active' : '');
          pane.innerHTML = _xlsxSheetTable(ws);
          tab.addEventListener('click', function () {
            tabs.querySelectorAll('.fp-xlsx-tab').forEach(function (t) { t.classList.remove('active'); });
            panes.querySelectorAll('.fp-xlsx-pane').forEach(function (p) { p.classList.remove('active'); });
            tab.classList.add('active');
            pane.classList.add('active');
          });
          tabs.appendChild(tab);
          panes.appendChild(pane);
        });

        if (sheets.length > 1) wrap.appendChild(tabs);
        wrap.appendChild(panes);
        body.appendChild(wrap);
        wrap.querySelectorAll('.fp-xlsx-table').forEach(_attachColumnFilters);
      });
  }

  // --- csv / tsv (parsed → table, reusing the xlsx table styling) ---

  function _isCsvPath(p) { return /\.(csv|tsv)$/i.test(p || ''); }

  function _csvDelim(absPath, text) {
    if (/\.tsv$/i.test(absPath)) return '\t';
    var first = (text.split('\n', 1)[0] || '');
    var cand = [',', ';', '\t'];
    var best = ',', bestN = -1;
    cand.forEach(function (d) {
      var n = first.split(d).length - 1;
      if (n > bestN) { bestN = n; best = d; }
    });
    return best;
  }

  // RFC 4180: handles quoted fields, escaped quotes (""), and newlines/delims
  // inside quotes.
  function _parseCsv(text, delim) {
    var rows = [], row = [], field = '', inQ = false, i = 0, n = text.length;
    while (i < n) {
      var c = text.charAt(i);
      if (inQ) {
        if (c === '"') {
          if (text.charAt(i + 1) === '"') { field += '"'; i += 2; continue; }
          inQ = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') { inQ = true; i++; continue; }
      if (c === delim) { row.push(field); field = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += c; i++;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function _renderCsv(body, content, absPath) {
    var rows = _parseCsv(content, _csvDelim(absPath, content));
    // Drop a trailing blank row from a final newline.
    if (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();
    if (!rows.length) { _renderCode(body, content, 'plaintext'); return; }

    var MAX_ROWS = 2000;
    var truncated = rows.length > MAX_ROWS;
    if (truncated) rows = rows.slice(0, MAX_ROWS);

    var html = '<table class="fp-xlsx-table"><tbody>';
    for (var r = 0; r < rows.length; r++) {
      html += '<tr>';
      var bold = r === 0 ? ' style="font-weight:600"' : '';
      var cells = rows[r];
      for (var c = 0; c < cells.length; c++) {
        html += '<td' + bold + '>' + _escapeHtml(cells[c]) + '</td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table>';

    body.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.className = 'fp-xlsx-wrap';
    var panes = document.createElement('div');
    panes.className = 'fp-xlsx-panes';
    var pane = document.createElement('div');
    pane.className = 'fp-xlsx-pane active';
    pane.innerHTML = html;
    panes.appendChild(pane);
    wrap.appendChild(panes);
    if (truncated) {
      var note = document.createElement('div');
      note.className = 'fp-dir-truncated';
      note.textContent = '已截断显示前 ' + MAX_ROWS + ' 行';
      wrap.appendChild(note);
    }
    body.appendChild(wrap);
    _attachColumnFilters(wrap.querySelector('.fp-xlsx-table'));
  }

  // --- Excel-style per-column filter (xlsx & csv flat tables) ---

  function _attachColumnFilters(table) {
    if (!table || !table.tBodies || !table.tBodies[0]) return;
    // Merged cells break column/row indexing — skip those tables.
    if (table.querySelector('[rowspan],[colspan]')) return;
    var rows = Array.prototype.slice.call(table.tBodies[0].rows);
    if (rows.length < 2) return;
    var header = rows[0];
    var dataRows = rows.slice(1);
    var filters = {}; // colIndex -> Set(allowed values); absent = no filter
    var terms = [];   // global fuzzy-search terms (AND across all cells in a row)
    var openPop = null;

    // Cache each row's lowercased full text so the search stays cheap on big tables.
    var rowText = dataRows.map(function (row) { return row.textContent.toLowerCase(); });

    function applyFilters() {
      var shown = 0;
      for (var i = 0; i < dataRows.length; i++) {
        var show = true, row = dataRows[i];
        for (var col in filters) {
          var cell = row.cells[col];
          if (!filters[col].has(cell ? cell.textContent : '')) { show = false; break; }
        }
        if (show && terms.length) {
          var hay = rowText[i];
          for (var t = 0; t < terms.length; t++) {
            if (hay.indexOf(terms[t]) < 0) { show = false; break; }
          }
        }
        row.style.display = show ? '' : 'none';
        if (show) shown++;
      }
      if (counter) counter.textContent = shown + ' / ' + dataRows.length + ' 行';
    }

    function distinct(col) {
      var seen = {}, out = [];
      for (var i = 0; i < dataRows.length; i++) {
        var cell = dataRows[i].cells[col];
        var v = cell ? cell.textContent : '';
        if (!Object.prototype.hasOwnProperty.call(seen, v)) { seen[v] = 1; out.push(v); }
      }
      return out.sort();
    }

    function closePop() {
      if (!openPop) return;
      openPop.remove(); openPop = null;
      document.removeEventListener('mousedown', onDoc, true);
    }
    function onDoc(e) {
      if (openPop && !openPop.contains(e.target) && !e.target.classList.contains('fp-colfilter-btn')) closePop();
    }

    function openFilter(col, btn) {
      var reopen = openPop && openPop._col === col;
      closePop();
      if (reopen) return; // clicking the same button toggles it closed

      var values = distinct(col);
      var allowed = filters[col] || null; // null = all selected
      var pop = document.createElement('div');
      pop.className = 'fp-colfilter-pop';
      pop._col = col;

      var search = document.createElement('input');
      search.className = 'fp-colfilter-search';
      search.placeholder = '搜索…';
      pop.appendChild(search);

      var list = document.createElement('div');
      list.className = 'fp-colfilter-list';
      pop.appendChild(list);

      var allCb = document.createElement('input'); allCb.type = 'checkbox'; allCb.checked = !allowed;
      var allLabel = document.createElement('label');
      allLabel.className = 'fp-colfilter-item fp-colfilter-all';
      allLabel.appendChild(allCb); allLabel.appendChild(document.createTextNode('（全选）'));
      list.appendChild(allLabel);

      var itemCbs = [];
      values.forEach(function (v) {
        var cb = document.createElement('input'); cb.type = 'checkbox';
        cb.checked = !allowed || allowed.has(v); cb.value = v;
        var label = document.createElement('label');
        label.className = 'fp-colfilter-item';
        label.appendChild(cb);
        label.appendChild(document.createTextNode(v === '' ? '（空）' : v));
        list.appendChild(label);
        itemCbs.push(cb);
      });

      function commit() {
        var checked = itemCbs.filter(function (c) { return c.checked; });
        if (checked.length === itemCbs.length) { delete filters[col]; btn.classList.remove('active'); }
        else { filters[col] = new Set(checked.map(function (c) { return c.value; })); btn.classList.add('active'); }
        applyFilters();
      }
      itemCbs.forEach(function (c) {
        c.addEventListener('change', function () {
          allCb.checked = itemCbs.every(function (x) { return x.checked; });
          commit();
        });
      });
      allCb.addEventListener('change', function () {
        itemCbs.forEach(function (c) { if (c.parentNode.style.display !== 'none') c.checked = allCb.checked; });
        commit();
      });
      search.addEventListener('input', function () {
        var q = search.value.toLowerCase();
        itemCbs.forEach(function (c) {
          c.parentNode.style.display = c.value.toLowerCase().indexOf(q) >= 0 ? '' : 'none';
        });
      });

      document.body.appendChild(pop);
      var r = btn.getBoundingClientRect();
      pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + 'px';
      pop.style.top = Math.min(r.bottom + 2, window.innerHeight - pop.offsetHeight - 8) + 'px';
      openPop = pop;
      setTimeout(function () { document.addEventListener('mousedown', onDoc, true); }, 0);
      search.focus();
    }

    for (var c = 0; c < header.cells.length; c++) {
      (function (col) {
        var btn = document.createElement('span');
        btn.className = 'fp-colfilter-btn';
        btn.textContent = '▾';
        btn.title = '筛选此列';
        btn.addEventListener('click', function (e) { e.stopPropagation(); openFilter(col, btn); });
        header.cells[col].appendChild(btn);
      })(c);
    }

    // Global fuzzy search bar — matches whole rows; whitespace splits into AND terms.
    var bar = document.createElement('div');
    bar.className = 'fp-table-search';
    var input = document.createElement('input');
    input.className = 'fp-table-search-input';
    input.type = 'search';
    input.placeholder = '搜索全表…（空格分隔多个关键词）';
    var counter = document.createElement('span');
    counter.className = 'fp-table-search-count';
    counter.textContent = dataRows.length + ' / ' + dataRows.length + ' 行';
    bar.appendChild(input);
    bar.appendChild(counter);
    input.addEventListener('input', function () {
      terms = input.value.toLowerCase().split(/\s+/).filter(Boolean);
      applyFilters();
    });
    table.parentNode.insertBefore(bar, table);
  }

  function _renderCode(body, content, language, targetLine) {
    body.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.className = 'fp-code-wrap';

    var lines = content.split('\n');
    var lineNums = document.createElement('div');
    lineNums.className = 'fp-line-numbers';
    lineNums.textContent = lines.map(function (_, i) { return i + 1; }).join('\n');

    var pre = document.createElement('pre');
    var code = document.createElement('code');
    code.textContent = content;

    Promise.all([_loadScript(CDN.hljs), _loadCSS(CDN.hljsCss)])
      .then(function () {
        if (window.hljs && language) {
          try {
            var result = window.hljs.highlight(content, { language: language, ignoreIllegals: true });
            code.innerHTML = result.value;
          } catch (_) {
            window.hljs.highlightElement(code);
          }
        } else if (window.hljs) {
          window.hljs.highlightElement(code);
        }
      })
      .catch(function () { /* highlight failed — show plain text */ });

    pre.appendChild(lineNums);
    pre.appendChild(code);
    wrap.appendChild(pre);
    body.appendChild(wrap);

    // Best-effort jump to a target line (from path:line:col). Never let a
    // scroll/measure failure block the file from opening.
    if (targetLine && targetLine > 1) {
      try {
        var per = lineNums.scrollHeight / Math.max(lines.length, 1);
        if (per > 0 && isFinite(per)) {
          wrap.scrollTop = Math.max(0, (targetLine - 1) * per - wrap.clientHeight / 3);
        }
      } catch (_e) { /* ignore */ }
    }
  }

  function _normalizeMarkdownHeading(text) {
    return String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  function _markdownHeadingSlug(text) {
    var slug = _normalizeMarkdownHeading(text)
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    return slug || 'section';
  }

  function _wikilinkHtml(target, label, hasAlias) {
    target = String(target || '').trim();
    var display = String(label || '').trim();
    if (target.charAt(0) === '#' && target.length > 1) {
      var heading = target.slice(1).trim();
      if (!display || !hasAlias) display = heading;
      return '<a class="fp-wikilink fp-wikilink-heading" href="#' + _escapeHtml(_markdownHeadingSlug(heading))
        + '" data-fp-heading-target="' + _escapeHtml(heading) + '">' + _escapeHtml(display) + '</a>';
    }
    return '<span class="fp-wikilink" title="Obsidian 链接: ' + _escapeHtml(target) + '">'
      + _escapeHtml(display || target) + '</span>';
  }

  function _decodeMarkdownPart(value) {
    try { return decodeURIComponent(value); } catch (_) { return null; }
  }

  function _encodedFileURLPath(absPath) {
    return String(absPath || '').split('/').map(function (part, index) {
      return index === 0 ? '' : encodeURIComponent(part);
    }).join('/');
  }

  function _resolveMarkdownHref(sourceAbsPath, rawHref) {
    var href = String(rawHref || '').trim();
    if (!href) return { kind: 'blocked' };

    if (href.charAt(0) === '#') {
      var localHeading = _decodeMarkdownPart(href.slice(1));
      return localHeading === null ? { kind: 'blocked' }
        : { kind: 'heading', headingRef: localHeading };
    }

    if (/^\/\//.test(href)) return { kind: 'web', href: 'https:' + href };
    var scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(href);
    if (scheme) {
      return /^https?$/i.test(scheme[1]) ? { kind: 'web', href: href } : { kind: 'blocked' };
    }

    if (typeof sourceAbsPath !== 'string' || sourceAbsPath.charAt(0) !== '/') {
      return { kind: 'blocked' };
    }

    try {
      var origin = 'https://file-preview.invalid';
      var target = new URL(href, origin + _encodedFileURLPath(sourceAbsPath));
      if (target.origin !== origin) {
        return /^https?:$/i.test(target.protocol) ? { kind: 'web', href: target.href } : { kind: 'blocked' };
      }
      var path = _decodeMarkdownPart(target.pathname);
      var headingRef = _decodeMarkdownPart(target.hash ? target.hash.slice(1) : '');
      if (path === null || headingRef === null) return { kind: 'blocked' };
      if (path === sourceAbsPath) return { kind: 'heading', headingRef: headingRef };
      return { kind: 'file', path: path, headingRef: headingRef || null };
    } catch (_) {
      return { kind: 'blocked' };
    }
  }

  function _scrollMarkdownHeading(wrap, raw) {
    if (!wrap) return false;
    var headingRef = String(raw || '');
    try { headingRef = decodeURIComponent(headingRef); } catch (_) { /* already decoded */ }
    var headings = Array.prototype.slice.call(wrap.querySelectorAll('h1, h2, h3, h4, h5, h6'));
    var normalized = _normalizeMarkdownHeading(headingRef);
    var target = null;
    for (var i = 0; i < headings.length; i++) {
      if (_normalizeMarkdownHeading(headings[i].textContent) === normalized) {
        target = headings[i];
        break;
      }
    }
    if (!target) {
      var slug = _markdownHeadingSlug(headingRef);
      for (var j = 0; j < headings.length; j++) {
        if (headings[j].id === slug) { target = headings[j]; break; }
      }
    }
    if (!target) return false;
    try { target.focus({ preventScroll: true }); } catch (_) { target.focus(); }
    if (typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    return true;
  }

  function _prepareMarkdownNavigation(wrap, sourceAbsPath, paneId) {
    if (!wrap) return;
    var headings = Array.prototype.slice.call(wrap.querySelectorAll('h1, h2, h3, h4, h5, h6'));
    var ids = {};
    headings.forEach(function (heading) {
      var base = _markdownHeadingSlug(heading.textContent);
      var count = ids[base] || 0;
      ids[base] = count + 1;
      heading.id = count === 0 ? base : base + '-' + count;
      heading.setAttribute('tabindex', '-1');
    });

    wrap.addEventListener('click', function (event) {
      var link = event.target.closest && event.target.closest('a[href]');
      if (!link || !wrap.contains(link)) return;
      var resolved = _resolveMarkdownHref(sourceAbsPath, link.getAttribute('href'));
      event.preventDefault();
      if (resolved.kind === 'heading') {
        var heading = link.getAttribute('data-fp-heading-target') || resolved.headingRef;
        _scrollMarkdownHeading(wrap, heading);
      } else if (resolved.kind === 'file') {
        openFile(resolved.path, paneId || _currentPaneId, { markdownFragment: resolved.headingRef });
      } else if (resolved.kind === 'web') {
        _openWeb(resolved.href);
      }
    });
  }

  // markdown-it plugin: Obsidian-flavored inline syntax.
  // We push our own html_inline tokens (rendered verbatim regardless of the
  // `html:false` option), so every bit of user text is escaped by hand first.
  function _obsidianMarkdown(md) {
    var esc = _escapeHtml;
    var IMG_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i;

    // ==highlight==  ->  <mark>
    md.inline.ruler.before('emphasis', 'obs_mark', function (state, silent) {
      var s = state.src, p = state.pos;
      if (s.charCodeAt(p) !== 0x3D || s.charCodeAt(p + 1) !== 0x3D) return false;
      var hit = s.indexOf('==', p + 2);
      if (hit < 0) return false;
      var inner = s.slice(p + 2, hit);
      if (!inner || inner.indexOf('\n') >= 0) return false;
      if (!silent) {
        var t = state.push('html_inline', '', 0);
        t.content = '<mark class="fp-hl">' + esc(inner) + '</mark>';
      }
      state.pos = hit + 2;
      return true;
    });

    // %%comment%%  ->  removed
    md.inline.ruler.before('emphasis', 'obs_comment', function (state, silent) {
      var s = state.src, p = state.pos;
      if (s.charCodeAt(p) !== 0x25 || s.charCodeAt(p + 1) !== 0x25) return false;
      var hit = s.indexOf('%%', p + 2);
      if (hit < 0) return false;
      state.pos = hit + 2; // swallow, emit nothing
      return true;
    });

    // ![[embed]]  ->  inline image (relative src is rewritten to the raw API
    // by the existing post-render pass) or a placeholder for non-images.
    md.inline.ruler.before('image', 'obs_embed', function (state, silent) {
      var s = state.src, p = state.pos;
      if (s.charCodeAt(p) !== 0x21 || s.charCodeAt(p + 1) !== 0x5B || s.charCodeAt(p + 2) !== 0x5B) return false;
      var end = s.indexOf(']]', p + 3);
      if (end < 0) return false;
      var inner = s.slice(p + 3, end);
      if (!inner || inner.indexOf('\n') >= 0 || inner.indexOf('[[') >= 0) return false;
      if (!silent) {
        var parts = inner.split('|');
        var target = parts[0].split('#')[0].trim();
        var label = (parts[1] != null ? parts[1] : parts[0]).trim();
        var t = state.push('html_inline', '', 0);
        if (IMG_RE.test(target)) {
          t.content = '<img class="fp-embed-img" src="' + esc(target) + '" alt="' + esc(label) + '">';
        } else {
          t.content = '<span class="fp-embed" title="Obsidian 嵌入: ' + esc(target) + '">\u{1F4CE} ' + esc(label) + '</span>';
        }
      }
      state.pos = end + 2;
      return true;
    });

    // [[#heading]] is a navigable in-document link. Other wikilinks remain
    // styled placeholders until cross-file preview navigation is supported.
    md.inline.ruler.before('link', 'obs_wikilink', function (state, silent) {
      var s = state.src, p = state.pos;
      if (s.charCodeAt(p) !== 0x5B || s.charCodeAt(p + 1) !== 0x5B) return false;
      var end = s.indexOf(']]', p + 2);
      if (end < 0) return false;
      var inner = s.slice(p + 2, end);
      if (!inner || inner.indexOf('\n') >= 0 || inner.indexOf('[[') >= 0) return false;
      if (!silent) {
        var parts = inner.split('|');
        var target = parts[0].trim();
        var label = (parts[1] != null ? parts[1] : parts[0]).trim();
        var t = state.push('html_inline', '', 0);
        t.content = _wikilinkHtml(target, label, parts[1] != null);
      }
      state.pos = end + 2;
      return true;
    });

    // #tag  ->  chip. Must follow start-of-line/whitespace/( and hold a non-digit.
    var TAG_RE = /^#[A-Za-z0-9_一-鿿][\w\/\-一-鿿]*/;
    md.inline.ruler.push('obs_tag', function (state, silent) {
      var s = state.src, p = state.pos;
      if (s.charCodeAt(p) !== 0x23) return false;
      if (p > 0) {
        var b = s.charCodeAt(p - 1);
        if (b !== 0x20 && b !== 0x09 && b !== 0x0A && b !== 0x28) return false;
      }
      var m = TAG_RE.exec(s.slice(p));
      if (!m || /^#[0-9]+$/.test(m[0])) return false;
      if (!silent) {
        var t = state.push('html_inline', '', 0);
        t.content = '<span class="fp-tag">' + esc(m[0]) + '</span>';
      }
      state.pos = p + m[0].length;
      return true;
    });
  }

  // Turn `> [!type] title` blockquotes into Obsidian callouts. Done on the
  // rendered DOM (not markdown-it) so the result is captured by the new-tab
  // export, which clones the live .fp-md-wrap.
  function _renderCallouts(wrap) {
    var ICONS = {
      note: '\u{1F5C8}', abstract: '\u{1F4CB}', summary: '\u{1F4CB}', tldr: '\u{1F4CB}',
      info: 'ℹ️', todo: '☑️', tip: '\u{1F4A1}', hint: '\u{1F4A1}',
      important: '❗', success: '✅', check: '✅', done: '✅',
      question: '❓', help: '❓', faq: '❓', warning: '⚠️',
      caution: '⚠️', attention: '⚠️', failure: '❌', fail: '❌',
      missing: '❌', danger: '\u{1F525}', error: '\u{1F525}', bug: '\u{1F41E}',
      example: '\u{1F4DD}', quote: '❝', cite: '❝',
    };
    var bqs = wrap.querySelectorAll('blockquote');
    Array.prototype.forEach.call(bqs, function (bq) {
      var first = bq.querySelector('p');
      if (!first) return;
      var m = /^\s*\[!([\w-]+)\]([+-]?)\s*([^\n]*)/.exec(first.textContent);
      if (!m) return;
      var type = m[1].toLowerCase();
      var defTitle = type.charAt(0).toUpperCase() + type.slice(1);
      bq.classList.add('fp-callout', 'fp-callout-' + type);

      var html = first.innerHTML;
      var nl = html.indexOf('\n');
      var titleHtml = (nl >= 0 ? html.slice(0, nl) : html).replace(/^\s*\[![\w-]+\][+-]?\s*/, '').trim();
      var restHtml = nl >= 0 ? html.slice(nl + 1) : '';

      var titleEl = document.createElement('div');
      titleEl.className = 'fp-callout-title';
      titleEl.innerHTML = '<span class="fp-callout-icon">' + (ICONS[type] || '\u{1F5C8}') + '</span>'
        + '<span class="fp-callout-titletext">' + (titleHtml || defTitle) + '</span>';

      if (restHtml.trim()) { first.innerHTML = restHtml; } else { first.remove(); }
      bq.insertBefore(titleEl, bq.firstChild);
    });
  }

  // Pull a leading YAML frontmatter block off the content. Returns the parsed
  // object (or null) and the body with the block removed. Deliberately a tiny
  // parser — covers `key: scalar`, `key: [a, b]`, and the multiline `- item`
  // list form that frontmatter actually uses; not a general YAML engine.
  function _extractFrontmatter(content) {
    var m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
    if (!m) return { fm: null, body: content };
    return { fm: _parseFrontmatter(m[1]), body: content.slice(m[0].length) };
  }

  function _stripQuotes(s) {
    s = s.trim();
    if ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'")) {
      return s.slice(1, -1);
    }
    return s;
  }

  function _parseFrontmatter(text) {
    var obj = {}, lines = text.split(/\r?\n/), curKey = null;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line.trim() || /^\s*#/.test(line)) continue;
      var li = /^\s*-\s+(.*)$/.exec(line);
      if (li && curKey) { (obj[curKey] = obj[curKey] || []).push(_stripQuotes(li[1])); continue; }
      var kv = /^([\w\-]+)\s*:\s*(.*)$/.exec(line);
      if (!kv) continue;
      var k = kv[1], v = kv[2].trim();
      if (v === '') { obj[k] = []; curKey = k; }
      else if (/^\[.*\]$/.test(v)) {
        obj[k] = v.slice(1, -1).split(',').map(function (x) { return _stripQuotes(x); }).filter(Boolean);
        curKey = null;
      } else { obj[k] = _stripQuotes(v); curKey = null; }
    }
    return obj;
  }

  // Render frontmatter as an Obsidian-style properties card; `tags`/`tag`
  // values become the same chips as inline #tags.
  function _renderFrontmatter(fm) {
    var esc = _escapeHtml;
    var rows = Object.keys(fm).map(function (k) {
      var v = fm[k], valHtml;
      if (/^tags?$/i.test(k)) {
        var arr = Array.isArray(v) ? v : (v ? [v] : []);
        valHtml = arr.map(function (t) {
          var tag = String(t); if (tag.charAt(0) !== '#') tag = '#' + tag;
          return '<span class="fp-tag">' + esc(tag) + '</span>';
        }).join(' ');
      } else if (Array.isArray(v)) {
        valHtml = v.map(function (x) { return esc(String(x)); }).join(', ');
      } else { valHtml = esc(String(v)); }
      if (!valHtml) return '';
      return '<div class="fp-fm-row"><span class="fp-fm-key">' + esc(k)
        + '</span><span class="fp-fm-val">' + valHtml + '</span></div>';
    }).filter(Boolean).join('');
    return rows ? '<div class="fp-frontmatter">' + rows + '</div>' : '';
  }

  function _renderMarkdown(body, content, filePath, paneId) {
    body.innerHTML = '<div class="fp-loading">Rendering Markdown\u2026</div>';
    var baseDir = filePath.substring(0, filePath.lastIndexOf('/'));

    return Promise.all([
      _loadScript(CDN.markdownIt),
      _loadScript(CDN.hljs),
      _loadCSS(CDN.hljsCss),
    ])
      .then(function () {
        var md = window.markdownit({
          html: false,
          linkify: true,
          highlight: function (str, lang) {
            if (window.hljs && lang) {
              try {
                return window.hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
              } catch (_) { /* fallback */ }
            }
            return '';
          },
        });

        md.use(_obsidianMarkdown);

        var katexLoaded = Promise.all([
          _loadCSS(CDN.katexCss),
          _loadScript(CDN.katexJs),
        ])
          .then(function () { return _loadScript(CDN.markdownItKatex); })
          .then(function () {
            if (window.markdownitKatex) md.use(window.markdownitKatex);
          })
          .catch(function () { /* KaTeX optional */ });

        return katexLoaded.then(function () { return md; });
      })
      .then(function (md) {
        var fmExtract = _extractFrontmatter(content);
        var fmHtml = fmExtract.fm ? _renderFrontmatter(fmExtract.fm) : '';
        var html = md.render(fmExtract.body);

        var _mdTp = typeof Auth !== 'undefined' ? Auth.wsTokenParam() : '';
        html = html.replace(
          /(<img\s+[^>]*src=")(?!https?:\/\/|data:|\/)([^"]+)(")/g,
          function (_, pre, src, post) {
            var absImgPath = baseDir + '/' + src;
            return pre + '/api/files/raw?path=' + encodeURIComponent(absImgPath) + (_mdTp ? '&' + _mdTp : '') + post;
          }
        );

        body.innerHTML = '';
        var wrap = document.createElement('div');
        wrap.className = 'fp-md-wrap';
        wrap.innerHTML = fmHtml + html;
        body.appendChild(wrap);

        _renderCallouts(wrap);
        _prepareMarkdownNavigation(wrap, filePath, paneId);

        var mermaidBlocks = wrap.querySelectorAll('code.language-mermaid');
        if (mermaidBlocks.length > 0) {
          _loadScript(CDN.mermaid)
            .then(function () {
              // Pin a system font so mermaid measures text with the SAME
              // always-available font it renders with. Otherwise a late-loading
              // webfont reflows the text after layout is computed, pushing it
              // past the boxes/spacing mermaid already sized — the "overlapping"
              // render. Waiting on document.fonts.ready guards the same hazard.
              _initializeMermaidTheme();
              var fontsReady = (document.fonts && document.fonts.ready)
                ? document.fonts.ready : Promise.resolve();
              return fontsReady.then(function () {
                var jobs = Array.prototype.map.call(mermaidBlocks, function (block, i) {
                  var code = block.textContent;
                  var container = document.createElement('div');
                  container.className = 'mermaid';
                  container.__fpMermaidSource = code;
                  container.setAttribute('data-fp-export-name', 'mermaid-diagram-' + (i + 1) + '.png');
                  block.parentElement.replaceWith(container);
                  // render() lays out in mermaid's own sandbox (deterministic),
                  // then we inject the finished SVG.
                  var id = 'fp-mmd-' + Date.now() + '-' + i;
                  return window.mermaid.render(id, code)
                    .then(function (res) {
                      container.innerHTML = res.svg;
                      _prepareMermaid(container);
                    })
                    .catch(function (err) {
                      // Render failed (usually a syntax error) — surface the
                      // reason above the raw source so it's clear it's not a
                      // "type unsupported" issue.
                      var box = document.createElement('div');
                      var msg = document.createElement('div');
                      msg.className = 'fp-mermaid-err';
                      msg.textContent = 'Mermaid 渲染失败：' + (err && err.message ? err.message : err);
                      var p = document.createElement('pre');
                      var c = document.createElement('code');
                      c.textContent = code;
                      p.appendChild(c);
                      box.appendChild(msg);
                      box.appendChild(p);
                      container.replaceWith(box);
                    });
                });
                return Promise.all(jobs).then(function () {
                  _installMermaidInteractions(wrap);
                });
              });
            })
            .catch(function () { /* mermaid optional */ });
        }
      })
      .catch(function () {
        _renderCode(body, content, 'markdown');
      });
  }

  // --- Path / URL detection (delegated to the DOM-free LinkDetect core) ---

  // Runs on a single LOGICAL line (wrapped rows already merged); returns
  // matches { text, kind, href, lineRef, startCol, endCol }. All regex logic
  // lives in public/js/link-detect.js (window.LinkDetect) so it is unit-tested.
  //   kind 'web'       -> open href in a new browser tab
  //   kind 'file'      -> open in the file preview (lineRef jumps to a line)
  //   kind 'ambiguous' -> let the user choose web vs file (e.g. example.com)
  function _findLinks(line) {
    if (typeof LinkDetect === 'undefined') return [];
    return LinkDetect.findLinks(line).map(function (m) {
      return { text: m.text, kind: m.kind, href: m.href, lineRef: m.lineRef,
        startCol: m.start, endCol: m.end };
    });
  }

  // --- Wrapped line helpers ---

  // Collect a logical line by merging wrapped buffer lines.
  // Returns { text, startRow, rows } where rows is an array of
  // { line, row, strStart, strLen } for each physical row.
  // A physical row is "full" (reached the right margin) if its last printable
  // cell is non-blank — a strong signal the next line is a forced continuation.
  function _rowIsFull(line) {
    var s = line.translateToString(false);
    return s.length > 0 && !/\s$/.test(s);
  }

  // Return the number of leading characters to omit from `below` when two
  // physical rows form one logical line, or -1 when they must stay separate.
  //
  // TUIs such as Codex may render their own wrapping as real newlines instead
  // of letting tmux/xterm mark the continuation with `isWrapped`. Their
  // continuation is commonly a hanging indent aligned with the path's start:
  //
  //   Documents/.../DataAnt-Android14-
  //   property_service-Wuying....md
  //
  // Accept that shape only when its trailing link begins at exactly the same
  // indentation and the ordinary seam heuristic
  // accepts the path characters after the indent. A TUI may wrap to its own
  // narrower content width, so hanging-indent joins deliberately do not require
  // the xterm row itself to be full. This keeps unrelated indented prose on a
  // new logical line while supporting Codex/Claude-style rendered paragraphs.
  function _hardJoinStrip(above, below) {
    if (!above || !below || typeof LinkDetect === 'undefined') return -1;
    var prevText = above.translateToString(true);
    var nextText = below.translateToString(true);
    if (_rowIsFull(above) && LinkDetect.shouldJoinHardWrap(prevText, true, nextText)) return 0;

    var indentMatch = /^( +)/.exec(nextText);
    if (!indentMatch) return -1;
    var stripChars = indentMatch[1].length;
    var continuation = nextText.slice(stripChars);
    if (!continuation || !LinkDetect.shouldJoinHardWrap(prevText, true, continuation)) return -1;

    var tailLinks = LinkDetect.findLinks(prevText);
    for (var i = tailLinks.length - 1; i >= 0; i--) {
      if (tailLinks[i].start === stripChars && tailLinks[i].end === prevText.length) {
        // Validate the seam as a whole, not just as two individually plausible
        // tokens. The joined result must be one file link covering both rows.
        var joined = prevText + continuation;
        var joinedLinks = LinkDetect.findLinks(joined);
        for (var j = joinedLinks.length - 1; j >= 0; j--) {
          if (joinedLinks[j].kind === 'file' && joinedLinks[j].start === stripChars &&
              joinedLinks[j].end === joined.length) return stripChars;
        }
      }
    }
    return -1;
  }

  function _hardJoins(above, below) {
    return _hardJoinStrip(above, below) >= 0;
  }

  function _getLogicalLine(buffer, bufRow) {
    // Walk backward to the true start: up the soft-wrap chain always, and
    // across ONE hard-newline join (Fix 10) so that the continuation row
    // resolves to the SAME merged line as the joined row (else its standalone
    // fragment would match as a wrong link / be unclickable).
    var startRow = bufRow;
    var crossedHard = false;
    for (;;) {
      while (startRow > 0) {
        var prev = buffer.getLine(startRow);
        if (!prev || !prev.isWrapped) break;
        startRow--;
      }
      if (crossedHard || startRow === 0) break;
      var above = buffer.getLine(startRow - 1);
      var cur = buffer.getLine(startRow);
      if (cur && !cur.isWrapped && _hardJoins(above, cur)) {
        startRow--;            // cross the hard newline upward
        crossedHard = true;
        continue;              // climb the predecessor's soft-wrap chain
      }
      break;
    }
    // Collect forward: soft-wrapped continuations always; a single hard-newline
    // row only when the conservative heuristic says the token was split.
    var first = buffer.getLine(startRow);
    if (!first) return { text: '', startRow: startRow, rows: [] };
    var lineObjs = [{ line: first, row: startRow, stripChars: 0 }];
    var row = startRow + 1;
    var joinedHard = false;
    while (row < buffer.length) {
      var ln = buffer.getLine(row);
      if (!ln) break;
      if (ln.isWrapped) { lineObjs.push({ line: ln, row: row, stripChars: 0 }); row++; continue; }
      if (joinedHard) break;   // at most one hard-newline join per logical line
      var stripChars = _hardJoinStrip(lineObjs[lineObjs.length - 1].line, ln);
      if (stripChars < 0) break;
      lineObjs.push({ line: ln, row: row, stripChars: stripChars });
      joinedHard = true;
      row++;                   // keep collecting the joined row's soft-wrap chain
    }
    // Build the merged string. Non-final wrapped rows keep a trailing pad space
    // when a wide CJK glyph could not split across the margin; trim it so the
    // URL/path is not severed at the wrap point (D30).
    var text = '';
    var rows = [];
    for (var i = 0; i < lineObjs.length; i++) {
      var l = lineObjs[i].line;
      var cellStart = lineObjs[i].stripChars || 0;
      var rowText = l.translateToString(i < lineObjs.length - 1).slice(cellStart);
      rows.push({ line: l, row: lineObjs[i].row, strStart: text.length,
        strLen: rowText.length, cellStart: cellStart });
      text += rowText;
    }
    return { text: text, startRow: startRow, rows: rows };
  }

  // Convert a string offset in the merged logical line to { y (1-based
  // lineNumber), x (1-based terminal column) }, correctly handling wide
  // (CJK) characters by walking cells.
  function _logicalStrOffsetToTermPos(rows, strOffset) {
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (strOffset < r.strStart + r.strLen || i === rows.length - 1) {
        var strInRow = Math.max(0, Math.min(strOffset - r.strStart, r.strLen));
        // Walk cells to find terminal column for strInRow-th character
        var col = r.cellStart || 0;
        var chars = 0;
        var lineLen = r.line.length;
        while (chars < strInRow && col < lineLen) {
          var cell = r.line.getCell(col);
          var w = cell ? (cell.getWidth() || 1) : 1;
          col += w;
          chars++;
        }
        return { y: r.row + 1, x: col + 1 };
      }
    }
    var last = rows[rows.length - 1];
    return { y: last.row + 1, x: last.line.length + 1 };
  }

  // --- Open from tmux paste buffer ---

  function _cleanBufferText(text) {
    // Join wrapped/indented lines, strip :line:col suffix
    var cleaned = text.split('\n').map(function (l) { return l.trim(); }).filter(Boolean).join('');
    cleaned = cleaned.replace(/:\d+(?::\d+)?$/, '');
    cleaned = cleaned.replace(/\(\d+(?:,\d+)?\)$/, '');
    return cleaned;
  }

  function openFromBuffer(paneId) {
    var _authHeaders = typeof Auth !== 'undefined' ? Auth.headers() : {};
    // No usable path → open the pane's cwd. '.' is resolved server-side against
    // #{pane_current_path} (resolveInputPath).
    var openCwd = function () { openFile('.', paneId); };
    fetch('/api/files/tmux-buffer', { headers: _authHeaders })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        var p = (res && res.success && res.data && res.data.path) ? res.data.path : '';
        if (!p) { openCwd(); return; }
        // The buffer endpoint hands back its raw text as "path" with no
        // validation, so confirm it resolves to a real file/dir before opening;
        // otherwise (clipboard has no matching path) fall back to the cwd.
        var probe = (typeof LinkDetect !== 'undefined') ? LinkDetect.parseLineRef(p).path : p;
        var qs = '?path=' + encodeURIComponent(probe)
          + (paneId ? '&paneId=' + encodeURIComponent(paneId) : '');
        fetch('/api/files/info' + qs, { headers: _authHeaders })
          .then(function (r) { return r.json(); })
          .then(function (info) {
            if (info && info.success) { openFile(p, paneId); } else { openCwd(); }
          })
          .catch(openCwd);
      })
      .catch(openCwd);
  }

  // --- Link Provider ---

  // Dispatch a matched link by kind. Web opens a browser tab; file opens the
  // preview; ambiguous (e.g. example.com) asks the user which one (project rule:
  // don't guess URL-vs-file — let the user choose).
  function _activateLink(f, paneId) {
    if (f.kind === 'web') { _openWeb(f.href); return; }
    if (f.kind === 'ambiguous') { _showLinkChooser(f, paneId); return; }
    openFile(f.text, paneId, { lineRef: f.lineRef });
  }

  function _openWeb(href) {
    // Only ever open http(s) — defensive gate against a future caller passing a
    // javascript:/data: href (detectors only ever emit http(s) today).
    if (href && /^https?:\/\//i.test(href)) window.open(href, '_blank', 'noopener');
  }

  function _showLinkChooser(f, paneId) {
    var ov = document.createElement('div');
    ov.className = 'fp-overlay fp-chooser';
    ov.addEventListener('click', function (e) { if (e.target === ov) ov.remove(); });
    var box = document.createElement('div');
    box.className = 'fp-chooser-box';
    var q = document.createElement('div');
    q.className = 'fp-chooser-q';
    q.textContent = f.text;
    var sub = document.createElement('div');
    sub.className = 'fp-chooser-sub';
    sub.textContent = '作为网址还是文件打开？';
    var row = document.createElement('div');
    row.className = 'fp-chooser-actions';
    var web = document.createElement('button');
    web.className = 'fp-btn fp-chooser-btn';
    web.textContent = '🌐 网址';
    web.addEventListener('click', function () {
      ov.remove();
      _openWeb(f.href || (typeof LinkDetect !== 'undefined' ? LinkDetect.computeHref(f.text) : 'https://' + f.text));
    });
    var file = document.createElement('button');
    file.className = 'fp-btn fp-chooser-btn';
    file.textContent = '📄 文件';
    file.addEventListener('click', function () { ov.remove(); openFile(f.text, paneId); });
    row.appendChild(web);
    row.appendChild(file);
    box.appendChild(q);
    box.appendChild(sub);
    box.appendChild(row);
    ov.appendChild(box);
    document.body.appendChild(ov);
    web.focus();
    ov.addEventListener('keydown', function (e) { if (e.key === 'Escape') { ov.remove(); e.stopPropagation(); } });
  }

  function _resolvePaneForAction(paneId, resolvePaneId, action) {
    if (typeof resolvePaneId !== 'function') return action(paneId);
    var resolved;
    try {
      resolved = resolvePaneId();
    } catch (_) {
      return action(paneId);
    }
    return Promise.resolve(resolved).then(
      function (livePaneId) { return action(livePaneId || paneId); },
      function () { return action(paneId); }
    );
  }

  function registerLinkProvider(term, paneId, resolvePaneId) {
    term.registerLinkProvider({
      provideLinks: function (lineNumber, callback) {
        var bufRow = lineNumber - 1;
        var buf = term.buffer.active;
        var logical = _getLogicalLine(buf, bufRow);
        var found = _findLinks(logical.text);
        if (found.length === 0) return callback(undefined);

        if (window._FP_DEBUG) {
          console.log('[FP] line', lineNumber, 'text=', JSON.stringify(logical.text), 'matches=', found);
        }

        var links = found.map(function (f) {
          var start = _logicalStrOffsetToTermPos(logical.rows, f.startCol);
          // xterm link ranges are INCLUSIVE, so map the LAST cell (endCol-1),
          // not the exclusive end. Mapping endCol directly lands on the next
          // row when the span ends exactly at a wrap boundary (over-underline).
          var end = _logicalStrOffsetToTermPos(logical.rows, f.endCol - 1);
          return {
            range: { start: start, end: { y: end.y,
              x: end.y === start.y ? Math.max(end.x, start.x) : end.x } },
            text: f.text,
            activate: function () {
              // Keep window.open inside the original user gesture so browsers
              // do not block ordinary web links as async popups.
              if (f.kind === 'web') { _activateLink(f, paneId); return; }
              _resolvePaneForAction(paneId, resolvePaneId, function (livePaneId) {
                _activateLink(f, livePaneId);
              });
            },
          };
        }).filter(function (link) {
          return link.range.start.y <= lineNumber && link.range.end.y >= lineNumber;
        });

        if (window._FP_DEBUG && links.length > 0) {
          console.log('[FP] returning links for line', lineNumber, links.map(function(l) {
            return { text: l.text, range: l.range };
          }));
        }

        callback(links.length > 0 ? links : undefined);
      },
    });
  }

  // --- Open File ---

  function _renderResolvedPreview(body, info, targetLine, options) {
    options = options || {};
    var headers = typeof Auth !== 'undefined' ? Auth.headers() : {};
    var tokenQs = typeof Auth !== 'undefined' ? Auth.wsTokenParam() : '';
    var requestId = options.requestId == null ? _previewGeneration : options.requestId;
    var expectedFile = options.expectedFile || null;
    var expectedPath = options.expectedPath || null;
    var renderedBody = document.createElement('div');
    var current;

    function isCurrent() {
      return _isPreviewRequestCurrent(requestId, body, expectedFile, expectedPath);
    }

    function commit(next, mode) {
      if (!isCurrent()) return false;
      _replacePreviewBody(body, renderedBody);
      if (options.reuseCurrent && expectedFile) Object.assign(expectedFile, next);
      else _currentFile = next;
      _previewReady = true;
      _applyMode(mode);
      return true;
    }

    if (info.isDirectory) {
      current = {
        absPath: info.absPath,
        isDirectory: true,
        size: info.size,
        mtimeMs: info.mtimeMs,
      };
      return _renderDirectory(renderedBody, info.absPath, {
        navBody: body, requestId: requestId,
        expectedFile: expectedFile, expectedPath: expectedPath,
      })
        .then(function (data) {
          if (!data || !isCurrent()) return false;
          current.absPath = data.absPath;
          if (!commit(current, 'dir')) return false;
          _dirContext = data.parent || null;
          _applyMode('dir');
          _setPreviewTitle(data.absPath);
          return true;
        });
    }

    var revision = info.mtimeMs != null ? String(Math.round(info.mtimeMs)) : '';
    var rawUrl = '/api/files/raw?path=' + encodeURIComponent(info.absPath)
      + (tokenQs ? '&' + tokenQs : '')
      + (revision ? '&v=' + encodeURIComponent(revision) : '');
    var filename = info.absPath.split('/').pop();

    current = {
      absPath: info.absPath,
      rawUrl: rawUrl,
      filename: filename,
      isText: info.isText,
      isImage: info.isImage,
      isPdf: info.isPdf,
      isXlsx: info.isXlsx,
      isMarkdown: info.isMarkdown,
      isArchive: info.isArchive,
      rawContent: null,
      size: info.size,
      mtimeMs: info.mtimeMs,
    };
    var renderPromise;
    if (info.isImage) {
      _renderImage(renderedBody, rawUrl);
      renderPromise = Promise.resolve();
    } else if (info.isPdf) {
      _renderPdf(renderedBody, rawUrl);
      renderPromise = Promise.resolve();
    } else if (info.isXlsx) {
      renderPromise = _renderXlsx(renderedBody, rawUrl);
    } else if (info.isArchive) {
      renderPromise = _renderArchive(renderedBody, info);
    } else {
      renderPromise = fetch('/api/files/content?path=' + encodeURIComponent(info.absPath), {
        headers: headers, cache: 'no-store',
      })
        .then(function (r) { return r.json(); })
        .then(function (cr) {
          if (!cr.success) throw new Error(cr.error || '加载文件失败');
          if (!isCurrent()) return false;
          current.rawContent = cr.data.content;
          if (info.isMarkdown) {
            return _renderMarkdown(renderedBody, cr.data.content, info.absPath, options.paneId);
          }
          if (_isCsvPath(info.absPath)) {
            _renderCsv(renderedBody, cr.data.content, info.absPath);
          } else {
            _renderCode(renderedBody, cr.data.content, cr.data.language, targetLine);
          }
          return true;
        });
    }

    return Promise.resolve(renderPromise).then(function (rendered) {
      if (rendered === false || !commit(current, 'file')) return false;
      if (current.isMarkdown && options.markdownFragment) {
        var scrollToLinkedHeading = function () {
          if (!isCurrent()) return;
          _scrollMarkdownHeading(body.querySelector('.fp-md-wrap'), options.markdownFragment);
        };
        if (window.requestAnimationFrame) window.requestAnimationFrame(scrollToLinkedHeading);
        else setTimeout(scrollToLinkedHeading, 0);
      }
      return true;
    });
  }

  // opts: `true` (legacy keep-dir-context) or { lineRef, keepDirContext, markdownFragment }.
  function openFile(filePath, paneId, opts) {
    var keepDir = opts === true || (opts && opts.keepDirContext);
    var targetLine = (opts && opts !== true && opts.lineRef != null) ? opts.lineRef : null;
    var markdownFragment = (opts && opts !== true && opts.markdownFragment) || null;
    // A path may still carry a :line[:col] suffix (e.g. from a mobile tap); split
    // it off so the server gets a clean path and we still know where to jump.
    if (targetLine == null && typeof LinkDetect !== 'undefined') {
      var parsed = LinkDetect.parseLineRef(filePath);
      filePath = parsed.path;
      targetLine = parsed.lineRef;
    }
    _currentPaneId = paneId || _currentPaneId;
    _currentOpenPath = filePath;
    if (!keepDir) _dirContext = null;
    var body = _createModal(filePath);
    var requestId = ++_previewGeneration;
    _previewReady = false;
    _currentFile = null;

    var qs = '?path=' + encodeURIComponent(filePath);
    if (paneId) qs += '&paneId=' + encodeURIComponent(paneId);

    var _authHeaders = typeof Auth !== 'undefined' ? Auth.headers() : {};

    return fetch('/api/files/info' + qs, { headers: _authHeaders, cache: 'no-store' })
      .then(function (r) {
        if (!_isPreviewRequestCurrent(requestId, body)) return null;
        if (r.status === 401) { close(); return null; }
        return r.json();
      })
      .then(function (res) {
        if (!res) return;
        if (!_isPreviewRequestCurrent(requestId, body)) return false;
        if (!res.success) {
          if (res.error === 'File not found' || res.error === 'Path not found') { close(); return; }
          var errorAbsPath = (res.data && res.data.absPath) ? res.data.absPath : null;
          _showError(body, res.error, errorAbsPath);
          return;
        }
        return _renderResolvedPreview(body, res.data, targetLine, {
          requestId: requestId,
          paneId: paneId || _currentPaneId,
          markdownFragment: markdownFragment,
        });
      })
      .then(function (rendered) {
        if (rendered === true) {
          _saveActiveDockTab();
          _syncAutoRefresh();
          return true;
        }
        return false;
      })
      .catch(function (err) {
        if (_isPreviewRequestCurrent(requestId, body)) {
          _previewReady = false;
          _showError(body, err.message);
        }
        return false;
      });
  }

  function _applyMode(mode) {
    if (!_overlay) return;
    _overlay.classList.toggle('fp-mode-dir', mode === 'dir');
    _overlay.classList.toggle('fp-has-back', !!_dirContext);
  }

  // --- Directory browser ---

  function _fmtSize(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function _fmtMtime(ms) {
    if (!ms) return '';
    var diff = Date.now() - ms;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' min ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' h ago';
    if (diff < 7 * 86400000) return Math.floor(diff / 86400000) + ' d ago';
    var d = new Date(ms);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function _iconFor(entry) {
    if (entry.type === 'dir' || entry.targetType === 'dir') return '📁'; // 📁
    if (entry.type === 'symlink' && entry.targetType === 'broken') return '⚠️'; // ⚠️
    return '📄'; // 📄
  }

  function _navDir(body, dirPath) {
    _stopAutoRefresh();
    var requestId = ++_previewGeneration;
    var previous = _currentFile;
    _previewReady = false;
    _currentFile = {
      absPath: dirPath,
      isDirectory: true,
      size: previous && previous.isDirectory ? previous.size : null,
      mtimeMs: previous && previous.isDirectory ? previous.mtimeMs : null,
    };
    var fileAtStart = _currentFile;
    _saveActiveDockTab();
    body.innerHTML = '<div class="fp-loading">Loading directory…</div>';
    var renderedBody = document.createElement('div');
    _renderDirectory(renderedBody, dirPath, {
      navBody: body, requestId: requestId, expectedFile: fileAtStart, expectedPath: dirPath,
    })
      .then(function (data) {
        if (!data || !_isPreviewRequestCurrent(requestId, body, fileAtStart, dirPath)) return;
        _replacePreviewBody(body, renderedBody);
        _currentFile.absPath = data.absPath;
        _dirContext = data.parent || null;
        _previewReady = true;
        _applyMode('dir');
        _setPreviewTitle(data.absPath);
        _saveActiveDockTab();
        _syncAutoRefresh();
      })
      .catch(function (err) {
        if (!_isPreviewRequestCurrent(requestId, body, fileAtStart, dirPath)) return;
        _showError(body, err.message, dirPath);
      });
  }

  function _formatBytes(n) {
    if (n == null || isNaN(n)) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB';
  }

  function _buildArchiveTree(entries) {
    var root = { children: {}, isDir: true };
    entries.forEach(function (entry) {
      var parts = String(entry.name).split('/').filter(Boolean);
      var node = root;
      parts.forEach(function (part, i) {
        node.children[part] = node.children[part] || { children: {} };
        node = node.children[part];
        if (i === parts.length - 1) {
          node.isDir = !!entry.isDir;
          node.size = entry.size || 0;
          node.mtime = entry.mtime || 0;
        } else {
          node.isDir = true;
        }
      });
    });
    return root;
  }

  function _renderArchiveTree(node, container, depth) {
    var names = Object.keys(node.children).sort(function (a, b) {
      var ad = node.children[a].isDir ? 0 : 1;
      var bd = node.children[b].isDir ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.localeCompare(b, undefined, { sensitivity: 'base' });
    });
    names.forEach(function (name) {
      var child = node.children[name];
      var row = document.createElement('div');
      row.className = 'fp-dir-row fp-arch-row' + (child.isDir ? ' fp-arch-dir' : '');
      row.style.paddingLeft = (8 + depth * 16) + 'px';
      var icon = child.isDir ? '📁' : '📄';
      row.innerHTML = '<span class="fp-dir-icon">' + icon + '</span>'
        + '<span class="fp-dir-name">' + _escapeHtml(name) + '</span>'
        + '<span class="fp-dir-size">' + (child.isDir ? '' : _escapeHtml(_formatBytes(child.size))) + '</span>';
      container.appendChild(row);
      if (child.isDir) {
        var sub = document.createElement('div');
        sub.className = 'fp-arch-sub';
        container.appendChild(sub);
        _renderArchiveTree(child, sub, depth + 1);
        row.addEventListener('click', function () {
          sub.hidden = !sub.hidden;
          row.classList.toggle('fp-arch-collapsed', sub.hidden);
        });
      }
    });
  }

  function _renderArchive(body, info) {
    body.innerHTML = '<div class="fp-loading">解析压缩包…</div>';
    var headers = typeof Auth !== 'undefined' ? Auth.headers() : {};
    return fetch('/api/files/archive?path=' + encodeURIComponent(info.absPath), {
      headers: headers, cache: 'no-store',
    })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res.success) throw new Error(res.error || '压缩包解析失败');
        var data = res.data;
        var wrap = document.createElement('div');
        wrap.className = 'fp-arch-wrap';

        var head = document.createElement('div');
        head.className = 'fp-arch-head';
        head.innerHTML = '<span class="fp-arch-type">' + _escapeHtml(data.archiveType) + '</span>'
          + '<span class="fp-arch-count">' + data.totalCount + ' 项</span>'
          + (data.truncated ? '<span class="fp-arch-trunc">已截断</span>' : '');
        wrap.appendChild(head);

        var list = document.createElement('div');
        list.className = 'fp-dir-list fp-arch-list';
        var tree = _buildArchiveTree(data.entries);
        _renderArchiveTree(tree, list, 0);
        wrap.appendChild(list);

        body.innerHTML = '';
        body.appendChild(wrap);
        return true;
      });
  }

  function _renderDirectory(body, dirPath, options) {
    options = options || {};
    var navBody = options.navBody || body;
    body.innerHTML = '<div class="fp-loading">Loading directory…</div>';
    var _authHeaders = typeof Auth !== 'undefined' ? Auth.headers() : {};
    var qs = '?path=' + encodeURIComponent(dirPath);
    if (_currentPaneId) qs += '&paneId=' + encodeURIComponent(_currentPaneId);

    return fetch('/api/files/list' + qs, { headers: _authHeaders, cache: 'no-store' })
      .then(function (r) {
        if (r.status === 401) {
          if (options.requestId == null || _isPreviewRequestCurrent(
            options.requestId, navBody, options.expectedFile, options.expectedPath
          )) close();
          return null;
        }
        return r.json();
      })
      .then(function (res) {
        if (!res) return;
        if (!res.success) {
          throw new Error(res.error || '目录加载失败');
        }
        var data = res.data;

        var wrap = document.createElement('div');
        wrap.className = 'fp-dir-wrap';

        // Breadcrumb
        var crumb = document.createElement('div');
        crumb.className = 'fp-dir-crumb';
        var segs = data.absPath.split('/').filter(Boolean);
        var rootLink = document.createElement('a');
        rootLink.className = 'fp-dir-crumb-seg';
        rootLink.textContent = '/';
        rootLink.href = '#';
        rootLink.addEventListener('click', function (e) {
          e.preventDefault();
          _navDir(navBody, '/');
        });
        crumb.appendChild(rootLink);
        var accum = '';
        segs.forEach(function (seg, i) {
          accum += '/' + seg;
          var sep = document.createElement('span');
          sep.className = 'fp-dir-crumb-sep';
          sep.textContent = '/';
          var el;
          if (i === segs.length - 1) {
            el = document.createElement('span');
            el.className = 'fp-dir-crumb-seg fp-dir-crumb-current';
            el.textContent = seg;
          } else {
            el = document.createElement('a');
            el.className = 'fp-dir-crumb-seg';
            el.textContent = seg;
            el.href = '#';
            var target = accum;
            el.addEventListener('click', function (e) {
              e.preventDefault();
              _navDir(navBody, target);
            });
          }
          crumb.appendChild(sep);
          crumb.appendChild(el);
        });
        wrap.appendChild(crumb);

        // List
        var list = document.createElement('div');
        list.className = 'fp-dir-list';

        if (data.parent) {
          var upRow = document.createElement('div');
          upRow.className = 'fp-dir-row fp-dir-parent';
          upRow.tabIndex = 0;
          upRow.innerHTML = '<span class="fp-dir-icon">↰</span>'
            + '<span class="fp-dir-name">..</span>'
            + '<span class="fp-dir-size"></span>'
            + '<span class="fp-dir-mtime"></span>';
          var parentPath = data.parent;
          upRow.addEventListener('click', function () { _navDir(navBody, parentPath); });
          upRow.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _navDir(navBody, parentPath); }
          });
          list.appendChild(upRow);
        }

        if (data.entries.length === 0) {
          var empty = document.createElement('div');
          empty.className = 'fp-dir-empty';
          empty.textContent = '(empty directory)';
          list.appendChild(empty);
        }

        data.entries.forEach(function (entry) {
          var row = document.createElement('div');
          row.className = 'fp-dir-row';
          if (entry.isHidden) row.className += ' fp-dir-hidden';
          if (entry.unreadable) row.className += ' fp-dir-unreadable';
          var isDir = entry.type === 'dir' || entry.targetType === 'dir';
          if (isDir) row.className += ' fp-dir-isdir';
          row.tabIndex = 0;

          var fullPath = (data.absPath === '/' ? '' : data.absPath) + '/' + entry.name;

          var icon = document.createElement('span');
          icon.className = 'fp-dir-icon';
          icon.textContent = _iconFor(entry);

          var name = document.createElement('span');
          name.className = 'fp-dir-name';
          var nameText = entry.name;
          if (entry.type === 'symlink') {
            var suffix = entry.targetType === 'broken'
              ? ' → (broken)'
              : ' → ' + (entry.targetType === 'dir' ? 'dir' : 'file');
            nameText += suffix;
          }
          name.textContent = nameText;
          name.title = fullPath;

          var size = document.createElement('span');
          size.className = 'fp-dir-size';
          size.textContent = isDir ? '' : _fmtSize(entry.size);

          var mtime = document.createElement('span');
          mtime.className = 'fp-dir-mtime';
          mtime.textContent = _fmtMtime(entry.mtime);

          row.appendChild(icon);
          row.appendChild(name);
          row.appendChild(size);
          row.appendChild(mtime);

          var activate = function () {
            if (entry.unreadable) return;
            if (isDir) {
              _navDir(navBody, fullPath);
            } else {
              // Remember the parent dir so the back button returns here
              _dirContext = data.absPath;
              openFile(fullPath, _currentPaneId, true);
            }
          };
          row.addEventListener('click', activate);
          row.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
          });

          list.appendChild(row);
        });

        wrap.appendChild(list);

        if (data.truncated) {
          var warn = document.createElement('div');
          warn.className = 'fp-dir-truncated';
          warn.textContent = 'Showing first ' + data.entries.length + ' of ' + data.totalCount + ' entries';
          wrap.appendChild(warn);
        }

        body.innerHTML = '';
        body.appendChild(wrap);
        return data;
      })
      ;
  }

  // Convert a terminal (bufRow, termCol) position to a string offset in
  // the merged logical line. Walks cells to skip wide-char placeholders.
  function _termPosToLogicalStrOffset(logical, bufRow, termCol) {
    for (var i = 0; i < logical.rows.length; i++) {
      var r = logical.rows[i];
      if (r.row !== bufRow) continue;
      // Walk cells on this row up to termCol, counting characters
      var col = 0;
      var chars = 0;
      var lineLen = r.line.length;
      var cellStart = r.cellStart || 0;
      if (termCol < cellStart) return -1;
      col = cellStart;
      while (col < termCol && col < lineLen) {
        var cell = r.line.getCell(col);
        var w = cell ? (cell.getWidth() || 1) : 1;
        col += w;
        chars++;
      }
      return r.strStart + chars;
    }
    return -1;
  }

  // Check if a position falls on a link. Returns the full match object
  // { kind, text, href, lineRef, ... } (dispatch via activateHit) or null.
  // For mobile: pass term + viewportRow to enable wrapped line detection.
  function hitTest(lineText, col, term, viewportRow) {
    if (term && viewportRow !== undefined) {
      var bufRow = term.buffer.active.viewportY + viewportRow;
      var logical = _getLogicalLine(term.buffer.active, bufRow);
      var strOffset = _termPosToLogicalStrOffset(logical, bufRow, col);
      if (strOffset < 0) return null;
      var links = _findLinks(logical.text);
      for (var i = 0; i < links.length; i++) {
        if (strOffset >= links[i].startCol && strOffset < links[i].endCol) {
          return links[i];
        }
      }
      return null;
    }
    // Fallback: single-line hit test
    var simpleLinks = _findLinks(lineText);
    for (var j = 0; j < simpleLinks.length; j++) {
      if (col >= simpleLinks[j].startCol && col < simpleLinks[j].endCol) {
        return simpleLinks[j];
      }
    }
    return null;
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', _syncAutoRefresh);
    document.addEventListener('tmux-theme-change', _refreshMermaidTheme);
  }

  return {
    registerLinkProvider: registerLinkProvider, openFile: openFile,
    openFromBuffer: openFromBuffer, close: close, closeDocked: closeDocked,
    restoreDocked: restoreDocked, switchDockContext: switchDockContext, hitTest: hitTest,
    activateHit: _activateLink,
    // Test seam (no DOM): exercised by test/file-preview-links.test.js.
    _test: {
      getLogicalLine: _getLogicalLine,
      strOffsetToTermPos: _logicalStrOffsetToTermPos,
      findLinks: _findLinks,
      resolvePaneForAction: _resolvePaneForAction,
      refreshCurrent: _refreshCurrent,
      syncAutoRefresh: _syncAutoRefresh,
      hasAutoRefreshTimer: function () { return _autoRefreshTimer != null; },
      autoRefreshMs: AUTO_REFRESH_MS,
      prepareMermaid: _prepareMermaid,
      installMermaidInteractions: _installMermaidInteractions,
      disposeMermaid: _disposeMermaid,
      mermaidThemeConfig: _mermaidThemeConfig,
      refreshMermaidTheme: _refreshMermaidTheme,
      mermaidStandaloneScript: _mermaidStandaloneScript,
      markdownHeadingSlug: _markdownHeadingSlug,
      wikilinkHtml: _wikilinkHtml,
      resolveMarkdownHref: _resolveMarkdownHref,
      scrollMarkdownHeading: _scrollMarkdownHeading,
      prepareMarkdownNavigation: _prepareMarkdownNavigation,
      buildArchiveTree: _buildArchiveTree,
      renderArchiveTree: _renderArchiveTree,
      formatBytes: _formatBytes,
      loadDockState: _loadDockState,
      persistDockState: _persistDockState,
      dockStateKey: function (serverId, sessionName, windowIndex) {
        return _dockStateStorageKey(_makeDockContextKey(serverId, sessionName, windowIndex));
      },
      legacyDockStateKey: LEGACY_DOCK_STATE_KEY,
      dockContextKey: function () { return _dockContextKey; },
      buildLinkRange: function (logical, f) {
        var start = _logicalStrOffsetToTermPos(logical.rows, f.startCol);
        var end = _logicalStrOffsetToTermPos(logical.rows, f.endCol - 1);
        return { start: start, end: { y: end.y,
          x: end.y === start.y ? Math.max(end.x, start.x) : end.x } };
      },
    },
  };
})();

if (typeof window !== 'undefined') window.FilePreview = FilePreview;
