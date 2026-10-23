(function () {
  if (window.__tmuxAndroidInstalled || !window.TmuxAndroid) return;
  window.__tmuxAndroidInstalled = true;
  if (window.Theme && window.__tmuxAndroidTheme) Theme.apply(window.__tmuxAndroidTheme);
  // The deployed bootstrap page has its own older light-theme identifier.
  if (!window.Theme && window.__tmuxAndroidTheme === 'oyster' && document.body.hasAttribute('data-theme')) {
    document.body.dataset.theme = 'github-light';
  }
  function send(value) { TmuxAndroid.postMessage(JSON.stringify(value)); }
  function theme() {
    var style = getComputedStyle(document.body);
    send({ type: 'theme', id: window.Theme ? document.documentElement.dataset.theme || '' : '',
      background: (style.getPropertyValue('--workspace-bg') || style.getPropertyValue('--bg-primary')).trim(),
      foreground: (style.getPropertyValue('--workspace-text') || style.getPropertyValue('--text-primary')).trim() });
  }
  document.addEventListener('tmux-theme-change', theme);
  theme();

  // Reuse the existing terminal/preview clipboard call sites. Transparency stays web-only.
  window.webkit = window.webkit || {};
  window.webkit.messageHandlers = window.webkit.messageHandlers || {};
  window.webkit.messageHandlers.tmuxPanelClipboard = {
    postMessage: function (value) { send(Object.assign({ type: 'clipboard' }, value)); }
  };

  function settings() {
    var host = document.getElementById('ms-view');
    if (!host || location.hash.indexOf('#/settings') !== 0 || host.querySelector('#android-client-settings')) return;
    var button = document.createElement('button');
    button.id = 'android-client-settings';
    button.type = 'button'; button.className = 'ms-btn';
    button.textContent = 'Android 客户端 · 连接设置';
    button.style.cssText = 'width:100%;min-height:48px;margin-bottom:16px';
    button.onclick = function () { send({ type: 'settings' }); };
    host.prepend(button);
  }
  var host = document.getElementById('ms-view');
  if (host) new MutationObserver(settings).observe(host, { childList: true });
  window.addEventListener('hashchange', settings);
  settings();

  window.__tmuxAndroidBack = function () {
    if (window.CommandPalette && CommandPalette.isOpen()) { CommandPalette.close(); return true; }
    var menu = document.querySelector('.fp-menu');
    if (menu) { menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return true; }
    var preview = document.querySelector('.fp-overlay:not(.fp-side)');
    if (preview && window.FilePreview) { FilePreview.closeModal(); return true; }
    if (window.AppShell && AppShell.isMobileWorkspaceOpen()) { AppShell.closeMobileWorkspaceSheet(); return true; }
    var notifications = document.getElementById('notification-sheet-overlay');
    if (notifications) { notifications.click(); return true; }
    var drawer = document.querySelector('.fab-drawer-mount.open .fab-drawer-close');
    if (drawer) { drawer.click(); return true; }
    var dialog = document.querySelector('.ms-modal-backdrop:not([hidden])');
    if (dialog) { dialog.click(); return true; }
    return false;
  };

  // Blob URLs belong to this renderer. Read them here and let Android's document
  // picker save the result instead of sending an unusable blob URL to DownloadManager.
  document.addEventListener('click', function (event) {
    var link = event.target.closest && event.target.closest('a[download]');
    if (!link || !link.href || !/^(blob:|data:|https?:)/.test(link.href)) return;
    if (/^https?:/.test(link.href)) {
      if (new URL(link.href).origin !== location.origin) return;
      event.preventDefault();
      send({ type: 'downloadUrl', url: link.href, name: link.download || 'download' });
      return;
    }
    event.preventDefault();
    fetch(link.href).then(function (response) { if (!response.ok) throw new Error('无法读取文件'); return response.blob(); })
      .then(function (blob) {
        if (blob.size > 16 * 1024 * 1024) throw new Error('文件超过 16 MB，请在浏览器中下载');
        var reader = new FileReader();
        reader.onload = function () { send({ type: 'download', name: link.download || 'download', mime: blob.type,
          data: String(reader.result).split(',')[1] }); };
        reader.onerror = function () { send({ type: 'notice', text: '文件读取失败，请重试' }); };
        reader.readAsDataURL(blob);
      }).catch(function (error) { send({ type: 'notice', text: error.message }); });
  }, true);
})();
