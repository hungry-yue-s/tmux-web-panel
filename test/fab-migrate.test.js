import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.localStorage = dom.window.localStorage;

await import('../public/js/fab-scene.js');
await import('../public/js/fab-heat.js');
await import('../public/js/fab-migrate.js');

describe('FabMigrate', () => {
  beforeEach(() => {
    localStorage.clear();
    if (window.FabHeat._resetCache) window.FabHeat._resetCache();
  });

  it('migrates drawer-quick-keys into terminal scene common items', () => {
    localStorage.setItem('drawer-quick-keys', JSON.stringify([
      { label: 'll', send: 'ls -la\r' },
      { label: 'gs', send: 'git status\r' },
    ]));
    window.FabMigrate.runOnce();
    const scenes = window.FabScene.loadScenes();
    const term = scenes.find(s => s.id === 'terminal');
    const items = term.defaultItems.common || [];
    expect(items.some(it => it.label === 'll')).toBe(true);
    expect(localStorage.getItem('drawer-quick-keys')).toBeNull();
  });

  it('migrates drawer-commands into claude scene slash items', () => {
    localStorage.setItem('drawer-commands', JSON.stringify([
      { label: '/pua', send: '/pua\r' },
    ]));
    window.FabMigrate.runOnce();
    const scenes = window.FabScene.loadScenes();
    const claude = scenes.find(s => s.id === 'claude');
    const items = claude.defaultItems.slash || [];
    expect(items.some(it => it.label === '/pua')).toBe(true);
  });

  it('runs only once (idempotent)', () => {
    localStorage.setItem('drawer-quick-keys', JSON.stringify([{ label: 'first', send: 'first\r' }]));
    window.FabMigrate.runOnce();
    // Set new data — should NOT be migrated
    localStorage.setItem('drawer-quick-keys', JSON.stringify([{ label: 'second', send: 'second\r' }]));
    window.FabMigrate.runOnce();
    const scenes = window.FabScene.loadScenes();
    const term = scenes.find(s => s.id === 'terminal');
    const items = term.defaultItems.common || [];
    expect(items.some(it => it.label === 'second')).toBe(false);
  });

  it('returns false when already migrated', () => {
    expect(window.FabMigrate.runOnce()).toBe(true); // first run
    expect(window.FabMigrate.runOnce()).toBe(false); // already done
  });
});
