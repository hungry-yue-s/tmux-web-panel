import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetSystemCpuForTests,
  parseDarwinDf,
  parseDarwinIostat,
  parseDarwinSwap,
  parseMemoryPressure,
  sampleSystemCpuPercent,
} from '../server/platform-system-stats.js';

describe('Darwin host metric parsers', () => {
  it('parses swap units', () => {
    expect(parseDarwinSwap('total = 8192.00M  used = 6878.06M  free = 1313.94M')).toEqual({
      total: 8192 * 1024 ** 2,
      used: 6878.06 * 1024 ** 2,
    });
  });

  it('turns memory availability into an explicit pressure metric', () => {
    expect(parseMemoryPressure('System-wide memory free percentage: 57%', 1000)).toEqual({
      total: 1000, used: 430, availablePercent: 57, metric: 'pressure',
    });
  });

  it('parses BSD df and filters internal APFS helper mounts', () => {
    const disks = parseDarwinDf([
      'Filesystem 1024-blocks Used Available Capacity Mounted on',
      '/dev/disk3s3s1 482797652 12160216 252932576 5% /',
      '/dev/disk3s6 482797652 8388632 252932576 4% /System/Volumes/VM',
      '/dev/disk3s1 482797652 196345104 252932576 44% /System/Volumes/Data',
      'devfs 218 218 0 100% /dev',
    ].join('\n'));
    expect(disks.map((d) => d.mount)).toEqual(['/', '/System/Volumes/Data']);
    expect(disks[0]).toMatchObject({ percent: 5, total: 482797652 * 1024 });
  });

  it('parses the last iostat interval across disks', () => {
    const bps = parseDarwinIostat([
      '          disk0           disk2',
      '    KB/t xfrs MB     KB/t xfrs MB',
      '   40.30 8279 325.1  10.0 100 20.0',
      '   34.77  905  30.5   8.0  10  1.5',
    ].join('\n'));
    expect(bps).toBe((30.5 + 1.5) * 1024 ** 2);
  });
});
describe('system CPU delta sampling', () => {
  beforeEach(() => _resetSystemCpuForTests());

  it('returns null for the baseline then whole-machine utilization', () => {
    const sample = (idle, user) => [{ times: { idle, user, nice: 0, sys: 0, irq: 0 } }];
    expect(sampleSystemCpuPercent(sample(800, 200))).toBeNull();
    expect(sampleSystemCpuPercent(sample(850, 250))).toBeCloseTo(50, 5);
  });
});
