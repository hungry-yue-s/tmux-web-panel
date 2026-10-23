/* global Theme */
// This origin remembers sessions while the panel moves between LAN addresses.
// Tokens travel only in fragments; DNS requests never include session data.
(function () {
  'use strict';
  var config = window.PANEL_RELAY_CONFIG;
  var TOKEN_KEY = 'panel_relay_token';
  var THEME_KEY = 'panel_relay_theme';
  var statusText = document.getElementById('status-text');
  var go = document.getElementById('go');
  var retry = document.getElementById('retry');
  var progress = document.getElementById('progress');
  var endpoints = ['https://dns.alidns.com/resolve', 'https://dns.google/resolve'];

  function readStored(key) {
    try { return localStorage.getItem(key); } catch (_e) { return null; }
  }

  function rememberTheme() {
    var id = Theme.getCurrent();
    // getCurrent reads localStorage, which may be unavailable in private modes.
    id = document.documentElement.dataset.theme || id;
    try { localStorage.setItem(THEME_KEY, id); } catch (_e) {}
    document.getElementById('theme-name').textContent = Theme.getName(id);
    document.querySelector('meta[name="theme-color"]').content =
      getComputedStyle(document.documentElement).getPropertyValue('--workspace-bg').trim();
  }
  rememberTheme();
  document.addEventListener('tmux-theme-change', rememberTheme);

  function setState(state, text) {
    document.body.dataset.state = state;
    statusText.textContent = text;
    progress.setAttribute('aria-label', text);
    progress.hidden = state === 'failed';
    if (state === 'ready') progress.setAttribute('aria-valuenow', '100');
    else progress.removeAttribute('aria-valuenow');
    document.getElementById('step-locate').removeAttribute('aria-current');
    document.getElementById('step-enter').removeAttribute('aria-current');
    document.getElementById(state === 'ready' ? 'step-enter' : 'step-locate').setAttribute('aria-current', 'step');
    retry.hidden = state !== 'failed';
  }

  function enter(target, text) {
    setState('ready', text);
    go.href = target.href;
    go.hidden = false;
    // No artificial delay: the manual link remains if a client blocks the hop.
    location.replace(target.href);
  }

  async function resolvePanel() {
    go.hidden = true;
    setState('resolving', '正在定位工作台…');
    var saved = readStored(TOKEN_KEY);
    for (var i = 0; i < endpoints.length; i++) {
      if (i) setState('resolving', '正在尝试备用地址解析…');
      var controller = new AbortController();
      var timeout = setTimeout(function () { controller.abort(); }, 5000);
      try {
        var res = await fetch(endpoints[i] + '?name=' + encodeURIComponent(config.name) + '&type=A', {
          signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer',
        });
        if (!res.ok) continue;
        var payload = await res.json();
        var answer = (Array.isArray(payload.Answer) ? payload.Answer : []).find(function (a) {
          return a.type === 1 && typeof a.data === 'string' &&
            /^(\d{1,3}\.){3}\d{1,3}$/.test(a.data) && a.data.split('.').every(function (part) { return Number(part) <= 255; });
        });
        if (!answer) continue;
        var target = new URL('https://' + answer.data + ':' + config.port + '/');
        var theme = document.documentElement.dataset.theme;
        if (saved) target.hash = new URLSearchParams({ handoff: saved, theme: theme }).toString();
        else {
          target.pathname = '/login.html';
          target.search = new URLSearchParams({ relay: '1', theme: theme }).toString();
        }
        enter(target, '地址已找到，正在前往工作台…');
        return;
      } catch (_e) { /* Try the next resolver, including on timeout. */ }
      finally { clearTimeout(timeout); }
    }
    setState('failed', '未能找到地址，请检查网络后重试');
  }

  retry.addEventListener('click', resolvePanel);
  var fragment = new URLSearchParams(location.hash.slice(1));
  if (fragment.has('store')) {
    try {
      var token = fragment.get('store');
      var back = new URL(fragment.get('return') || '/', location.href);
      if (!token || back.protocol !== 'https:' || back.username || back.password) throw new Error('Invalid handoff');
      try { localStorage.setItem(TOKEN_KEY, token); } catch (_e) {}
      back.hash = new URLSearchParams({ handoff: token, theme: document.documentElement.dataset.theme }).toString();
      enter(back, '登录状态已接续，正在返回工作台…');
    } catch (_e) {
      setState('failed', '返回地址无效，请重新打开引导链接');
    }
  } else resolvePanel();
})();
