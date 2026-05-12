import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PinStore } from '../server/pins.js';

describe('PinStore', () => {
  let tmpDir;
  let pinsPath;
  let store;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pins-test-'));
    pinsPath = path.join(tmpDir, 'pins.json');
    store = new PinStore(pinsPath);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('starts empty when file does not exist', async () => {
    await store.load();
    expect(store.list()).toEqual([]);
    expect(store.has('@5')).toBe(false);
  });

  it('persists set() across instances', async () => {
    await store.load();
    await store.set('@5', true);
    await store.set('@12', true);

    const store2 = new PinStore(pinsPath);
    await store2.load();
    expect(store2.list().sort()).toEqual(['@12', '@5']);
  });

  it('removes id when set(_, false)', async () => {
    await store.load();
    await store.set('@5', true);
    await store.set('@5', false);
    expect(store.has('@5')).toBe(false);
  });

  it('writes atomically (tmp file + rename)', async () => {
    await store.load();
    await store.set('@5', true);
    const entries = await fs.readdir(tmpDir);
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
    expect(entries).toContain('pins.json');
  });

  it('survives 100 concurrent set calls without losing updates', async () => {
    await store.load();
    const ops = [];
    for (let i = 0; i < 100; i++) {
      ops.push(store.set('@' + i, true));
    }
    await Promise.all(ops);

    const store2 = new PinStore(pinsPath);
    await store2.load();
    expect(store2.list()).toHaveLength(100);
  });

  it('sweep drops orphans', async () => {
    await store.load();
    await store.set('@5', true);
    await store.set('@7', true);
    await store.set('@99', true);

    await store.sweep(new Set(['@5', '@99']));
    expect(store.list().sort()).toEqual(['@5', '@99']);
  });
});
