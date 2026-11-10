/* global Api, Blocks, BlockHost, Router, Theme, AppShell, PanelSlots */

// The workspace's own commands and pickers: a new shell window, the theme
// picker with live preview, the hosts panel, the keyboard shortcut sheet,
// the block window commands, and the Alt+Shift shortcuts for every command
// any plugin registered (Blocks.registerCommand, blocks.js).

(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.Blocks || !window.BlockHost || !window.PanelSlots) return;

  var ui = Blocks.ui;
  var el = ui.el, button = ui.button, iconButton = ui.iconButton, icon = Blocks.icon;
  var toast = ui.toast, errorText = ui.errorText;

  // ===========================================================================
  // Overlay pickers: theme, hosts, shortcuts
  // ===========================================================================

  var _picker = null;

  function openPicker(options) {
    if (_picker) _picker.close();
    var previous = document.activeElement;
    var overlay = el('div', 'blk-picker-overlay');
    var box = el('div', 'blk-picker' + (options.className ? ' ' + options.className : ''));
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', options.title);
    var head = el('div', 'blk-picker-head');
    var mark = el('span', 'blk-picker-icon');
    mark.innerHTML = icon(options.icon);
    head.appendChild(mark);
    var input = null;
    if (options.filter) {
      input = el('input', 'blk-picker-input');
      input.placeholder = options.filter;
      input.setAttribute('aria-label', options.filter);
      input.spellcheck = false;
      input.autocomplete = 'off';
      head.appendChild(input);
    } else {
      head.appendChild(el('strong', 'blk-picker-title', options.title));
    }
    var esc = el('button', 'blk-picker-esc', 'esc');
    esc.type = 'button';
    esc.setAttribute('aria-label', '关闭');
    head.appendChild(esc);
    var body = el('div', 'blk-picker-body');
    var foot = el('div', 'blk-picker-foot');
    (options.hints || []).forEach(function (hint) {
      var item = el('span', 'blk-picker-hint');
      item.appendChild(ui.kbd(hint[0]));
      item.appendChild(document.createTextNode(hint[1]));
      foot.appendChild(item);
    });
    box.append(head, body, foot);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    var picker = {
      overlay: overlay, box: box, body: body, input: input,
      close: function (reason) {
        if (!overlay.isConnected) return;
        overlay.remove();
        _picker = null;
        if (options.onClose) options.onClose(reason || 'dismiss');
        if (previous && previous.focus && previous.isConnected) previous.focus({ preventScroll: true });
      },
    };
    esc.addEventListener('click', function () { picker.close('dismiss'); });
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) picker.close('dismiss'); });
    overlay.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); picker.close('dismiss'); return; }
      if (options.onKey) options.onKey(e);
    });
    _picker = picker;
    setTimeout(function () { (input || esc).focus(); }, 0);
    return picker;
  }

  /** Arrow/Enter navigation over `.blk-option` rows inside a picker body. */
  function listNavigation(picker, onActivate, onSelectChange) {
    var activeIndex = 0;
    function options() { return Array.prototype.slice.call(picker.body.querySelectorAll('.blk-option')); }
    function set(index, scroll) {
      var all = options();
      if (!all.length) return;
      activeIndex = (index + all.length) % all.length;
      all.forEach(function (n, i) {
        n.classList.toggle('is-active', i === activeIndex);
        n.setAttribute('aria-selected', String(i === activeIndex));
      });
      if (scroll !== false) all[activeIndex].scrollIntoView({ block: 'nearest' });
      if (onSelectChange) onSelectChange(all[activeIndex]);
    }
    return {
      set: set,
      index: function () { return activeIndex; },
      bind: function () {
        options().forEach(function (n, i) {
          n.addEventListener('mousemove', function () { if (i !== activeIndex) set(i, false); });
          n.addEventListener('click', function () { set(i, false); onActivate(n); });
        });
      },
      key: function (e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); set(activeIndex + 1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); set(activeIndex - 1); }
        else if (e.key === 'Enter' && !e.isComposing) {
          var all = options();
          if (all[activeIndex]) { e.preventDefault(); onActivate(all[activeIndex]); }
        }
      },
    };
  }

  // --- theme picker -------------------------------------------------------------

  function themePreview(theme) {
    var t = theme.terminal || {};
    var box = el('div', 'theme-preview');
    box.style.background = t.background;
    box.style.color = t.foreground;
    function line(parts) {
      var row = el('div', 'theme-preview-line');
      parts.forEach(function (part) {
        var span = el('span', '', part[0]);
        if (part[1]) span.style.color = t[part[1]] || part[1];
        if (part[2]) span.style.fontWeight = '600';
        row.appendChild(span);
      });
      box.appendChild(row);
    }
    line([['➜ ', 'green', true], ['~/work/stencil ', 'cyan', true], ['main ', 'magenta'], ['●3 ↑1', 'yellow']]);
    line([['$ ', 'brightBlack'], ['git status --short']]);
    line([[' M ', 'yellow'], ['src/terminal.ts']]);
    line([['?? ', 'red'], ['notes/plan.md']]);
    line([['$ ', 'brightBlack'], ['npm test']]);
    line([['✓ ', 'green'], ['42 passed ', 'green'], ['✗ ', 'red'], ['1 failed ', 'red'], ['(1.2s)', 'brightBlack']]);
    var cursor = el('span', 'theme-preview-cursor');
    cursor.style.background = t.cursor || t.foreground;
    var last = el('div', 'theme-preview-line');
    last.appendChild(el('span', '', '$ '));
    last.firstChild.style.color = t.brightBlack;
    last.appendChild(cursor);
    box.appendChild(last);
    var palette = el('div', 'theme-preview-palette');
    ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'].forEach(function (name) {
      var dot = el('i');
      dot.style.background = t[name];
      dot.title = name;
      palette.appendChild(dot);
    });
    box.appendChild(palette);
    return box;
  }

  function openThemePicker() {
    if (typeof Theme === 'undefined') return;
    var original = Theme.getCurrent();
    var themes = Theme.getThemeList();
    var committed = false;
    var previewing = original;
    var picker = openPicker({
      title: '主题', icon: 'theme', filter: '筛选主题…', className: 'theme-picker',
      hints: [['Up+Down', '预览'], ['Enter', '使用'], ['Escape', '恢复']],
      onClose: function () { if (!committed && previewing !== original) Theme.apply(original); },
      onKey: function (e) { nav.key(e); },
    });
    var layoutBox = el('div', 'theme-layout');
    var list = el('div', 'theme-list');
    list.setAttribute('role', 'listbox');
    var previewHost = el('div', 'theme-preview-host');
    layoutBox.append(list, previewHost);
    picker.body.appendChild(layoutBox);

    var nav = listNavigation(picker, function (node) {
      committed = true;
      Theme.apply(node.dataset.theme);
      picker.close('commit');
      toast('主题：' + node.dataset.name);
    }, function (node) {
      if (node.dataset.theme !== previewing) {
        previewing = node.dataset.theme;
        Theme.apply(previewing);
      }
      var theme = themes.find(function (t) { return t.id === node.dataset.theme; });
      previewHost.replaceChildren(themePreview(theme));
    });

    function draw() {
      var q = picker.input.value.trim().toLowerCase();
      list.replaceChildren();
      var groups = [['dark', '深色'], ['light', '浅色']];
      var activeId = previewing;
      var startIndex = 0, count = 0;
      groups.forEach(function (group) {
        var members = themes.filter(function (t) {
          return (t.colorScheme === 'light' ? 'light' : 'dark') === group[0]
            && (!q || (t.name + ' ' + t.id + ' ' + (t.description || '')).toLowerCase().indexOf(q) !== -1);
        });
        if (!members.length) return;
        list.appendChild(el('div', 'blk-menu-section', group[1]));
        members.forEach(function (theme) {
          var t = theme.terminal || {};
          var row = el('div', 'blk-option theme-option');
          row.setAttribute('role', 'option');
          row.dataset.theme = theme.id;
          row.dataset.name = theme.name;
          var aa = el('span', 'theme-aa', 'Aa');
          aa.style.background = t.background;
          aa.style.color = t.foreground;
          aa.style.borderColor = theme.colors && theme.colors['--border'] ? theme.colors['--border'] : 'transparent';
          var name = el('span', 'theme-name', theme.name);
          var dots = el('span', 'theme-dots');
          ['red', 'green', 'yellow', 'blue', 'magenta'].forEach(function (k) {
            var d = el('i');
            d.style.background = t[k];
            dots.appendChild(d);
          });
          row.append(aa, name, dots);
          if (theme.id === original) row.appendChild(el('span', 'theme-current', '当前'));
          if (theme.id === activeId) startIndex = count;
          count++;
          list.appendChild(row);
        });
      });
      if (!count) list.appendChild(el('div', 'blk-menu-empty', '没有匹配的主题'));
      nav.bind();
      if (count) nav.set(q ? 0 : startIndex);
    }
    picker.input.addEventListener('input', draw);
    draw();
  }

  // --- hosts panel ---------------------------------------------------------------

  function hostStatus(server, health, current) {
    var workspace = AppShell.workspace(server.id);
    var sessions = workspace && Array.isArray(workspace.sessions) ? workspace.sessions.length : null;
    var sessionText = sessions == null ? '' : sessions + ' 个会话';
    var latency = health.latencyMs != null ? health.latencyMs + 'ms' : '';
    var stateText;
    switch (health.state) {
      case 'online': stateText = server.kind === 'local' ? '本机' : '已连接'; break;
      case 'degraded': stateText = '连接不稳定'; break;
      case 'checking': stateText = '正在连接…'; break;
      case 'offline': stateText = '连接中断 · 自动重连中'; break;
      case 'auth_required': stateText = '认证失败'; break;
      case 'host_key_error': stateText = '主机指纹变化'; break;
      case 'disabled': stateText = '已停用'; break;
      default: stateText = server.kind === 'local' ? '本机' : '尚未检测';
    }
    return [stateText, sessionText, server.kind === 'local' ? '' : latency, current ? '当前' : ''].filter(Boolean).join(' · ');
  }

  function openHosts() {
    if (typeof AppShell === 'undefined') return;
    var currentId = Api.activeServerId();
    var picker = openPicker({
      title: '主机', icon: 'server', filter: '查找主机…', className: 'hosts-picker',
      hints: [['Up+Down', '选择'], ['Enter', '切换'], ['Escape', '关闭']],
      onKey: function (e) { nav.key(e); },
      onClose: function () { clearInterval(timer); },
    });
    var list = el('div', 'hosts-list');
    list.setAttribute('role', 'listbox');
    picker.body.appendChild(list);
    var nav = listNavigation(picker, function (node) {
      picker.close('commit');
      if (node.dataset.action === 'add') {
        if (window.MsApp && typeof window.MsApp.openAddServer === 'function') window.MsApp.openAddServer();
        else Router.go({ name: 'servers', params: {} });
        return;
      }
      var server = AppShell.server(node.dataset.server);
      var health = AppShell.health(node.dataset.server);
      var broken = ['offline', 'auth_required', 'host_key_error'].indexOf(health.state) !== -1;
      Router.go(broken
        ? { name: 'server', params: { serverId: server.id, section: 'connection' } }
        : { name: 'terminal', params: { serverId: server.id } });
    });
    var lastSignature = '';
    function draw(force) {
      var q = picker.input.value.trim().toLowerCase();
      var servers = AppShell.servers().filter(function (s) {
        return !q || (s.name + ' ' + s.id + ' ' + AppShell._addressOf(s)).toLowerCase().indexOf(q) !== -1;
      });
      var signature = q + '|' + servers.map(function (s) {
        var h = AppShell.health(s.id);
        return s.id + ':' + h.state + ':' + h.latencyMs + ':' + hostStatus(s, h, s.id === currentId);
      }).join(',');
      if (!force && signature === lastSignature) return;
      lastSignature = signature;
      var keep = nav.index();
      list.replaceChildren();
      servers.forEach(function (server) {
        var health = AppShell.health(server.id);
        var row = el('div', 'blk-option host-option' + (server.id === currentId ? ' is-current' : ''));
        row.setAttribute('role', 'option');
        row.dataset.server = server.id;
        var dot = el('span', 'host-dot is-' + (health.state || 'unknown'));
        var text = el('span', 'host-text');
        text.appendChild(el('strong', '', server.name || server.id));
        text.appendChild(el('span', 'host-address', AppShell._addressOf(server)));
        row.append(dot, text, el('span', 'host-status', hostStatus(server, health, server.id === currentId)));
        list.appendChild(row);
      });
      if (!servers.length) list.appendChild(el('div', 'blk-menu-empty', '没有匹配的主机'));
      var add = el('div', 'blk-option host-option host-add');
      add.dataset.action = 'add';
      add.setAttribute('role', 'option');
      var plus = el('span', 'host-dot is-add');
      plus.innerHTML = icon('plus');
      add.append(plus, el('span', 'host-text', '添加远程主机…'));
      list.appendChild(add);
      nav.bind();
      nav.set(force ? Math.max(0, servers.findIndex(function (s) { return s.id === currentId; })) : Math.min(keep, servers.length), false);
    }
    picker.input.addEventListener('input', function () { draw(true); nav.set(0); });
    draw(true);
    // Health changes arrive over the status socket; keep the list live while open.
    var timer = setInterval(function () { draw(false); }, 1000);
  }

  // --- keyboard shortcuts sheet ------------------------------------------------------

  function shortcutGroups() {
    return [
      ['导航', [
        ['Mod+K', '快速切换：窗口、命令、主机'],
        ['Alt+Shift+P', '快速打开文件'],
        ['Alt+Shift+H', '切换主机'],
        ['Alt+Shift+/', '键盘快捷键'],
      ]],
      ['Blocks', PanelSlots.commands.list().filter(function (c) { return c.group === 'block'; }).map(function (c) { return [c.keys, c.title]; })],
      ['窗口', [
        ['Alt+Shift+W', '关闭当前 block'],
        ['Alt+Shift+F', '浮动 / 停靠'],
        ['Alt+Shift+Enter', '最大化 / 还原'],
        ['Escape', '还原最大化的 block'],
      ]],
      ['终端', [
        ['Mod+L', '窗格布局'],
        ['Ctrl+Shift+O', '打开剪贴板里的路径'],
      ]],
      ['编辑与提交', [
        ['Mod+S', '保存文件'],
        ['Mod+Enter', '提交 / 执行 SQL'],
        ['Space', 'Git 列表里暂存或取消暂存'],
      ]],
    ];
  }

  function openShortcuts() {
    var picker = openPicker({ title: '键盘快捷键', icon: 'keyboard', className: 'shortcuts-picker', hints: [['Escape', '关闭']] });
    var grid = el('div', 'shortcuts-grid');
    shortcutGroups().forEach(function (group) {
      var section = el('section', 'shortcuts-group');
      section.appendChild(el('h4', '', group[0]));
      group[1].forEach(function (entry) {
        var row = el('div', 'shortcuts-row');
        row.append(el('span', '', entry[1]), ui.kbd(entry[0]));
        section.appendChild(row);
      });
      grid.appendChild(section);
    });
    picker.body.appendChild(grid);
    if (!ui.isMac) picker.body.appendChild(el('p', 'blk-muted shortcuts-note', 'Mod 在 macOS 上是 ⌘，其它系统上是 Ctrl。'));
  }

  function newShellWindow() {
    var ctx = ui.currentContext();
    if (!ctx.sessionId) { toast('先打开一个会话', { error: true }); return; }
    Api.post(Api.workspaceUrl(ctx.serverId, '/sessions/' + encodeURIComponent(ctx.sessionId) + '/windows'), {})
      .then(function (created) {
        if (created && created.id) Router.go({ name: 'terminal', params: { serverId: ctx.serverId, sessionId: ctx.sessionId, windowId: created.id } });
      })
      .catch(function (err) { toast(errorText(err), { error: true }); });
  }

  function hosts() {
    if (typeof AppShell === 'undefined') return [];
    var currentId = Api.activeServerId();
    return AppShell.servers().map(function (server) {
      var health = AppShell.health(server.id);
      return {
        display: server.name || server.id,
        meta: hostStatus(server, health, server.id === currentId),
        keywords: server.id + ' ' + AppShell._addressOf(server),
        icon: 'server', kind: '主机', state: health.state,
        run: function () {
          var broken = ['offline', 'auth_required', 'host_key_error'].indexOf(health.state) !== -1;
          Router.go(broken ? { name: 'server', params: { serverId: server.id, section: 'connection' } } : { name: 'terminal', params: { serverId: server.id } });
        },
      };
    });
  }

  PanelSlots.commands.register({ id: 'shell', order: 10, group: 'block', title: '新建 Shell 窗口', icon: 'terminal', keys: 'Alt+Shift+T', code: 'KeyT', run: newShellWindow, keywords: 'new window terminal shell 新窗口' });
  PanelSlots.commands.register({ id: 'hosts', order: 80, group: 'nav', title: '切换主机…', icon: 'server', keys: 'Alt+Shift+H', code: 'KeyH', run: openHosts, keywords: 'host server switch 服务器 主机 远程' });
  PanelSlots.commands.register({ id: 'theme', order: 90, group: 'block', title: '主题…', icon: 'theme', keys: 'Alt+Shift+Y', code: 'KeyY', run: openThemePicker, keywords: 'theme color 主题 配色 外观' });
  PanelSlots.commands.register({ id: 'shortcuts', order: 100, group: 'nav', title: '键盘快捷键', icon: 'keyboard', keys: 'Alt+Shift+/', code: 'Slash', run: openShortcuts, keywords: 'keyboard shortcuts help 快捷键 帮助' });
  PanelSlots.commands.register({ id: 'close-block', order: 110, group: 'window', title: '关闭当前 block', icon: 'close', keys: 'Alt+Shift+W', code: 'KeyW', run: function () { if (!BlockHost.closeFocused()) toast('没有打开的 block'); }, keywords: 'close block 关闭' });
  PanelSlots.commands.register({ id: 'float-block', order: 120, group: 'window', title: 'Block：浮动 / 停靠', icon: 'float', keys: 'Alt+Shift+F', code: 'KeyF', run: function () { if (!BlockHost.toggleFloatFocused()) toast('没有打开的 block'); }, keywords: 'float dock window 浮动 停靠' });
  PanelSlots.commands.register({ id: 'max-block', order: 130, group: 'window', title: 'Block：最大化 / 还原', icon: 'max', keys: 'Alt+Shift+Enter', code: 'Enter', run: function () { if (!BlockHost.toggleMaxFocused()) toast('没有打开的 block'); }, keywords: 'maximize zoom 最大化 全屏' });

  // Capture phase so the shortcut wins over xterm, which would send it to the shell.
  document.addEventListener('keydown', function (e) {
    if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey || e.isComposing) return;
    var command = PanelSlots.commands.list().find(function (c) { return c.code === e.code; });
    if (!command) return;
    e.preventDefault();
    e.stopPropagation();
    command.run();
  }, true);

  Blocks.hosts = hosts;
  Blocks.openThemePicker = openThemePicker;
  Blocks.openHosts = openHosts;
  Blocks.openShortcuts = openShortcuts;

  // --- boot ---
  function boot() {
    BlockHost.render();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else setTimeout(boot, 0);
})();
