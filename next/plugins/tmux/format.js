// tmux `-F` formats and their parsers, carried over from server/tmux.js.

/**
 * Field separator for `-F` output. It has to be printable: tmux 3.6a replaces
 * every control character in format output with "_", which destroyed the
 * previous \x1f separator irreversibly.
 */
export const FIELD_SEP = '=:=';

/** stderr of a tmux call that found no server (or nothing on it). */
export const NO_SERVER_RE = /no server running|no sessions|error connecting[^\n]*No such file/i;

/**
 * Splits one `-F` line into `count` fields, reassembling the free-text field at
 * `textIndex` from whatever the anchored fields around it do not claim: a
 * window name may legitimately contain FIELD_SEP, the ids around it may not.
 */
export function splitFields(line, count, textIndex) {
  const parts = line.split(FIELD_SEP);
  if (parts.length <= count) return parts;
  const trailing = count - textIndex - 1;
  return [
    ...parts.slice(0, textIndex),
    parts.slice(textIndex, parts.length - trailing).join(FIELD_SEP),
    ...parts.slice(parts.length - trailing),
  ];
}

/**
 * The name of a pane's process. MSYS2 tmux on Windows reports a native program
 * as an escaped absolute path (C:\\Users\\me\\.local\\bin\\claude.exe).
 */
export function commandName(raw) {
  const text = String(raw || '');
  const base = text.split(/[\\/]+/).filter(Boolean).pop() || text;
  return base.replace(/\.exe$/i, '');
}

/** automatic-rename can name a Windows window after that same absolute path. */
export function windowName(raw) {
  const text = String(raw || '');
  return /^[A-Za-z]:[\\/]/.test(text) ? commandName(text) : text;
}

export function parseSessions(output) {
  if (!output || !output.trim()) return [];
  return output.trim().split('\n').map((line) => {
    const [id, name, windows, attached, lastAttached] = splitFields(line, 5, 1);
    return { id, name, windows: Number(windows), attached: attached === '1', lastAttached: Number(lastAttached) || null };
  });
}

export function parseWindows(output) {
  if (!output || !output.trim()) return [];
  return output.trim().split('\n').map((line) => {
    const [id, index, name, active, width, height, bell, activity] = splitFields(line, 8, 2);
    return {
      id,
      index: Number(index),
      name: windowName(name),
      active: active === '1',
      width: Number(width),
      height: Number(height),
      bell: bell === '1',
      activity: Number(activity),
    };
  });
}

/** The label is anchored last: pane labels may not contain FIELD_SEP, commands may. */
export function parsePanes(output) {
  if (!output || !output.trim()) return [];
  return output.trim().split('\n').map((line) => {
    const [id, x, y, width, height, active, command, label] = splitFields(line, 8, 6);
    return {
      id,
      x: Number(x),
      y: Number(y),
      width: Number(width),
      height: Number(height),
      active: active === '1',
      command: commandName(command),
      label: label || '',
    };
  });
}

/** The whole session/window/pane tree as one chained tmux command; see parseTree. */
export const TREE_COMMANDS = [
  'list-sessions', '-F', `S${FIELD_SEP}#{session_id}${FIELD_SEP}#{session_name}${FIELD_SEP}#{session_windows}${FIELD_SEP}#{session_attached}${FIELD_SEP}#{session_last_attached}`,
  ';',
  'list-windows', '-a', '-F', `W${FIELD_SEP}#{session_id}${FIELD_SEP}#{window_id}${FIELD_SEP}#{window_index}${FIELD_SEP}#{window_name}${FIELD_SEP}#{window_active}${FIELD_SEP}#{window_width}${FIELD_SEP}#{window_height}${FIELD_SEP}#{window_bell_flag}${FIELD_SEP}#{window_activity}`,
  ';',
  'list-panes', '-a', '-F', `P${FIELD_SEP}#{window_id}${FIELD_SEP}#{pane_id}${FIELD_SEP}#{pane_left}${FIELD_SEP}#{pane_top}${FIELD_SEP}#{pane_width}${FIELD_SEP}#{pane_height}${FIELD_SEP}#{pane_active}${FIELD_SEP}#{pane_current_command}${FIELD_SEP}#{@pane_label}`,
];

/** The server instance (pid:start_time) and the tree, from one client and one server. */
export const SNAPSHOT_COMMANDS = ['display-message', '-p', `I${FIELD_SEP}#{pid}:#{start_time}`, ';', ...TREE_COMMANDS];

/**
 * Assembles tagged S/W/P lines into sessions holding windows holding panes.
 * `list-panes -a` repeats a linked window's panes for every session holding it.
 */
export function parseTree(output) {
  const sessions = [];
  const windowsBySession = new Map();
  const panesByWindow = new Map();
  for (const line of String(output || '').split('\n')) {
    if (line.slice(1, 1 + FIELD_SEP.length) !== FIELD_SEP) continue;
    const kind = line[0];
    const rest = line.slice(1 + FIELD_SEP.length);
    if (kind === 'S') {
      sessions.push(...parseSessions(rest));
      continue;
    }
    if (kind !== 'W' && kind !== 'P') continue;
    const cut = rest.indexOf(FIELD_SEP);
    if (cut < 0) continue;
    const parent = rest.slice(0, cut);
    const body = rest.slice(cut + FIELD_SEP.length);
    const map = kind === 'W' ? windowsBySession : panesByWindow;
    const parsed = kind === 'W' ? parseWindows(body) : parsePanes(body);
    if (!map.has(parent)) map.set(parent, []);
    const known = map.get(parent);
    known.push(...(kind === 'P' ? parsed.filter((pane) => !known.some((other) => other.id === pane.id)) : parsed));
  }
  return sessions.map((session) => ({
    ...session,
    windowList: (windowsBySession.get(session.id) || []).map((window) => ({
      ...window,
      panes: panesByWindow.get(window.id) || [],
    })),
  }));
}

/** The instance line of SNAPSHOT_COMMANDS output, or null. */
export function parseInstance(output) {
  const line = String(output || '').split('\n').find((text) => text.startsWith(`I${FIELD_SEP}`));
  const value = line ? line.slice(1 + FIELD_SEP.length).trim() : '';
  return /^\d+:\d+$/.test(value) ? value : null;
}
