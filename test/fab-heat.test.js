import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.localStorage = dom.window.localStorage;

await import('../public/js/fab-heat.js');
const FabHeat = globalThis.window.FabHeat;

describe('FabHeat', () => {
  beforeEach(() => {
    localStorage.clear();
    FabHeat._resetCache();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-20T00:00:00Z'));
  });

  afterEach(() => vi.useRealTimers());

  it('new item has score 0', () => {
    expect(FabHeat.score('claude', 'plan')).toBe(0);
  });

  it('touch sets score to 1 initially', () => {
    FabHeat.touch('claude', 'plan');
    expect(FabHeat.score('claude', 'plan')).toBeCloseTo(1, 5);
  });

  it('multiple touches accumulate', () => {
    FabHeat.touch('claude', 'plan');
    FabHeat.touch('claude', 'plan');
    FabHeat.touch('claude', 'plan');
    expect(FabHeat.score('claude', 'plan')).toBeCloseTo(3, 5);
  });

  it('decays exponentially over days', () => {
    FabHeat.touch('claude', 'plan');
    vi.setSystemTime(new Date('2026-05-04T00:00:00Z')); // 14 days later
    expect(FabHeat.score('claude', 'plan')).toBeCloseTo(0.487, 2); // 0.95^14 ≈ 0.488
  });

  it('touching after decay combines with new use', () => {
    FabHeat.touch('claude', 'plan');
    vi.setSystemTime(new Date('2026-05-04T00:00:00Z'));
    FabHeat.touch('claude', 'plan');
    expect(FabHeat.score('claude', 'plan')).toBeCloseTo(1.487, 2);
  });

  it('topN sorts by score', () => {
    FabHeat.touch('terminal', 'a');
    FabHeat.touch('terminal', 'b'); FabHeat.touch('terminal', 'b');
    FabHeat.touch('terminal', 'c'); FabHeat.touch('terminal', 'c'); FabHeat.touch('terminal', 'c');
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const ranked = FabHeat.topN('terminal', items, 3);
    expect(ranked.map(it => it.id)).toEqual(['c', 'b', 'a']);
  });

  it('initHeatForNew uses median of top 10 × 0.5', () => {
    ['a','b','c','d','e','f','g','h','i','j'].forEach((id, i) => {
      for (let k = 0; k < (i + 1); k++) FabHeat.touch('terminal', id);
    });
    FabHeat.initHeatForNew('terminal', 'new-item');
    // Top 10 counts: [10,9,8,7,6,5,4,3,2,1], median (index 5) = 5
    expect(FabHeat.score('terminal', 'new-item')).toBeCloseTo(2.5, 1);
  });

  it('seedHeat injects initial count', () => {
    FabHeat.seedHeat('terminal', 'adb-logcat', 20);
    expect(FabHeat.score('terminal', 'adb-logcat')).toBeCloseTo(20, 5);
  });

  it('clearScene wipes one scene without affecting others', () => {
    FabHeat.touch('terminal', 'a');
    FabHeat.touch('claude', 'b');
    FabHeat.clearScene('terminal');
    expect(FabHeat.score('terminal', 'a')).toBe(0);
    expect(FabHeat.score('claude', 'b')).toBeCloseTo(1, 5);
  });
});
