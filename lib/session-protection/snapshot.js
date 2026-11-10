/**
 * tmux-resurrect snapshot files: reading them, and finding them on disk.
 *
 * A snapshot is tab-separated lines. The ones restoring needs:
 *   pane    session  winIdx  winActive  :winFlags  paneIdx  title  :path  paneActive  command  :fullCommand
 *   window  session  winIdx  :name  winActive  :winFlags  layout  automaticRename
 *   state   clientSession  clientLastSession
 */

import { copyFile, lstat, readdir, readFile, rm, stat, symlink, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { replaceFile } from '../atomic-file.js';

export const SNAPSHOT_RE = /^tmux_resurrect_\d{8}T\d{6}\.txt$/;

const strip = (value) => String(value ?? '').replace(/^:/, '');

export function parseSnapshot(text) {
  const sessions = new Map();
  const session = (name) => {
    if (!sessions.has(name)) sessions.set(name, { name, windows: new Map() });
    return sessions.get(name);
  };
  const windowOf = (name, index) => {
    const owner = session(name);
    if (!owner.windows.has(index)) {
      owner.windows.set(index, { index, name: '', active: false, layout: null, automaticRename: true, panes: [] });
    }
    return owner.windows.get(index);
  };
  let activeSession = null;
  let sawState = false;
  const described = new Set();

  for (const line of String(text || '').split(/\r?\n/)) {
    const fields = line.split('\t');
    if (fields[0] === 'pane' && fields.length >= 10) {
      const index = Number(fields[2]);
      if (!Number.isInteger(index)) continue;
      windowOf(fields[1], index).panes.push({
        index: Number(fields[5]) || 0,
        title: fields[6] || '',
        path: strip(fields[7]),
        active: fields[8] === '1',
        command: fields[9] || '',
        fullCommand: strip(fields.slice(10).join('\t')).trim(),
      });
    } else if (fields[0] === 'window' && fields.length >= 7) {
      const index = Number(fields[2]);
      if (!Number.isInteger(index)) continue;
      const window = windowOf(fields[1], index);
      described.add(window);
      window.name = strip(fields[3]);
      window.active = fields[4] === '1';
      window.layout = fields[6] || null;
      // ":" means the option was left at its default (on); "off" was explicit.
      window.automaticRename = strip(fields[7]) !== 'off';
    } else if (fields[0] === 'state') {
      sawState = true;
      activeSession = fields[1] || null;
    }
  }

  return {
    activeSession,
    // save.sh writes panes, then windows, then the state line, each from its
    // own tmux call. A tmux that stops answering part way leaves no state line,
    // or panes without any window (no names, no layouts). One window missing
    // alone is a session that closed between the calls, not a broken save.
    complete: sawState && described.size > 0,
    sessions: [...sessions.values()]
      .map((entry) => ({
        name: entry.name,
        windows: [...entry.windows.values()]
          .filter((window) => window.panes.length > 0)
          .sort((a, b) => a.index - b.index)
          .map((window) => ({ ...window, panes: window.panes.sort((a, b) => a.index - b.index) })),
      }))
      .filter((entry) => entry.windows.length > 0),
  };
}

/** A save a new server can be restored from: it has sessions and was written to the end. */
export function isUsable(snapshot) {
  return Boolean(snapshot && snapshot.sessions.length > 0 && snapshot.complete);
}

export function summarize(snapshot) {
  let windows = 0;
  let panes = 0;
  for (const session of snapshot.sessions) {
    windows += session.windows.length;
    for (const window of session.windows) panes += window.panes.length;
  }
  return { sessions: snapshot.sessions.length, windows, panes };
}

/** Width and height a saved layout was drawn at, old and JSON layout formats. */
export function layoutSize(layout) {
  const text = String(layout || '');
  const json = text.match(/"w":(\d+),"h":(\d+)/);
  if (json) return { width: Number(json[1]), height: Number(json[2]) };
  const classic = text.match(/^[0-9a-f]{4},(\d+)x(\d+),/);
  if (classic) return { width: Number(classic[1]), height: Number(classic[2]) };
  return null;
}

/** The snapshots in a resurrect directory, newest first. Unreadable ones are skipped. */
export async function listSnapshots(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const entries = [];
  for (const name of names) {
    if (!SNAPSHOT_RE.test(name)) continue;
    try {
      const info = await stat(join(dir, name));
      entries.push({ id: name, at: info.mtime.toISOString(), mtime: info.mtimeMs });
    } catch { /* removed while listing */ }
  }
  return entries.sort((a, b) => b.mtime - a.mtime).map(({ id, at }) => ({ id, at }));
}

export async function readSnapshot(dir, id) {
  if (!SNAPSHOT_RE.test(id)) return null;
  try {
    return parseSnapshot(await readFile(join(dir, id), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** The newest snapshot a new server can be restored from, or null. */
async function newestUsable(dir) {
  for (const entry of await listSnapshots(dir)) {
    const snapshot = await readSnapshot(dir, entry.id);
    if (isUsable(snapshot)) return { ...entry, snapshot };
  }
  return null;
}

/**
 * The snapshot `last` points to. On MSYS2 `ln -s` copies, so `last` may be a
 * plain file; either way its contents are the latest save.
 *
 * tmux-resurrect points `last` at every save that differs from the one before,
 * a broken one too: a save made while tmux does not answer has no sessions, or
 * panes without their windows. Such a `last` falls back to the newest usable
 * snapshot. Nothing legitimate saves an empty one: session protection never
 * saves while tmux has no sessions. With nothing better, `last` is used as is.
 */
export async function readLatest(dir) {
  let latest;
  try {
    const file = join(dir, 'last');
    const [text, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
    latest = { at: info.mtime.toISOString(), snapshot: parseSnapshot(text) };
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  if (isUsable(latest.snapshot)) return latest;
  const good = await newestUsable(dir);
  return good ? { at: good.at, snapshot: good.snapshot } : latest;
}

/** `last` made the way resurrect made it: a link where it links, a copy dated like the snapshot where MSYS2 copies. */
async function pointLast(dir, good) {
  const file = join(dir, 'last');
  const temp = join(dir, `.last.twp-${process.pid}`);
  await rm(temp, { force: true });
  try {
    let linked = false;
    if ((await lstat(file)).isSymbolicLink()) {
      try {
        await symlink(good.id, temp);
        linked = true;
      } catch (err) {
        // Windows needs a privilege for links; a copy restores just as well.
        if (err.code !== 'EPERM') throw err;
      }
    }
    if (!linked) {
      await copyFile(join(dir, good.id), temp);
      const when = new Date(good.at);
      await utimes(temp, when, when);
    }
    await replaceFile(temp, file);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

/**
 * Points a broken `last` (see readLatest) back at the newest usable snapshot,
 * and removes the empty snapshots newer than that one: they hold nothing, and
 * resurrect would otherwise count them among the backups it keeps. Partial ones
 * stay for "find a session" to offer. Returns the snapshot `last` now points
 * to, or null when `last` was fine or there is nothing better.
 */
export async function repairLast(dir) {
  let text;
  try {
    text = await readFile(join(dir, 'last'), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  if (isUsable(parseSnapshot(text))) return null;
  const good = await newestUsable(dir);
  if (!good) return null;
  await pointLast(dir, good);
  for (const entry of await listSnapshots(dir)) {
    if (entry.id === good.id) break;
    const snapshot = await readSnapshot(dir, entry.id);
    if (snapshot && snapshot.sessions.length === 0) await rm(join(dir, entry.id), { force: true });
  }
  return { id: good.id, at: good.at };
}
