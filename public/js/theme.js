/* global */

// === Theme Manager ===

var Theme = (function () {
  var STORAGE_KEY = 'tmux_theme';
  var DEFAULT_THEME = 'tokyo-night';
  // Retired choices migrate once on load; they no longer appear in the picker.
  var THEME_ALIASES = {
    'tokyo-night-storm': 'tokyo-night',
    'catppuccin-mocha': 'prism',
    'catppuccin-mocha-pastel': 'prism',
    'rose-pine-moon': 'prism',
    'dracula': 'prism',
    'one-dark': 'graphite',
    'solarized-dark': 'deep-current',
  };
  var TRANSPARENCY_KEY = 'tmux_native_transparency';
  var transparency = readTransparency();
  var GLASS_KEY = 'tmux_native_glass_intensity';
  var glassIntensity = readGlassIntensity();

  function supportsGlassIntensity() {
    var handlers = window.webkit && window.webkit.messageHandlers;
    return supportsTransparency() && !!(handlers && handlers.tmuxPanelAppearance
      && typeof handlers.tmuxPanelAppearance.postMessage === 'function');
  }

  function clampGlassIntensity(value) {
    var number = Number(value);
    return isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : 100;
  }

  function readGlassIntensity() {
    try {
      var saved = localStorage.getItem(GLASS_KEY);
      return saved === null ? 100 : clampGlassIntensity(saved);
    } catch (_e) { return 100; }
  }

  function getGlassIntensity() { return glassIntensity; }

  function applyGlassIntensity() {
    if (!supportsGlassIntensity()) return;
    try { window.webkit.messageHandlers.tmuxPanelAppearance.postMessage({ glassIntensity: glassIntensity }); }
    catch (_e) {}
  }

  function setGlassIntensity(value) {
    if (!supportsGlassIntensity()) return;
    glassIntensity = clampGlassIntensity(value);
    try { localStorage.setItem(GLASS_KEY, String(glassIntensity)); } catch (_e) {}
    applyGlassIntensity();
    document.dispatchEvent(new CustomEvent('tmux-glass-change'));
  }

  function supportsTransparency() {
    return window.__tmuxPanelTransparency === true;
  }

  function clampTransparency(value) {
    var number = Number(value);
    return isFinite(number) ? Math.max(0, Math.min(50, Math.round(number))) : 0;
  }

  function readTransparency() {
    try { return clampTransparency(localStorage.getItem(TRANSPARENCY_KEY)); }
    catch (_e) { return 0; }
  }

  function getTransparency() {
    return supportsTransparency() ? transparency : 0;
  }

  function applyTransparency(themeId) {
    var root = document.documentElement;
    var amount = getTransparency();
    root.toggleAttribute('data-native-transparency', amount > 0);
    var hex = themes[themeId].ui['--bg-primary'];
    var rgb = [1, 3, 5].map(function (offset) { return parseInt(hex.slice(offset, offset + 2), 16); });
    root.style.setProperty('--native-window-background', 'rgba(' + rgb.join(', ') + ', ' + (1 - amount / 100) + ')');
  }

  function setTransparency(value) {
    if (!supportsTransparency()) return;
    transparency = clampTransparency(value);
    try { localStorage.setItem(TRANSPARENCY_KEY, String(transparency)); } catch (_e) {}
    applyTransparency(getCurrent());
    document.dispatchEvent(new CustomEvent('tmux-transparency-change'));
  }

  var themes = {
    'prism': {
      name: 'Prism · 棱镜', description: '烟紫底色 · 银灰文字 · 柔紫强调',
      ui: {
        '--bg-primary': '#191923', '--bg-deep': '#22212e', '--bg-card': '#292736',
        '--bg-hover': '#363345', '--border': '#655e7b', '--border-subtle': '#403a51',
        '--text-primary': '#e8e5f2', '--text-secondary': '#aca8be', '--text-muted': '#aca8be',
        '--accent-blue': '#a6a5f8', '--accent-green': '#a7c7ad', '--accent-red': '#ef9ba9',
        '--accent-yellow': '#e7c78e', '--accent-purple': '#c4a4e8',
      },
      workspace: { '--workspace-accent': '#b9a6ee' },
      terminal: {
        background: '#191923', foreground: '#e8e5f2', cursor: '#c8b8f4', cursorAccent: '#191923',
        selectionBackground: '#464058', black: '#22212e', red: '#ef9ba9', green: '#a7c7ad',
        yellow: '#e7c78e', blue: '#a6a5f8', magenta: '#c4a4e8', cyan: '#92cbd3', white: '#d4d0e2',
        brightBlack: '#8d879f', brightRed: '#ffb3bd', brightGreen: '#bcdec2', brightYellow: '#f3dba8',
        brightBlue: '#c0baff', brightMagenta: '#dfbafa', brightCyan: '#abe3e9', brightWhite: '#f8f4ff',
      },
    },
    'graphite': {
      name: 'Graphite · 石墨', description: '中性炭黑 · 暖银强调 · 低饱和语法色',
      ui: {
        '--bg-primary': '#141414', '--bg-deep': '#1c1c1c', '--bg-card': '#252525',
        '--bg-hover': '#303030', '--border': '#62625e', '--border-subtle': '#393937',
        '--text-primary': '#e9e9e6', '--text-secondary': '#b0b0aa', '--text-muted': '#b0b0aa',
        '--accent-blue': '#a8bdd5', '--accent-green': '#a9c7a4', '--accent-red': '#e8a0a0',
        '--accent-yellow': '#dbc58d', '--accent-purple': '#c5adcf',
      },
      workspace: { '--workspace-accent': '#c9c7bf' },
      terminal: {
        background: '#141414', foreground: '#e9e9e6', cursor: '#eee9d9', cursorAccent: '#141414',
        selectionBackground: '#42423e', black: '#1c1c1c', red: '#e8a0a0', green: '#a9c7a4',
        yellow: '#dbc58d', blue: '#a8bdd5', magenta: '#c5adcf', cyan: '#9dc9c7', white: '#d2d2cc',
        brightBlack: '#8e8e88', brightRed: '#f4b5b5', brightGreen: '#bedbb8', brightYellow: '#eed9a6',
        brightBlue: '#bed1e8', brightMagenta: '#dcc3e5', brightCyan: '#b6dfdc', brightWhite: '#f5f5ef',
      },
    },
    'deep-current': {
      name: 'Deep Current', description: '深海青底 · 暖铜强调',
      ui: {
        '--bg-primary': '#101b1e', '--bg-deep': '#173b40', '--bg-card': '#223236',
        '--bg-hover': '#2b4549', '--border': '#526b6a', '--border-subtle': '#344f51',
        '--text-primary': '#e5efeb', '--text-secondary': '#a1b7b5', '--text-muted': '#a1b7b5',
        '--accent-blue': '#7aa2f7', '--accent-green': '#9ece6a', '--accent-red': '#f7768e',
        '--accent-yellow': '#e0af68', '--accent-purple': '#bb9af7',
      },
      workspace: { '--workspace-accent': '#edbd8b' },
      terminal: {
        background: '#101b1e', foreground: '#e5efeb', cursor: '#edbd8b', cursorAccent: '#101b1e',
        selectionBackground: '#42524a', black: '#101b1e', red: '#f7768e', green: '#9ece6a',
        yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#c0caf5',
        brightBlack: '#718b89', brightRed: '#f7768e', brightGreen: '#9ece6a', brightYellow: '#e0af68',
        brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#e5efeb',
      },
    },
    'forest-ink': {
      name: 'Forest Ink · 森林', description: '深林绿底 · 苔黄强调 · 草木色阶',
      ui: {
        '--bg-primary': '#121d17', '--bg-deep': '#1a2920', '--bg-card': '#24332a',
        '--bg-hover': '#304237', '--border': '#617c65', '--border-subtle': '#354a3b',
        '--text-primary': '#e2ebde', '--text-secondary': '#afc3ac', '--text-muted': '#afc3ac',
        '--accent-blue': '#a1b9ca', '--accent-green': '#baca84', '--accent-red': '#e49c8b',
        '--accent-yellow': '#ddc48e', '--accent-purple': '#c2acd0',
      },
      workspace: { '--workspace-accent': '#baca84' },
      terminal: {
        background: '#121d17', foreground: '#e2ebde', cursor: '#baca84', cursorAccent: '#121d17',
        selectionBackground: '#3b503e', black: '#1a2920', red: '#e49c8b', green: '#baca84',
        yellow: '#ddc48e', blue: '#a1b9ca', magenta: '#c2acd0', cyan: '#91c9b7', white: '#cedbc9',
        brightBlack: '#879b85', brightRed: '#f4b4a3', brightGreen: '#d0dfa0', brightYellow: '#efdaa7',
        brightBlue: '#bbd0df', brightMagenta: '#d9c3e6', brightCyan: '#a8dfcc', brightWhite: '#f0f5e9',
      },
    },
    'tokyo-night': {
      name: 'Tokyo Night', description: '午夜蓝底 · 清亮蓝紫',
      ui: {
        '--bg-primary': '#1a1b26',
        '--bg-deep': '#16161e',
        '--bg-card': '#24283b',
        '--bg-hover': '#292e42',
        '--border': '#3b4261',
        '--border-subtle': '#2f3450',
        '--text-primary': '#c0caf5',
        '--text-secondary': '#a9b1d6',
        '--text-muted': '#565f89',
        '--accent-blue': '#7aa2f7',
        '--accent-green': '#9ece6a',
        '--accent-red': '#f7768e',
        '--accent-yellow': '#e0af68',
        '--accent-purple': '#bb9af7',
      },
      terminal: {
        background: '#1a1b26',
        foreground: '#c0caf5',
        cursor: '#c0caf5',
        cursorAccent: '#1a1b26',
        selectionBackground: '#33467c',
        black: '#15161e',
        red: '#f7768e',
        green: '#9ece6a',
        yellow: '#e0af68',
        blue: '#7aa2f7',
        magenta: '#bb9af7',
        cyan: '#7dcfff',
        white: '#a9b1d6',
        brightBlack: '#414868',
        brightRed: '#f7768e',
        brightGreen: '#9ece6a',
        brightYellow: '#e0af68',
        brightBlue: '#7aa2f7',
        brightMagenta: '#bb9af7',
        brightCyan: '#7dcfff',
        brightWhite: '#c0caf5',
      },
    },
    'nord': {
      name: 'Nord', description: '北欧蓝灰 · 冷调低饱和',
      ui: {
        '--bg-primary': '#2e3440',
        '--bg-deep': '#272c36',
        '--bg-card': '#3b4252',
        '--bg-hover': '#434c5e',
        '--border': '#4c566a',
        '--border-subtle': '#3b4252',
        '--text-primary': '#eceff4',
        '--text-secondary': '#d8dee9',
        '--text-muted': '#616e88',
        '--accent-blue': '#81a1c1',
        '--accent-green': '#a3be8c',
        '--accent-red': '#bf616a',
        '--accent-yellow': '#ebcb8b',
        '--accent-purple': '#b48ead',
      },
      terminal: {
        background: '#2e3440',
        foreground: '#d8dee9',
        cursor: '#d8dee9',
        cursorAccent: '#2e3440',
        selectionBackground: '#434c5e',
        black: '#3b4252',
        red: '#bf616a',
        green: '#a3be8c',
        yellow: '#ebcb8b',
        blue: '#81a1c1',
        magenta: '#b48ead',
        cyan: '#88c0d0',
        white: '#e5e9f0',
        brightBlack: '#4c566a',
        brightRed: '#bf616a',
        brightGreen: '#a3be8c',
        brightYellow: '#ebcb8b',
        brightBlue: '#81a1c1',
        brightMagenta: '#b48ead',
        brightCyan: '#8fbcbb',
        brightWhite: '#eceff4',
      },
    },
    'gruvbox-dark': {
      name: 'Gruvbox Dark', description: '暖炭灰底 · 复古琥珀',
      ui: {
        '--bg-primary': '#282828',
        '--bg-deep': '#1d2021',
        '--bg-card': '#3c3836',
        '--bg-hover': '#504945',
        '--border': '#665c54',
        '--border-subtle': '#3c3836',
        '--text-primary': '#ebdbb2',
        '--text-secondary': '#d5c4a1',
        '--text-muted': '#928374',
        '--accent-blue': '#83a598',
        '--accent-green': '#b8bb26',
        '--accent-red': '#fb4934',
        '--accent-yellow': '#fabd2f',
        '--accent-purple': '#d3869b',
      },
      terminal: {
        background: '#282828',
        foreground: '#ebdbb2',
        cursor: '#ebdbb2',
        cursorAccent: '#282828',
        selectionBackground: '#504945',
        black: '#282828',
        red: '#cc241d',
        green: '#98971a',
        yellow: '#d79921',
        blue: '#458588',
        magenta: '#b16286',
        cyan: '#689d6a',
        white: '#a89984',
        brightBlack: '#928374',
        brightRed: '#fb4934',
        brightGreen: '#b8bb26',
        brightYellow: '#fabd2f',
        brightBlue: '#83a598',
        brightMagenta: '#d3869b',
        brightCyan: '#8ec07c',
        brightWhite: '#ebdbb2',
      },
    },
    'oyster': {
      name: 'Oyster · 牡蛎白', description: '暖灰白底 · 陶土红强调 · 深墨文字',
      ui: {
        '--bg-primary': '#f4f1eb', '--bg-deep': '#e9e3d9', '--bg-card': '#fcfaf6',
        '--bg-hover': '#dfd7cb', '--border': '#9a8c7c', '--border-subtle': '#d4cbbc',
        '--text-primary': '#282522', '--text-secondary': '#63594e', '--text-muted': '#63594e',
        '--accent-blue': '#315e88', '--accent-green': '#3d603d', '--accent-red': '#a33735',
        '--accent-yellow': '#725014', '--accent-purple': '#795184',
      },
      workspace: { '--workspace-accent': '#a74a34' },
      terminal: {
        background: '#f4f1eb', foreground: '#282522', cursor: '#a74a34', cursorAccent: '#f4f1eb',
        selectionBackground: '#d6c5ae', black: '#302b26', red: '#a33735', green: '#3d603d',
        yellow: '#725014', blue: '#315e88', magenta: '#795184', cyan: '#27676b', white: '#6d6257',
        brightBlack: '#75695c', brightRed: '#b13b36', brightGreen: '#456d3f', brightYellow: '#806020',
        brightBlue: '#3c6594', brightMagenta: '#85588c', brightCyan: '#34747a', brightWhite: '#5b5148',
      },
    },
    'solarized-light': {
      name: 'Solarized Light', description: '浅米黄底 · 经典日光配色',
      ui: {
        '--bg-primary': '#fdf6e3',
        '--bg-deep': '#eee8d5',
        '--bg-card': '#eee8d5',
        '--bg-hover': '#e6dfcb',
        '--border': '#d3cbb7',
        '--border-subtle': '#eee8d5',
        '--text-primary': '#657b83',
        '--text-secondary': '#586e75',
        '--text-muted': '#93a1a1',
        '--accent-blue': '#268bd2',
        '--accent-green': '#859900',
        '--accent-red': '#dc322f',
        '--accent-yellow': '#b58900',
        '--accent-purple': '#6c71c4',
      },
      terminal: {
        background: '#fdf6e3',
        foreground: '#657b83',
        cursor: '#586e75',
        cursorAccent: '#fdf6e3',
        selectionBackground: '#eee8d5',
        black: '#073642',
        red: '#dc322f',
        green: '#859900',
        yellow: '#b58900',
        blue: '#268bd2',
        magenta: '#d33682',
        cyan: '#2aa198',
        white: '#eee8d5',
        brightBlack: '#586e75',
        brightRed: '#cb4b16',
        brightGreen: '#586e75',
        brightYellow: '#657b83',
        brightBlue: '#839496',
        brightMagenta: '#6c71c4',
        brightCyan: '#93a1a1',
        brightWhite: '#fdf6e3',
      },
    },
    'github-light': {
      name: 'GitHub Light', description: '纯白底 · 清晰蓝色强调',
      ui: {
        '--bg-primary': '#ffffff',
        '--bg-deep': '#f6f8fa',
        '--bg-card': '#f6f8fa',
        '--bg-hover': '#ebeef1',
        '--border': '#d0d7de',
        '--border-subtle': '#e8ebef',
        '--text-primary': '#1f2328',
        '--text-secondary': '#656d76',
        '--text-muted': '#8b949e',
        '--accent-blue': '#0969da',
        '--accent-green': '#1a7f37',
        '--accent-red': '#cf222e',
        '--accent-yellow': '#9a6700',
        '--accent-purple': '#8250df',
      },
      terminal: {
        background: '#ffffff',
        foreground: '#1f2328',
        cursor: '#044289',
        cursorAccent: '#ffffff',
        selectionBackground: '#bbd6fb',
        black: '#24292f',
        red: '#cf222e',
        green: '#116329',
        yellow: '#4d2d00',
        blue: '#0969da',
        magenta: '#8250df',
        cyan: '#1b7c83',
        white: '#6e7781',
        brightBlack: '#57606a',
        brightRed: '#a40e26',
        brightGreen: '#1a7f37',
        brightYellow: '#633c01',
        brightBlue: '#218bff',
        brightMagenta: '#a475f9',
        brightCyan: '#3192aa',
        brightWhite: '#8c959f',
      },
    },

  };

  // Correct foreground colors against their actual opaque surfaces. The 8%
  // backdrop samples add headroom for UI tints; arbitrary native transparency
  // can still reveal desktop colors outside these bounds.
  function rgb(hex) {
    return [1, 3, 5].map(function (offset) { return parseInt(hex.slice(offset, offset + 2), 16); });
  }

  function mix(a, b, amount) {
    return a.map(function (channel, index) { return Math.round(channel * (1 - amount) + b[index] * amount); });
  }

  function hex(channels) {
    return '#' + channels.map(function (channel) { return ('0' + channel.toString(16)).slice(-2); }).join('');
  }

  function luminance(channels) {
    var linear = channels.map(function (channel) {
      var value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
    });
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  }

  function contrast(a, b) {
    var first = luminance(a), second = luminance(b);
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
  }

  function readable(color, surfaces, light, ratio) {
    var original = rgb(color), end = light ? [0, 0, 0] : [255, 255, 255];
    for (var step = 0; step <= 100; step++) {
      var candidate = mix(original, end, step / 100);
      if (surfaces.every(function (surface) { return contrast(candidate, surface) >= ratio; })) return hex(candidate);
    }
    return hex(end);
  }

  Object.keys(themes).forEach(function (id) {
    var theme = themes[id], ui = theme.ui;
    var light = luminance(rgb(ui['--bg-primary'])) > 0.5;
    theme.colorScheme = light ? 'light' : 'dark';
    var workspace = {
      '--workspace-bg': ui['--bg-primary'], '--workspace-sidebar': ui['--bg-deep'],
      '--workspace-panel': ui['--bg-card'], '--workspace-hover': ui['--bg-hover'],
      '--workspace-text': ui['--text-primary'], '--workspace-muted': ui['--text-secondary'],
      '--workspace-accent': ui['--accent-blue'], '--workspace-line': ui['--border-subtle'],
      '--workspace-line-strong': ui['--border'],
    };
    Object.assign(workspace, theme.workspace || {});
    var surfaces = ['--workspace-bg', '--workspace-sidebar', '--workspace-panel', '--workspace-hover']
      .map(function (key) { return rgb(workspace[key]); });
    var backdrops = surfaces.slice();
    surfaces.forEach(function (surface) {
      backdrops.push(mix(surface, [0, 0, 0], 0.08), mix(surface, [255, 255, 255], 0.08));
    });
    ['--workspace-text', '--workspace-muted', '--workspace-accent'].forEach(function (key) {
      workspace[key] = readable(workspace[key], backdrops, light, 4.6);
    });
    workspace['--workspace-line-strong'] = readable(workspace['--workspace-line-strong'], backdrops, light, 3.1);
    ['--accent-blue', '--accent-green', '--accent-red', '--accent-yellow', '--accent-purple'].forEach(function (key) {
      ui[key] = readable(ui[key], backdrops, light, 4.6);
    });
    ui['--text-primary'] = workspace['--workspace-text'];
    ui['--text-secondary'] = ui['--text-muted'] = workspace['--workspace-muted'];
    ui['--border'] = workspace['--workspace-line-strong'];
    Object.assign(ui, workspace);

    var terminal = theme.terminal;
    ['foreground', 'cursor']
      .forEach(function (key) {
        terminal[key] = readable(terminal[key], [rgb(terminal.background)], light, 4.6);
      });
    // Preserve ANSI slots: TUI programs use them for backgrounds and reverse video
    // too. xterm corrects contrast per cell. Selection needs its own text color.
    terminal.selectionForeground = readable(terminal.foreground, [rgb(terminal.selectionBackground)], light, 4.6);
  });

  function resolveThemeId(themeId) {
    var id = Object.prototype.hasOwnProperty.call(THEME_ALIASES, themeId) ? THEME_ALIASES[themeId] : themeId;
    return Object.prototype.hasOwnProperty.call(themes, id) ? id : DEFAULT_THEME;
  }

  function getCurrent() {
    try {
      return resolveThemeId(localStorage.getItem(STORAGE_KEY));
    } catch (_e) {}
    return DEFAULT_THEME;
  }

  function apply(themeId) {
    themeId = resolveThemeId(themeId);
    var t = themes[themeId];

    // Apply CSS variables to :root
    var root = document.documentElement;
    var ui = t.ui;
    for (var key in ui) {
      if (ui.hasOwnProperty(key)) {
        root.style.setProperty(key, ui[key]);
      }
    }

    // Set data attribute for potential CSS selectors
    root.setAttribute('data-theme', themeId);
    root.style.colorScheme = t.colorScheme;
    root.setAttribute('data-color-scheme', t.colorScheme);
    applyTransparency(themeId);

    // Persist
    try { localStorage.setItem(STORAGE_KEY, themeId); } catch (_e) {}

    // Let theme-aware rendered content (for example Mermaid SVGs) rebuild
    // colors that were embedded at render time.
    try {
      document.dispatchEvent(new CustomEvent('tmux-theme-change', {
        detail: { themeId: themeId },
      }));
    } catch (_e) {}
  }

  function getTerminalTheme(themeId) {
    var id = resolveThemeId(themeId || getCurrent());
    // Return a copy
    var t = themes[id].terminal;
    var copy = {};
    for (var key in t) {
      if (t.hasOwnProperty(key)) copy[key] = t[key];
    }
    // Only the page background carries alpha. Painting it again in xterm
    // would stack the two backgrounds and make the terminal nearly opaque.
    if (getTransparency() > 0) copy.background = 'rgba(0, 0, 0, 0)';
    return copy;
  }

  function getThemeList() {
    var list = [];
    for (var id in themes) {
      if (themes.hasOwnProperty(id)) {
        list.push({
          id: id,
          name: themes[id].name,
          description: themes[id].description,
          colorScheme: themes[id].colorScheme,
          colors: themes[id].ui,
          terminal: Object.assign({}, themes[id].terminal),
        });
      }
    }
    return list;
  }

  function getName(themeId) {
    return themes[resolveThemeId(themeId || getCurrent())].name;
  }

  // Apply saved theme immediately on load
  apply(getCurrent());
  applyGlassIntensity();

  // Native pop-out terminals share this origin's preferences.
  window.addEventListener('storage', function (event) {
    if (!supportsTransparency()) return;
    if (event.key === GLASS_KEY || event.key === null) {
      glassIntensity = readGlassIntensity();
      applyGlassIntensity();
      document.dispatchEvent(new CustomEvent('tmux-glass-change'));
    }
    if (event.key === TRANSPARENCY_KEY || event.key === null) {
      transparency = readTransparency();
      applyTransparency(getCurrent());
      document.dispatchEvent(new CustomEvent('tmux-transparency-change'));
    }
    if (event.key === STORAGE_KEY || event.key === null) apply(getCurrent());
  });

  return {
    getCurrent: getCurrent,
    apply: apply,
    getTerminalTheme: getTerminalTheme,
    getThemeList: getThemeList,
    getName: getName,
    supportsTransparency: supportsTransparency,
    getTransparency: getTransparency,
    setTransparency: setTransparency,
    supportsGlassIntensity: supportsGlassIntensity,
    getGlassIntensity: getGlassIntensity,
    setGlassIntensity: setGlassIntensity,
  };
})();
