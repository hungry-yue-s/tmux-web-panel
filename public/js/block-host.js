/* global Api */

// BlockHost: where tool blocks (git, browser…) live next to the terminal.
//
// A block is docked as a tab in a right-hand column, floats as a window over
// the workstage, or is maximized over it. Phones and narrow windows show it
// as a full-screen sheet. Every block belongs to one server: switching
// servers swaps the set of blocks, and each server remembers its own
// blocks, modes, sizes and positions across reloads.
//
// File blocks (SQLite, notebooks, boards) stay in the file preview, which has
// its own docked tabs keyed by path.

var BlockHost = (function () {
  'use strict';

  var STORAGE_PREFIX = 'twp_blocks_v1:';
  var DOCK_MIN = 360;
  var FLOAT_MIN_W = 360;
  var FLOAT_MIN_H = 240;
  var COMPACT_WIDTH = 900;

  var kinds = {};
  var instances = [];
  var nextId = 1;
  var zTop = 30;
  var dock = null;
  var dockState = {}; // serverId -> { active, width }
  var restoredServers = {};
  var focusedId = null;

  // --- small DOM helpers (shared look with blocks.js) ---------------------

  var ICON_PATHS = {
    dock: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M14 4v16"/>',
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

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  // --- persistence -----------------------------------------------------------

  function storageKey(serverId) { return STORAGE_PREFIX + encodeURIComponent(serverId); }

  function persist(serverId) {
    var own = instances.filter(function (i) { return i.serverId === serverId && kinds[i.kind] && kinds[i.kind].persist !== false; });
    var state = dockState[serverId] || {};
    var active = own.find(function (i) { return i.id === state.active; });
    var data = {
      version: 1,
      blocks: own.slice(0, 12).map(function (i) {
        return { kind: i.kind, params: i.params, mode: i.mode, geom: i.geom || null };
      }),
      active: active ? own.indexOf(active) : -1,
      width: state.width || 0,
    };
    try {
      if (own.length || data.width) window.localStorage.setItem(storageKey(serverId), JSON.stringify(data));
      else window.localStorage.removeItem(storageKey(serverId));
    } catch (_) { /* private mode */ }
  }

  function restore(serverId) {
    if (restoredServers[serverId]) return;
    restoredServers[serverId] = true;
    var raw = null;
    try { raw = window.localStorage.getItem(storageKey(serverId)); } catch (_) { return; }
    if (!raw) return;
    var data;
    try { data = JSON.parse(raw); } catch (_) { return; }
    if (!data || data.version !== 1 || !Array.isArray(data.blocks)) return;
    dockState[serverId] = { active: null, width: Number(data.width) || 0 };
    var created = [];
    data.blocks.forEach(function (saved) {
      if (!saved || !kinds[saved.kind]) return;
      var mode = saved.mode === 'float' || saved.mode === 'max' ? saved.mode : 'dock';
      var instance = create(saved.kind, saved.params || {}, { mode: mode, serverId: serverId, geom: saved.geom, quiet: true });
      if (instance) created.push(instance);
    });
    var active = created[data.active];
    if (active) dockState[serverId].active = active.id;
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
      url: function (path) { return window.Api ? Api.nodeUrl(serverId, path) : path; },
      setTitle: function (title) { instance.title = title || definition.title; syncTitle(instance); },
      setSubtitle: function (subtitle) { instance.subtitle = subtitle || ''; syncTitle(instance); },
      setParams: function (next) { instance.params = Object.assign({}, instance.params, next || {}); instance.key = keyOf(kind, instance.params); persist(serverId); },
      setBusy: function (busy) { instance.busy = !!busy; instance.frame.classList.toggle('is-busy', instance.busy); renderTabs(); },
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
    renderTabs();
  }

  function renderActions(instance) {
    var actions = instance.actionsEl;
    actions.replaceChildren();
    var mode = effectiveMode(instance);
    if (mode === 'sheet') {
      actions.appendChild(iconButton('close', '关闭', function () { close(instance.id); }, 'blk-frame-close'));
      return;
    }
    if (mode !== 'dock') actions.appendChild(iconButton('dock', '停靠到右侧', function () { setMode(instance.id, 'dock'); }));
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
    var floats = instances.filter(function (i) { return i.mode === 'float' && i.serverId === currentServer(); }).length;
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
        persist(instance.serverId);
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
        persist(instance.serverId);
      }
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
  }

  // --- dock ------------------------------------------------------------------

  function ensureDock() {
    if (dock) return dock;
    var root = el('aside', 'blk-dock');
    root.setAttribute('aria-label', '工具区');
    var grip = el('div', 'blk-dock-resizer');
    grip.setAttribute('role', 'separator');
    grip.setAttribute('aria-orientation', 'vertical');
    grip.setAttribute('aria-label', '调整工具区宽度');
    grip.tabIndex = 0;
    var bar = el('div', 'blk-dock-bar');
    var tabs = el('div', 'blk-dock-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', '工具标签');
    var actions = el('div', 'blk-dock-actions');
    bar.append(tabs, actions);
    var panels = el('div', 'blk-dock-panels');
    root.append(grip, bar, panels);
    dock = { root: root, tabs: tabs, actions: actions, panels: panels, grip: grip };

    function setWidth(width) {
      var bounds = dockBounds();
      var next = Math.round(Math.max(bounds.min, Math.min(bounds.max, width || bounds.preferred)));
      root.style.width = next + 'px';
      var sid = currentServer();
      dockState[sid] = dockState[sid] || {};
      dockState[sid].width = next;
      grip.setAttribute('aria-valuenow', String(next));
      return next;
    }
    dock.setWidth = setWidth;
    grip.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      var startX = e.clientX;
      var startW = root.getBoundingClientRect().width;
      document.body.classList.add('blk-resizing');
      function move(ev) { setWidth(startW + startX - ev.clientX); }
      function up() {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        document.body.classList.remove('blk-resizing');
        persist(currentServer());
      }
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
    grip.addEventListener('keydown', function (e) {
      var width = root.getBoundingClientRect().width;
      var step = e.shiftKey ? 60 : 20;
      if (e.key === 'ArrowLeft') width += step;
      else if (e.key === 'ArrowRight') width -= step;
      else return;
      e.preventDefault();
      setWidth(width);
      persist(currentServer());
    });
    return dock;
  }

  function dockBounds() {
    var main = layout();
    var width = main ? main.getBoundingClientRect().width : window.innerWidth;
    var max = Math.max(DOCK_MIN, Math.floor(width * 0.65));
    return { min: DOCK_MIN, max: max, preferred: Math.min(max, Math.max(DOCK_MIN, Math.round(width * 0.42))) };
  }

  function renderTabs() {
    if (!dock) return;
    var sid = currentServer();
    var docked = instances.filter(function (i) { return i.serverId === sid && effectiveMode(i) === 'dock'; });
    var state = dockState[sid] || {};
    var focusTab = document.activeElement && document.activeElement.closest && document.activeElement.closest('.blk-dock-tab');
    var focusedTabId = focusTab && focusTab.dataset.blockId;
    dock.tabs.replaceChildren();
    docked.forEach(function (instance) {
      var active = instance.id === state.active;
      var tab = el('div', 'blk-dock-tab' + (active ? ' is-active' : '') + (instance.busy ? ' is-busy' : ''));
      tab.dataset.blockId = instance.id;
      var select = el('button', 'blk-dock-tab-select');
      select.type = 'button';
      select.setAttribute('role', 'tab');
      select.setAttribute('aria-selected', String(active));
      select.tabIndex = active ? 0 : -1;
      select.title = instance.title + (instance.subtitle ? ' · ' + instance.subtitle : '');
      select.innerHTML = iconMarkup(kinds[instance.kind].icon || instance.kind);
      select.appendChild(el('span', 'blk-dock-tab-title', instance.title));
      select.addEventListener('click', function () { activate(instance.id); });
      select.addEventListener('dblclick', function () { setMode(instance.id, 'max'); });
      select.addEventListener('auxclick', function (e) { if (e.button === 1) close(instance.id); });
      select.addEventListener('keydown', function (e) {
        var index = docked.indexOf(instance);
        var next = null;
        if (e.key === 'ArrowRight') next = docked[(index + 1) % docked.length];
        else if (e.key === 'ArrowLeft') next = docked[(index + docked.length - 1) % docked.length];
        else if (e.key === 'Delete') { e.preventDefault(); close(instance.id); return; }
        if (!next) return;
        e.preventDefault();
        activate(next.id);
        var target = dock.tabs.querySelector('[data-block-id="' + next.id + '"] .blk-dock-tab-select');
        if (target) target.focus();
      });
      var closeBtn = iconButton('close', '关闭 ' + instance.title, function (e) { e.stopPropagation(); close(instance.id); }, 'blk-dock-tab-close');
      tab.append(select, closeBtn);
      dock.tabs.appendChild(tab);
    });
    if (focusedTabId) {
      var again = dock.tabs.querySelector('[data-block-id="' + focusedTabId + '"] .blk-dock-tab-select');
      if (again) again.focus();
    }
    dock.actions.replaceChildren();
    var activeInstance = docked.find(function (i) { return i.id === state.active; });
    if (activeInstance) {
      dock.actions.append(
        iconButton('float', '浮动窗口', function () { setMode(activeInstance.id, 'float'); }),
        iconButton('max', '最大化', function () { setMode(activeInstance.id, 'max'); })
      );
    }
  }

  // --- placement -------------------------------------------------------------

  function isVisible(instance) {
    return instance.serverId === currentServer() && instance.frame.isConnected && !instance.frame.hidden;
  }

  function render() {
    var sid = currentServer();
    restore(sid);
    var main = layout();
    var compact = isCompact();
    var docked = instances.filter(function (i) { return i.serverId === sid && effectiveMode(i) === 'dock'; });
    var state = dockState[sid] = dockState[sid] || { active: null, width: 0 };
    if (docked.length && !docked.some(function (i) { return i.id === state.active; })) {
      state.active = docked[docked.length - 1].id;
    }

    if (docked.length && main && !compact) {
      ensureDock();
      if (dock.root.parentNode !== main) main.appendChild(dock.root);
      main.classList.add('blk-has-dock');
      dock.setWidth(state.width);
    } else if (dock && dock.root.isConnected) {
      dock.root.remove();
      if (main) main.classList.remove('blk-has-dock');
    }

    instances.forEach(function (instance) {
      var frame = instance.frame;
      if (instance.serverId !== sid) {
        frame.hidden = true;
        instance.shown = false;
        return;
      }
      var mode = effectiveMode(instance);
      frame.classList.toggle('blk-mode-dock', mode === 'dock');
      frame.classList.toggle('blk-mode-float', mode === 'float');
      frame.classList.toggle('blk-mode-max', mode === 'max');
      frame.classList.toggle('blk-mode-sheet', mode === 'sheet');
      var target = mode === 'dock' ? dock && dock.panels : mode === 'sheet' ? document.body : main;
      if (!target) target = document.body;
      if (frame.parentNode !== target) target.appendChild(frame);
      frame.hidden = mode === 'dock' && instance.id !== state.active;
      if (mode === 'float') {
        applyGeom(instance);
        frame.style.zIndex = String(instance.z);
      } else {
        frame.style.left = frame.style.top = frame.style.width = frame.style.height = '';
        frame.style.zIndex = mode === 'max' ? '60' : '';
      }
      renderActions(instance);
      syncTitle(instance);
      if (instance.entering && !reducedMotion()) {
        frame.classList.add('is-entering');
        setTimeout(function () { frame.classList.remove('is-entering'); }, 220);
      }
      instance.entering = false;
      // onShow fires when a block comes back into view, not on every layout pass.
      var shown = !frame.hidden;
      if (shown && !instance.shown && instance.impl && typeof instance.impl.onShow === 'function') {
        try { instance.impl.onShow(); } catch (_) { /* a block's own refresh failing must not break the host */ }
      }
      instance.shown = shown;
    });
    renderTabs();
    document.body.classList.toggle('blk-sheet-open', instances.some(function (i) {
      return i.serverId === sid && effectiveMode(i) === 'sheet';
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
    restore(sid);
    var key = keyOf(kind, params);
    var existing = key && instances.find(function (i) { return i.serverId === sid && i.key === key; });
    if (existing) {
      if (options.mode && options.mode !== existing.mode) existing.mode = options.mode;
      if (existing.impl && typeof existing.impl.update === 'function') existing.impl.update(params || {});
      activate(existing.id);
      return existing.api;
    }
    var instance = create(kind, params || {}, { mode: options.mode || kinds[kind].defaultMode || 'dock', serverId: sid });
    if (!instance) return null;
    if (instance.mode === 'dock') {
      dockState[sid] = dockState[sid] || {};
      dockState[sid].active = instance.id;
    }
    render();
    persist(sid);
    setTimeout(function () { focusInstance(instance); }, 30);
    return instance.api;
  }

  function activate(id) {
    var instance = instances.find(function (i) { return i.id === id; });
    if (!instance) return;
    if (instance.mode === 'dock') {
      dockState[instance.serverId] = dockState[instance.serverId] || {};
      dockState[instance.serverId].active = id;
    }
    raise(instance);
    render();
    persist(instance.serverId);
    focusInstance(instance);
  }

  function setMode(id, mode) {
    var instance = instances.find(function (i) { return i.id === id; });
    if (!instance || instance.mode === mode) return;
    if (mode === 'max') instance.previousMode = instance.mode;
    if (mode === 'float' && !instance.geom) instance.geom = defaultGeom();
    instance.mode = mode;
    if (mode === 'dock') {
      dockState[instance.serverId] = dockState[instance.serverId] || {};
      dockState[instance.serverId].active = id;
    }
    instance.entering = true;
    raise(instance);
    render();
    persist(instance.serverId);
    focusInstance(instance);
  }

  function close(id) {
    var instance = instances.find(function (i) { return i.id === id; });
    if (!instance) return;
    if (instance.impl && typeof instance.impl.dispose === 'function') {
      try { instance.impl.dispose(); } catch (_) { /* best effort */ }
    }
    instance.frame.remove();
    instances = instances.filter(function (i) { return i !== instance; });
    var state = dockState[instance.serverId];
    if (state && state.active === id) state.active = null;
    if (focusedId === id) focusedId = null;
    render();
    persist(instance.serverId);
    // Typing returns to the terminal on desktop; phones would pop the keyboard.
    if (!isCompact()) {
      var terminal = document.querySelector('.terminal-view .xterm-helper-textarea');
      if (terminal) terminal.focus({ preventScroll: true });
    }
  }

  function focused() {
    var sid = currentServer();
    var instance = instances.find(function (i) { return i.id === focusedId && i.serverId === sid && isVisible(i); });
    if (instance) return instance;
    var state = dockState[sid] || {};
    return instances.find(function (i) { return i.id === state.active && i.serverId === sid; })
      || instances.filter(function (i) { return i.serverId === sid; }).pop() || null;
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
    var sid = currentServer();
    return instances.filter(function (i) { return i.serverId === sid; }).map(function (i) {
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
