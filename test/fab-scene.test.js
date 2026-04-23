import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;

const scene = await import('../public/js/fab-scene.js');

describe('fab-scene builtin scenes', () => {
  beforeEach(() => localStorage.clear());

  it('exports 4 builtin scenes', () => {
    const scenes = scene.getBuiltinScenes();
    expect(scenes.map(s => s.id)).toEqual(['terminal', 'claude', 'vim', 'lazygit']);
  });

  it('each scene has required fields', () => {
    for (const s of scene.getBuiltinScenes()) {
      expect(s.id).toBeTruthy();
      expect(s.name).toBeTruthy();
      expect(s.icon).toBeTruthy();
      expect(Array.isArray(s.detect)).toBe(true);
      expect(Array.isArray(s.fixtures)).toBe(true);
      expect(Array.isArray(s.tabs)).toBe(true);
      expect(s.tabs[0].key).toBe('common');
    }
  });
});
