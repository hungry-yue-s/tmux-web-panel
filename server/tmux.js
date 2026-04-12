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

/**
 * Validates a tmux window index (non-negative integer string).
 */
export function validateWindowIndex(index) {
  if (typeof index !== 'string') return false;
  if (!WINDOW_INDEX_RE.test(index)) return false;
  const num = Number(index);
  return Number.isInteger(num) && num >= 0;
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
 * Parses `tmux list-windows -F '#{window_index}|#{window_name}|#{window_active}|#{window_width}|#{window_height}|#{window_bell_flag}'`
 */
export function parseWindows(output) {
  if (!output || output.trim().length === 0) return [];
  return output.trim().split('\n').map((line) => {
    const [index, name, active, width, height, bell] = line.split('|');
    return {
      index: Number(index),
      name,
      active: active === '1',
      width: Number(width),
      height: Number(height),
      bell: bell === '1',
    };
  });
}

/**
 * Parses `tmux list-panes -F '#{pane_id}|#{pane_left}|#{pane_top}|#{pane_width}|#{pane_height}|#{pane_active}|#{pane_current_command}'`
 */
export function parsePanes(output) {
  if (!output || output.trim().length === 0) return [];
  return output.trim().split('\n').map((line) => {
    const [id, x, y, width, height, active, command] = line.split('|');
    return {
      id,
      x: Number(x),
      y: Number(y),
      width: Number(width),
      height: Number(height),
      active: active === '1',
      command,
    };
  });
}

/**
 * Parses `tmux list-panes -s -F '#{window_index}|#{pane_id}|#{pane_current_command}'`
 */
export function parsePaneCommands(output) {
  if (!output || output.trim().length === 0) return [];
  return output.trim().split('\n').map((line) => {
    const [windowIndex, paneId, command, path, pid] = line.split('|');
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

// --- High-Level Functions ---

export async function listSessions() {
  const stdout = await tmuxExec([
    'list-sessions',
    '-F',
    '#{session_name}|#{session_windows}|#{session_attached}|#{session_last_attached}',
  ]);
  return parseSessions(stdout);
}

export async function listWindows(session) {
  requireValidSessionName(session);
  const stdout = await tmuxExec([
    'list-windows',
    '-t', session,
    '-F',
    '#{window_index}|#{window_name}|#{window_active}|#{window_width}|#{window_height}|#{window_bell_flag}',
  ]);
  return parseWindows(stdout);
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
    '#{pane_id}|#{pane_left}|#{pane_top}|#{pane_width}|#{pane_height}|#{pane_active}|#{pane_current_command}',
  ]);
  return parsePanes(stdout);
}

export async function listPaneCommands(session) {
  requireValidSessionName(session);
  const stdout = await tmuxExec([
    'list-panes', '-s', '-t', session, '-F',
    '#{window_index}|#{pane_id}|#{pane_current_command}|#{pane_current_path}|#{pane_pid}',
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

export async function capturePane(paneId) {
  requireValidPaneId(paneId);
  const stdout = await tmuxExec([
    'capture-pane', '-t', paneId, '-p',
  ]);
  return stdout;
}
