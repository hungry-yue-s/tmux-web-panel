/**
 * fab-heat.js — Lazy exponential decay heat algorithm for FAB toolbar
 *
 * Browser usage: loaded via <script> tag, exposes window.FabHeat
 * Test/ESM usage: named ESM exports at bottom of file
 *
 * Algorithm: each item stores { count, lastUse } in localStorage.
 * score(sceneId, itemId) = count * DECAY_BASE^daysSinceLastUse
 * touch() decays the existing count then adds 1.
 */

const STORAGE_KEY = 'fab-heat-v1';
const DECAY_BASE = 0.95;

// ─── In-memory cache ──────────────────────────────────────────────────────────

let _cache = null;

/**
 * Reads heat data from cache or localStorage.
 * @returns {Object} heat data map: { [sceneId]: { [itemId]: { count, lastUse } } }
 */
function _load() {
  if (_cache !== null) return _cache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    _cache = raw ? JSON.parse(raw) : {};
  } catch (_e) {
    _cache = {};
  }
  return _cache;
}

/**
 * Persists heat data to localStorage and updates in-memory cache.
 * @param {Object} data - heat data map to persist
 */
function _save(data) {
  _cache = data;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (_e) {
    // localStorage quota exceeded or unavailable — silently ignore
  }
}

/**
 * Clears in-memory cache (for tests only).
 */
function _resetCache() {
  _cache = null;
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

/**
 * Returns today's date string in 'YYYY-MM-DD' format (UTC).
 * @returns {string}
 */
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Returns the integer number of days between two 'YYYY-MM-DD' strings.
 * @param {string} a - earlier date string
 * @param {string} b - later date string
 * @returns {number} integer days (b - a), clamped to >= 0
 */
function daysBetween(a, b) {
  const msA = new Date(a).getTime();
  const msB = new Date(b).getTime();
  const diff = Math.round((msB - msA) / 86400000);
  return diff < 0 ? 0 : diff;
}

// ─── Core API ─────────────────────────────────────────────────────────────────

/**
 * Returns the current heat score for an item, applying exponential decay.
 * @param {string} sceneId
 * @param {string} itemId
 * @returns {number} decayed score (0 if item not found)
 */
function score(sceneId, itemId) {
  const data = _load();
  const scene = data[sceneId];
  if (!scene) return 0;
  const record = scene[itemId];
  if (!record) return 0;

  const days = daysBetween(record.lastUse, todayStr());
  return record.count * Math.pow(DECAY_BASE, days);
}

/**
 * Records a use of an item: decays existing count then adds 1.
 * @param {string} sceneId
 * @param {string} itemId
 */
function touch(sceneId, itemId) {
  const data = _load();
  const today = todayStr();

  const scene = data[sceneId] || {};
  const record = scene[itemId];

  let newCount;
  if (!record) {
    newCount = 1;
  } else {
    const days = daysBetween(record.lastUse, today);
    const decayed = record.count * Math.pow(DECAY_BASE, days);
    newCount = decayed + 1;
  }

  const updatedScene = Object.assign({}, scene, {
    [itemId]: { count: newCount, lastUse: today },
  });

  _save(Object.assign({}, data, { [sceneId]: updatedScene }));
}

/**
 * Injects a fixed initial count for an item (bypasses decay).
 * @param {string} sceneId
 * @param {string} itemId
 * @param {number} count - initial heat count
 */
function seedHeat(sceneId, itemId, count) {
  const data = _load();
  const today = todayStr();

  const scene = Object.assign({}, data[sceneId] || {}, {
    [itemId]: { count, lastUse: today },
  });

  _save(Object.assign({}, data, { [sceneId]: scene }));
}

/**
 * Initialises heat for a newly-added item using the median of the top 10
 * items in the same scene multiplied by 0.5.
 * @param {string} sceneId
 * @param {string} itemId
 */
function initHeatForNew(sceneId, itemId) {
  const data = _load();
  const scene = data[sceneId] || {};
  const today = todayStr();

  // Collect current (decayed) scores for all existing items in scene
  const scores = Object.entries(scene).map(([id, record]) => {
    const days = daysBetween(record.lastUse, today);
    return record.count * Math.pow(DECAY_BASE, days);
  });

  // Sort descending, take top 10
  scores.sort((a, b) => b - a);
  const top10 = scores.slice(0, 10);

  let medianScore = 0;
  if (top10.length > 0) {
    // Use index 5 (6th element) when >= 6 items, otherwise middle
    const midIndex = top10.length >= 6 ? 5 : Math.floor(top10.length / 2);
    medianScore = top10[midIndex] !== undefined ? top10[midIndex] : 0;
  }

  const initialCount = medianScore * 0.5;
  seedHeat(sceneId, itemId, initialCount);
}

/**
 * Sorts items by their heat score (descending) and returns the top n.
 * @param {string} sceneId
 * @param {Array<Object>} items - array of items with .id property
 * @param {number} n - max items to return
 * @returns {Array<Object>} top n items sorted by heat score desc
 */
function topN(sceneId, items, n) {
  const scored = items.map(item => ({
    item,
    score: score(sceneId, item.id),
  }));

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, n).map(s => s.item);
}

/**
 * Removes all heat data for a scene from localStorage.
 * @param {string} sceneId
 */
function clearScene(sceneId) {
  const data = _load();
  const updated = Object.assign({}, data);
  delete updated[sceneId];
  _save(updated);
}

// ─── Browser global exposure (IIFE guards against re-execution) ───────────────
(function exposeBrowserGlobal() {
  const target = typeof window !== 'undefined' ? window : null;
  if (target && !target.FabHeat) {
    target.FabHeat = {
      score,
      touch,
      seedHeat,
      initHeatForNew,
      topN,
      clearScene,
      _resetCache,
    };
  }
})();

// ─── ESM named exports (for vitest / Node ESM imports) ───────────────────────
export { score, touch, seedHeat, initHeatForNew, topN, clearScene, _resetCache };
