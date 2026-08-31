import { describe, it, expect } from 'vitest';
import {
  validateSessionName,
  validatePaneId,
  validateWindowIndex,
  validateWindowId,
  parseSessions,
  parseWindows,
  parsePanes,
  parsePaneCommands,
  parsePaneAddress,
  validatePaneLabel,
  setPaneLabel,
} from '../server/tmux.js';

describe('validateSessionName', () => {
  it('accepts valid ASCII names', () => {
    expect(validateSessionName('my-session')).toBe(true);
    expect(validateSessionName('a_b-c')).toBe(true);
    expect(validateSessionName('session1')).toBe(true);
    expect(validateSessionName('My Session')).toBe(true);
  });

  it('accepts valid Unicode names', () => {
    expect(validateSessionName('中文会话')).toBe(true);
    expect(validateSessionName('会话_test-1')).toBe(true);
  });

  it('rejects command injection attempts', () => {
    expect(validateSessionName('; rm -rf')).toBe(false);
    expect(validateSessionName('$(cmd)')).toBe(false);
    expect(validateSessionName('`whoami`')).toBe(false);
    expect(validateSessionName('a|b')).toBe(false);
    expect(validateSessionName('a&b')).toBe(false);
    expect(validateSessionName('a>b')).toBe(false);
  });

  it('rejects empty or whitespace-only names', () => {
    expect(validateSessionName('')).toBe(false);
    expect(validateSessionName('   ')).toBe(false);
  });

  it('rejects non-string inputs', () => {
    expect(validateSessionName(null)).toBe(false);
    expect(validateSessionName(undefined)).toBe(false);
    expect(validateSessionName(123)).toBe(false);
  });
});

describe('validatePaneId', () => {
  it('accepts valid pane IDs', () => {
    expect(validatePaneId('%0')).toBe(true);
    expect(validatePaneId('%123')).toBe(true);
    expect(validatePaneId('%9999')).toBe(true);
  });

  it('rejects invalid pane IDs', () => {
    expect(validatePaneId('0')).toBe(false);
    expect(validatePaneId('abc')).toBe(false);
    expect(validatePaneId('%')).toBe(false);
    expect(validatePaneId('%abc')).toBe(false);
    expect(validatePaneId('')).toBe(false);
    expect(validatePaneId(null)).toBe(false);
  });
});

describe('validatePaneLabel', () => {
  it('accepts normal short labels (incl. Unicode) and empty', () => {
    expect(validatePaneLabel('build')).toBe(true);
    expect(validatePaneLabel('构建服务')).toBe(true);
    expect(validatePaneLabel('')).toBe(true);
  });
  it('rejects control chars, newlines and the field separator', () => {
    expect(validatePaneLabel('a\x1fb')).toBe(false);
    expect(validatePaneLabel('a\nb')).toBe(false);
    expect(validatePaneLabel('a\x00b')).toBe(false);
    expect(validatePaneLabel('a=:=b')).toBe(false);
  });
  it('rejects over-long and non-string', () => {
    expect(validatePaneLabel('x'.repeat(33))).toBe(false);
    expect(validatePaneLabel(123)).toBe(false);
    expect(validatePaneLabel(null)).toBe(false);
  });
});

describe('setPaneLabel', () => {
  it('rejects invalid pane id', async () => {
    await expect(setPaneLabel('bad', 'x')).rejects.toThrow(/Invalid pane ID/);
  });
  it('rejects invalid label', async () => {
    await expect(setPaneLabel('%0', 'x'.repeat(40))).rejects.toThrow(/Invalid pane label/);
  });
});

describe('validateWindowIndex', () => {
  it('accepts valid window indices', () => {
    expect(validateWindowIndex('0')).toBe(true);
    expect(validateWindowIndex('1')).toBe(true);
    expect(validateWindowIndex('99')).toBe(true);
  });

  it('rejects invalid window indices', () => {
    expect(validateWindowIndex('-1')).toBe(false);
    expect(validateWindowIndex('abc')).toBe(false);
    expect(validateWindowIndex('')).toBe(false);
    expect(validateWindowIndex('1.5')).toBe(false);
    expect(validateWindowIndex(null)).toBe(false);
  });
});

