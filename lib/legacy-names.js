// Anymux was called tmux-web-panel. Installations made under the old name keep
// working:
//
// - environment variables named TMUX_PANEL_*, TMUX_WEB_PANEL_* or TWP_* are
//   read as the ANYMUX_* of the same suffix (adoptLegacyEnv), so an old service
//   unit or a shell profile still configures the panel;
// - ~/.config, ~/.cache and ~/.local/share/tmux-web-panel move to .../anymux
//   (migrateLegacyDirs) and leave a link behind, because a Hub of the old
//   version still reads ~/.config/tmux-web-panel/node.json over SFTP. The panel
//   does this when it starts; on Windows scripts/install-service.ps1 does it.
//   appDir() answers with the old directory only while the new one is missing.
//
// Each place that reads a renamed marker, header, tmux option or storage key
// from outside this process accepts the old one as well; docs/architecture.md
// ("改名兼容") lists them.

import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const APP_ID = 'anymux';
export const LEGACY_APP_ID = 'tmux-web-panel';

const ENV_PREFIX = 'ANYMUX_';
const LEGACY_ENV_PREFIXES = ['TMUX_WEB_PANEL_', 'TMUX_PANEL_', 'TWP_'];

/** The new name of a legacy environment variable, or null. */
export function currentEnvName(name) {
  const prefix = LEGACY_ENV_PREFIXES.find((candidate) => name.startsWith(candidate));
  return prefix ? ENV_PREFIX + name.slice(prefix.length) : null;
}

/** Copies each legacy variable to its ANYMUX_ name unless that is already set. */
export function adoptLegacyEnv(env = process.env) {
  for (const name of Object.keys(env)) {
    const current = currentEnvName(name);
    if (current && env[current] === undefined) env[current] = env[name];
  }
  return env;
}

const BASES = {
  config: ['.config'],
  cache: ['.cache'],
  data: ['.local', 'share'],
};

function locations(kind, home) {
  const parts = BASES[kind];
  if (!parts) throw new Error(`unknown directory kind: ${kind}`);
  const base = join(home, ...parts);
  return { current: join(base, APP_ID), legacy: join(base, LEGACY_APP_ID) };
}

/**
 * ~/.config/anymux (kind 'config'), ~/.cache/anymux ('cache') or
 * ~/.local/share/anymux ('data'); the tmux-web-panel directory while only that
 * one exists.
 */
export function appDir(kind, { home = homedir(), exists = existsSync } = {}) {
  const { current, legacy } = locations(kind, home);
  return !exists(current) && exists(legacy) ? legacy : current;
}

/** Both candidates for a path below an app directory, current name first. */
export function appPathCandidates(kind, relative, { home = homedir() } = {}) {
  const { current, legacy } = locations(kind, home);
  return [join(current, relative), join(legacy, relative)];
}

function isRealDirectory(path) {
  try {
    const info = lstatSync(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Moves what src holds into dst, entry by entry, where dst has nothing of that
 * name; an entry that cannot move (a file another process holds open, on
 * Windows) or that dst already has stays in src. Returns the paths left behind.
 */
function mergeInto(src, dst) {
  const left = [];
  for (const name of readdirSync(src)) {
    const from = join(src, name);
    const to = join(dst, name);
    if (!existsSync(to)) {
      try {
        renameSync(from, to);
        continue;
      } catch {
        if (!isRealDirectory(from)) {
          left.push(from);
          continue;
        }
        mkdirSync(to, { recursive: true });
      }
    }
    if (isRealDirectory(from) && isRealDirectory(to)) {
      left.push(...mergeInto(from, to));
      try { rmdirSync(from); } catch { /* still holds what could not move */ }
    } else {
      left.push(from);
    }
  }
  return left;
}

/**
 * Moves each legacy directory to the new name and links the old path to it (a
 * relative symlink; a junction on Windows, which needs no privilege). When the
 * whole directory cannot move, or the new one exists already, its entries move
 * one by one; the old directory is linked once nothing is left in it, and
 * keeps whatever could not move until a later run.
 *
 * Does nothing on Windows unless `windows` is set: there the scheduled tasks
 * name the settings file by its path, so scripts/install-service.ps1 moves the
 * directories while it replaces the tasks.
 */
export function migrateLegacyDirs({
  home = homedir(),
  platform = process.platform,
  windows = false,
  warn = (message) => console.warn(message),
} = {}) {
  const results = [];
  if (platform === 'win32' && !windows) return results;
  for (const kind of Object.keys(BASES)) {
    const { current, legacy } = locations(kind, home);
    if (!isRealDirectory(legacy)) continue;
    let left = [];
    try {
      if (existsSync(current)) left = mergeInto(legacy, current);
      else {
        try {
          renameSync(legacy, current);
        } catch {
          mkdirSync(current, { recursive: true });
          left = mergeInto(legacy, current);
        }
      }
      if (left.length === 0 && existsSync(legacy)) rmdirSync(legacy);
    } catch (error) {
      warn(`[anymux] could not move ${legacy} to ${current} (${error.code || error.message})`);
      continue;
    }
    results.push({ kind, from: legacy, to: current, left });
    if (left.length) {
      warn(`[anymux] moved ${legacy} to ${current} except ${left.length} item(s) in use; they move on a later start`);
      continue;
    }
    try {
      if (platform === 'win32') symlinkSync(current, legacy, 'junction');
      else symlinkSync(APP_ID, legacy);
    } catch (error) {
      warn(`[anymux] moved ${legacy} to ${current} but could not link the old path (${error.code || error.message})`);
    }
  }
  return results;
}
