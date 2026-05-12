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
  it('parses tmux session list output', () => {
    const output = [
      'main|3|1|2025-03-20T10:00:00',
      'dev|1|0|2025-03-20T11:00:00',
    ].join('\n');

    const result = parseSessions(output);
    expect(result).toEqual([
      { name: 'main', windows: 3, attached: true, lastActivity: '2025-03-20T10:00:00' },
      { name: 'dev', windows: 1, attached: false, lastActivity: '2025-03-20T11:00:00' },
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(parseSessions('')).toEqual([]);
  });
});

describe('parseWindows', () => {
  const SEP = '\x1f';

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
  const SEP = '\x1f';

  it('parses pane lines with unit-separator', () => {
    const line = ['%0', '0', '0', '80', '24', '1', 'zsh'].join(SEP);
    expect(parsePanes(line)).toEqual([
      { id: '%0', x: 0, y: 0, width: 80, height: 24, active: true, command: 'zsh' },
    ]);
  });

  it('returns empty array on empty input', () => {
    expect(parsePanes('')).toEqual([]);
  });
});

describe('parsePaneCommands', () => {
  const SEP = '\x1f';

  it('parses pane command lines with unit-separator', () => {
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
});
