/**
 * fab-scene.js — Scene data model for the FAB toolbar
 *
 * Browser usage: loaded via <script> tag, exposes window.FabScene
 * Test/ESM usage: named ESM exports at bottom of file
 */

// ─── Arrow-pad fixture sentinel ─────────────────────────────────────────────
const ARROW_PAD = Object.freeze({ type: 'arrow-pad' });

// ─── Builtin scene definitions ───────────────────────────────────────────────

const BUILTIN_SCENES = [
  {
    id: 'terminal',
    name: '终端',
    icon: '>_',
    detect: [],
    builtin: true,
    createdAt: 0,
    fixtures: [
      ARROW_PAD,
      { id: 'tab',   label: 'Tab', send: '\t' },
      { id: 'ctrlc', label: 'C-c', send: '\x03' },
      { id: 'ctrlr', label: 'C-r', send: '\x12' },
      { id: 'ctrll', label: 'C-l', send: '\x0c' },
    ],
    tabs: [
      { key: 'common',    name: '常用' },
      { key: 'keys',      name: '按键' },
      { key: 'commands',  name: '命令' },
      { key: 'templates', name: '模板' },
    ],
    defaultItems: {
      common: [
        { id: 'ls',         label: 'ls',         send: 'ls\r' },
        { id: 'git-status', label: 'git status',  send: 'git status\r' },
        { id: 'cd-up',      label: 'cd ..',       send: 'cd ..\r' },
        { id: 'pwd',        label: 'pwd',         send: 'pwd\r' },
        { id: 'clear',      label: 'clear',       send: 'clear\r' },
        { id: 'history',    label: 'history',     send: 'history\r' },
        { id: 'ctrlc2',     label: 'C-c',         send: '\x03' },
        { id: 'ctrld',      label: 'C-d',         send: '\x04' },
      ],
    },
  },

  {
    id: 'claude',
    name: 'Claude',
    icon: '✦',
    detect: ['claude', 'claude-code'],
    builtin: true,
    createdAt: 0,
    fixtures: [
      ARROW_PAD,
      { id: 'alt-t',     label: 'Alt+T',     send: '\x1bt',  color: 'orange' },
      { id: 'ctrl-o',    label: 'Ctrl+O',    send: '\x0f',   color: 'orange' },
      { id: 'shift-tab', label: 'Shift+Tab', send: '\x1b[Z' },
      { id: 'ctrl-j',    label: 'Ctrl+J',    send: '\n' },
    ],
    tabs: [
      { key: 'common',    name: '常用' },
      { key: 'keys',      name: '按键' },
      { key: 'slash',     name: 'Slash' },
      { key: 'templates', name: '模板' },
    ],
    defaultItems: {
      common: [
        { id: 'plan',     label: '/plan',     send: '/plan\r' },
        { id: 'review',   label: '/review',   send: '/review\r' },
        { id: 'commit',   label: '/commit',   send: '/commit\r' },
        { id: 'test',     label: '/test',     send: '/test\r' },
        { id: 'refactor', label: '/refactor', send: '/refactor\r' },
        { id: 'explain',  label: '/explain',  send: '/explain\r' },
        { id: 'init',     label: '/init',     send: '/init\r' },
        { id: 'help',     label: '/help',     send: '/help\r' },
      ],
    },
  },

  {
    id: 'vim',
    name: 'Vim',
    icon: '⌨',
    detect: ['vim', 'nvim', 'lazyvim', 'vi'],
    builtin: true,
    createdAt: 0,
    fixtures: [
      { id: 'esc',   label: 'Esc',    send: '\x1b', color: 'red',   wide: true },
      ARROW_PAD,
      { id: 'saves', label: 'Ctrl+S', send: '\x13', color: 'green' },
      { id: 'write', label: ':w',     send: ':w\r' },
    ],
    tabs: [
      { key: 'common',   name: '常用' },
      { key: 'keys',     name: '按键' },
      { key: 'commands', name: '命令' },
      { key: 'motion',   name: '移动' },
    ],
    defaultItems: {
      common: [
        { id: 'dd',   label: 'dd',  send: 'dd' },
        { id: 'yy',   label: 'yy',  send: 'yy' },
        { id: 'p',    label: 'p',   send: 'p' },
        { id: 'u',    label: 'u',   send: 'u' },
        { id: 'gg',   label: 'gg',  send: 'gg' },
        { id: 'G',    label: 'G',   send: 'G' },
        { id: 'quit', label: ':q!', send: ':q!\r' },
        { id: 'find', label: '/',   send: '/' },
      ],
    },
  },

  {
    id: 'lazygit',
    name: 'Lazygit',
    icon: '⎇',
    detect: ['lazygit'],
    builtin: true,
    createdAt: 0,
    fixtures: [
      ARROW_PAD,
      { id: 'enter', label: 'Enter', send: '\r' },
      { id: 'space', label: 'Space', send: ' ',  color: 'accent' },
      { id: 'tab',   label: 'Tab',   send: '\t' },
      { id: 'quit',  label: 'q',     send: 'q',  color: 'red' },
    ],
    tabs: [
      { key: 'common',   name: '常用' },
      { key: 'actions',  name: '操作' },
      { key: 'panels',   name: '面板' },
      { key: 'branches', name: '分支' },
    ],
    defaultItems: {
      common: [
        { id: 'commit',    label: 'c commit',    send: 'c' },
        { id: 'push',      label: 'P push',      send: 'P' },
        { id: 'pull',      label: 'p pull',      send: 'p' },
        { id: 'stage-all', label: 'a stage-all', send: 'a' },
        { id: 'amend',     label: 'A amend',     send: 'A' },
        { id: 'rebase',    label: 'R rebase',    send: 'R' },
        { id: 'discard',   label: 'd discard',   send: 'd' },
        { id: 'help',      label: '? help',      send: '?' },
      ],
    },
  },
];

