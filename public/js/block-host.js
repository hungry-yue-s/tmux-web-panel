/* global Api */

// BlockHost: where tool blocks (git, browser…) live next to the terminal.
//
// A block is docked as a tab in the right-hand sidebar it shares with file
// previews, floats as a window over the workstage, or is maximized over it.
// Phones and narrow windows show it as a full-screen sheet. Every block
// belongs to one server: switching servers swaps the set of blocks, and each
// server remembers its own blocks, modes and positions across reloads. A kind
// registered with `perWindow` (git) belongs to one tmux window as well, the way
// file tabs do, and is kept under the same identity: server, tmux instance, window.
//
// The sidebar itself (tab strip, width, hide/restore) belongs to the file
// preview; this file only declares which frames belong in it. It exists only
// next to a terminal, so a block opened anywhere else floats.

var BlockHost = (function () {
  'use strict';

  var STORAGE_PREFIX = 'twp_blocks_v1:';
  var WINDOW_STORAGE_PREFIX = 'twp_window_blocks_v1:';
  var FLOAT_MIN_W = 360;
  var FLOAT_MIN_H = 240;
  var COMPACT_WIDTH = 900;

  var kinds = {};
  var instances = [];
  var nextId = 1;
  var zTop = 30;
  var dockState = {}; // scope -> { active }
  var restoredScopes = {};
  var focusedId = null;

  // --- small DOM helpers (shared look with blocks.js) ---------------------

  var ICON_PATHS = {
    dock: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M14 4v16"/>',
    hide: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/><path d="m8 9 3 3-3 3"/>',
    float: '<rect x="3" y="4" width="18" height="16" rx="2"/><rect x="11" y="11" width="8" height="6" rx="1"/>',
    max: '<path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/>',
    restore: '<path d="M3 8h5V3M21 8h-5V3M3 16h5v5M21 16h-5v5"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
  };

  function svg(paths) {
    return '<svg class="blk-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"'
      + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + paths + '</svg>';
  }

  function iconMarkup(name) {
    if (ICON_PATHS[name]) return svg(ICON_PATHS[name]);
    if (window.Blocks && window.Blocks.icon) return window.Blocks.icon(name);
    return '';
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function iconButton(name, label, onclick, className) {
    var b = el('button', 'blk-icon-btn' + (className ? ' ' + className : ''));
    b.type = 'button';
    b.innerHTML = iconMarkup(name);
    b.setAttribute('aria-label', label);
    b.title = label;
    b.addEventListener('click', onclick);
    return b;
  }

  // --- environment ---------------------------------------------------------

  function currentServer() {
    return (window.Api && Api.activeServerId) ? Api.activeServerId() : 'local';
  }

  function layout() {
    return document.querySelector('.ms-app .ms-main');
  }

  function isCompact() {
    if (window.MobileUI && typeof window.MobileUI.isMobile === 'function' && window.MobileUI.isMobile()) return true;
    return window.innerWidth < COMPACT_WIDTH || !layout();
  }

  function effectiveMode(instance) {
    return isCompact() ? 'sheet' : instance.mode;
  }

  function sidebar() {
    return window.FilePreview ? window.FilePreview.blockDock : null;
  }

  /** The tmux window on screen on this server, under the key the sidebar knows it by. */
  function currentWindow() {
    var dock = sidebar();
    var context = dock ? dock.context() : null;
    return context && context.indexOf(currentServer() + '\u0000') === 0 ? context : null;
  }

  /** What a block is saved and restored with: its window, or else its server. */
  function scopeOf(instance) {
    return instance.windowKey || instance.serverId;
  }

  function isHere(instance) {
    return instance.serverId === currentServer()
      && (!instance.windowKey || instance.windowKey === currentWindow());
  }

  function canDock() {
    var dock = sidebar();
    return !!(dock && dock.available());
  }

  /** The sidebar only exists next to a terminal: elsewhere a docked block floats. */
  function placeableMode(mode) {
    return mode === 'dock' && !isCompact() && !canDock() ? 'float' : mode;
  }

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  // --- persistence -----------------------------------------------------------

  function storageKey(scope) {
    if (scope.indexOf('\u0000') < 0) return STORAGE_PREFIX + encodeURIComponent(scope);
    // tmux reuses window ids after a restart, so without its instance id a window
    // cannot be told from an earlier one: memory only, the same as file tabs.
    return scope.split('\u0000')[1] ? WINDOW_STORAGE_PREFIX + encodeURIComponent(scope) : null;
  }

  function persist(scope) {
    var key = storageKey(scope);
    if (!key) return;
    var own = instances.filter(function (i) { return scopeOf(i) === scope && kinds[i.kind] && kinds[i.kind].persist !== false; });
    var state = dockState[scope] || {};
    var active = own.find(function (i) { return i.id === state.active; });
    var data = {
      version: 1,
      blocks: own.slice(0, 12).map(function (i) {
        return { kind: i.kind, params: i.params, mode: i.mode, geom: i.geom || null };
      }),
      active: active ? own.indexOf(active) : -1,
    };
    try {
      if (own.length) window.localStorage.setItem(key, JSON.stringify(data));
      else window.localStorage.removeItem(key);
    } catch (_) { /* private mode */ }
  }

  function restore(scope, serverId, windowKey) {
    if (restoredScopes[scope]) return;
    restoredScopes[scope] = true;
    var key = storageKey(scope);
    if (!key) return;
    var raw = null;
    try { raw = window.localStorage.getItem(key); } catch (_) { return; }
    if (!raw) return;
    var data;
    try { data = JSON.parse(raw); } catch (_) { return; }
    if (!data || data.version !== 1 || !Array.isArray(data.blocks)) return;
    dockState[scope] = { active: null };
    var created = [];
    data.blocks.forEach(function (saved) {
      if (!saved || !kinds[saved.kind]) return;
      var mode = saved.mode === 'float' || saved.mode === 'max' ? saved.mode : 'dock';
      var instance = create(saved.kind, saved.params || {}, { mode: mode, serverId: serverId, windowKey: windowKey, geom: saved.geom, quiet: true });
      if (instance) created.push(instance);
    });
    var active = created[data.active];
    if (active) dockState[scope].active = active.id;
  }

  /** A window's blocks are only built once it is visited. */
  function restoreHere() {
    var sid = currentServer();
    restore(sid, sid, null);
    var win = currentWindow();
    if (win) restore(win, sid, win);
  }

  /**
   * A per-window block with no window yet, because it was opened on another page
   * or saved before blocks were per window, joins the first one it is seen in.
   */
  function adoptUnbound() {
    var win = currentWindow();
    if (!win) return;
    var sid = currentServer();
    var adopted = false;
    instances.slice().forEach(function (instance) {
      if (instance.windowKey || instance.serverId !== sid || !kinds[instance.kind].perWindow) return;
      adopted = true;
      var twin = instance.key && instances.find(function (i) { return i.windowKey === win && i.key === instance.key; });
      if (twin) {
        discard(instance);
        return;
      }
      var state = dockState[sid];
      if (state && state.active === instance.id) {
        state.active = null;
        dockState[win] = dockState[win] || { active: null };
        dockState[win].active = instance.id;
      }
      instance.windowKey = win;
    });
    if (!adopted) return;
    persist(sid);
    persist(win);
  }

  /** Windows that are gone take their blocks with them, like their file tabs. */
  function forgetWindows(serverId, isLive) {
    var gone = function (scope) {
      return scope.indexOf(serverId + '\u0000') === 0 && !isLive(scope);
    };
    var removed = false;
    instances.slice().forEach(function (instance) {
      if (instance.windowKey && gone(instance.windowKey)) {
        discard(instance);
        removed = true;
      }
    });
    Object.keys(restoredScopes).forEach(function (scope) {
      if (gone(scope)) delete restoredScopes[scope];
    });
    Object.keys(dockState).forEach(function (scope) {
      if (gone(scope)) delete dockState[scope];
    });
    try {
      var storage = window.localStorage;
      for (var i = storage.length - 1; i >= 0; i--) {
        var key = storage.key(i);
        if (key.indexOf(WINDOW_STORAGE_PREFIX) !== 0) continue;
        var scope;
        try { scope = decodeURIComponent(key.slice(WINDOW_STORAGE_PREFIX.length)); } catch (_) { continue; }
        if (gone(scope)) storage.removeItem(key);
      }
    } catch (_) { /* storage may be unavailable */ }
    if (removed) render();
  }

  // --- instances -------------------------------------------------------------

  function register(kind, definition) {
    kinds[kind] = definition;
  }

  function keyOf(kind, params) {
    var definition = kinds[kind];
    return definition && definition.key ? kind + ':' + definition.key(params || {}) : null;
  }

  function create(kind, params, options) {
    var definition = kinds[kind];
    if (!definition) return null;
    var serverId = options.serverId || currentServer();
    var instance = {
      id: 'blk-' + (nextId++),
      kind: kind,
      key: keyOf(kind, params),
      serverId: serverId,
      windowKey: options.windowKey || null,
      params: params || {},
      mode: options.mode || definition.defaultMode || 'dock',
      previousMode: null,
      geom: options.geom || null,
      title: definition.title,
      subtitle: '',
      icon: definition.icon || kind,
      busy: false,
      z: ++zTop,
    };
    buildFrame(instance);
    var api = {
      id: instance.id,
      serverId: serverId,
      params: instance.params,
      /** Coming back with its window rather than opened by the user just now. */
      restored: !!options.quiet,
      url: function (path) { return window.Api ? Api.nodeUrl(serverId, path) : path; },
      setTitle: function (title) {
        var next = title || definition.title;
        if (next === instance.title) return;
        instance.title = next;
        syncTitle(instance);
        syncSidebar();
      },
      setSubtitle: function (subtitle) {
        var next = subtitle || '';
        if (next === instance.subtitle) return;
        instance.subtitle = next;
        syncTitle(instance);
        syncSidebar();
      },
      setParams: function (next) { instance.params = Object.assign({}, instance.params, next || {}); instance.key = keyOf(kind, instance.params); persist(scopeOf(instance)); },
      setBusy: function (busy) { instance.busy = !!busy; instance.frame.classList.toggle('is-busy', instance.busy); syncSidebar(); },
      close: function () { close(instance.id); },
      isVisible: function () { return isVisible(instance); },
      focus: function () { focusInstance(instance); },
    };
    instance.api = api;
    var impl = null;
    try {
      impl = definition.create(api) || {};
    } catch (err) {
      impl = { el: el('div', 'blk-error', '无法打开：' + (err && err.message ? err.message : err)) };
    }
    instance.impl = impl;
    if (impl.el) instance.body.appendChild(impl.el);
    instances.push(instance);
    if (!options.quiet) instance.entering = true;
    return instance;
  }

  function buildFrame(instance) {
    var frame = el('section', 'blk-frame');
    frame.dataset.blockId = instance.id;
    frame.setAttribute('role', 'region');
    var head = el('header', 'blk-frame-head');
    var icon = el('span', 'blk-frame-icon');
    var titles = el('div', 'blk-frame-titles');
    var title = el('strong', 'blk-frame-title');
    var subtitle = el('span', 'blk-frame-sub');
    titles.append(title, subtitle);
    var actions = el('div', 'blk-frame-actions');
    head.append(icon, titles, actions);
    var body = el('div', 'blk-frame-body');
    var grip = el('div', 'blk-frame-resize');
    grip.setAttribute('aria-hidden', 'true');
    frame.append(head, body, grip);
    instance.frame = frame;
    instance.head = head;
    instance.body = body;
    instance.iconEl = icon;
    instance.titleEl = title;
    instance.subtitleEl = subtitle;
    instance.actionsEl = actions;
    icon.innerHTML = iconMarkup(kinds[instance.kind].icon || instance.kind);

    frame.addEventListener('pointerdown', function () { raise(instance); focusedId = instance.id; }, true);
    frame.addEventListener('focusin', function () { focusedId = instance.id; });
    frame.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !e.defaultPrevented && instance.mode === 'max' && !isCompact()) {
        e.preventDefault();
        setMode(instance.id, instance.previousMode || 'dock');
      }
    });
    head.addEventListener('dblclick', function (e) {
      if (e.target.closest('button') || isCompact()) return;
      setMode(instance.id, instance.mode === 'max' ? (instance.previousMode || 'dock') : 'max');
    });
    installDrag(instance);
    installResize(instance);
  }

  function syncTitle(instance) {
    instance.titleEl.textContent = instance.title;
    instance.subtitleEl.textContent = instance.subtitle;
    instance.subtitleEl.hidden = !instance.subtitle;
    instance.frame.setAttribute('aria-label', instance.title + (instance.subtitle ? ' · ' + instance.subtitle : ''));
  }

  function renderActions(instance) {
    var actions = instance.actionsEl;
    actions.replaceChildren();
    var mode = effectiveMode(instance);
    if (mode === 'sheet') {
      actions.appendChild(iconButton('close', '关闭', function () { close(instance.id); }, 'blk-frame-close'));
      return;
    }
    if (mode !== 'dock' && canDock()) actions.appendChild(iconButton('dock', '停靠到右侧', function () { setMode(instance.id, 'dock'); }));
    if (mode !== 'float') actions.appendChild(iconButton('float', '浮动窗口', function () { setMode(instance.id, 'float'); }));
    actions.appendChild(mode === 'max'
      ? iconButton('restore', '还原（Esc）', function () { setMode(instance.id, instance.previousMode || 'dock'); })
      : iconButton('max', '最大化', function () { setMode(instance.id, 'max'); }));
    actions.appendChild(iconButton('close', '关闭', function () { close(instance.id); }, 'blk-frame-close'));
  }

  // --- float drag & resize -----------------------------------------------------

  function mainRect() {
    var main = layout();
    return main ? main.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  }

  function clampGeom(geom) {
    var rect = mainRect();
    var w = Math.max(FLOAT_MIN_W, Math.min(geom.w, rect.width - 16));
    var h = Math.max(FLOAT_MIN_H, Math.min(geom.h, rect.height - 16));
    var x = Math.max(8, Math.min(geom.x, rect.width - w - 8));
    var y = Math.max(8, Math.min(geom.y, rect.height - h - 8));
    return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
  }

  function defaultGeom() {
    var rect = mainRect();
    var floats = instances.filter(function (i) { return i.mode === 'float' && isHere(i); }).length;
    var w = Math.min(760, Math.max(FLOAT_MIN_W, rect.width * 0.55));
    var h = Math.min(560, Math.max(FLOAT_MIN_H, rect.height * 0.7));
    return clampGeom({ x: rect.width - w - 24 - floats * 24, y: 24 + floats * 24, w: w, h: h });
  }

  function applyGeom(instance) {
    instance.geom = clampGeom(instance.geom || defaultGeom());
    var style = instance.frame.style;
    style.left = instance.geom.x + 'px';
    style.top = instance.geom.y + 'px';
    style.width = instance.geom.w + 'px';
    style.height = instance.geom.h + 'px';
  }

  function installDrag(instance) {
    instance.head.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || effectiveMode(instance) !== 'float' || e.target.closest('button,input,select,textarea,a')) return;
      e.preventDefault();
      var start = { x: e.clientX, y: e.clientY, gx: instance.geom.x, gy: instance.geom.y };
      document.body.classList.add('blk-dragging');
      function move(ev) {
        instance.geom = clampGeom({ x: start.gx + ev.clientX - start.x, y: start.gy + ev.clientY - start.y, w: instance.geom.w, h: instance.geom.h });
        applyGeom(instance);
      }
      function up() {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        document.body.classList.remove('blk-dragging');
        persist(scopeOf(instance));
      }
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
  }

  function installResize(instance) {
    var grip = instance.frame.querySelector('.blk-frame-resize');
    grip.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || effectiveMode(instance) !== 'float') return;
      e.preventDefault();
      var start = { x: e.clientX, y: e.clientY, w: instance.geom.w, h: instance.geom.h };
      document.body.classList.add('blk-resizing');
      function move(ev) {
        instance.geom = clampGeom({ x: instance.geom.x, y: instance.geom.y, w: start.w + ev.clientX - start.x, h: start.h + ev.clientY - start.y });
        applyGeom(instance);
      }
      function up() {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        document.body.classList.remove('blk-resizing');
        persist(scopeOf(instance));
      }
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
  }

  // --- sidebar ---------------------------------------------------------------

  function sidebarActions(instance) {
    return [
      iconButton('float', '浮动窗口', function () { setMode(instance.id, 'float'); }),
      iconButton('max', '最大化', function () { setMode(instance.id, 'max'); }),
      iconButton('hide', '隐藏右侧边栏（Esc）', function () { sidebar().hide(); }),
    ];
  }

  /** Tells the sidebar which blocks belong in its tab strip right now. */
  function syncSidebar() {
    var dock = sidebar();
    if (!dock) return;
    dock.sync(instances.filter(function (instance) {
      return isHere(instance) && effectiveMode(instance) === 'dock';
    }).map(function (instance) {
      var state = dockState[scopeOf(instance)] || {};
      return {
        key: instance.id,
        persistKey: instance.key || instance.kind,
        title: instance.title,
        subtitle: instance.subtitle,
        icon: iconMarkup(kinds[instance.kind].icon || instance.kind),
        busy: instance.busy,
        element: instance.frame,
        active: instance.id === state.active,
        actions: sidebarActions(instance),
        onClose: function () { close(instance.id); },
        onDoubleClick: function () { setMode(instance.id, 'max'); },
      };
    }));
  }

  /** A tab in the sidebar came to the front (null: a file preview did). */
  function onSidebarChange(id) {
    var instance = instances.find(function (i) { return i.id === id; });
    var front = instance ? scopeOf(instance) : null;
    [currentServer(), currentWindow()].forEach(function (scope) {
      if (!scope) return;
      var state = dockState[scope] = dockState[scope] || { active: null };
      var next = scope === front ? id : null;
      if (state.active === next) return;
      state.active = next;
      persist(scope);
    });
    if (instance && instance.impl && typeof instance.impl.onShow === 'function') {
      try { instance.impl.onShow(); } catch (_) { /* a block's own refresh failing must not break the tabs */ }
    }
  }

  // --- placement -------------------------------------------------------------

  function isVisible(instance) {
    return isHere(instance) && instance.frame.isConnected && !instance.frame.hidden;
  }

  function render() {
    restoreHere();
    adoptUnbound();
    var main = layout();
    // First: a frame leaving the sidebar must be released before it is placed.
    syncSidebar();

    instances.forEach(function (instance) {
      var frame = instance.frame;
      if (!isHere(instance)) {
        frame.hidden = true;
        instance.shown = false;
        return;
      }
      var mode = effectiveMode(instance);
      frame.classList.toggle('blk-mode-dock', mode === 'dock');
      frame.classList.toggle('blk-mode-float', mode === 'float');
      frame.classList.toggle('blk-mode-max', mode === 'max');
      frame.classList.toggle('blk-mode-sheet', mode === 'sheet');
      if (mode === 'float') {
        applyGeom(instance);
        frame.style.zIndex = String(instance.z);
      } else {
        frame.style.left = frame.style.top = frame.style.width = frame.style.height = '';
        frame.style.zIndex = mode === 'max' ? '60' : '';
      }
      // The sidebar attaches and shows docked frames itself.
      if (mode !== 'dock') {
        var target = (mode === 'sheet' ? document.body : main) || document.body;
        if (frame.parentNode !== target) target.appendChild(frame);
        frame.hidden = false;
      }
      renderActions(instance);
      syncTitle(instance);
      if (instance.entering && !reducedMotion()) {
        frame.classList.add('is-entering');
        setTimeout(function () { frame.classList.remove('is-entering'); }, 220);
      }
      instance.entering = false;
      if (mode !== 'dock') {
        // onShow fires when a block comes back into view, not on every layout pass.
        if (!instance.shown && instance.impl && typeof instance.impl.onShow === 'function') {
          try { instance.impl.onShow(); } catch (_) { /* a block's own refresh failing must not break the host */ }
        }
        instance.shown = true;
      } else {
        instance.shown = false;
      }
    });
    document.body.classList.toggle('blk-sheet-open', instances.some(function (i) {
      return isHere(i) && effectiveMode(i) === 'sheet';
    }));
  }

  function raise(instance) {
    if (instance.mode !== 'float') return;
    instance.z = ++zTop;
    instance.frame.style.zIndex = String(instance.z);
  }

  function focusInstance(instance) {
    focusedId = instance.id;
    var target = instance.frame.querySelector('[data-autofocus]')
      || instance.frame.querySelector('.blk-frame-body button, .blk-frame-body input, .blk-frame-body textarea, .blk-frame-body [tabindex="0"]');
    if (target && !isCompact()) target.focus({ preventScroll: true });
  }

  // --- public operations -------------------------------------------------------

  function open(kind, params, options) {
    options = options || {};
    if (!kinds[kind]) return null;
    var sid = currentServer();
    restoreHere();
    // Whatever was asked for should be what's on screen, not behind a file modal.
    if (window.FilePreview && window.FilePreview.closeModal) window.FilePreview.closeModal();
    var key = keyOf(kind, params);
    var existing = key && instances.find(function (i) { return isHere(i) && i.key === key; });
    if (existing) {
      if (options.mode && options.mode !== existing.mode) existing.mode = options.mode;
      existing.mode = placeableMode(existing.mode);
      if (existing.impl && typeof existing.impl.update === 'function') existing.impl.update(params || {});
      activate(existing.id);
      return existing.api;
    }
    var mode = placeableMode(options.mode || kinds[kind].defaultMode || 'dock');
    var instance = create(kind, params || {}, { mode: mode, serverId: sid, windowKey: kinds[kind].perWindow ? currentWindow() : null });
    if (!instance) return null;
    activate(instance.id);
    // A freshly built frame may have nothing focusable until its first load.
    setTimeout(function () { focusInstance(instance); }, 30);
    return instance.api;
  }

  /** Brings a docked block to the front of the sidebar once it is in the strip. */
  function frontInSidebar(instance) {
    if (instance.mode !== 'dock' || isCompact()) return;
    var dock = sidebar();
    if (dock) dock.activate(instance.id);
  }

  function activate(id) {
    var instance = instances.find(function (i) { return i.id === id; });
    if (!instance) return;
    if (instance.mode === 'dock') {
      dockState[scopeOf(instance)] = dockState[scopeOf(instance)] || {};
      dockState[scopeOf(instance)].active = id;
    }
    raise(instance);
    render();
    frontInSidebar(instance);
    persist(scopeOf(instance));
    focusInstance(instance);
  }

  function setMode(id, requested) {
    var instance = instances.find(function (i) { return i.id === id; });
    var mode = placeableMode(requested);
    if (!instance || instance.mode === mode) return;
    if (mode === 'max') instance.previousMode = instance.mode;
    if (mode === 'float' && !instance.geom) instance.geom = defaultGeom();
    instance.mode = mode;
    if (mode === 'dock') {
      dockState[scopeOf(instance)] = dockState[scopeOf(instance)] || {};
      dockState[scopeOf(instance)].active = id;
    }
    instance.entering = true;
    raise(instance);
    render();
    frontInSidebar(instance);
    persist(scopeOf(instance));
    focusInstance(instance);
  }

  function discard(instance) {
    if (instance.impl && typeof instance.impl.dispose === 'function') {
      try { instance.impl.dispose(); } catch (_) { /* best effort */ }
    }
    instance.frame.remove();
    instances = instances.filter(function (i) { return i !== instance; });
    var state = dockState[scopeOf(instance)];
    if (state && state.active === instance.id) state.active = null;
    if (focusedId === instance.id) focusedId = null;
  }

  function close(id) {
    var instance = instances.find(function (i) { return i.id === id; });
    if (!instance) return;
    discard(instance);
    render();
    persist(scopeOf(instance));
    // Typing returns to the terminal on desktop; phones would pop the keyboard.
    if (!isCompact()) {
      var terminal = document.querySelector('.terminal-view .xterm-helper-textarea');
      if (terminal) terminal.focus({ preventScroll: true });
    }
  }

  function focused() {
    var instance = instances.find(function (i) { return i.id === focusedId && isVisible(i); });
    if (instance) return instance;
    return instances.find(function (i) { return isHere(i) && i.id === (dockState[scopeOf(i)] || {}).active; })
      || instances.filter(isVisible).pop() || null;
  }

  function closeFocused() {
    var instance = focused();
    if (instance) close(instance.id);
    return !!instance;
  }

  function toggleFloatFocused() {
    var instance = focused();
    if (!instance) return false;
    setMode(instance.id, instance.mode === 'float' ? 'dock' : 'float');
    return true;
  }

  function toggleMaxFocused() {
    var instance = focused();
    if (!instance) return false;
    setMode(instance.id, instance.mode === 'max' ? (instance.previousMode || 'dock') : 'max');
    return true;
  }

  function list() {
    return instances.filter(isHere).map(function (i) {
      return { id: i.id, kind: i.kind, title: i.title, subtitle: i.subtitle, mode: i.mode };
    });
  }

  if (typeof window !== 'undefined') {
    var resizeTimer = null;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(render, 80);
    });
    window.addEventListener('terminal-target-server', function () { render(); });
    window.addEventListener('hashchange', function () { setTimeout(render, 0); });
    if (sidebar()) {
      sidebar().onChange(onSidebarChange);
      sidebar().onWindowChange(render);
      sidebar().onWindowsGone(forgetWindows);
    }
  }

  return {
    register: register,
    open: open,
    close: close,
    activate: activate,
    setMode: setMode,
    render: render,
    list: list,
    closeFocused: closeFocused,
    toggleFloatFocused: toggleFloatFocused,
    toggleMaxFocused: toggleMaxFocused,
    _test: { clampGeom: clampGeom, keyOf: keyOf, instances: function () { return instances; } },
  };
})();

if (typeof window !== 'undefined') window.BlockHost = BlockHost;
