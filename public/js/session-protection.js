/**
 * The "会话" page of a server: session protection, finding lost sessions, and
 * the tmux settings the panel needs. Everything it shows is about that one
 * machine and comes from its node (/n/:serverId/api/session-protection).
 */
(function (global) {
  var esc = function (value) { return global.AppShell.escape(value); };

  var state = { root: null, serverId: null, status: null, snapshots: null, busy: false, token: 0 };

  function api(path) {
    return global.Api.nodeUrl(state.serverId, '/api/session-protection' + (path || ''));
  }

  function clock(iso) {
    var date = new Date(iso);
    if (!Number.isFinite(date.getTime())) return '—';
    var pad = function (n) { return String(n).padStart(2, '0'); };
    var today = new Date();
    var sameDay = date.toDateString() === today.toDateString();
    return (sameDay ? '今天 ' : (date.getMonth() + 1) + '月' + date.getDate() + '日 ') + pad(date.getHours()) + ':' + pad(date.getMinutes());
  }

  function ago(iso) {
    var seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (!Number.isFinite(seconds)) return '';
    if (seconds < 60) return '刚刚';
    if (seconds < 3600) return Math.floor(seconds / 60) + ' 分钟前';
    if (seconds < 86400) return Math.floor(seconds / 3600) + ' 小时前';
    return Math.floor(seconds / 86400) + ' 天前';
  }

  function counts(entry) {
    return entry.sessions + ' 个会话 · ' + entry.windows + ' 个窗口';
  }

  function badge(text, tone) {
    return '<span class="ms-badge ' + tone + '">' + esc(text) + '</span>';
  }

  function button(label, action, extra, primary) {
    return '<button type="button" class="ms-btn' + (primary ? ' primary' : '') + '" data-sp="' + action + '"' + (extra || '') + '>' + esc(label) + '</button>';
  }

  // --- cards ---

  function protectionCard(s) {
    if (s.mode === 'unavailable') {
      return '<div class="ms-card sp-card"><div class="capability-head"><strong>会话保护</strong>' + badge('不可用', 'red') + '</div>'
        + '<p>这台机器上没有可用的 tmux，装好 tmux 后这里会自动可用。</p></div>';
    }
    var external = s.mode === 'external';
    var head = external ? badge('由你的 tmux 配置负责', 'muted')
      : !s.enabled ? badge('已关闭', 'yellow')
        : !s.tmux.running ? badge('等待 tmux 启动', 'yellow') : badge('已开启', 'green');
    var body = '';
    if (external) {
      body += s.external && s.external.continuum
        ? '<p>你在 ~/.tmux.conf 里配置了 tmux-continuum，自动保存和恢复由它负责，面板不重复做。</p>'
        : '<p>你在 ~/.tmux.conf 里加载了 tmux-resurrect，但没有自动保存：只有按 prefix + Ctrl-s 时才会保存。'
          + '去掉那段配置后，面板会接管：自动保存，并在 tmux 重新启动后自动恢复。</p>';
    } else {
      body += '<label class="sp-switch"><input type="checkbox" data-sp="enabled"' + (s.enabled ? ' checked' : '') + '>'
        + '<span><strong>自动保存会话，tmux 重新启动后自动恢复</strong>'
        + '<small>例如重启电脑之后。每 ' + esc(s.intervalMinutes) + ' 分钟保存一次窗口、窗格、所在目录和正在运行的程序；'
        + '没有会话时不保存，以免覆盖上一次的记录。</small></span></label>';
    }
    if (s.autoRestore) {
      body += '<div class="sp-notice ok">tmux 在 ' + esc(clock(s.tmux.startedAt || s.autoRestore.at)) + ' 重新启动，面板已自动恢复 '
        + esc(s.autoRestore.sessions) + ' 个会话' + (s.autoRestore.from ? '（来自 ' + esc(clock(s.autoRestore.from)) + ' 的保存）' : '') + '。</div>';
    } else if (!s.tmux.running && s.enabled && !external) {
      body += '<div class="sp-notice">tmux 现在没有运行。它启动后，面板会自动恢复上次保存的会话。</div>';
    }
    if (s.lastSave && !s.lastSave.ok) {
      body += '<div class="sp-notice error">' + esc(clock(s.lastSave.at)) + ' 的自动保存失败：' + esc(s.lastSave.error || '原因未知') + '</div>';
    }
    var saved = s.lastSave && s.lastSave.ok ? s.lastSave.at : s.latest && s.latest.at;
    var facts = saved
      ? '上次保存：' + esc(clock(saved)) + '（' + esc(ago(saved)) + '）' + (s.latest ? ' · ' + esc(counts(s.latest)) : '')
      : '还没有保存过';
    body += '<div class="sp-facts"><span>' + facts + '</span>'
      + (s.tmux.running ? button('立即保存', 'save') : '') + '</div>';
    return '<div class="ms-card sp-card"><div class="capability-head"><strong>会话保护</strong>' + head + '</div>' + body + '</div>';
  }

  function programsCard(s) {
    if (s.mode !== 'managed') return '';
    var rows = s.programs.map(function (choice) {
      return '<label class="sp-choice"><input type="checkbox" data-sp="program" value="' + esc(choice.id) + '"'
        + (choice.selected ? ' checked' : '') + '><span><strong>' + esc(choice.label) + '</strong>'
        + '<small>' + esc(choice.detail) + '</small></span></label>';
    }).join('');
    return '<div class="ms-card sp-card"><div class="capability-head"><strong>恢复时重新打开的程序</strong></div>'
      + '<p class="muted">没有勾选的程序不会重新运行，窗格回到 shell，停在原来的目录。窗格里出现过的其他程序也会列在这里，默认不重新运行。</p>'
      + '<div class="sp-choices">' + rows + '</div></div>';
  }

  function historyCard() {
    var list = state.snapshots;
    var body;
    if (!list) {
      body = '<p class="muted">正在读取保存记录…</p>';
    } else if (!list.length) {
      body = '<p class="muted">还没有保存记录。</p>';
    } else {
      body = list.slice(0, 20).map(function (snapshot, index) {
        var sessions = snapshot.list.map(function (session) {
          return '<li><div><strong>' + esc(session.name) + '</strong><small>' + esc(session.windows.filter(Boolean).join('、') || (session.windows.length + ' 个窗口'))
            + '</small></div>' + button('恢复这个会话', 'restore', ' data-id="' + esc(snapshot.id) + '" data-session="' + esc(session.name) + '"') + '</li>';
        }).join('');
        return '<details class="sp-snapshot"' + (index === 0 ? ' open' : '') + '><summary><span>' + esc(clock(snapshot.at)) + '</span>'
          + '<small>' + esc(counts(snapshot)) + '</small></summary><ul>' + sessions + '</ul></details>';
      }).join('');
    }
    return '<div class="ms-card sp-card"><div class="capability-head"><strong>找回会话</strong></div>'
      + '<p class="muted">内容有变化的每次保存都会留下一份，保留 30 天。恢复的会话作为新会话打开，不影响正在运行的会话；'
      + '名字已被占用时会加上“恢复”。</p>' + body + '</div>';
  }

  function baseCard(s) {
    var base = s.base;
    if (!base) return '';
    var needs = '<ul class="sp-needs"><li>开启鼠标：在网页里拖动选中复制、滚轮翻看输出</li>'
      + '<li>每个窗格保留 5 万行输出历史</li><li>没有会话时 tmux 也继续运行，重新启动后才能恢复会话</li></ul>';
    var head;
    var tail = '';
    if (base.packaged) {
      head = badge('已生效', 'green');
      tail = '<p class="muted">桌面客户端自带的 tmux 已经使用这些设置。</p>';
    } else if (base.linked) {
      head = badge('已生效', 'green');
      tail = '<p class="muted">由 ' + esc(base.userPath) + ' 末尾的一行引用加载。</p>';
    } else {
      head = badge('未生效', 'yellow');
      tail = '<p class="muted">会在 ' + esc(base.userPath) + ' 末尾加一行引用，你自己的设置保持不变；修改前会先备份。</p>'
        + button('写入 ' + (base.file || '.tmux.conf'), 'link-base', '', true);
    }
    if (base.extraLines) {
      tail += '<p class="muted">另外还包含你之前手写的 ' + esc(base.extraLines) + ' 行设置，仍然生效（' + esc(base.path) + '）。</p>';
    }
    return '<div class="ms-card sp-card"><div class="capability-head"><strong>面板需要的 tmux 设置</strong>' + head + '</div>'
      + needs + tail + '</div>';
  }

  function render() {
    var root = state.root;
    if (!root || !root.isConnected) return;
    var s = state.status;
    root.innerHTML = '<div class="sp-page">' + protectionCard(s) + programsCard(s)
      + (s.mode === 'unavailable' ? '' : historyCard()) + baseCard(s) + '</div>';
  }

  function renderError(error) {
    var root = state.root;
    if (!root || !root.isConnected) return;
    var message = error && error.status === 404
      ? '那台机器上的面板版本较旧，更新后可以使用会话保护。'
      : '读取失败：' + (error && error.message ? error.message : '未知错误');
    root.innerHTML = '<div class="ms-card sp-card"><p role="alert">' + esc(message) + '</p>' + button('重试', 'reload') + '</div>';
  }

  // --- data ---

  function load() {
    var token = ++state.token;
    return global.Api.get(api('')).then(function (status) {
      if (token !== state.token) return;
      state.status = status;
      render();
      if (status.mode === 'unavailable') return;
      return global.Api.get(api('/snapshots')).then(function (data) {
        if (token !== state.token) return;
        state.snapshots = data.snapshots || [];
        render();
      });
    }).catch(function (error) {
      if (token === state.token) renderError(error);
    });
  }

  function toast(text) {
    if (global.AppShell && global.AppShell.toast) global.AppShell.toast(text);
  }

  function failure(prefix, error) {
    toast(prefix + (error && error.message ? error.message : '未知错误'));
  }

  function run(target, work) {
    if (state.busy) return;
    state.busy = true;
    if (target) target.disabled = true;
    Promise.resolve().then(work).catch(function () {}).then(function () {
      state.busy = false;
      if (target && target.isConnected) target.disabled = false;
    });
  }

  function selectedPrograms() {
    return Array.prototype.map.call(state.root.querySelectorAll('[data-sp="program"]:checked'), function (input) { return input.value; });
  }

  function onChange(event) {
    var target = event.target;
    var kind = target && target.dataset ? target.dataset.sp : null;
    if (kind !== 'enabled' && kind !== 'program') return;
    var body = kind === 'enabled' ? { enabled: target.checked } : { programs: selectedPrograms() };
    run(null, function () {
      return global.Api.request('PUT', api(''), body).then(function (status) {
        state.status = status;
        render();
        toast(kind === 'enabled' ? (body.enabled ? '已开启会话保护' : '已关闭会话保护') : '已保存');
      }).catch(function (error) {
        failure('没有保存：', error);
        render();
      });
    });
  }

  function onClick(event) {
    var target = event.target.closest('[data-sp]');
    if (!target || target.disabled || target.tagName === 'INPUT') return;
    var action = target.dataset.sp;
    if (action === 'reload') { load(); return; }
    if (action === 'save') {
      run(target, function () {
        return global.Api.post(api('/save')).then(function (status) {
          state.status = status;
          toast('已保存');
          return load();
        }).catch(function (error) {
          if (error && error.code === 'VALIDATION_ERROR') toast('现在没有会话，保留上一次的保存');
          else failure('保存失败：', error);
        });
      });
    } else if (action === 'restore') {
      var session = target.dataset.session;
      run(target, function () {
        return global.Api.post(api('/snapshots/' + encodeURIComponent(target.dataset.id) + '/restore'), { session: session }).then(function (result) {
          toast('已恢复为会话“' + result.name + '”' + (result.programs ? '，并重新打开了 ' + result.programs + ' 个程序' : ''));
          if (global.MsApp && typeof global.MsApp.refreshWorkspace === 'function') global.MsApp.refreshWorkspace(state.serverId);
        }).catch(function (error) { failure('恢复失败：', error); });
      });
    } else if (action === 'link-base') {
      run(target, function () {
        return global.Api.post(api('/base/link')).then(function (status) {
          state.status = status;
          render();
          toast('已写入，tmux 设置已生效');
        }).catch(function (error) { failure('写入失败：', error); });
      });
    }
  }

  function mount(root, serverId) {
    if (!root) return;
    unmount();
    state.root = root;
    state.serverId = serverId || 'local';
    state.status = null;
    state.snapshots = null;
    root.innerHTML = '<div class="ms-card sp-card"><p role="status">正在读取…</p></div>';
    root.addEventListener('change', onChange);
    root.addEventListener('click', onClick);
    return load();
  }

  function unmount() {
    if (state.root) {
      state.root.removeEventListener('change', onChange);
      state.root.removeEventListener('click', onClick);
    }
    state.root = null;
    state.token += 1;
    state.busy = false;
  }

  global.SessionProtectionPage = { mount: mount, unmount: unmount };
})(typeof window !== 'undefined' ? window : globalThis);
