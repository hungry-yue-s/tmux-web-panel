import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const TMUX_BIN = 'tmux';
const EXEC_TIMEOUT = 5000;
const EXEC_MAX_BUFFER = 4 * 1024 * 1024;

// --- Validation ---

const SESSION_NAME_RE = /^[\w\-\u4e00-\u9fff][\w\-\u4e00-\u9fff\s]*$/;
const WINDOW_NAME_RE = /^[^\x00-\x1f:]*$/;
const PANE_ID_RE = /^%\d+$/;
const WINDOW_INDEX_RE = /^\d+$/;
const WINDOW_ID_RE = /^@\d+$/;
const SESSION_ID_RE = /^\$\d+$/;

const FIELD_SEP = '\x1f'; // ASCII Unit Separator — cannot occur in app-created tmux names
// tmux 3.5a on macOS renders control characters in format output using vis(3)
// notation, so FIELD_SEP arrives as the four literal characters "\037".
const ESCAPED_FIELD_SEP = '\\037';

function splitTmuxFields(line) {
  return line.includes(FIELD_SEP)
    ? line.split(FIELD_SEP)
    : line.split(ESCAPED_FIELD_SEP);
}

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
 * Validates a tmux session ID (format: $<digits>). Session IDs are stable across
 * renames — prefer over name when an identity must survive edits.
 */
export function validateSessionId(id) {
  if (typeof id !== 'string') return false;
  return SESSION_ID_RE.test(id);
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
 * Parses `tmux list-sessions -F '#{session_id}\x1f#{session_name}\x1f#{session_windows}\x1f#{session_attached}\x1f#{session_last_attached}'`
 *
 * Also accepts the legacy pipe-delimited 4-field output (no session_id), which
 * yields `id: null`.
 */
export function parseSessions(output) {
  if (!output || output.trim().length === 0) return [];
  return output.trim().split('\n').map((line) => {
    const fields = splitTmuxFields(line);
    if (fields.length < 5) {
      const [name, windows, attached, lastActivity] = line.split('|');
      return { id: null, name, windows: Number(windows), attached: attached === '1', lastActivity };
    }
    const [id, name, windows, attached, lastActivity] = fields;
    return {
      id,
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
    const [id, index, name, active, width, height, bell, activity] = splitTmuxFields(line);
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
    const [id, x, y, width, height, active, command, label] = splitTmuxFields(line);
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
    const [windowIndex, paneId, command, path, pid] = splitTmuxFields(line);
    return { windowIndex: Number(windowIndex), paneId, command, path: path || '', pid: pid ? Number(pid) : 0 };
  });
}

/** Parses the stable address returned by `display-message -t %pane`. */
export function parsePaneAddress(output) {
  if (!output || output.trim().length === 0) return null;
  const [paneId, sessionId, sessionName, windowId, windowIndex] = splitTmuxFields(output.trim());
  if (!paneId || !windowId) return null;
  return {
    paneId,
    sessionId: sessionId || sessionName,
    sessionName,
    windowId,
    windowIndex: Number(windowIndex),
  };
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
    maxBuffer: EXEC_MAX_BUFFER,
  });
  return stdout;
}

/**
 * Executor contract consumed by createTmuxApi:
 *   exec(command, args, options) -> Promise<{ stdout, stderr }>
 * The local executor runs execFile directly; the OpenSSH executor forwards the
 * same argv to a remote host. Both keep arguments as arrays — never a shell string.
 */
export const localExecutor = Object.freeze({
  id: 'local',
  transport: 'local',
  async exec(command, args, options = {}) {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: options.timeout || EXEC_TIMEOUT,
      maxBuffer: options.maxBuffer || EXEC_MAX_BUFFER,
    });
    return { stdout, stderr };
  },
});

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

/**
 * Accepts either a stable session ID ($N) or a session name and returns the
 * value to pass to `-t`. Callers holding a stable ID stay correct across renames.
 */
export function sessionTarget(idOrName) {
  if (validateSessionId(idOrName)) return idOrName;
  requireValidSessionName(idOrName);
  return idOrName;
}

// --- High-Level Functions ---

/**
 * Binds every tmux operation to one executor so local and remote hosts share a
 * single set of format strings, parsers and validation rules.
 *
 * @param {{ exec: (command: string, args: string[], options?: object) => Promise<{stdout: string, stderr: string}> }} executor
 */