describe('validateWindowId', () => {
  it('accepts valid window IDs', () => {
    expect(validateWindowId('@0')).toBe(true);
    expect(validateWindowId('@1')).toBe(true);
    expect(validateWindowId('@123')).toBe(true);
  });

  it('rejects invalid forms', () => {
    expect(validateWindowId('0')).toBe(false);
    expect(validateWindowId('%0')).toBe(false);
    expect(validateWindowId('@')).toBe(false);
    expect(validateWindowId('@abc')).toBe(false);
    expect(validateWindowId('@1@2')).toBe(false);
    expect(validateWindowId('')).toBe(false);
    expect(validateWindowId(null)).toBe(false);
    expect(validateWindowId(undefined)).toBe(false);
  });
});

describe('parseSessions', () => {
  const SEP = '=:=';

  it('parses 5 separated fields including the stable session id', () => {
    const output = [
      ['$0', 'main', '3', '1', '2025-03-20T10:00:00'].join(SEP),
      ['$4', 'dev', '1', '0', '2025-03-20T11:00:00'].join(SEP),
    ].join('\n');

    expect(parseSessions(output)).toEqual([
      { id: '$0', name: 'main', windows: 3, attached: true, lastActivity: '2025-03-20T10:00:00' },
      { id: '$4', name: 'dev', windows: 1, attached: false, lastActivity: '2025-03-20T11:00:00' },
    ]);
  });

  it('keeps the id and counters exact when the name contains the separator', () => {
    const line = ['$7', `a${SEP}b`, '2', '1', '2025-03-20T10:00:00'].join(SEP);
    expect(parseSessions(line)).toEqual([
      { id: '$7', name: `a${SEP}b`, windows: 2, attached: true, lastActivity: '2025-03-20T10:00:00' },
    ]);
  });

  it('still parses legacy pipe-delimited output with a null id', () => {
    const output = [
      'main|3|1|2025-03-20T10:00:00',
      'dev|1|0|2025-03-20T11:00:00',
    ].join('\n');

    expect(parseSessions(output)).toEqual([
      { id: null, name: 'main', windows: 3, attached: true, lastActivity: '2025-03-20T10:00:00' },
      { id: null, name: 'dev', windows: 1, attached: false, lastActivity: '2025-03-20T11:00:00' },
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(parseSessions('')).toEqual([]);
  });
});

describe('parseWindows', () => {
  const SEP = '=:=';

  it('parses 8 fields including id and activity', () => {
    const line = ['@5', '0', 'main', '1', '80', '24', '0', '1700000000'].join(SEP);
    expect(parseWindows(line)).toEqual([
      { id: '@5', index: 0, name: 'main', active: true, width: 80, height: 24, bell: false, activity: 1700000000 },
    ]);
  });

  it('parses multiple lines', () => {
    const out = [
      ['@1', '0', 'shell', '1', '80', '24', '0', '1700000000'].join(SEP),
      ['@2', '1', 'vim', '0', '80', '24', '1', '1700000100'].join(SEP),
    ].join('\n');
    const parsed = parseWindows(out);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe('@1');
    expect(parsed[1].bell).toBe(true);
    expect(parsed[1].activity).toBe(1700000100);
  });

  it('keeps ids and numbers exact when the name contains the separator', () => {
    const line = ['@5', '1', `plan${SEP}b`, '1', '120', '40', '0', '1700000000'].join(SEP);
    expect(parseWindows(line)).toEqual([
      { id: '@5', index: 1, name: `plan${SEP}b`, active: true, width: 120, height: 40, bell: false, activity: 1700000000 },
    ]);
  });

  it('handles names containing pipe character', () => {
    const line = ['@9', '3', 'docs|notes', '0', '80', '24', '0', '0'].join(SEP);
    const parsed = parseWindows(line);
    expect(parsed[0].name).toBe('docs|notes');
  });

  it('returns empty array on empty input', () => {
    expect(parseWindows('')).toEqual([]);
    expect(parseWindows('   ')).toEqual([]);
  });
});

describe('parsePanes', () => {
  const SEP = '=:=';

  it('parses pane lines with the field separator and @pane_label', () => {
    const line = ['%0', '0', '0', '80', '24', '1', 'zsh', '构建服务'].join(SEP);
    expect(parsePanes(line)).toEqual([
      { id: '%0', x: 0, y: 0, width: 80, height: 24, active: true, command: 'zsh', label: '构建服务' },
    ]);
  });

  it('defaults label to empty string when @pane_label unset', () => {
    const line = ['%1', '0', '0', '80', '24', '0', 'vim', ''].join(SEP);
    expect(parsePanes(line)[0].label).toBe('');
  });

  it('lets the command absorb a separator while id, geometry and label stay exact', () => {
    const line = ['%2', '3', '4', '80', '24', '1', `fi${SEP}sh`, '主窗格'].join(SEP);
    expect(parsePanes(line)).toEqual([
      { id: '%2', x: 3, y: 4, width: 80, height: 24, active: true, command: `fi${SEP}sh`, label: '主窗格' },
    ]);
  });

  it('returns empty array on empty input', () => {
    expect(parsePanes('')).toEqual([]);
  });
});

describe('parsePaneCommands', () => {
  const SEP = '=:=';

  it('parses pane command lines', () => {
    const line = ['0', '%1', 'vim', '/home/u', '1234'].join(SEP);
    expect(parsePaneCommands(line)).toEqual([
      { windowIndex: 0, paneId: '%1', command: 'vim', path: '/home/u', pid: 1234 },
    ]);
  });

  it('handles missing path and pid', () => {
    const line = ['0', '%1', 'zsh', '', ''].join(SEP);
    const parsed = parsePaneCommands(line);
    expect(parsed[0].path).toBe('');
    expect(parsed[0].pid).toBe(0);
  });

  it('lets the path absorb a separator while ids and pid stay exact', () => {
    const line = ['2', '%9', 'codex', `/tmp/a${SEP}b`, '4321'].join(SEP);
    expect(parsePaneCommands(line)).toEqual([
      { windowIndex: 2, paneId: '%9', command: 'codex', path: `/tmp/a${SEP}b`, pid: 4321 },
    ]);
  });
});

describe('parsePaneAddress', () => {
  it('parses one stable pane address and falls back to the session name', () => {
    expect(parsePaneAddress(['%12', '$1', 'DataAnt', '@5', '2'].join('=:='))).toEqual({
      paneId: '%12', sessionId: '$1', sessionName: 'DataAnt', windowId: '@5', windowIndex: 2,
    });
    expect(parsePaneAddress(['%12', '', 'legacy', '@5', '2'].join('=:=')).sessionId).toBe('legacy');
    expect(parsePaneAddress('')).toBeNull();
  });
});

describe('by-id tmux helpers', () => {
  it('rejects bad windowId for renameWindowById', async () => {
    const { renameWindowById } = await import('../server/tmux.js');
    await expect(renameWindowById('bad', 'name')).rejects.toThrow(/Invalid window ID/);
  });

  it('rejects bad windowId for killWindowById', async () => {
    const { killWindowById } = await import('../server/tmux.js');
    await expect(killWindowById('bad')).rejects.toThrow(/Invalid window ID/);
  });

  it('rejects bad windowId or sessionName for moveWindowById', async () => {
    const { moveWindowById } = await import('../server/tmux.js');
    await expect(moveWindowById('bad', 'dst')).rejects.toThrow(/Invalid window ID/);
    await expect(moveWindowById('@1', '; rm')).rejects.toThrow(/Invalid session name/);
  });

  it('rejects invalid windowName for renameWindowById', async () => {
    const { renameWindowById } = await import('../server/tmux.js');
    await expect(renameWindowById('@1', 'bad:name')).rejects.toThrow(/Invalid window name/);
  });
});
