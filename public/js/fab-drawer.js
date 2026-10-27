/* Scene-aware terminal tool drawer. Depends on FabScene and FabHeat. */
(function (global) {
  'use strict';

  /**
   * Minimal virtual-DOM helper: creates a DOM element with attrs and children.
   * Supports: class, style (object), onXxx (event listeners), html (innerHTML),
   * and any other attribute via setAttribute.
   */
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    attrs = attrs || {};
    if (tag === 'button' && !attrs.type) el.type = 'button';
    children = children || [];
    var keys = Object.keys(attrs);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var v = attrs[k];
      if (k === 'class') {
        el.className = v;
      } else if (k.length > 2 && k.slice(0, 2) === 'on' && typeof v === 'function') {
        el.addEventListener(k.slice(2), v);
      } else if (k === 'html') {
        el.innerHTML = v;
      } else if (k === 'style' && typeof v === 'object') {
        var styleKeys = Object.keys(v);
        for (var j = 0; j < styleKeys.length; j++) {
          el.style[styleKeys[j]] = v[styleKeys[j]];
        }
      } else {
        el.setAttribute(k, v);
      }
    }
    for (var ci = 0; ci < children.length; ci++) {
      var c = children[ci];
      if (c == null) continue;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }

  /**
   * mount(container, options) — renders the drawer into `container`.
   *
   * options:
   *   sendKey(str)  — called when a key button is tapped
   *   onKeyboard()  — called when the keyboard icon button is tapped
   *   onClose()     — called when the ✕ button or backdrop is tapped
   *
   * Returns an api object:
   *   setScene(sceneId)  — externally switch the active scene (triggers flash)
   *   getState()         — returns current mutable state snapshot
   *   rerender()         — force a full re-render
   */
  function mount(container, options) {
    options = options || {};

    seedBuiltinFallbackHeat();
    runDiscoveryIfNeeded();

    var state = {
      currentScene: 'terminal',
      currentTab: 0,
      scenes: global.FabScene ? global.FabScene.loadScenes() : [],
      sendKey: options.sendKey || function () {},
      overrideMenuOpen: false,
    };

    var repeatCleanups = [];
    var formOverlays = [];
    function stopRepeats() {
      repeatCleanups.forEach(function (stop) { stop(); });
      repeatCleanups = [];
    }

    /* ── DOM skeleton ─────────────────────────────────────────────── */
    var drawerEl = h('div', { class: 'fab-drawer', role: 'region', 'aria-label': '终端工具台' });
    var headerEl = h('div', { class: 'fab-drawer-header' });
    var overrideEl = h('div', { class: 'fab-override-menu' });
    var tabbarEl = h('div', { class: 'fab-drawer-tabbar', role: 'group', 'aria-label': '快捷操作分类' });
    var bodyEl = h('div', { class: 'fab-drawer-body' });

    drawerEl.appendChild(overrideEl);
    drawerEl.appendChild(headerEl);
    drawerEl.appendChild(tabbarEl);
    drawerEl.appendChild(bodyEl);
    container.appendChild(drawerEl);

    /* ── Helpers ──────────────────────────────────────────────────── */

    function getScene() {
      var scenes = state.scenes;
      for (var i = 0; i < scenes.length; i++) {
        if (scenes[i].id === state.currentScene) return scenes[i];
      }
      return scenes[0] || null;
    }

    /* ── Scene badge ──────────────────────────────────────────────── */

    function renderBadge() {
      var s = getScene();
      if (!s) return h('span');
      var badge = h('button', {
        class: 'scene-inline',
        'aria-label': '切换工具场景，当前' + s.name,
        'aria-expanded': state.overrideMenuOpen ? 'true' : 'false',
        onclick: function () {
          state.overrideMenuOpen = !state.overrideMenuOpen;
          renderOverride();
        },
      }, [
        h('span', { class: 'dot', 'aria-hidden': 'true' }),
        h('span', { class: 'scene-name' }, [s.name]),
        h('span', { class: 'scene-chevron', 'aria-hidden': 'true', html: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="m5 6 3 3 3-3"/></svg>' }),
      ]);
      return badge;
    }

    /* ── Tab bar ──────────────────────────────────────────────────── */

    function renderTabbar() {
      tabbarEl.innerHTML = '';
      headerEl.innerHTML = '';
      headerEl.appendChild(h('div', { class: 'fab-drawer-heading' }, [
        h('strong', {}, ['终端工具']), renderBadge(),
      ]));

      var s = getScene();
      if (s && s.tabs) {
        s.tabs.forEach(function (t, i) {
          var btn = h('button', {
            class: i === state.currentTab ? 'fab-drawer-tab active' : 'fab-drawer-tab',
            'aria-pressed': i === state.currentTab ? 'true' : 'false',
            onclick: function () {
              var restoreFocus = document.activeElement === btn;
              state.currentTab = i;
              renderBody();
              renderTabbar();
              if (restoreFocus) tabbarEl.children[i].focus({ preventScroll: true });
            },
          }, [t.name]);
          tabbarEl.appendChild(btn);
        });
      }

      // Keyboard switch button
      headerEl.appendChild(h('button', {
        class: 'fab-drawer-kbd-btn',
        'aria-label': '切换到键盘输入',
        html: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="2.5" y="5" width="19" height="14" rx="3"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 15h10"/></svg>',
        onclick: function () {
          if (options.onKeyboard) options.onKeyboard();
        },
      }));

      // Close button
      headerEl.appendChild(h('button', {
        class: 'fab-drawer-close',
        'aria-label': '收起终端工具',
        html: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="m6 6 12 12M6 18 18 6"/></svg>',
        onclick: function () {
          if (options.onClose) options.onClose();
        },
      }));
    }

    /* ── Override (scene picker) menu ─────────────────────────────── */

    function renderOverride() {
      overrideEl.innerHTML = '';
      var badge = headerEl.querySelector('.scene-inline');
      if (badge) badge.setAttribute('aria-expanded', state.overrideMenuOpen ? 'true' : 'false');
      if (!state.overrideMenuOpen) {
        overrideEl.classList.remove('show');
        return;
      }
      overrideEl.classList.add('show');

      overrideEl.appendChild(h('div', { class: 'mtitle' }, ['手动切换场景（误判兜底）']));

      state.scenes.forEach(function (s) {
        var isCurrent = s.id === state.currentScene;
        overrideEl.appendChild(h('button', {
          class: 'mitem' + (isCurrent ? ' current' : ''),
          onclick: function () {
            state.currentScene = s.id;
            state.currentTab = 0;
            state.overrideMenuOpen = false;
            rerender();
          },
        }, [s.icon + ' ' + s.name + (isCurrent ? ' ● 当前' : '')]));
      });

      // Add scene entry point
      overrideEl.appendChild(h('button', {
        class: 'mitem add',
        onclick: function () {
          state.overrideMenuOpen = false;
          renderOverride();
          showSceneForm(null, function (def) {
            global.FabScene.addScene(def);
            state.scenes = global.FabScene.loadScenes();
            state.currentScene = def.id;
            state.currentTab = 0;
            rerender();
          });
        },
      }, ['＋ 添加新场景']));
    }

    // Close override menu when clicking outside
    function onOutsideClick(e) {
      if (!state.overrideMenuOpen) return;
      if (overrideEl.contains(e.target)) return;
      // Check if click was on the badge that toggles the menu
      var badge = headerEl.querySelector('.scene-inline');
      if (badge && badge.contains(e.target)) return;
      state.overrideMenuOpen = false;
      renderOverride();
    }
    document.addEventListener('click', onOutsideClick);

    /* ── Scene form (add / edit) ─────────────────────────────────── */

    function showSceneForm(existingScene, onSave) {
      var overlay = h('div', { class: 'fab-form-overlay show' });
      formOverlays.push(overlay);
      var modal = h('div', { class: 'fab-form-modal' });

      var nameInput = h('input', { type: 'text', value: existingScene ? existingScene.name : '', placeholder: '场景名称' });
      var iconInput = h('input', { type: 'text', value: existingScene ? existingScene.icon : '🔧', placeholder: '图标 (emoji)' });
      var detectInput = h('input', { type: 'text', value: existingScene ? (existingScene.detect || []).join(',') : '', placeholder: '进程名，逗号分隔 (如 python,ipython)' });

      var fixtureSel = h('select');
      var fixtureOpts = [
        { value: 'terminal-set', label: '终端套（方向+Tab+C-c）' },
        { value: 'vim-set', label: 'Vim 套（Esc+方向+:w）' },
        { value: 'claude-set', label: 'Claude 套（方向+Alt+T）' },
        { value: 'codex-set', label: 'Codex 套（方向+Tab+历史）' },
        { value: 'arrow-only', label: '纯方向键' },
        { value: 'none', label: '无' },
      ];
      fixtureOpts.forEach(function (opt) {
        fixtureSel.appendChild(h('option', { value: opt.value }, [opt.label]));
      });

      var inheritSel = h('select');
      var inheritOpts = [
        { value: 'terminal', label: '终端' },
        { value: 'claude', label: 'Claude' },
        { value: 'codex', label: 'Codex' },
        { value: 'vim', label: 'Vim' },
        { value: 'lazygit', label: 'Lazygit' },
        { value: 'empty', label: '空白' },
      ];
      inheritOpts.forEach(function (opt) {
        inheritSel.appendChild(h('option', { value: opt.value }, [opt.label]));
      });

      function close() {
        overlay.remove();
        formOverlays = formOverlays.filter(function (item) { return item !== overlay; });
      }

      var cancelBtn = h('button', { class: 'fab-form-btn cancel', onclick: close }, ['取消']);
      var saveBtn = h('button', { class: 'fab-form-btn save', onclick: function () {
        var name = nameInput.value.trim();
        if (!name) { nameInput.focus(); return; }
        var inheritedScene = global.FabScene.getBuiltinScenes().find(function (scene) {
          return scene.id === inheritSel.value;
        });
        var def = {
          id: existingScene ? existingScene.id : ('custom-' + Date.now()),
          name: name,
          icon: iconInput.value.trim() || '🔧',
          detect: detectInput.value.split(',').map(function(s) { return s.trim(); }).filter(Boolean),
          fixtures: getFixtureTemplate(fixtureSel.value),
          tabs: inheritedScene ? inheritedScene.tabs : [
            { key: 'common', name: '常用' },
            { key: 'keys', name: '按键' },
            { key: 'cmd', name: '命令' },
            { key: 'tpl', name: '模板' },
          ],
          defaultItems: getInheritedItems(inheritSel.value),
        };
        onSave(def);
        close();
      }}, ['保存']);

      modal.appendChild(h('h3', {}, [existingScene ? '编辑场景' : '添加场景']));
      modal.appendChild(h('label', {}, ['场景名']));
      modal.appendChild(nameInput);
      modal.appendChild(h('label', {}, ['图标']));
      modal.appendChild(iconInput);
      modal.appendChild(h('label', {}, ['识别进程名（逗号分隔）']));
      modal.appendChild(detectInput);
      modal.appendChild(h('label', {}, ['Fixture 模板']));
      modal.appendChild(fixtureSel);
      modal.appendChild(h('label', {}, ['继承布局自']));
      modal.appendChild(inheritSel);
      modal.appendChild(h('div', { class: 'fab-form-actions' }, [cancelBtn, saveBtn]));

      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      setTimeout(function () { nameInput.focus(); }, 100);
    }

    function getFixtureTemplate(kind) {
      var pad = { type: 'arrow-pad' };
      if (kind === 'terminal-set') return [pad, { id: 'tab', label: 'Tab', send: '\t' }, { id: 'c-c', label: 'C-c', send: '\x03', color: 'red' }];
      if (kind === 'vim-set') return [{ id: 'esc-big', label: 'Esc', send: '\x1b', color: 'red', size: 'wide' }, pad, { id: 'colon-w', label: ':w', send: ':w\r' }];
      if (kind === 'claude-set') return [pad, { id: 'alt-t', label: 'Alt+T', send: '\x1bt', color: 'orange' }, { id: 'c-o', label: 'Ctrl+O', send: '\x0f', color: 'orange' }];
      if (kind === 'codex-set') {
        var codex = global.FabScene.getBuiltinScenes().find(function (scene) { return scene.id === 'codex'; });
        return codex ? codex.fixtures : [pad];
      }
      if (kind === 'arrow-only') return [pad];
      return [];
    }

    function getInheritedItems(sourceId) {
      if (sourceId === 'empty') return { common: [], keys: [], cmd: [], tpl: [] };
      var builtins = global.FabScene ? global.FabScene.getBuiltinScenes() : [];
      for (var i = 0; i < builtins.length; i++) {
        if (builtins[i].id === sourceId) return JSON.parse(JSON.stringify(builtins[i].defaultItems));
      }
      return { common: [], keys: [], cmd: [], tpl: [] };
    }

    /* ── Body content ─────────────────────────────────────────────── */

    function renderSection(title, meta, contentEl) {
      var sec = h('div', { class: 'fab-section' });
      var lbl = h('div', {
        class: 'fab-section-label',
        html: '<span>' + title + '</span>' + (meta ? '<span class="meta">' + meta + '</span>' : ''),
      });
      sec.appendChild(lbl);
      sec.appendChild(contentEl);
      return sec;
    }

    function renderArrowPad() {
      var pad = h('div', { class: 'fab-arrow-pad' });
      var cells = [
        { label: 'Esc', name: 'Escape', send: '\x1b' }, { label: '↑', name: '向上', send: '\x1b[A' }, { label: '↵', name: '回车', send: '\r' },
        { label: '←', name: '向左', send: '\x1b[D' }, { label: '↓', name: '向下', send: '\x1b[B' }, { label: '→', name: '向右', send: '\x1b[C' },
      ];
      cells.forEach(function (c) {
        var b = h('button', {
          class: 'fab-drawer-btn',
          'aria-label': '发送' + c.name,
          onclick: function () {
            state.sendKey(c.send);
            if (navigator.vibrate) navigator.vibrate(10);
          },
        }, [c.label]);
        // Long press repeat for arrow keys
        if (c.label === '↑' || c.label === '↓' || c.label === '←' || c.label === '→') {
          var rTimer = null;
          var rInterval = null;
          b.addEventListener('touchstart', function (e) {
            e.stopPropagation();
            rTimer = setTimeout(function () {
              rInterval = setInterval(function () {
                state.sendKey(c.send);
                if (navigator.vibrate) navigator.vibrate(5);
              }, 80);
            }, 300);
          }, { passive: true });
          function stopRepeat() {
            clearTimeout(rTimer);
            clearInterval(rInterval);
          }
          repeatCleanups.push(stopRepeat);
          b.addEventListener('touchend', stopRepeat);
          b.addEventListener('touchcancel', stopRepeat);
        }
        pad.appendChild(b);
      });
      return pad;
    }

    function renderFixtureItem(f) {
      var cls = 'fab-drawer-btn';
      if (f.color) cls += ' ' + f.color;
      if (f.size === 'wide') cls += ' fab-fixture-wide';
      var b = h('button', {
        class: cls,
        onclick: function () {
          if (f.send != null) {
            state.sendKey(f.send);
            if (navigator.vibrate) navigator.vibrate(10);
          }
          if (f.id && global.FabHeat) global.FabHeat.touch(state.currentScene, f.id);
        },
      }, [f.label]);
      return b;
    }

    function renderHeatBtn(item) {
      var scoreVal = global.FabHeat ? global.FabHeat.score(state.currentScene, item.id) : 0;
      var b = h('button', {
        class: 'fab-drawer-btn',
        onclick: function () {
          state.sendKey(item.send);
          if (navigator.vibrate) navigator.vibrate(10);
          if (global.FabHeat) global.FabHeat.touch(state.currentScene, item.id);
        },
      }, [item.label]);
      if (scoreVal >= 1) {
        var badgeCls = 'fab-heat-badge' + (scoreVal < 5 ? ' dim' : '');
        b.appendChild(h('span', { class: badgeCls }, [String(Math.round(scoreVal))]));
      }
      return b;
    }

    function getAllItems(scene) {
      var all = [];
      var seen = {};
      var tabKeys = Object.keys(scene.defaultItems || {});
      for (var i = 0; i < tabKeys.length; i++) {
        var items = scene.defaultItems[tabKeys[i]] || [];
        for (var j = 0; j < items.length; j++) {
          if (!seen[items[j].id]) {
            seen[items[j].id] = true;
            all.push(items[j]);
          }
        }
      }
      return all;
    }

    function renderCommonTab(scene) {
      var frag = document.createDocumentFragment();

      // --- Fixture block ---
      var fxWrap = h('div', { class: 'fab-fixture-wrap' });
      var fxGrid = h('div', { class: 'fab-drawer-grid' });
      var hasArrow = false;
      scene.fixtures.forEach(function (f) {
        if (f.type === 'arrow-pad') {
          if (!hasArrow) { fxWrap.appendChild(renderArrowPad()); hasArrow = true; }
        } else {
          fxGrid.appendChild(renderFixtureItem(f));
        }
      });
      if (fxGrid.children.length > 0) fxWrap.appendChild(fxGrid);
      frag.appendChild(renderSection('快捷按键', '', fxWrap));

      // --- Heat Top 8 ---
      var fixtureIds = {};
      scene.fixtures.forEach(function (f) { if (f.id) fixtureIds[f.id] = true; });
      var allItems = getAllItems(scene).filter(function (it) { return !fixtureIds[it.id]; });
      var top8 = global.FabHeat
        ? global.FabHeat.topN(state.currentScene, allItems, 8)
        : allItems.slice(0, 8);

      var heatGrid = h('div', { class: 'fab-drawer-grid' });
      top8.forEach(function (item) { heatGrid.appendChild(renderHeatBtn(item)); });
      frag.appendChild(renderSection('常用操作', '按使用频率排序', heatGrid));

      return frag;
    }

    function showAddItemForm(sceneId, tabKey, onDone) {
      var overlay = h('div', { class: 'fab-form-overlay show' });
      formOverlays.push(overlay);
      var modal = h('div', { class: 'fab-form-modal' });
      var labelInput = h('input', { type: 'text', placeholder: '显示名称（如 /pua:p9）' });
      var sendInput = h('input', { type: 'text', placeholder: '发送内容（留空则同名称+回车）' });
      var hint = h('div', { style: { fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' } },
        ['\\x03=C-c  \\x1b=Esc  \\r=回车  或任意文本']);

      function close() {
        overlay.remove();
        formOverlays = formOverlays.filter(function (item) { return item !== overlay; });
      }
      function parseEsc(s) {
        return s.replace(/\\x([0-9a-fA-F]{2})/g, function (_, hex) {
          return String.fromCharCode(parseInt(hex, 16));
        }).replace(/\\r/g, '\r').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
      }

      var cancelBtn = h('button', { class: 'fab-form-btn cancel', onclick: close }, ['取消']);
      var saveBtn = h('button', { class: 'fab-form-btn save', onclick: function () {
        var label = labelInput.value.trim();
        if (!label) { labelInput.focus(); return; }
        var send = sendInput.value.trim();
        if (!send) send = label + '\r';
        else send = parseEsc(send);
        var id = 'user-' + Date.now() + '-' + label.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10);
        addItemToScene(sceneId, tabKey, { id: id, label: label, send: send });
        close();
        if (onDone) onDone();
      }}, ['保存']);

      modal.appendChild(h('h3', {}, ['添加快捷项']));
      modal.appendChild(h('label', {}, ['显示名称']));
      modal.appendChild(labelInput);
      modal.appendChild(h('label', {}, ['发送内容']));
      modal.appendChild(sendInput);
      modal.appendChild(hint);
      modal.appendChild(h('div', { class: 'fab-form-actions' }, [cancelBtn, saveBtn]));
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      setTimeout(function () { labelInput.focus(); }, 100);
    }

    function addItemToScene(sceneId, tabKey, item) {
      // Persist into custom scene override
      var customs = [];
      try { var raw = localStorage.getItem('fab-scenes-v1'); if (raw) customs = JSON.parse(raw); } catch (_e) {}
      var target = null;
      for (var i = 0; i < customs.length; i++) {
        if (customs[i].id === sceneId) { target = customs[i]; break; }
      }
      if (!target) {
        // Clone builtin to make it customizable
        var builtins = global.FabScene.getBuiltinScenes();
        for (var bi = 0; bi < builtins.length; bi++) {
          if (builtins[bi].id === sceneId) { target = JSON.parse(JSON.stringify(builtins[bi])); break; }
        }
        if (!target) return;
        target.builtin = false;
        customs.push(target);
      }
      if (!target.defaultItems) target.defaultItems = {};
      if (!target.defaultItems[tabKey]) target.defaultItems[tabKey] = [];
      target.defaultItems[tabKey].push(item);
      localStorage.setItem('fab-scenes-v1', JSON.stringify(customs));
      // Seed initial heat
      if (global.FabHeat) global.FabHeat.seedHeat(sceneId, item.id, 10);
      // Refresh scenes in state
      state.scenes = global.FabScene.loadScenes();
    }

    function removeItemFromScene(sceneId, tabKey, itemId) {
      var customs = [];
      try { var raw = localStorage.getItem('fab-scenes-v1'); if (raw) customs = JSON.parse(raw); } catch (_e) {}
      var target = null;
      for (var i = 0; i < customs.length; i++) {
        if (customs[i].id === sceneId) { target = customs[i]; break; }
      }
      if (!target) return;
      if (!target.defaultItems || !target.defaultItems[tabKey]) return;
      target.defaultItems[tabKey] = target.defaultItems[tabKey].filter(function (it) { return it.id !== itemId; });
      localStorage.setItem('fab-scenes-v1', JSON.stringify(customs));
      state.scenes = global.FabScene.loadScenes();
    }

    function renderOtherTab(scene, tabKey) {
      var items = (scene.defaultItems && scene.defaultItems[tabKey]) || [];
      // Sort by heat
      if (global.FabHeat) {
        items = global.FabHeat.topN(state.currentScene, items, items.length);
      }
      var grid = h('div', { class: 'fab-drawer-grid' });
      items.forEach(function (item) {
        var btn = renderHeatBtn(item);
        // Long press to delete
        var lpTimer = null, lpFired = false;
        btn.addEventListener('touchstart', function () {
          lpFired = false;
          lpTimer = setTimeout(function () {
            lpFired = true;
            if (navigator.vibrate) navigator.vibrate(30);
            if (confirm('删除「' + item.label + '」？')) {
              removeItemFromScene(state.currentScene, tabKey, item.id);
              rerender();
            }
          }, 600);
        }, { passive: true });
        btn.addEventListener('touchend', function (e) {
          clearTimeout(lpTimer);
          if (lpFired) { e.preventDefault(); e.stopPropagation(); }
        });
        btn.addEventListener('contextmenu', function (e) {
          e.preventDefault();
          if (confirm('删除「' + item.label + '」？')) {
            removeItemFromScene(state.currentScene, tabKey, item.id);
            rerender();
          }
        });
        grid.appendChild(btn);
      });

      // Add button
      var addBtn = h('button', { class: 'fab-drawer-btn fab-add-btn', onclick: function () {
        showAddItemForm(state.currentScene, tabKey, function () { rerender(); });
      }}, ['+']);
      grid.appendChild(addBtn);

      var tabLabel = tabKey;
      var s = getScene();
      if (s) {
        for (var i = 0; i < s.tabs.length; i++) {
          if (s.tabs[i].key === tabKey) { tabLabel = s.tabs[i].name; break; }
        }
      }
      return renderSection(tabLabel, null, grid);
    }

    function renderBody() {
      stopRepeats();
      bodyEl.innerHTML = '';
      var scene = getScene();
      if (!scene) return;
      var tab = scene.tabs[state.currentTab];
      if (!tab) return;

      if (tab.key === 'common') {
        bodyEl.appendChild(renderCommonTab(scene));
      } else {
        bodyEl.appendChild(renderOtherTab(scene, tab.key));
      }
    }

    /* ── Full re-render ───────────────────────────────────────────── */

    function rerender() {
      renderTabbar();
      renderOverride();
      renderBody();
    }

    /* ── Public API ───────────────────────────────────────────────── */

    /**
     * setScene(sceneId) — switch to a different scene and flash the badge.
     * Called from Task 14's WebSocket pane-cmd handler.
     */
    function setScene(sceneId) {
      if (state.currentScene === sceneId) return;
      state.currentScene = sceneId;
      state.currentTab = 0;
      rerender();
      var badge = headerEl.querySelector('.scene-inline');
      if (badge) {
        badge.classList.remove('flash');
        void badge.offsetWidth;
        badge.classList.add('flash');
      }
    }

    // Initial render
    rerender();

    var api = {
      setScene: setScene,
      getState: function () { return state; },
      rerender: rerender,
      destroy: function () {
        stopRepeats();
        formOverlays.forEach(function (overlay) { overlay.remove(); });
        formOverlays = [];
        document.removeEventListener('click', onOutsideClick);
        drawerEl.remove();
        if (global._fabDrawerInstance === api) global._fabDrawerInstance = null;
      },
    };
    global._fabDrawerInstance = api;
    return api;
  }

  /* ── First-run discovery + baseline heat seeding ─────────────── */

  var DISCOVER_MARK_KEY = 'fab-discover-v1';

  function runDiscoveryIfNeeded() {
    if (localStorage.getItem(DISCOVER_MARK_KEY)) return;
    var xhr = new XMLHttpRequest();
    xhr.open('GET', Api.activeUrl('/api/scene/discover'), true);
    xhr.onload = function () {
      if (xhr.status !== 200) return;
      try {
        var data = JSON.parse(xhr.responseText);
        applyDiscovery(data);
        localStorage.setItem(DISCOVER_MARK_KEY, JSON.stringify({ at: Date.now() }));
      } catch (_e) { /* silent */ }
    };
    xhr.onerror = function () { /* silent */ };
    xhr.send();
  }

  function applyDiscovery(data) {
    // Terminal — top full commands become heat seeds
    var termCmds = (data.terminal && data.terminal.topFullCommands) || [];
    termCmds.slice(0, 8).forEach(function (entry, rank) {
      var id = 'disc-' + slugify(entry.command);
      if (global.FabHeat) global.FabHeat.seedHeat('terminal', id, Math.max(8, 20 - rank * 1.5));
    });

    // Claude — slash commands
    var claudeCmds = (data.claude && data.claude.slashCommands) || [];
    claudeCmds.slice(0, 8).forEach(function (cmd, rank) {
      var id = 'disc-' + slugify(cmd.id);
      if (global.FabHeat) global.FabHeat.seedHeat('claude', id, Math.max(8, 20 - rank * 1.5));
    });

    // Vim — custom keymaps
    var vimKeys = (data.vim && data.vim.customKeymaps) || [];
    vimKeys.slice(0, 8).forEach(function (k, rank) {
      var id = 'disc-' + slugify(k.key);
      if (global.FabHeat) global.FabHeat.seedHeat('vim', id, Math.max(8, 20 - rank * 1.5));
    });
    // Lazygit — user is typically default; skip injection
  }

  function slugify(s) {
    return String(s).replace(/[^a-zA-Z0-9]/g, '-').slice(0, 24);
  }

  function seedBuiltinFallbackHeat() {
    var seededKey = 'fab-builtin-seeded-v1';
    if (localStorage.getItem(seededKey)) return;
    if (!global.FabScene || !global.FabHeat) return;
    var scenes = global.FabScene.getBuiltinScenes();
    scenes.forEach(function (scene) {
      var tabKeys = Object.keys(scene.defaultItems || {});
      for (var i = 0; i < tabKeys.length; i++) {
        var items = scene.defaultItems[tabKeys[i]] || [];
        items.forEach(function (item) {
          global.FabHeat.seedHeat(scene.id, item.id, 10);
        });
      }
    });
    localStorage.setItem(seededKey, '1');
  }

  global.FabDrawer = { mount: mount };

})(typeof window !== 'undefined' ? window : globalThis);
