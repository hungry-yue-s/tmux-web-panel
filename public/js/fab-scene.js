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
      common: [],
      keys: [
        { id: 'ctrl-a', label: 'C-a', send: '\x01' },
        { id: 'ctrl-e', label: 'C-e', send: '\x05' },
        { id: 'ctrl-u', label: 'C-u', send: '\x15' },
        { id: 'ctrl-w', label: 'C-w', send: '\x17' },
        { id: 'ctrl-k', label: 'C-k', send: '\x0b' },
        { id: 'ctrl-d', label: 'C-d', send: '\x04' },
        { id: 'ctrl-z', label: 'C-z', send: '\x1a' },
        { id: 'alt-t',  label: 'Alt+T 思考', send: '\x1bt' },
        { id: 'ctrl-o', label: 'Ctrl+O 详细', send: '\x0f' },
        { id: 'pipe',   label: '|',   send: '|' },
        { id: 'and',    label: '&&',  send: '&&' },
        { id: 'gt',     label: '>',   send: '>' },
        { id: 'tilde',  label: '~',   send: '~' },
        { id: 'dollar', label: '$',   send: '$' },
      ],
      commands: [
        { id: 'claude',     label: 'claude',     send: 'claude --dangerously-skip-permissions\r' },
        { id: 'lazygit',    label: 'lazygit',    send: 'lazygit\r' },
        { id: 'vim',        label: 'vim',        send: 'vim ' },
        { id: 'ls',         label: 'ls',         send: 'ls\r' },
        { id: 'git-status', label: 'git status', send: 'git status\r' },
        { id: 'cd-up',      label: 'cd ..',      send: 'cd ..\r' },
        { id: 'pwd',        label: 'pwd',        send: 'pwd\r' },
        { id: 'clear',      label: 'clear',      send: 'clear\r' },
        { id: 'history',    label: 'history',    send: 'history\r' },
        { id: 'exit',       label: 'exit',       send: 'exit\r' },
      ],
      templates: [
        { id: 'tpl-git-log',  label: 'git log --oneline -20',       send: 'git log --oneline -20\r' },
        { id: 'tpl-docker',   label: 'docker ps -a',                send: 'docker ps -a\r' },
        { id: 'tpl-find',     label: 'find . -name "*.js"',         send: 'find . -name "*.js"\r' },
        { id: 'tpl-grep',     label: 'grep -rn "TODO" .',           send: 'grep -rn "TODO" .\r' },
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
      common: [],
      keys: [
        { id: 'esc',    label: 'Esc',    send: '\x1b' },
        { id: 'ctrl-c', label: 'C-c',    send: '\x03' },
        { id: 'enter',  label: 'Enter',  send: '\r' },
        { id: 'up',     label: '↑ 上条', send: '\x1b[A' },
        { id: 'down',   label: '↓ 下条', send: '\x1b[B' },
      ],
      slash: [
        { id: 'plan',     label: '/plan',     send: '/plan\r' },
        { id: 'review',   label: '/review',   send: '/review\r' },
        { id: 'commit',   label: '/commit',   send: '/commit\r' },
        { id: 'test',     label: '/test',     send: '/test\r' },
        { id: 'refactor', label: '/refactor', send: '/refactor\r' },
        { id: 'explain',  label: '/explain',  send: '/explain\r' },
        { id: 'init',     label: '/init',     send: '/init\r' },
        { id: 'help',     label: '/help',     send: '/help\r' },
      ],
      templates: [
        { id: 'tpl-analyze',  label: '分析这段代码的性能瓶颈',      send: '分析这段代码的性能瓶颈\r' },
        { id: 'tpl-tdd',      label: '用 TDD 实现这个功能',         send: '用 TDD 实现这个功能\r' },
        { id: 'tpl-pr',       label: '写一份 PR 描述并列出测试点',   send: '写一份 PR 描述并列出测试点\r' },
        { id: 'tpl-refactor', label: '帮我重构，保持接口不变',       send: '帮我重构，保持接口不变\r' },
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
      common: [],
      keys: [
        { id: 'i',  label: 'i',  send: 'i' },
        { id: 'a',  label: 'a',  send: 'a' },
        { id: 'o',  label: 'o',  send: 'o' },
        { id: 'x',  label: 'x',  send: 'x' },
        { id: 'dd', label: 'dd', send: 'dd' },
        { id: 'yy', label: 'yy', send: 'yy' },
        { id: 'p',  label: 'p',  send: 'p' },
        { id: 'u',  label: 'u',  send: 'u' },
        { id: 'dot', label: '.',  send: '.' },
        { id: 'v',  label: 'v',  send: 'v' },
        { id: 'V',  label: 'V',  send: 'V' },
        { id: 'star', label: '*', send: '*' },
      ],
      commands: [
        { id: 'wq',    label: ':wq',    send: ':wq\r' },
        { id: 'quit',  label: ':q!',    send: ':q!\r' },
        { id: 'qa',    label: ':qa',    send: ':qa\r' },
        { id: 'subst', label: ':%s/',   send: ':%s/' },
        { id: 'setnu', label: ':set nu',send: ':set nu\r' },
        { id: 'edit',  label: ':e ',    send: ':e ' },
        { id: 'bn',    label: ':bn',    send: ':bn\r' },
        { id: 'bp',    label: ':bp',    send: ':bp\r' },
      ],
      motion: [
        { id: 'h',      label: 'h',  send: 'h' },
        { id: 'j',      label: 'j',  send: 'j' },
        { id: 'k',      label: 'k',  send: 'k' },
        { id: 'l',      label: 'l',  send: 'l' },
        { id: 'w',      label: 'w',  send: 'w' },
        { id: 'b',      label: 'b',  send: 'b' },
        { id: 'e',      label: 'e',  send: 'e' },
        { id: 'gg',     label: 'gg', send: 'gg' },
        { id: 'G',      label: 'G',  send: 'G' },
        { id: 'zero',   label: '0',  send: '0' },
        { id: 'dollar', label: '$',  send: '$' },
        { id: 'pct',    label: '%',  send: '%' },
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
      common: [],
      actions: [
        { id: 'stage',     label: 'Space 暂存',  send: ' ' },
        { id: 'stage-all', label: 'a 全选',      send: 'a' },
        { id: 'discard',   label: 'd 丢弃',      send: 'd' },
        { id: 'edit',      label: 'e 编辑',      send: 'e' },
        { id: 'commit',    label: 'c 提交',      send: 'c' },
        { id: 'amend',     label: 'A amend',     send: 'A' },
        { id: 'push',      label: 'P 推送',      send: 'P' },
        { id: 'pull',      label: 'p 拉取',      send: 'p' },
        { id: 'fetch',     label: 'f fetch',     send: 'f' },
        { id: 'stash',     label: 's stash',     send: 's' },
        { id: 'help',      label: '? 帮助',      send: '?' },
      ],
      panels: [
        { id: 'p1', label: '1 状态', send: '1' },
        { id: 'p2', label: '2 文件', send: '2' },
        { id: 'p3', label: '3 分支', send: '3' },
        { id: 'p4', label: '4 提交', send: '4' },
        { id: 'p5', label: '5 暂存', send: '5' },
        { id: 'stab',  label: 'Shift+Tab', send: '\x1b[Z' },
      ],
      branches: [
        { id: 'new-branch', label: 'n 新建', send: 'n' },
        { id: 'checkout',   label: 'Space 切换', send: ' ' },
        { id: 'merge',      label: 'M merge',   send: 'M' },
        { id: 'rebase',     label: 'R rebase',   send: 'R' },
        { id: 'del-branch', label: 'd 删除',     send: 'd' },
        { id: 'rename',     label: 'r 重命名',   send: 'r' },
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

