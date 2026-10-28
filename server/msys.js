// Windows hosts run tmux from MSYS2. Native Node talks to it through two
// boundaries this module owns: the tmux executable/environment, and the
// translation between MSYS paths (what tmux and the shells report, e.g.
// /home/me or /c/Users/me) and the native paths Node's fs needs.

import { existsSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { win32 } from 'node:path';

export const IS_WINDOWS = process.platform === 'win32';

const DEFAULT_MSYS_ROOT = 'C:\\msys64';

/**
 * Resolves the tmux executable. TMUX_BIN wins everywhere; Windows falls back to
 * the MSYS2 package so the service does not need MSYS2's usr/bin on PATH (it
 * would shadow Windows tools such as find and sort).
 */
export function resolveTmuxBin({ env = process.env, platform = process.platform, exists = existsSync } = {}) {
  if (env.TMUX_BIN) return env.TMUX_BIN;
  if (platform !== 'win32') return 'tmux';
  const candidate = win32.join(env.MSYS2_ROOT || DEFAULT_MSYS_ROOT, 'usr', 'bin', 'tmux.exe');
  return exists(candidate) ? candidate : 'tmux';
}

/** The MSYS2 installation root, which is the native location of MSYS's `/`. */
export function resolveMsysRoot({ env = process.env, tmuxBin = resolveTmuxBin({ env }) } = {}) {
  if (env.MSYS2_ROOT) return win32.resolve(env.MSYS2_ROOT);
  const normalized = win32.normalize(tmuxBin);
  if (win32.isAbsolute(normalized) && /\\usr\\bin\\[^\\]+$/i.test(normalized)) {
    return win32.resolve(normalized, '..', '..', '..');
  }
  return DEFAULT_MSYS_ROOT;
}

/**
 * MSYS expands unquoted wildcard and brace arguments of programs started by
 * native Windows processes, which turns tmux formats such as
 * `#{session_id}` into `#session_id`. `noglob` keeps argv verbatim.
 */
export function withNoGlob(value) {
  const options = String(value || '').split(/\s+/).filter(Boolean);
  if (options.includes('noglob')) return options.join(' ');
  return [...options.filter((option) => option !== 'glob' && !option.startsWith('glob:')), 'noglob'].join(' ');
}

/**
 * Quotes one argument the way the MSYS2 runtime splits a Windows command line.
 * Node's own quoting escapes `"` as `\"`, which MSYS does not read back:
 * `{"V":2}` arrived as `{\V\:2}` and `"a b" c` as several words. MSYS keeps
 * single-quoted text literally, and a `'` is spelled `'"'"'`.
 */
export function msysQuote(arg) {
  return "'" + String(arg).replace(/'/g, `'"'"'`) + "'";
}

/**
 * execFile arguments and options for running an MSYS2 program (tmux) from
 * native Node, so every argument reaches it exactly as given. A no-op off
 * Windows, where argv is passed through as is.
 */
export function msysExecArgs(args, options = {}, windows = IS_WINDOWS) {
  if (!windows) return [args, options];
  return [args.map(msysQuote), { ...options, windowsVerbatimArguments: true }];
}

/** `/c/Users/me` → `C:\Users\me`; any other absolute path lives under the MSYS root. */
export function toNativePath(posixPath, root = MSYS_ROOT) {
  const drive = String(posixPath).match(/^\/(?:cygdrive\/)?([a-zA-Z])(?=\/|$)(.*)$/);
  if (drive) return win32.normalize(`${drive[1].toUpperCase()}:\\${drive[2].replace(/\//g, '\\')}`);
  return win32.join(root, posixPath);
}

/** Inverse of toNativePath, so fs results can be compared with MSYS paths. */
export function toPosixPath(nativePath, root = MSYS_ROOT) {
  const normalized = win32.resolve(nativePath);
  const base = win32.resolve(root);
  const lower = normalized.toLowerCase();
  const baseLower = base.toLowerCase();
  if (lower === baseLower) return '/';
  if (lower.startsWith(baseLower.endsWith('\\') ? baseLower : baseLower + '\\')) {
    return '/' + normalized.slice(base.length).replace(/^\\/, '').replace(/\\/g, '/');
  }
  const drive = normalized.match(/^([a-zA-Z]):\\?(.*)$/);
  if (drive) return `/${drive[1].toLowerCase()}` + (drive[2] ? '/' + drive[2].replace(/\\/g, '/') : '');
  return normalized.replace(/\\/g, '/');
}

/**
 * The home directories a Windows user's panes start in: MSYS2's own
 * /home/<user> (the default) and the Windows profile, both in MSYS form.
 */
export function msysHomeRoots({ env = process.env, root = MSYS_ROOT } = {}) {
  const roots = [];
  if (env.HOME && env.HOME.startsWith('/')) roots.push(env.HOME);
  const user = env.USERNAME || env.USER;
  if (user) roots.push(`/home/${user}`);
  if (env.USERPROFILE) roots.push(toPosixPath(env.USERPROFILE, root));
  return [...new Set(roots)];
}

export const TMUX_BIN = resolveTmuxBin();
export const MSYS_ROOT = IS_WINDOWS ? resolveMsysRoot({ tmuxBin: TMUX_BIN }) : DEFAULT_MSYS_ROOT;

/**
 * The home tmux has, where it reads ~/.tmux.conf: MSYS2's /home/<user> on
 * Windows (not the Windows profile), the usual home elsewhere.
 */
export function tmuxUserHome({ windows = IS_WINDOWS, root = MSYS_ROOT, user = userInfo().username } = {}) {
  return windows ? win32.join(root, 'home', user) : homedir();
}

// Every tmux child — execFile calls and the attach PTY — inherits this.
if (IS_WINDOWS) process.env.MSYS = withNoGlob(process.env.MSYS);
