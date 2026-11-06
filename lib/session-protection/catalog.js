/**
 * Which programs session protection reopens after tmux restarts.
 *
 * The user picks groups ("editors"), not process names: a group says in plain
 * words what reopening means for its programs. Programs outside every group
 * are offered one by one, and only once they have actually been seen in a
 * pane, because rerunning an arbitrary command (a deploy, a migration) must be
 * a deliberate choice.
 */

const SHELLS = ['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'nu', 'elvish', 'xonsh', 'pwsh'];

export const PROGRAM_GROUPS = Object.freeze([
  {
    id: 'ai',
    label: 'AI 编程助手',
    detail: 'claude、codex：重新打开，并接着这个目录里最近的一次对话',
    members: ['claude', 'codex'],
    // A plain rerun would start a fresh conversation; these resume instead.
    resume: { claude: 'claude --continue', codex: 'codex resume --last' },
    defaultOn: true,
  },
  {
    id: 'editors',
    label: '编辑器',
    detail: 'vim、nvim、emacs、nano 等：重新打开上次打开的文件',
    members: ['vim', 'nvim', 'vi', 'view', 'emacs', 'nano', 'micro', 'hx', 'helix'],
    defaultOn: true,
  },
  {
    id: 'viewers',
    label: '查看器',
    detail: 'less、man、tail 等：重新打开上次查看的内容',
    members: ['less', 'more', 'man', 'tail', 'bat'],
    defaultOn: true,
  },
  {
    id: 'monitors',
    label: '系统监控',
    detail: 'top、htop、btop',
    members: ['top', 'htop', 'btop', 'glances'],
    defaultOn: true,
  },
  {
    id: 'shells',
    label: '在窗格里另开的 shell',
    detail: '例如在 bash 窗格里又打开的 fish、zsh',
    members: SHELLS,
    defaultOn: true,
  },
]);

export const DEFAULT_PROGRAMS = Object.freeze(PROGRAM_GROUPS.filter((group) => group.defaultOn).map((group) => group.id));

const OTHER_PREFIX = 'cmd:';
const NAME_RE = /^[\w.+-]{1,64}$/;

/** `C:\x\claude.exe --y` / `/usr/bin/vim a` / `-bash` → `claude` / `vim` / `bash`. */
export function programName(command) {
  const text = String(command || '').trim();
  if (!text) return null;
  // printf %q escapes spaces and backslashes; undo it for the first word only.
  const match = text.match(/^((?:\\.|[^\s\\])+)/);
  const first = (match ? match[1] : text).replace(/\\(.)/g, '$1');
  const base = first.split(/[\\/]/).pop().replace(/^-/, '').replace(/\.exe$/i, '');
  return base ? base.toLowerCase() : null;
}

function groupOf(name) {
  return PROGRAM_GROUPS.find((group) => group.members.includes(name)) || null;
}

/** The choice id a program falls under: a group id, or `cmd:<name>`. */
export function choiceFor(name) {
  if (!name) return null;
  const group = groupOf(name);
  return group ? group.id : OTHER_PREFIX + name;
}

export function isValidChoice(id) {
  if (typeof id !== 'string') return false;
  if (PROGRAM_GROUPS.some((group) => group.id === id)) return true;
  return id.startsWith(OTHER_PREFIX) && NAME_RE.test(id.slice(OTHER_PREFIX.length));
}

/**
 * What to type into a restored pane, or null to leave it at its shell.
 * @param {{ command: string, fullCommand: string }} pane as saved
 * @param {string[]} selected choice ids
 * @param {string|null} defaultShell the shell tmux starts panes with
 */
export function restoreCommand(pane, selected, defaultShell) {
  const full = String(pane.fullCommand || '').trim();
  const name = programName(full) || programName(pane.command);
  if (!name || name === defaultShell) return null;
  const choice = choiceFor(name);
  if (!selected.includes(choice)) return null;
  const group = groupOf(name);
  if (group && group.resume && group.resume[name]) return group.resume[name];
  return full || name;
}

/**
 * The choices to show: every group, plus programs seen in panes that no group
 * covers. `seen` maps a program name to an example full command.
 */
export function choiceList(selected, seen = new Map(), defaultShell = null) {
  const choices = PROGRAM_GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    detail: group.detail,
    selected: selected.includes(group.id),
  }));
  const others = [...seen.entries()]
    .filter(([name]) => name && name !== defaultShell && !groupOf(name) && NAME_RE.test(name))
    .sort(([a], [b]) => a.localeCompare(b));
  for (const [name, example] of others) {
    choices.push({
      id: OTHER_PREFIX + name,
      label: name,
      detail: example ? '重新运行上次的命令：' + example.slice(0, 80) : '重新运行上次的命令',
      selected: selected.includes(OTHER_PREFIX + name),
    });
  }
  // A chosen program that is no longer around stays visible so it can be unchecked.
  for (const id of selected) {
    if (id.startsWith(OTHER_PREFIX) && !choices.some((choice) => choice.id === id)) {
      choices.push({ id, label: id.slice(OTHER_PREFIX.length), detail: '重新运行上次的命令', selected: true });
    }
  }
  return choices;
}

/**
 * The same choices as tmux-resurrect options, so its own prefix + Ctrl-r
 * reopens what the panel would. Returned as option values.
 */
export function resurrectProcessOptions(selected) {
  const entries = [];
  for (const id of selected) {
    const group = PROGRAM_GROUPS.find((candidate) => candidate.id === id);
    if (group) {
      for (const member of group.members) {
        const resume = group.resume && group.resume[member];
        entries.push(resume ? `"~${member}->${resume}"` : member);
      }
    } else if (id.startsWith(OTHER_PREFIX)) {
      entries.push(id.slice(OTHER_PREFIX.length));
    }
  }
  return {
    // Replace resurrect's built-in list so unchecking a group really removes
    // it. Not '': resurrect reads an empty option as unset and falls back.
    defaultProcesses: '_twp_none_',
    processes: entries.length ? entries.join(' ') : 'false',
  };
}
