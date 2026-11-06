import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { createViewStore, validateWindowTarget } from '../../plugins/workbench/client/model.js';

const target = { serverId: 'dev', instanceId: '42:123', sessionId: '$1', windowId: '@1', clientId: 'c-stable' };
function storage() { return new JSDOM('', { url: 'https://panel.test' }).window.localStorage; }

describe('native window view identities', () => {
  it('restores one window and its persistent client identity without owning the pane layout', () => {
    const disk = storage(); const store = createViewStore(disk, 'install:user');
    const view = store.create({ ...target, title: '开发' });
    store.update(view.id, (saved) => { saved.fontSize = 18; });
    const saved = createViewStore(disk, 'install:user').get(view.id);
    expect(saved).toMatchObject({ ...target, fontSize: 18 });
    expect(saved.root).toBeUndefined();
    expect(Object.isFrozen(validateWindowTarget(saved))).toBe(true);
    expect(createViewStore(disk, 'another-user').list()).toEqual([]);
    expect(() => store.update(view.id, (item) => { item.windowId = '@2'; })).toThrow();
    store.follow(view.id, { ...target, sessionId: '$2', windowId: '@9' });
    expect(store.get(view.id)).toMatchObject({ sessionId: '$2', windowId: '@9' });
    expect(() => store.follow(view.id, { ...target, instanceId: '99:456' })).toThrow();
  });
  it('retains a request before uncertain window creation and never binds a different instance', () => {
    const disk = storage(); const store = createViewStore(disk, 'scope');
    const pending = store.create({ serverId: 'dev', instanceId: '42:123', sessionId: '$1' });
    const restored = createViewStore(disk, 'scope');
    expect(restored.get(pending.id).requestId).toBe(pending.requestId);
    expect(restored.get(pending.id).clientId).toBe(pending.clientId);
    expect(() => restored.bind(pending.id, { ...target, instanceId: 'other' })).toThrow();
    expect(() => restored.bind(pending.id, { ...target, sessionId: '$2' })).toThrow();
    restored.bind(pending.id, target);
    expect(restored.get(pending.id).windowId).toBe('@1');
    expect(() => restored.bind(pending.id, { ...target, windowId: '@2' })).toThrow();
  });
  it('leaves prototype v1 layouts untouched and rejects corrupted v2 identities', () => {
    const disk = storage(); const old = JSON.stringify({ version: 1, views: [{ id: 'old', root: { type: 'split' } }] });
    disk.setItem('twp_workbench_v1:scope', old);
    const store = createViewStore(disk, 'scope'); expect(store.list()).toEqual([]);
    const view = store.create(target);
    const raw = JSON.parse(disk.getItem('twp_workbench_v2:scope')); raw.views[0].clientId = 'bad;kill-server';
    disk.setItem('twp_workbench_v2:scope', JSON.stringify(raw));
    expect(createViewStore(disk, 'scope').get(view.id)).toBeNull();
    expect(disk.getItem('twp_workbench_v1:scope')).toBe(old);
  });
});
