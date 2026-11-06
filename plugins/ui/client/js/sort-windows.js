/**
 * Pure sort function — no DOM, no state. Returns an ordered array of window_ids.
 *
 * Tiers (top → bottom):
 *  1. pinned (sorted within by activity desc)
 *  2. promoted bells (in given order, newest first; pinned excluded)
 *  3. remaining bells (sorted within by activity desc)
 *  4. active window (singleton)
 *  5. rest (sorted by activity desc)
 *
 * @param {Array<{id: string, active: boolean, bell: boolean, activity: number}>} windows
 * @param {{ pinsById: Record<string, true>, promotedBellIds: string[] }} opts
 * @returns {string[]} window ids in display order
 */
export function sortWindowsForSnapshot(windows, opts) {
  const { pinsById = {}, promotedBellIds = [] } = opts || {};
  const byActivityDesc = (a, b) => (b.activity || 0) - (a.activity || 0);

  const byId = new Map(windows.map((w) => [w.id, w]));

  const pinned = windows.filter((w) => pinsById[w.id]);
  const nonPinned = windows.filter((w) => !pinsById[w.id]);

  const promotedSet = new Set();
  const promoted = [];
  for (const id of promotedBellIds) {
    if (pinsById[id]) continue;
    const w = byId.get(id);
    if (w && !promotedSet.has(id)) {
      promoted.push(w);
      promotedSet.add(id);
    }
  }

  const remainingBells = nonPinned.filter((w) => w.bell && !promotedSet.has(w.id));
  const active = nonPinned.filter((w) => !w.bell && !promotedSet.has(w.id) && w.active);
  const rest = nonPinned.filter((w) => !w.bell && !promotedSet.has(w.id) && !w.active);

  return [
    ...pinned.slice().sort(byActivityDesc),
    ...promoted,
    ...remainingBells.slice().sort(byActivityDesc),
    ...active,
    ...rest.slice().sort(byActivityDesc),
  ].map((w) => w.id);
}

// Expose to browser global for legacy script-tag loading.
if (typeof window !== 'undefined') {
  window.sortWindowsForSnapshot = sortWindowsForSnapshot;
}
