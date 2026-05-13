import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';

const baseline = '   8       0 sda 100 0 2048 0 50 0 1024 0 0 0 0 0 0 0 0 0 0\n';
const nextSample = '   8       0 sda 100 0 3072 0 50 0 2048 0 0 0 0 0 0 0 0 0 0\n';

async function importReadDiskIo(readFile) {
  vi.doMock('node:fs/promises', () => ({
    readFile,
    readdir: vi.fn(),
  }));
  return import('../../server/proc-stats.js').then((m) => m.readDiskIo);
}

describe('readDiskIo', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock('node:fs/promises');
  });

  test('returns zero rates on first call and records baseline state', async () => {
    const readFile = vi.fn().mockResolvedValue(baseline);
    const readDiskIo = await importReadDiskIo(readFile);

    vi.setSystemTime(1_000);
    const first = await readDiskIo();
    vi.setSystemTime(2_000);
    const second = await readDiskIo();

    expect(first.get('sda')).toEqual({ readBps: 0, writeBps: 0 });
    expect(second.get('sda')).toEqual({ readBps: 0, writeBps: 0 });
  });

  test('computes read and write rates from sector deltas', async () => {
    const readFile = vi.fn()
      .mockResolvedValueOnce(baseline)
      .mockResolvedValueOnce(nextSample);
    const readDiskIo = await importReadDiskIo(readFile);

    vi.setSystemTime(1_000);
    await readDiskIo();
    vi.setSystemTime(2_000);
    const second = await readDiskIo();

    expect(second.get('sda')).toEqual({ readBps: 524288, writeBps: 524288 });
  });
});
