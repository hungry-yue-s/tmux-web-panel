import { describe, expect, it } from 'vitest';
import { parseDarwinPs } from '../server/darwin-stats.js';

describe('Darwin process parsing', () => {
  it('parses relationships, CPU, RSS and full command lines', () => {
    const parsed = parseDarwinPs([
      '  101     1  12.5  2048 fish /opt/homebrew/bin/fish -l',
      '  202   101   3.2 65536 node node server/index.js --flag value',
      '',
    ].join('\n'));

    expect(parsed.size).toBe(2);
    expect(parsed.get(101)).toMatchObject({
      pid: 101, ppid: 1, cpuPercent: 12.5, rssKb: 2048, comm: 'fish',
      cmdline: '/opt/homebrew/bin/fish -l',
    });
    expect(parsed.get(202).cmdline).toBe('node server/index.js --flag value');
  });

  it('ignores malformed rows', () => {
    expect(parseDarwinPs('header\nnot a process\n')).toEqual(new Map());
  });
});
