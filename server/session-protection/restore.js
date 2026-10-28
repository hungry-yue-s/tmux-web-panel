/**
 * Rebuilds sessions from a parsed snapshot.
 *
 * This is the panel's own restore, used both for the automatic restore after
 * tmux restarts and for bringing back one session from history. Unlike
 * resurrect's restore.sh it never merges into a session that exists: a session
 * whose name is taken comes back under a new name, so restoring cannot disturb
 * what is running. Every target is an id tmux returned, never a name.
 */

import { restoreCommand } from './catalog.js';
import { layoutSize } from './snapshot.js';

/** `name`, or `name 恢复`, `name 恢复2`, … — the first one not in use. */
export function freeName(name, taken) {
  if (!taken.has(name)) return name;
  for (let n = 1; ; n += 1) {
    const candidate = `${name} 恢复${n === 1 ? '' : n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

const pathArgs = (path) => (path ? ['-c', path] : []);
const nameArgs = (name) => (name ? ['-n', name] : []);

/**
 * @param {(args: string[]) => Promise<string>} tmux runs one tmux command, resolves stdout
 * @param {object} session one entry of parseSnapshot().sessions
 * @param {object} options
 * @param {string} options.name the name to create it under (already free)
 * @param {string[]} options.programs selected program choices
 * @param {string|null} options.defaultShell
 * @returns {Promise<{ sessionId: string, name: string, programs: number }>}
 */
export async function restoreSession(tmux, session, { name, programs, defaultShell }) {
  const [first, ...rest] = session.windows;
  const size = layoutSize(first.layout);
  const created = (await tmux([
    'new-session', '-d', '-P', '-F', '#{session_id}\t#{window_id}\t#{pane_id}',
    '-s', name, ...nameArgs(first.name),
    ...(size ? ['-x', String(size.width), '-y', String(size.height)] : []),
    ...pathArgs(first.panes[0].path),
  ])).trim().split('\t');
  const sessionId = created[0];

  const built = [{ window: first, windowId: created[1], paneIds: [created[2]] }];
  for (const window of rest) {
    const [windowId, paneId] = (await tmux([
      'new-window', '-d', '-P', '-F', '#{window_id}\t#{pane_id}',
      '-t', `${sessionId}:`, ...nameArgs(window.name), ...pathArgs(window.panes[0].path),
    ])).trim().split('\t');
    built.push({ window, windowId, paneIds: [paneId] });
  }

  let started = 0;
  for (const { window, windowId, paneIds } of built) {
    for (const pane of window.panes.slice(1)) {
      paneIds.push((await tmux([
        'split-window', '-d', '-P', '-F', '#{pane_id}', '-t', windowId, ...pathArgs(pane.path),
      ])).trim());
    }
    if (window.layout) {
      // A layout saved by another tmux version may not parse; the panes still exist.
      await tmux(['select-layout', '-t', windowId, window.layout]).catch(() => {});
    }
    // Naming a window turns automatic-rename off; give back the saved behaviour.
    if (window.automaticRename) await tmux(['set-option', '-w', '-u', '-t', windowId, 'automatic-rename']).catch(() => {});

    for (let i = 0; i < window.panes.length; i += 1) {
      const command = restoreCommand(window.panes[i], programs, defaultShell);
      if (!command) continue;
      await tmux(['send-keys', '-t', paneIds[i], '-l', command]);
      await tmux(['send-keys', '-t', paneIds[i], 'Enter']);
      started += 1;
    }
    const active = window.panes.findIndex((pane) => pane.active);
    if (active > 0) await tmux(['select-pane', '-t', paneIds[active]]).catch(() => {});
  }

  const activeWindow = built.find(({ window }) => window.active);
  if (activeWindow) await tmux(['select-window', '-t', activeWindow.windowId]).catch(() => {});
  return { sessionId, name, programs: started };
}
