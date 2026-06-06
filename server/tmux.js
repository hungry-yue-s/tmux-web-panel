import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const TMUX_BIN = 'tmux';
const EXEC_TIMEOUT = 5000;

// --- Validation ---

const SESSION_NAME_RE = /^[\w\-\u4e00-\u9fff][\w\-\u4e00-\u9fff\s]*$/;
const WINDOW_NAME_RE = /^[^\x00-\x1f:]*$/;
const PANE_ID_RE = /^%\d+$/;
const WINDOW_INDEX_RE = /^\d+$/;
const WINDOW_ID_RE = /^@\d+$/;

const FIELD_SEP = '\x1f'; // ASCII Unit Separator \u2014 cannot occur in app-created tmux names

/**
 * Validates a tmux session or window name.
 * Allowed characters: [a-zA-Z0-9_\-\u4e00-\u9fff\s], must not be empty/whitespace-only.
 */
export function validateSessionName(name) {
  if (typeof name !== 'string') return false;
  if (name.trim().length === 0) return false;
  return SESSION_NAME_RE.test(name);
}

/**
 * Validates a tmux window name.
 * More permissive than session names — disallows control chars and colon (tmux separator).
 */
export function validateWindowName(name) {
  if (typeof name !== 'string') return false;
  if (name.trim().length === 0) return false;
  return WINDOW_NAME_RE.test(name);
}

/**
 * Validates a tmux pane ID (format: %<digits>).
 */
export function validatePaneId(id) {
  if (typeof id !== 'string') return false;
  return PANE_ID_RE.test(id);
}

const PANE_LABEL_MAX_LEN = 32;

/**
 * Validates a user-supplied pane label. Stored as the tmux per-pane user
 * option @pane_label. Disallows control chars (incl. FIELD_SEP \x1f and
 * newlines) so it can't corrupt list-panes parsing.
 */
export function validatePaneLabel(label) {
  if (typeof label !== 'string') return false;
  if (label.length > PANE_LABEL_MAX_LEN) return false;
  return !/[\x00-\x1f]/.test(label);
}

/**
 * Validates a tmux window index (non-negative integer string).
 */
export function validateWindowIndex(index) {
  if (typeof index !== 'string') return false;
  if (!WINDOW_INDEX_RE.test(index)) return false;
  const num = Number(index);
  return Number.isInteger(num) && num >= 0;
}

/**
 * Validates a tmux window ID (format: @<digits>). Window IDs are stable across
 * renames/moves/renumbers — prefer over index for destructive operations.
 */
export function validateWindowId(id) {
  if (typeof id !== 'string') return false;
  return WINDOW_ID_RE.test(id);
}

// --- Parsing ---

/**
 * Parses `tmux list-sessions -F '#{session_name}|#{session_windows}|#{session_attached}|#{session_last_attached}'`
 */
export function parseSessions(output) {
  if (!output || output.trim().length === 0) return [];
  return output.trim().split('\n').map((line) => {
    const [name, windows, attached, lastActivity] = line.split('|');
    return {
      name,
      windows: Number(windows),
      attached: attached === '1',
      lastActivity,
    };
  });
}

/**
 * Parses `tmux list-windows -F '#{window_id}\x1f#{window_index}\x1f...'`
 * 8 fields: id, index, name, active, width, height, bell, activity.
 */
export function parseWindows(output) {
  if (!output || output.trim().length === 0) return [];
  return output.trim().split('\n').map((line) => {
    const [id, index, name, active, width, height, bell, activity] = line.split(FIELD_SEP);
    return {
      id,
      index: Number(index),
      name,
      active: active === '1',
      width: Number(width),
      height: Number(height),
      bell: bell === '1',
      activity: Number(activity),
    };
  });
}

/**
 * Parses `tmux list-panes -F '#{pane_id}\x1f#{pane_left}\x1f...'`
 */
export function parsePanes(output) {
  if (!output || output.trim().length === 0) return [];
  return output.trim().split('\n').map((line) => {
    const [id, x, y, width, height, active, command, label] = line.split(FIELD_SEP);
    return {
      id,
      x: Number(x),
      y: Number(y),
      width: Number(width),
      height: Number(height),
      active: active === '1',
      command,
      label: label || '',
    };
  });
}

/**
 * Parses `tmux list-panes -s -F '#{window_index}\x1f#{pane_id}\x1f...'`
 */
export function parsePaneCommands(output) {
  if (!output || output.trim().length === 0) return [];
  return output.trim().split('\n').map((line) => {
    const [windowIndex, paneId, command, path, pid] = line.split(FIELD_SEP);
    return { windowIndex: Number(windowIndex), paneId, command, path: path || '', pid: pid ? Number(pid) : 0 };
  });
}

// --- Exec Wrapper ---

/**
 * Executes a tmux command with array arguments via execFile (no shell).
 * @param {string[]} args - tmux subcommand and arguments
 * @returns {Promise<string>} stdout
 */
