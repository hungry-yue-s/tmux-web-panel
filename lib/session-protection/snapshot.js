/**
 * tmux-resurrect snapshot files: reading them, and finding them on disk.
 *
 * A snapshot is tab-separated lines. The ones restoring needs:
 *   pane    session  winIdx  winActive  :winFlags  paneIdx  title  :path  paneActive  command  :fullCommand
 *   window  session  winIdx  :name  winActive  :winFlags  layout  automaticRename
 *   state   clientSession  clientLastSession
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

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
      window.name = strip(fields[3]);
      window.active = fields[4] === '1';
      window.layout = fields[6] || null;
      // ":" means the option was left at its default (on); "off" was explicit.
      window.automaticRename = strip(fields[7]) !== 'off';
    } else if (fields[0] === 'state') {
      activeSession = fields[1] || null;
    }
  }

  return {
    activeSession,
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

/**
 * The snapshot `last` points to. On MSYS2 `ln -s` copies, so `last` may be a
 * plain file; either way its contents are the latest save.
 */
export async function readLatest(dir) {
  try {
    const file = join(dir, 'last');
    const [text, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
    return { at: info.mtime.toISOString(), snapshot: parseSnapshot(text) };
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}