// ─── Public API ──────────────────────────────────────────────────────────────

const LS_KEY = 'fab-scenes-v1';

const BUILTIN_IDS = new Set(BUILTIN_SCENES.map(s => s.id));

/**
 * Returns a deep clone of all builtin scenes to prevent accidental mutation.
 * @returns {Array<Object>}
 */
function getBuiltinScenes() {
  return JSON.parse(JSON.stringify(BUILTIN_SCENES));
}

/**
 * Reads custom scenes from localStorage.
 * @returns {Array<Object>}
 */
function _readCustomScenes() {
  try {
    const raw = (typeof localStorage !== 'undefined') && localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (_) {
    return [];
  }
}

/**
 * Writes custom scenes array to localStorage.
 * @param {Array<Object>} customs
 */
function _writeCustomScenes(customs) {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(LS_KEY, JSON.stringify(customs));
  }
}

/**
 * Loads all scenes: builtins merged with custom overrides.
 * Custom scenes override builtins with the same id.
 * @returns {Array<Object>}
 */
function loadScenes() {
  const builtins = getBuiltinScenes();
  const customs = _readCustomScenes();

  // Build a map from builtins, then overlay customs (custom wins on id conflict)
  const map = new Map(builtins.map(s => [s.id, s]));
  for (const c of customs) {
    map.set(c.id, c);
  }

  return Array.from(map.values());
}

/**
 * Adds a custom scene to localStorage persistence.
 * @param {Object} def - Scene definition (id and name required)
 * @throws {Error} if id or name is missing
 */
function addScene(def) {
  if (!def || !def.id) {
    throw new Error('Scene id is required');
  }
  if (!def.name) {
    throw new Error('Scene name is required');
  }

  const customs = _readCustomScenes();
  const newScene = Object.assign({}, def, {
    builtin: false,
    createdAt: Date.now(),
  });

  // Replace existing custom with same id, or append
  const idx = customs.findIndex(s => s.id === newScene.id);
  const updated = idx >= 0
    ? [...customs.slice(0, idx), newScene, ...customs.slice(idx + 1)]
    : [...customs, newScene];

  _writeCustomScenes(updated);
}

/**
 * Deletes a custom scene from localStorage.
 * @param {string} id - Scene id to delete
 * @throws {Error} if the scene is a builtin
 */
function deleteScene(id) {
  if (BUILTIN_IDS.has(id)) {
    throw new Error(`Cannot delete builtin scene: ${id}`);
  }

  const customs = _readCustomScenes();
  _writeCustomScenes(customs.filter(s => s.id !== id));
}

/**
 * Finds the best matching scene id for a given command string.
 * Scenes are sorted by createdAt descending so newer custom scenes win on conflict.
 * @param {string} cmd - Command string to match against scene detect patterns
 * @param {Array<Object>} scenes - Scenes to search (from loadScenes())
 * @returns {string} Matched scene id, or 'terminal' as fallback
 */
function matchScene(cmd, scenes) {
  // Sort by createdAt descending so newer (custom) scenes are checked first
  const sorted = [...scenes].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  for (const s of sorted) {
    if (!s.detect || s.detect.length === 0) continue;
    for (const pat of s.detect) {
      if (cmd.includes(pat)) {
        return s.id;
      }
    }
  }

  return 'terminal';
}

// ─── Browser global exposure (IIFE guards against re-execution) ──────────────
(function exposeBrowserGlobal() {
  const target = typeof window !== 'undefined' ? window : null;
  if (target && !target.FabScene) {
    target.FabScene = { getBuiltinScenes, loadScenes, addScene, deleteScene, matchScene };
  }
})();

// ─── ESM named exports (for vitest / Node ESM imports) ───────────────────────
export { getBuiltinScenes, loadScenes, addScene, deleteScene, matchScene };
