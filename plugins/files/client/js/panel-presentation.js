// Theme transport for opt-in, sandboxed information pages. No layout or reset CSS.
(function (global) {
  'use strict';
  var MESSAGE = 'anymux:presentation-theme';
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

  function getTheme(frame) {
    var root = global.document.documentElement;
    var css = global.getComputedStyle(root);
    var tokens = {};
    Object.keys(COLORS).forEach(function (name) {
      var value = css.getPropertyValue(COLORS[name]).trim();
      if (/^#[\da-f]{6}$/i.test(value)) tokens[name] = value;
    });
    var theme = global.Theme;
    var transparency = frame && theme && theme.supportsTransparency() ? theme.getTransparency() : 0;
    var glassIntensity = frame && theme && theme.supportsGlassIntensity() ? theme.getGlassIntensity() : 0;
    return { type: MESSAGE, version: 1, themeId: root.getAttribute('data-theme') || '',
      colorScheme: root.getAttribute('data-color-scheme') === 'light' ? 'light' : 'dark', tokens: tokens,
      appearance: {
        // Modal readers and portable snapshots keep an opaque reading surface.
        material: transparency > 0 && frame.closest('.fp-dock') ? 'native-glass' : 'solid',
        transparency: transparency, glassIntensity: glassIntensity,
      } };
  }

  // Serialized into srcdoc, so this function must not capture host variables.
  function installBridge(initial, parentOrigin) {
    var names = Object.keys(initial.tokens);
    var current;
    function apply(theme) {
      if (!theme || theme.type !== initial.type || theme.version !== 1
        || typeof theme.themeId !== 'string' || !/^[a-z0-9-]*$/.test(theme.themeId)
        || !['light', 'dark'].includes(theme.colorScheme) || !theme.tokens) return;
      // Appearance is additive to v1; older color-only messages remain valid.
      var appearance = theme.appearance || { material: 'solid', transparency: 0, glassIntensity: 0 };
      if (!['solid', 'native-glass'].includes(appearance.material)
        || !Number.isFinite(appearance.transparency) || appearance.transparency < 0 || appearance.transparency > 50
        || !Number.isFinite(appearance.glassIntensity) || appearance.glassIntensity < 0 || appearance.glassIntensity > 100
        || (appearance.material === 'native-glass' && appearance.transparency === 0)) return;
      var tokens = {};
      for (var i = 0; i < names.length; i++) {
        var value = theme.tokens[names[i]];
        if (typeof value !== 'string' || !/^#[\da-f]{6}$/i.test(value)) return;
        tokens[names[i]] = value;
      }
      var root = document.documentElement;
      names.forEach(function (name) { root.style.setProperty(name, tokens[name]); });
      var glass = appearance.material === 'native-glass';
      root.style.setProperty('--pp-page-bg', glass ? 'transparent' : tokens['--pp-bg'] || 'Canvas');
      var surface = tokens['--pp-surface'];
      if (glass && surface) {
        var rgb = [1, 3, 5].map(function (offset) { return parseInt(surface.slice(offset, offset + 2), 16); });
        surface = 'rgba(' + rgb.join(', ') + ', 0.16)';
      }
      root.style.setProperty('--pp-glass-surface', surface || 'Canvas');
      root.style.colorScheme = theme.colorScheme;
      root.setAttribute('data-panel-theme', theme.themeId);
      root.setAttribute('data-panel-material', appearance.material);
      current = Object.freeze({ version: 1, themeId: theme.themeId, colorScheme: theme.colorScheme,
        tokens: Object.freeze(tokens), appearance: Object.freeze({ material: appearance.material,
          transparency: appearance.transparency, glassIntensity: appearance.glassIntensity }) });
      document.dispatchEvent(new CustomEvent('panel-theme-change', { detail: current }));
    }
    window.PanelPresentation = { getTheme: function () { return current; } };
    window.addEventListener('message', function (event) {
      if (event.source === parent && event.origin === parentOrigin) apply(event.data);
    });
    apply(initial);
  }

  function prepare(content, frame) {
    var doc = new global.DOMParser().parseFromString(content, 'text/html');
    // tmux-panel-presentation: pages written before the rename.
    if (!doc.head.querySelector('meta[name="anymux-presentation"][content="1"], meta[name="tmux-panel-presentation"][content="1"]')) return content;
    var script = doc.createElement('script');
    // Only public appearance data goes into the frame, never URLs or credentials.
    var args = JSON.stringify([getTheme(frame), global.location.origin]).replace(/</g, '\\u003c');
    script.textContent = '(' + installBridge.toString() + ').apply(null,' + args + ');';
    doc.head.prepend(script);
    return '<!doctype html>\n' + doc.documentElement.outerHTML;
  }

  function send(frame) {
    if (frame.contentWindow) frame.contentWindow.postMessage(getTheme(frame), '*'); // opaque sandbox origin
  }

  function mount(frame, content) {
    var html = prepare(content, frame);
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
