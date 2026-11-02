// Theme transport for opt-in, sandboxed information pages. No layout or reset CSS.
(function (global) {
  'use strict';
  var MESSAGE = 'tmux-panel:presentation-theme';
  var COLORS = {
    '--pp-bg': '--workspace-bg',
    '--pp-surface': '--workspace-panel',
    '--pp-surface-alt': '--workspace-hover',
    '--pp-fg': '--workspace-text',
    '--pp-muted': '--workspace-muted',
    '--pp-border': '--workspace-line-strong',
    '--pp-accent': '--workspace-accent',
    '--pp-accent-fg': '--workspace-bg',
    '--pp-success': '--accent-green',
    '--pp-warning': '--accent-yellow',
    '--pp-danger': '--accent-red',
    '--pp-purple': '--accent-purple',
  };

  function getTheme() {
    var root = global.document.documentElement;
    var css = global.getComputedStyle(root);
    var tokens = {};
    Object.keys(COLORS).forEach(function (name) {
      var value = css.getPropertyValue(COLORS[name]).trim();
      if (/^#[\da-f]{6}$/i.test(value)) tokens[name] = value;
    });
    return { type: MESSAGE, version: 1, themeId: root.getAttribute('data-theme') || '',
      colorScheme: root.getAttribute('data-color-scheme') === 'light' ? 'light' : 'dark', tokens: tokens };
  }

  // Serialized into srcdoc, so this function must not capture host variables.
  function installBridge(initial, parentOrigin) {
    var names = Object.keys(initial.tokens);
    var current;
    function apply(theme) {
      if (!theme || theme.type !== initial.type || theme.version !== 1
        || typeof theme.themeId !== 'string' || !/^[a-z0-9-]*$/.test(theme.themeId)
        || !['light', 'dark'].includes(theme.colorScheme) || !theme.tokens) return;
      var tokens = {};
      for (var i = 0; i < names.length; i++) {
        var value = theme.tokens[names[i]];
        if (typeof value !== 'string' || !/^#[\da-f]{6}$/i.test(value)) return;
        tokens[names[i]] = value;
      }
      var root = document.documentElement;
      names.forEach(function (name) { root.style.setProperty(name, tokens[name]); });
      root.style.colorScheme = theme.colorScheme;
      root.setAttribute('data-panel-theme', theme.themeId);
      current = Object.freeze({ version: 1, themeId: theme.themeId, colorScheme: theme.colorScheme,
        tokens: Object.freeze(tokens) });
      document.dispatchEvent(new CustomEvent('panel-theme-change', { detail: current }));
    }
    window.PanelPresentation = { getTheme: function () { return current; } };
    window.addEventListener('message', function (event) {
      if (event.source === parent && event.origin === parentOrigin) apply(event.data);
    });
    apply(initial);
  }

  function prepare(content) {
    var doc = new global.DOMParser().parseFromString(content, 'text/html');
    if (!doc.head.querySelector('meta[name="tmux-panel-presentation"][content="1"]')) return content;
    var script = doc.createElement('script');
    // Only public theme data goes into the frame, never URLs or credentials.
    var args = JSON.stringify([getTheme(), global.location.origin]).replace(/</g, '\\u003c');
    script.textContent = '(' + installBridge.toString() + ').apply(null,' + args + ');';
    doc.head.prepend(script);
    return '<!doctype html>\n' + doc.documentElement.outerHTML;
  }

  function send(frame) {
    if (frame.contentWindow) frame.contentWindow.postMessage(getTheme(), '*'); // opaque sandbox origin
  }

  function mount(frame, content) {
    var html = prepare(content);
    if (html !== content) {
      frame.setAttribute('data-panel-presentation', '1');
      frame.__panelPresentationSource = content;
      frame.addEventListener('load', function () { send(frame); });
    }
    frame.srcdoc = html;
  }

  function sync(root) {
    if (root) root.querySelectorAll('iframe[data-panel-presentation="1"]').forEach(send);
  }

  global.PanelPresentation = { getTheme: getTheme, mount: mount, sync: sync,
    snapshot: function (frame) {
      return frame.__panelPresentationSource !== undefined ? prepare(frame.__panelPresentationSource) : frame.srcdoc;
    } };
})(window);
