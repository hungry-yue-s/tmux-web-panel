import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { createViewStore, validateWindowTarget } from '../../plugins/workbench/client/model.js';

const target = { serverId: 'dev', instanceId: '42:123', sessionId: '$1', windowId: '@1', clientId: 'c-stable' };
function storage() { return new JSDOM('', { url: 'https://panel.test' }).window.localStorage; }

describe('native window view identities', () => {
  it('merges independent tabs without replacing another view or reviving a closed view', () => {
    const disk = storage(), first = createViewStore(disk, 'shared'), second = createViewStore(disk, 'shared');
    const one = first.create({ ...target, title: 'one' });
    const two = second.create({ ...target, title: 'two' });
    expect(createViewStore(disk, 'shared').list().map(view => view.id).sort()).toEqual([one.id, two.id].sort());
    first.update(one.id, saved => { saved.title = 'renamed'; });
    second.update(two.id, saved => { saved.fontSize = 18; });
    expect(first.get(two.id).fontSize).toBe(18);
    expect(second.get(one.id).title).toBe('renamed');
    expect(() => first.update(one.id, saved => { second.close(one.id); saved.title = 'late'; })).toThrow('工作台不存在');
    expect(createViewStore(disk, 'shared').get(one.id)).toBeNull();
    expect(createViewStore(disk, 'shared').get(two.id)).not.toBeNull();
  });

  it('restores the same native client after the shared Anymux storage migration', () => {
    const disk = storage();
    const legacy = { version: 2, views: [{ ...target, id: 'saved-view', requestId: 'saved-request', title: '旧工作台', fontSize: 17 }] };
    disk.setItem('twp_workbench_v2:scope', JSON.stringify(legacy));
    expect(createViewStore(disk, 'scope').get('saved-view')).toMatchObject({ clientId: 'c-stable', fontSize: 17 });
    new Function('window', readFileSync('plugins/ui/client/js/legacy-storage.js', 'utf8'))({ localStorage: disk });
    const store = createViewStore(disk, 'scope');
    expect(store.get('saved-view')).toMatchObject({ clientId: 'c-stable', title: '旧工作台' });
    store.update('saved-view', saved => { saved.fontSize = 19; });
    expect(createViewStore(disk, 'scope').get('saved-view').fontSize).toBe(19);
    expect(JSON.parse(disk.getItem('anymux_workbench_v2:scope')).views[0].fontSize).toBe(17);
  });
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
    const raw = JSON.parse(disk.getItem('anymux_workbench_v3:scope:' + view.id)); raw.clientId = 'bad;kill-server';
    disk.setItem('anymux_workbench_v3:scope:' + view.id, JSON.stringify(raw));
    expect(createViewStore(disk, 'scope').get(view.id)).toBeNull();
    expect(disk.getItem('twp_workbench_v1:scope')).toBe(old);
  });
});