export async function tmuxExec(args) {
  const { stdout } = await execFileAsync(TMUX_BIN, args, {
    timeout: EXEC_TIMEOUT,
  });
  return stdout;
}

// --- Validation Helpers ---

function requireValidSessionName(name) {
  if (!validateSessionName(name)) {
    throw new Error(`Invalid session name: ${name}`);
  }
}

function requireValidWindowName(name) {
  if (!validateWindowName(name)) {
    throw new Error(`Invalid window name: ${name}`);
  }
}

function requireValidPaneId(id) {
  if (!validatePaneId(id)) {
    throw new Error(`Invalid pane ID: ${id}`);
  }
}

function requireValidWindowIndex(index) {
  if (!validateWindowIndex(index)) {
    throw new Error(`Invalid window index: ${index}`);
  }
}

function requireValidWindowId(id) {
  if (!validateWindowId(id)) {
    throw new Error(`Invalid window ID: ${id}`);
  }
}

// --- High-Level Functions ---

export async function listSessions() {
  try {
    const stdout = await tmuxExec([
      'list-sessions',
      '-F',
      '#{session_name}|#{session_windows}|#{session_attached}|#{session_last_attached}',
    ]);
    return parseSessions(stdout);
  } catch (err) {
    // tmux server not running yet → treat as "no sessions" rather than error.
    // The web panel intentionally does not auto-start tmux; recovery is the
    // job of tmux-server.service + tmux-continuum auto-restore (see CLAUDE.md).
    if (typeof err?.stderr === 'string' && err.stderr.includes('no server running')) {
      return [];
    }
    throw err;
  }
}

export async function listWindows(session) {
  requireValidSessionName(session);
  const stdout = await tmuxExec([
    'list-windows',
    '-t', session,
    '-F',
    `#{window_id}${FIELD_SEP}#{window_index}${FIELD_SEP}#{window_name}${FIELD_SEP}#{window_active}${FIELD_SEP}#{window_width}${FIELD_SEP}#{window_height}${FIELD_SEP}#{window_bell_flag}${FIELD_SEP}#{window_activity}`,
  ]);
  return parseWindows(stdout);
}

/**
 * Returns the set of all live window_id values across all sessions.
 * Per-session errors are swallowed so one bad session doesn't abort the scan.
 *
 * @returns {Promise<Set<string>>}
 */
export async function listAllWindowIds() {
  const sessions = await listSessions();
  const all = new Set();
  for (const s of sessions) {
    try {
      const windows = await listWindows(s.name);
      for (const w of windows) {
        if (w.id) all.add(w.id);
      }
    } catch {
      // Skip sessions we can't read.
    }
  }
  return all;
}

export async function unzoomWindow(session, window) {
  requireValidSessionName(session);
  requireValidWindowIndex(window);
  try {
    const flag = await tmuxExec([
      'display-message', '-p', '-t', `${session}:${window}`,
      '#{window_zoomed_flag}',
    ]);
    if (flag.trim() === '1') {
      await tmuxExec(['resize-pane', '-Z', '-t', `${session}:${window}`]);
    }
  } catch {
    // Ignore — window may not exist or already unzoomed
  }
}

export async function listPanes(session, window) {
  requireValidSessionName(session);
  requireValidWindowIndex(window);
  const stdout = await tmuxExec([
    'list-panes',
    '-t', `${session}:${window}`,
    '-F',
    `#{pane_id}${FIELD_SEP}#{pane_left}${FIELD_SEP}#{pane_top}${FIELD_SEP}#{pane_width}${FIELD_SEP}#{pane_height}${FIELD_SEP}#{pane_active}${FIELD_SEP}#{pane_current_command}${FIELD_SEP}#{@pane_label}`,
  ]);
  return parsePanes(stdout);
}

export async function listPaneCommands(session) {
  requireValidSessionName(session);
  const stdout = await tmuxExec([
    'list-panes', '-s', '-t', session, '-F',
    `#{window_index}${FIELD_SEP}#{pane_id}${FIELD_SEP}#{pane_current_command}${FIELD_SEP}#{pane_current_path}${FIELD_SEP}#{pane_pid}`,
  ]);
  return parsePaneCommands(stdout);
}

export async function createSession(name) {
  requireValidSessionName(name);
  await tmuxExec(['new-session', '-d', '-s', name]);
}

export async function createWindow(session, name) {
  requireValidSessionName(session);
  const args = ['new-window', '-t', session + ':', '-P', '-F', '#{window_index}'];
  if (name) {
    requireValidWindowName(name);
    args.push('-n', name);
  }
  const stdout = await tmuxExec(args);
  return stdout.trim();
}

export async function splitPane(paneId, direction) {
  requireValidPaneId(paneId);
  const flag = direction === 'horizontal' ? '-h' : '-v';
  await tmuxExec(['split-window', flag, '-t', paneId]);
}

