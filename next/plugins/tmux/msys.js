// Windows hosts run tmux from MSYS2 (see the root CLAUDE.md). Carried over from
// server/msys.js, with one change: the MSYS environment is handed to each tmux
// child explicitly instead of being written into the global process.env.

import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

export const IS_WINDOWS = process.platform === 'win32';

const DEFAULT_MSYS_ROOT = 'C:\\msys64';

/**
 * TMUX_BIN wins everywhere; Windows falls back to the MSYS2 package so the
 * service does not need MSYS2's usr/bin on PATH (it would shadow Windows tools
 * such as find and sort).
 */
export function resolveTmuxBin({ env = process.env, platform = process.platform, exists = existsSync } = {}) {
  if (env.TMUX_BIN) return env.TMUX_BIN;
  if (platform !== 'win32') return 'tmux';
  const candidate = win32.join(env.MSYS2_ROOT || DEFAULT_MSYS_ROOT, 'usr', 'bin', 'tmux.exe');
  return exists(candidate) ? candidate : 'tmux';
}

/** The MSYS2 installation root, the native location of MSYS's `/`. */
export function resolveMsysRoot({ env = process.env, tmuxBin = resolveTmuxBin({ env }) } = {}) {
  if (env.MSYS2_ROOT) return win32.resolve(env.MSYS2_ROOT);
  const normalized = win32.normalize(tmuxBin);
  if (win32.isAbsolute(normalized) && /\\usr\\bin\\[^\\]+$/i.test(normalized)) {
    return win32.resolve(normalized, '..', '..', '..');
  }
  return DEFAULT_MSYS_ROOT;
}

/** `/c/Users/me` → `C:\Users\me`; any other absolute path lives under the MSYS root. */
export function toNativePath(posixPath, root) {
  const drive = String(posixPath).match(/^\/(?:cygdrive\/)?([a-zA-Z])(?=\/|$)(.*)$/);
  if (drive) return win32.normalize(`${drive[1].toUpperCase()}:\\${drive[2].replace(/\//g, '\\')}`);
  return win32.join(root, posixPath);
}

/**
 * MSYS expands unquoted wildcard and brace arguments of programs started by
 * native Windows processes, which turns tmux formats such as `#{session_id}`
 * into `#session_id`. `noglob` keeps argv verbatim.
 */
export function withNoGlob(value) {
  const options = String(value || '').split(/\s+/).filter(Boolean);
  if (options.includes('noglob')) return options.join(' ');
  return [...options.filter((option) => option !== 'glob' && !option.startsWith('glob:')), 'noglob'].join(' ');
}

/**
 * The environment every tmux child needs on Windows. MSYS2_PATH_TYPE=inherit
 * reaches the panes of a server the panel itself starts; without it their
 * login shells reset PATH to the MSYS2 minimum (docs/known-issues.md ENV-2).
 */
export function msysEnv(env = process.env) {
  return { ...env, MSYS: withNoGlob(env.MSYS), MSYS2_PATH_TYPE: 'inherit' };
}

/**
 * Quotes one argument the way the MSYS2 runtime splits a Windows command line.
 * Node's own quoting escapes `"` as `\"`, which MSYS does not read back. MSYS
 * keeps single-quoted text literally, and a `'` is spelled `'"'"'`.
 */
export function msysQuote(arg) {
  return "'" + String(arg).replace(/'/g, `'"'"'`) + "'";
}

/** execFile arguments and options for an MSYS2 program; a no-op off Windows. */
export function msysExecArgs(args, options = {}, windows = IS_WINDOWS) {
  if (!windows) return [args, options];
  return [args.map(msysQuote), { ...options, windowsVerbatimArguments: true }];
}