export function createTmuxApi(executor) {
  if (!executor || typeof executor.exec !== 'function') {
    throw new Error('createTmuxApi requires an executor with exec()');
  }
  const bin = executor.tmuxBin || TMUX_BIN;

  async function run(args, options) {
    const { stdout } = await executor.exec(bin, args, options);
    return stdout;
  }

  async function listSessions() {
    try {
      const stdout = await run([
        'list-sessions',
        '-F',
        `#{session_id}${FIELD_SEP}#{session_name}${FIELD_SEP}#{session_windows}${FIELD_SEP}#{session_attached}${FIELD_SEP}#{session_last_attached}`,
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

  async function listWindows(session) {
    const target = sessionTarget(session);
    const stdout = await run([
      'list-windows',
      '-t', target,
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
  async function listAllWindowIds() {
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

  async function unzoomWindow(session, window) {
    const target = sessionTarget(session);
    requireValidWindowIndex(window);
    try {
      const flag = await run([
        'display-message', '-p', '-t', `${target}:${window}`,
        '#{window_zoomed_flag}',
      ]);
      if (flag.trim() === '1') {
        await run(['resize-pane', '-Z', '-t', `${target}:${window}`]);
      }
    } catch {
      // Ignore — window may not exist or already unzoomed
    }
  }

  async function listPanes(session, window) {
    const target = sessionTarget(session);
    requireValidWindowIndex(window);
    const stdout = await run([
      'list-panes',
      '-t', `${target}:${window}`,
      '-F',
      `#{pane_id}${FIELD_SEP}#{pane_left}${FIELD_SEP}#{pane_top}${FIELD_SEP}#{pane_width}${FIELD_SEP}#{pane_height}${FIELD_SEP}#{pane_active}${FIELD_SEP}#{pane_current_command}${FIELD_SEP}#{@pane_label}`,
    ]);
    return parsePanes(stdout);
  }

  /** Panes of one window addressed by stable window ID (@N). */
  async function listPanesByWindowId(windowId) {
    requireValidWindowId(windowId);
    const stdout = await run([
      'list-panes',
      '-t', windowId,
      '-F',
      `#{pane_id}${FIELD_SEP}#{pane_left}${FIELD_SEP}#{pane_top}${FIELD_SEP}#{pane_width}${FIELD_SEP}#{pane_height}${FIELD_SEP}#{pane_active}${FIELD_SEP}#{pane_current_command}${FIELD_SEP}#{@pane_label}`,
    ]);
    return parsePanes(stdout);
  }

  async function listPaneCommands(session) {
    const target = sessionTarget(session);
    const stdout = await run([
      'list-panes', '-s', '-t', target, '-F',
      `#{window_index}${FIELD_SEP}#{pane_id}${FIELD_SEP}#{pane_current_command}${FIELD_SEP}#{pane_current_path}${FIELD_SEP}#{pane_pid}`,
    ]);
    return parsePaneCommands(stdout);
  }

  /** Resolve one pane without walking the complete Session/Window tree. */
  async function getPaneAddress(paneId) {
    requireValidPaneId(paneId);
    const stdout = await run([
      'display-message', '-p', '-t', paneId,
      `#{pane_id}${FIELD_SEP}#{session_id}${FIELD_SEP}#{session_name}${FIELD_SEP}#{window_id}${FIELD_SEP}#{window_index}`,
    ]);
    return parsePaneAddress(stdout);
  }

  async function createSession(name) {
    requireValidSessionName(name);
    await run(['new-session', '-d', '-s', name]);
  }

  /** Creates a session and returns its stable session ID. */
  async function createSessionReturningId(name) {
    requireValidSessionName(name);
    const stdout = await run(['new-session', '-d', '-s', name, '-P', '-F', '#{session_id}']);
    return stdout.trim();
  }

  async function createWindow(session, name) {
    const target = sessionTarget(session);
    const args = ['new-window', '-t', target + ':', '-P', '-F', '#{window_index}'];
    if (name) {
      requireValidWindowName(name);
      args.push('-n', name);
    }
    const stdout = await run(args);
    return stdout.trim();
  }

  /** Creates a window and returns its stable window ID (@N). */
  async function createWindowReturningId(session, name) {
    const target = sessionTarget(session);
    const args = ['new-window', '-t', target + ':', '-P', '-F', '#{window_id}'];
    if (name) {
      requireValidWindowName(name);
      args.push('-n', name);
    }
    const stdout = await run(args);
    return stdout.trim();
  }

  async function splitPane(paneId, direction) {
    requireValidPaneId(paneId);
    const flag = direction === 'horizontal' ? '-h' : '-v';
    await run(['split-window', flag, '-t', paneId]);
  }

  /** Splits a pane and returns the new pane's stable ID (%N). */
  async function splitPaneReturningId(paneId, direction) {
    requireValidPaneId(paneId);
    const flag = direction === 'horizontal' ? '-h' : '-v';
    const stdout = await run(['split-window', flag, '-t', paneId, '-P', '-F', '#{pane_id}']);
    return stdout.trim();
  }

  async function renameSession(name, newName) {
    const target = sessionTarget(name);
    requireValidSessionName(newName);
    await run(['rename-session', '-t', target, newName]);
  }

  async function renameWindow(session, index, newName) {
    const target = sessionTarget(session);
    requireValidWindowIndex(index);
    requireValidWindowName(newName);
    await run(['rename-window', '-t', `${target}:${index}`, newName]);
  }

  async function killSession(name) {
    const target = sessionTarget(name);
    await run(['kill-session', '-t', target]);
  }

  async function killWindow(session, index) {
    const target = sessionTarget(session);
    requireValidWindowIndex(index);
    await run(['kill-window', '-t', `${target}:${index}`]);
  }

  async function killPane(paneId) {
    requireValidPaneId(paneId);
    await run(['kill-pane', '-t', paneId]);
  }

  async function selectPane(paneId) {
    requireValidPaneId(paneId);
    await run(['select-pane', '-t', paneId]);
  }

  /**
   * Sets or clears a pane's custom label via the @pane_label user option.
   * Empty/nullish label clears it. tmux redraws the pane border automatically.
   */
  async function setPaneLabel(paneId, label) {
    requireValidPaneId(paneId);
    if (label == null || (typeof label === 'string' && label.trim() === '')) {
      await run(['set-option', '-pu', '-t', paneId, '@pane_label']);
      return;
    }
    if (!validatePaneLabel(label)) {
      throw new Error('Invalid pane label');
    }
    await run(['set-option', '-p', '-t', paneId, '@pane_label', label]);
  }

  async function sendKeys(paneId, command) {
    requireValidPaneId(paneId);
    if (typeof command !== 'string') {
      throw new Error('Command must be a string');
    }
    await run(['send-keys', '-t', paneId, command, 'Enter']);
  }

  async function selectLayout(session, window, layout) {
    const target = sessionTarget(session);
    requireValidWindowIndex(window);
    const validLayouts = ['even-horizontal', 'even-vertical', 'main-horizontal', 'main-vertical', 'tiled'];
    if (!validLayouts.includes(layout)) {
      throw new Error(`Invalid layout: ${layout}`);
    }
    await run(['select-layout', '-t', `${target}:${window}`, layout]);
  }

  async function resizePane(paneId, direction, amount) {
    requireValidPaneId(paneId);
    const validDirs = ['U', 'D', 'L', 'R'];
    if (!validDirs.includes(direction)) {
      throw new Error(`Invalid direction: ${direction}`);
    }
    if (!Number.isInteger(amount) || amount < 1) {
      throw new Error(`Invalid amount: ${amount}`);
    }
    await run(['resize-pane', '-t', paneId, `-${direction}`, String(amount)]);
  }

  async function swapPane(srcPaneId, dstPaneId) {
    requireValidPaneId(srcPaneId);
    requireValidPaneId(dstPaneId);
    await run(['swap-pane', '-s', srcPaneId, '-t', dstPaneId]);
  }

  async function capturePane(paneId, { escape = false } = {}) {
    requireValidPaneId(paneId);
    const args = ['capture-pane'];
    if (escape) args.push('-e');
    args.push('-t', paneId, '-p');
    const stdout = await run(args);
    return stdout;
  }

  /**
   * Globally enables the pane border title line so pane labels render.
   * Idempotent and best-effort — throws if no tmux server; callers should catch.
   */
  async function ensurePaneBorderConfig() {
    await run(['set-option', '-g', 'pane-border-status', 'top']);
    await run(['set-option', '-g', 'pane-border-format', PANE_BORDER_FORMAT]);
  }

  // --- by-id helpers (use window_id @N — stable across renames/moves/renumbers) ---

  async function renameWindowById(windowId, newName) {
    requireValidWindowId(windowId);
    requireValidWindowName(newName);
    await run(['rename-window', '-t', windowId, newName]);
  }

  async function killWindowById(windowId) {
    requireValidWindowId(windowId);
    await run(['kill-window', '-t', windowId]);
  }

  async function moveWindowById(windowId, dstSession) {
    requireValidWindowId(windowId);
    if (validateSessionId(dstSession)) {
      await run(['move-window', '-s', windowId, '-t', dstSession + ':']);
      return;
    }
    requireValidSessionName(dstSession);
    // '=<name>:' forces exact-name match (no prefix collision like foo vs foobar).
    await run(['move-window', '-s', windowId, '-t', '=' + dstSession + ':']);
  }

  /** Reads the tmux server version, e.g. "3.5a". Throws if tmux is unusable. */
  async function version() {
    const stdout = await run(['-V']);
    const match = /tmux\s+(?:next-)?([0-9]+\.[0-9]+[a-z]?)/i.exec(stdout.trim());
    return match ? match[1] : null;
  }

  return {
    executor,
    run,
    listSessions,
    listWindows,
    listAllWindowIds,
    unzoomWindow,
    listPanes,
    listPanesByWindowId,
    listPaneCommands,
    getPaneAddress,
    createSession,
    createSessionReturningId,
    createWindow,
    createWindowReturningId,
    splitPane,
    splitPaneReturningId,
    renameSession,
    renameWindow,
    killSession,
    killWindow,
    killPane,
    selectPane,
    setPaneLabel,
    sendKeys,
    selectLayout,
    resizePane,
    swapPane,
    capturePane,
    ensurePaneBorderConfig,
    renameWindowById,
    killWindowById,
    moveWindowById,
    version,
  };
}

// Border title shown by tmux on each pane's top border (pane-border-status top).
// [label] only when @pane_label is set; the active pane is reversed for contrast.
export const PANE_BORDER_FORMAT =
  '#{?pane_active,#[reverse],} #{?#{@pane_label},[#{@pane_label}] ,}#{pane_index}:#{pane_current_command} #[default]';

// The local tmux binding. Every pre-existing caller keeps importing these named
// exports; remote hosts get their own instance from createTmuxApi(sshExecutor).
const local = createTmuxApi(localExecutor);

export const listSessions = (...args) => local.listSessions(...args);
export const listWindows = (...args) => local.listWindows(...args);
export const listAllWindowIds = (...args) => local.listAllWindowIds(...args);
export const unzoomWindow = (...args) => local.unzoomWindow(...args);
export const listPanes = (...args) => local.listPanes(...args);
export const listPanesByWindowId = (...args) => local.listPanesByWindowId(...args);
export const listPaneCommands = (...args) => local.listPaneCommands(...args);
export const getPaneAddress = (...args) => local.getPaneAddress(...args);
export const createSession = (...args) => local.createSession(...args);
export const createWindow = (...args) => local.createWindow(...args);
export const splitPane = (...args) => local.splitPane(...args);
export const renameSession = (...args) => local.renameSession(...args);
export const renameWindow = (...args) => local.renameWindow(...args);
export const killSession = (...args) => local.killSession(...args);
export const killWindow = (...args) => local.killWindow(...args);
export const killPane = (...args) => local.killPane(...args);
export const selectPane = (...args) => local.selectPane(...args);
export const setPaneLabel = (...args) => local.setPaneLabel(...args);
export const sendKeys = (...args) => local.sendKeys(...args);
export const selectLayout = (...args) => local.selectLayout(...args);
export const resizePane = (...args) => local.resizePane(...args);
export const swapPane = (...args) => local.swapPane(...args);
export const capturePane = (...args) => local.capturePane(...args);
export const ensurePaneBorderConfig = (...args) => local.ensurePaneBorderConfig(...args);
export const renameWindowById = (...args) => local.renameWindowById(...args);
export const killWindowById = (...args) => local.killWindowById(...args);
export const moveWindowById = (...args) => local.moveWindowById(...args);
export const tmuxVersion = (...args) => local.version(...args);
