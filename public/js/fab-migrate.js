/**
 * fab-migrate.js — One-time migration from legacy drawer-* localStorage keys
 *                  into the new scene-based model (fab-scenes-v1).
 *
 * Browser usage: loaded via <script> tag, exposes window.FabMigrate
 * Test/ESM usage: named ESM exports at bottom of file
 *
 * Old key mapping:
 *   drawer-quick-keys → terminal scene, common tab
 *   drawer-ctrl-keys  → terminal scene, keys tab
 *   drawer-commands   → claude scene, slash tab
 *   drawer-templates  → claude scene, tpl tab
 */

(function (global) {
  'use strict';

  var MARK = 'fab-migrated-v1';

  var MIGRATIONS = [
    { key: 'drawer-quick-keys', sceneId: 'terminal', tabKey: 'common' },
    { key: 'drawer-ctrl-keys',  sceneId: 'terminal', tabKey: 'keys' },
    { key: 'drawer-commands',   sceneId: 'claude',   tabKey: 'slash' },
    { key: 'drawer-templates',  sceneId: 'claude',   tabKey: 'tpl' },
  ];

  /**
   * Runs the migration exactly once. Subsequent calls return false.
   * @returns {boolean} true if migration ran, false if already done
   */
  function runOnce() {
    if (localStorage.getItem(MARK)) return false;

    var customs = [];
    try {
      var raw = localStorage.getItem('fab-scenes-v1');
      if (raw) customs = JSON.parse(raw);
    } catch (_e) { customs = []; }

    for (var m = 0; m < MIGRATIONS.length; m++) {
      var mig = MIGRATIONS[m];
      try {
        var data = localStorage.getItem(mig.key);
        if (!data) continue;
        var items = JSON.parse(data);
        if (!Array.isArray(items)) continue;

        // Find existing custom override for this scene, or clone from builtin
        var target = null;
        for (var i = 0; i < customs.length; i++) {
          if (customs[i].id === mig.sceneId) { target = customs[i]; break; }
        }
        if (!target && global.FabScene) {
          var builtins = global.FabScene.getBuiltinScenes();
          for (var bi = 0; bi < builtins.length; bi++) {
            if (builtins[bi].id === mig.sceneId) {
              target = JSON.parse(JSON.stringify(builtins[bi]));
              target.builtin = false;
              customs.push(target);
              break;
            }
          }
        }
        if (!target) continue;

        target.defaultItems = target.defaultItems || {};
        target.defaultItems[mig.tabKey] = target.defaultItems[mig.tabKey] || [];

        for (var j = 0; j < items.length; j++) {
          var it = items[j];
          if (!it.label) continue;
          var id = 'mig-' + mig.key + '-' + j + '-' + String(it.label).replace(/[^a-zA-Z0-9]/g, '').slice(0, 10);
          target.defaultItems[mig.tabKey].push({ id: id, label: it.label, send: it.send });
          if (global.FabHeat) global.FabHeat.seedHeat(mig.sceneId, id, 10);
        }
        localStorage.removeItem(mig.key);
      } catch (_e) { /* skip individual migration failures */ }
    }

    localStorage.setItem('fab-scenes-v1', JSON.stringify(customs));
    localStorage.setItem(MARK, '1');
    return true;
  }

  var exports = { runOnce: runOnce };
  global.FabMigrate = exports;
})(typeof window !== 'undefined' ? window : globalThis);

// ─── ESM named exports (for vitest / Node ESM imports) ───────────────────────
export function runOnce() { return globalThis.FabMigrate.runOnce(); }
