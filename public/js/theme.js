/* global */

// === Theme Manager ===

var Theme = (function () {
  var STORAGE_KEY = 'tmux_theme';
  var DEFAULT_THEME = 'tokyo-night';

  var themes = {
    'tokyo-night': {
      name: 'Tokyo Night',
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
    'catppuccin-mocha': {
      name: 'Catppuccin Mocha',
      ui: {
        '--bg-primary': '#1e1e2e',
        '--bg-deep': '#181825',
        '--bg-card': '#313244',
        '--bg-hover': '#45475a',
        '--border': '#585b70',
        '--border-subtle': '#45475a',
        '--text-primary': '#cdd6f4',
        '--text-secondary': '#bac2de',
        '--text-muted': '#6c7086',
        '--accent-blue': '#89b4fa',
        '--accent-green': '#a6e3a1',
        '--accent-red': '#f38ba8',
        '--accent-yellow': '#f9e2af',
        '--accent-purple': '#cba6f7',
      },
      terminal: {
        background: '#1e1e2e',
        foreground: '#cdd6f4',
        cursor: '#f5e0dc',
        cursorAccent: '#1e1e2e',
        selectionBackground: '#45475a',
        black: '#45475a',
        red: '#f38ba8',
        green: '#a6e3a1',
        yellow: '#f9e2af',
        blue: '#89b4fa',
        magenta: '#cba6f7',
        cyan: '#94e2d5',
        white: '#bac2de',
        brightBlack: '#585b70',
        brightRed: '#f38ba8',
        brightGreen: '#a6e3a1',
        brightYellow: '#f9e2af',
        brightBlue: '#89b4fa',
        brightMagenta: '#cba6f7',
        brightCyan: '#94e2d5',
        brightWhite: '#a6adc8',
      },
    },
    'dracula': {
      name: 'Dracula',
      ui: {
        '--bg-primary': '#282a36',
        '--bg-deep': '#21222c',
        '--bg-card': '#44475a',
        '--bg-hover': '#4e5173',
        '--border': '#6272a4',
        '--border-subtle': '#44475a',
        '--text-primary': '#f8f8f2',
        '--text-secondary': '#e2e2dc',
        '--text-muted': '#6272a4',
        '--accent-blue': '#8be9fd',
        '--accent-green': '#50fa7b',
        '--accent-red': '#ff5555',
        '--accent-yellow': '#f1fa8c',
        '--accent-purple': '#bd93f9',
      },
      terminal: {
        background: '#282a36',
        foreground: '#f8f8f2',
        cursor: '#f8f8f2',
        cursorAccent: '#282a36',
        selectionBackground: '#44475a',
        black: '#21222c',
        red: '#ff5555',
        green: '#50fa7b',
        yellow: '#f1fa8c',
        blue: '#bd93f9',
        magenta: '#ff79c6',
        cyan: '#8be9fd',
        white: '#f8f8f2',
        brightBlack: '#6272a4',
        brightRed: '#ff6e6e',
        brightGreen: '#69ff94',
        brightYellow: '#ffffa5',
        brightBlue: '#d6acff',
        brightMagenta: '#ff92df',
        brightCyan: '#a4ffff',
        brightWhite: '#ffffff',
      },
    },
    'nord': {
      name: 'Nord',
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
    'solarized-dark': {
      name: 'Solarized Dark',
      ui: {
        '--bg-primary': '#002b36',
        '--bg-deep': '#00252e',
        '--bg-card': '#073642',
        '--bg-hover': '#0a4050',
        '--border': '#586e75',
        '--border-subtle': '#073642',
        '--text-primary': '#93a1a1',
        '--text-secondary': '#839496',
        '--text-muted': '#586e75',
        '--accent-blue': '#268bd2',
        '--accent-green': '#859900',
        '--accent-red': '#dc322f',
        '--accent-yellow': '#b58900',
        '--accent-purple': '#6c71c4',
      },
      terminal: {
        background: '#002b36',
        foreground: '#839496',
        cursor: '#93a1a1',
        cursorAccent: '#002b36',
        selectionBackground: '#073642',
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
    'solarized-light': {
      name: 'Solarized Light',
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
      name: 'GitHub Light',
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
    'gruvbox-dark': {
      name: 'Gruvbox Dark',
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
    'one-dark': {
      name: 'One Dark',
      ui: {
        '--bg-primary': '#282c34',
        '--bg-deep': '#21252b',
        '--bg-card': '#2c313a',
        '--bg-hover': '#383e4a',
        '--border': '#4b5263',
        '--border-subtle': '#3a3f4b',
        '--text-primary': '#abb2bf',
        '--text-secondary': '#9da5b4',
        '--text-muted': '#636d83',
        '--accent-blue': '#61afef',
        '--accent-green': '#98c379',
        '--accent-red': '#e06c75',
        '--accent-yellow': '#e5c07b',
        '--accent-purple': '#c678dd',
      },
      terminal: {
        background: '#282c34',
        foreground: '#abb2bf',
        cursor: '#528bff',
        cursorAccent: '#282c34',
        selectionBackground: '#3e4451',
        black: '#282c34',
        red: '#e06c75',
        green: '#98c379',
        yellow: '#e5c07b',
        blue: '#61afef',
        magenta: '#c678dd',
        cyan: '#56b6c2',
        white: '#abb2bf',
        brightBlack: '#5c6370',
        brightRed: '#e06c75',
        brightGreen: '#98c379',
        brightYellow: '#e5c07b',
        brightBlue: '#61afef',
        brightMagenta: '#c678dd',
        brightCyan: '#56b6c2',
        brightWhite: '#ffffff',
      },
    },
    'catppuccin-mocha-pastel': {
      name: 'Catppuccin Mocha Pastel',
      ui: {
        '--bg-primary': '#1e1e2e',
        '--bg-deep': '#181825',
        '--bg-card': '#313244',
        '--bg-hover': '#45475a',
        '--border': '#585b70',
        '--border-subtle': '#45475a',
        '--text-primary': '#cdd6f4',
        '--text-secondary': '#bac2de',
        '--text-muted': '#7f849c',
        '--accent-blue': '#89b4fa',
        '--accent-green': '#a6e3a1',
        '--accent-red': '#f38ba8',
        '--accent-yellow': '#f9e2af',
        '--accent-purple': '#cba6f7',
      },
      terminal: {
        background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', cursorAccent: '#1e1e2e',
        selectionBackground: '#585b70', black: '#45475a', red: '#f38ba8', green: '#a6e3a1',
        yellow: '#f9e2af', blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de',
        brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af',
        brightBlue: '#89b4fa', brightMagenta: '#f5c2e7', brightCyan: '#94e2d5', brightWhite: '#a6adc8',
      },
    },
    'rose-pine-moon': {
      name: 'Rosé Pine Moon',
      ui: {
        '--bg-primary': '#232136',
        '--bg-deep': '#191724',
        '--bg-card': '#2a273f',
        '--bg-hover': '#393552',
        '--border': '#56526e',
        '--border-subtle': '#44415a',
        '--text-primary': '#e0def4',
        '--text-secondary': '#908caa',
        '--text-muted': '#6e6a86',
        '--accent-blue': '#3e8fb0',
        '--accent-green': '#9ccfd8',
        '--accent-red': '#eb6f92',
        '--accent-yellow': '#f6c177',
        '--accent-purple': '#c4a7e7',
      },
      terminal: {
        background: '#232136', foreground: '#e0def4', cursor: '#c4a7e7', cursorAccent: '#232136',
        selectionBackground: '#44415a', black: '#393552', red: '#eb6f92', green: '#3e8fb0',
        yellow: '#f6c177', blue: '#9ccfd8', magenta: '#c4a7e7', cyan: '#ea9a97', white: '#e0def4',
        brightBlack: '#6e6a86', brightRed: '#eb6f92', brightGreen: '#3e8fb0', brightYellow: '#f6c177',
        brightBlue: '#9ccfd8', brightMagenta: '#c4a7e7', brightCyan: '#ea9a97', brightWhite: '#ffffff',
      },
    },
    'tokyo-night-storm': {
      name: 'Tokyo Night Storm',
      ui: {
        '--bg-primary': '#24283b',
        '--bg-deep': '#1f2335',
        '--bg-card': '#292e42',
        '--bg-hover': '#3b4261',
        '--border': '#545c7e',
        '--border-subtle': '#414868',
        '--text-primary': '#c0caf5',
        '--text-secondary': '#a9b1d6',
        '--text-muted': '#565f89',
        '--accent-blue': '#7aa2f7',
        '--accent-green': '#73daca',
        '--accent-red': '#f7768e',
        '--accent-yellow': '#e0af68',
        '--accent-purple': '#bb9af7',
      },
      terminal: {
        background: '#24283b', foreground: '#c0caf5', cursor: '#c0caf5', cursorAccent: '#24283b',
        selectionBackground: '#3d59a1', black: '#414868', red: '#f7768e', green: '#73daca',
        yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#c0caf5',
        brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#73daca', brightYellow: '#e0af68',
        brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#c0caf5',
      },
    },
  };

  function getCurrent() {
    try {
      var saved = localStorage.getItem(STORAGE_KEY);
      if (saved && themes[saved]) return saved;
    } catch (_e) {}
    return DEFAULT_THEME;
  }

  function apply(themeId) {
    if (!themes[themeId]) themeId = DEFAULT_THEME;
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
    var id = themeId || getCurrent();
    if (!themes[id]) id = DEFAULT_THEME;
    // Return a copy
    var t = themes[id].terminal;
    var copy = {};
    for (var key in t) {
      if (t.hasOwnProperty(key)) copy[key] = t[key];
    }
    return copy;
  }

  function getThemeList() {
    var list = [];
    for (var id in themes) {
      if (themes.hasOwnProperty(id)) {
        list.push({
          id: id,
          name: themes[id].name,
          colors: themes[id].ui,
        });
      }
    }
    return list;
  }

  function getName(themeId) {
    var id = themeId || getCurrent();
    return themes[id] ? themes[id].name : 'Unknown';
  }

  // Apply saved theme immediately on load
  apply(getCurrent());

  return {
    getCurrent: getCurrent,
    apply: apply,
    getTerminalTheme: getTerminalTheme,
    getThemeList: getThemeList,
    getName: getName,
  };
})();
