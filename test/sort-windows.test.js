import { describe, it, expect } from 'vitest';
import { sortWindowsForSnapshot } from '../public/js/sort-windows.js';

function mkWindow(id, name, opts = {}) {
  return {
    id,
    index: opts.index ?? Number(id.slice(1)),
    name,
    active: opts.active || false,
    bell: opts.bell || false,
    activity: opts.activity ?? 0,
    width: 80,
    height: 24,
  };
}

describe('sortWindowsForSnapshot', () => {
  it('returns ids in tier order: pinned, promoted-bell, bell, active, rest (by activity desc)', () => {
    const windows = [
      mkWindow('@1', 'a', { activity: 100 }),
      mkWindow('@2', 'b', { bell: true, activity: 50 }),
      mkWindow('@3', 'c', { active: true, activity: 75 }),
      mkWindow('@4', 'd', { activity: 200 }),
      mkWindow('@5', 'e', { activity: 25 }),
    ];
    const order = sortWindowsForSnapshot(windows, {
      pinsById: {},
      promotedBellIds: [],
    });
    expect(order).toEqual(['@2', '@3', '@4', '@1', '@5']);
  });

  it('puts pinned above bell', () => {
    const windows = [
      mkWindow('@1', 'a', { activity: 100 }),
      mkWindow('@2', 'b', { bell: true, activity: 50 }),
      mkWindow('@3', 'c', { activity: 75 }),
    ];
    const order = sortWindowsForSnapshot(windows, {
      pinsById: { '@1': true },
      promotedBellIds: [],
    });
    expect(order).toEqual(['@1', '@2', '@3']);
  });

  it('within pinned tier sorts by activity desc', () => {
    const windows = [
      mkWindow('@1', 'a', { activity: 100 }),
      mkWindow('@2', 'b', { activity: 200 }),
      mkWindow('@3', 'c', { activity: 50 }),
    ];
    const order = sortWindowsForSnapshot(windows, {
      pinsById: { '@1': true, '@2': true, '@3': true },
      promotedBellIds: [],
    });
    expect(order).toEqual(['@2', '@1', '@3']);
  });

  it('places promoted bell ids ABOVE regular bell tier, newest first', () => {
    const windows = [
      mkWindow('@1', 'a', { bell: true, activity: 100 }),
      mkWindow('@2', 'b', { bell: true, activity: 200 }),
      mkWindow('@3', 'c', { bell: true, activity: 50 }),
    ];
    const order = sortWindowsForSnapshot(windows, {
      pinsById: {},
      promotedBellIds: ['@3', '@1'],
    });
    expect(order).toEqual(['@3', '@1', '@2']);
  });

  it('skips promoted ids that are pinned (they already sit higher)', () => {
    const windows = [
      mkWindow('@1', 'a', { activity: 100 }),
      mkWindow('@2', 'b', { bell: true, activity: 200 }),
    ];
    const order = sortWindowsForSnapshot(windows, {
      pinsById: { '@1': true },
      promotedBellIds: ['@1'],
    });
    expect(order).toEqual(['@1', '@2']);
  });

  it('handles a single active window with no other signals', () => {
    const windows = [
      mkWindow('@1', 'a', { active: true, activity: 100 }),
      mkWindow('@2', 'b', { activity: 200 }),
    ];
    const order = sortWindowsForSnapshot(windows, {
      pinsById: {},
      promotedBellIds: [],
    });
    expect(order).toEqual(['@1', '@2']);
  });

  it('returns [] for empty input', () => {
    expect(sortWindowsForSnapshot([], { pinsById: {}, promotedBellIds: [] })).toEqual([]);
  });

  it('is deterministic when activity is equal (stable: original order falls through)', () => {
    const windows = [
      mkWindow('@1', 'a', { activity: 100 }),
      mkWindow('@2', 'b', { activity: 100 }),
      mkWindow('@3', 'c', { activity: 100 }),
    ];
    const order = sortWindowsForSnapshot(windows, { pinsById: {}, promotedBellIds: [] });
    expect(order).toEqual(['@1', '@2', '@3']);
  });
});
