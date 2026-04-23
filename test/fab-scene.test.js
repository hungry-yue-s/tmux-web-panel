import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;

await import('../public/js/fab-scene.js');
const scene = window.FabScene;

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

describe('fab-scene matching', () => {
  beforeEach(() => localStorage.clear());

  it('matches claude command to claude scene', () => {
    const scenes = scene.loadScenes();
    expect(scene.matchScene('claude', scenes)).toBe('claude');
  });

  it('matches nvim to vim scene', () => {
    const scenes = scene.loadScenes();
    expect(scene.matchScene('nvim', scenes)).toBe('vim');
  });

  it('matches substring (claude-code → claude)', () => {
    const scenes = scene.loadScenes();
    expect(scene.matchScene('claude-code', scenes)).toBe('claude');
  });

  it('falls back to terminal for unknown command', () => {
    const scenes = scene.loadScenes();
    expect(scene.matchScene('bash', scenes)).toBe('terminal');
    expect(scene.matchScene('zsh', scenes)).toBe('terminal');
  });

  it('prefers newer custom scenes over builtin on conflict', () => {
    const scenes = scene.loadScenes();
    scene.addScene({
      id: 'git-custom', name: 'Git', icon: '🔧',
      detect: ['lazygit'],
      fixtures: [], tabs: [{key:'common',name:'常用'}], defaultItems: {common:[]},
    });
    const updated = scene.loadScenes();
    expect(scene.matchScene('lazygit', updated)).toBe('git-custom');
  });
});

describe('fab-scene CRUD persistence', () => {
  beforeEach(() => localStorage.clear());

  it('persists added scene across loads', () => {
    scene.addScene({
      id: 'git', name: 'Git', icon: '🔧', detect: ['git'],
      fixtures: [], tabs: [{key:'common',name:'常用'}], defaultItems: {common:[]},
    });
    const scenes = scene.loadScenes();
    expect(scenes.find(s => s.id === 'git')).toBeDefined();
  });

  it('cannot delete builtin scenes', () => {
    expect(() => scene.deleteScene('terminal')).toThrow(/builtin/);
  });

  it('deletes custom scene', () => {
    scene.addScene({
      id: 'tmp', name: 'Tmp', icon: '✨', detect: [],
      fixtures: [], tabs: [{key:'common',name:'常用'}], defaultItems: {common:[]},
    });
    scene.deleteScene('tmp');
    const scenes = scene.loadScenes();
    expect(scenes.find(s => s.id === 'tmp')).toBeUndefined();
  });
});
