import { describe, it, expect } from 'vitest';
import { parseMacProcesses } from '../server/diagnostics-platform.js';

describe('diagnostic OS process metadata', () => {
  it('reads cumulative CPU and RSS while excluding unrelated process names and command paths', () => {
    const rows = parseMacProcesses([
      '123 1 Mon Nov 2 08:00:00 2026 1:02.50 4096 /Applications/Tmux Panel.app/Contents/MacOS/Tmux Panel',
      '124 1 Mon Nov 2 08:00:00 2026 1-02:03:04 1024 /usr/local/bin/node',
      '125 1 Mon Nov 2 08:00:00 2026 0:01.00 1024 /usr/bin/unrelated',
      '126 1 Mon Nov 2 08:00:00 2026 0:02.00 2048 /Applications/Tmux Panel.app/Contents/MacOS/TmuxPanel',
    ].join('\n'));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ pid: 123, ppid: 1, name: 'Tmux Panel', cpuSeconds: 62.5, rssBytes: 4194304 });
    expect(rows[1].cpuSeconds).toBe(93784);
    expect(rows[2].name).toBe('TmuxPanel');
    expect(JSON.stringify(rows)).not.toContain('/Applications');
  });
});