export async function renameSession(name, newName) {
  requireValidSessionName(name);
  requireValidSessionName(newName);
  await tmuxExec(['rename-session', '-t', name, newName]);
}

export async function renameWindow(session, index, newName) {
  requireValidSessionName(session);
  requireValidWindowIndex(index);
  requireValidWindowName(newName);
  await tmuxExec(['rename-window', '-t', `${session}:${index}`, newName]);
}

export async function killSession(name) {
  requireValidSessionName(name);
  await tmuxExec(['kill-session', '-t', name]);
}

export async function killWindow(session, index) {
  requireValidSessionName(session);
  requireValidWindowIndex(index);
  await tmuxExec(['kill-window', '-t', `${session}:${index}`]);
}

export async function killPane(paneId) {
  requireValidPaneId(paneId);
  await tmuxExec(['kill-pane', '-t', paneId]);
}

export async function selectPane(paneId) {
  requireValidPaneId(paneId);
  await tmuxExec(['select-pane', '-t', paneId]);
}

/**
 * Sets or clears a pane's custom label via the @pane_label user option.
 * Empty/nullish label clears it. tmux redraws the pane border automatically.
 */
export async function setPaneLabel(paneId, label) {
  requireValidPaneId(paneId);
  if (label === '' || label == null) {
    await tmuxExec(['set-option', '-pu', '-t', paneId, '@pane_label']);
    return;
  }
  if (!validatePaneLabel(label)) {
    throw new Error(`Invalid pane label: ${label}`);
  }
  await tmuxExec(['set-option', '-p', '-t', paneId, '@pane_label', label]);
}

export async function sendKeys(paneId, command) {
  requireValidPaneId(paneId);
  if (typeof command !== 'string') {
    throw new Error('Command must be a string');
  }
  await tmuxExec(['send-keys', '-t', paneId, command, 'Enter']);
}

export async function selectLayout(session, window, layout) {
  requireValidSessionName(session);
  requireValidWindowIndex(window);
  const validLayouts = ['even-horizontal', 'even-vertical', 'main-horizontal', 'main-vertical', 'tiled'];
  if (!validLayouts.includes(layout)) {
    throw new Error(`Invalid layout: ${layout}`);
  }
  await tmuxExec(['select-layout', '-t', `${session}:${window}`, layout]);
}

export async function resizePane(paneId, direction, amount) {
  requireValidPaneId(paneId);
  const validDirs = ['U', 'D', 'L', 'R'];
  if (!validDirs.includes(direction)) {
    throw new Error(`Invalid direction: ${direction}`);
  }
  if (!Number.isInteger(amount) || amount < 1) {
    throw new Error(`Invalid amount: ${amount}`);
  }
  await tmuxExec(['resize-pane', '-t', paneId, `-${direction}`, String(amount)]);
}

export async function swapPane(srcPaneId, dstPaneId) {
  requireValidPaneId(srcPaneId);
  requireValidPaneId(dstPaneId);
  await tmuxExec(['swap-pane', '-s', srcPaneId, '-t', dstPaneId]);
}

export async function capturePane(paneId, { escape = false } = {}) {
  requireValidPaneId(paneId);
  const args = ['capture-pane'];
  if (escape) args.push('-e');
  args.push('-t', paneId, '-p');
  const stdout = await tmuxExec(args);
  return stdout;
}

// Border title shown by tmux on each pane's top border (pane-border-status top).
// [label] only when @pane_label is set; the active pane is reversed for contrast.
export const PANE_BORDER_FORMAT =
  '#{?pane_active,#[reverse],} #{?#{@pane_label},[#{@pane_label}] ,}#{pane_index}:#{pane_current_command} #[default]';

/**
 * Globally enables the pane border title line so pane labels render.
 * Idempotent and best-effort — throws if no tmux server; callers should catch.
 */
export async function ensurePaneBorderConfig() {
  await tmuxExec(['set-option', '-g', 'pane-border-status', 'top']);
  await tmuxExec(['set-option', '-g', 'pane-border-format', PANE_BORDER_FORMAT]);
}

// --- by-id helpers (use window_id @N — stable across renames/moves/renumbers) ---

export async function renameWindowById(windowId, newName) {
  requireValidWindowId(windowId);
  requireValidWindowName(newName);
  await tmuxExec(['rename-window', '-t', windowId, newName]);
}

export async function killWindowById(windowId) {
  requireValidWindowId(windowId);
  await tmuxExec(['kill-window', '-t', windowId]);
}

export async function moveWindowById(windowId, dstSession) {
  requireValidWindowId(windowId);
  requireValidSessionName(dstSession);
  // '=<name>:' forces exact-name match (no prefix collision like foo vs foobar).
  await tmuxExec(['move-window', '-s', windowId, '-t', '=' + dstSession + ':']);
}
