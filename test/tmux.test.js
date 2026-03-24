import { describe, it, expect } from 'vitest';
import {
  validateSessionName,
  validatePaneId,
  validateWindowIndex,
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
  it('parses tmux window list output', () => {
    const output = [
      '0|bash|1|80|24|0',
      '1|vim|0|120|40|1',
    ].join('\n');

    const result = parseWindows(output);
    expect(result).toEqual([
      { index: 0, name: 'bash', active: true, width: 80, height: 24, bell: false },
      { index: 1, name: 'vim', active: false, width: 120, height: 40, bell: true },
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(parseWindows('')).toEqual([]);
  });
});

describe('parsePanes', () => {
  it('parses tmux pane list output with geometry', () => {
    const output = [
      '%0|0|0|80|24|1|bash',
      '%1|0|24|80|12|0|node',
    ].join('\n');

    const result = parsePanes(output);
    expect(result).toEqual([
      { id: '%0', x: 0, y: 0, width: 80, height: 24, active: true, command: 'bash' },
      { id: '%1', x: 0, y: 24, width: 80, height: 12, active: false, command: 'node' },
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(parsePanes('')).toEqual([]);
  });
});

describe('parsePaneCommands', () => {
  it('parses tmux pane command list output', () => {
    const output = '0|%0|zsh\n0|%1|node\n1|%2|python';
    const result = parsePaneCommands(output);
    expect(result).toEqual([
      { windowIndex: 0, paneId: '%0', command: 'zsh', path: '', pid: 0 },
      { windowIndex: 0, paneId: '%1', command: 'node', path: '', pid: 0 },
      { windowIndex: 1, paneId: '%2', command: 'python', path: '', pid: 0 },
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(parsePaneCommands('')).toEqual([]);
  });

  it('parsePaneCommands should parse path and pid fields', () => {
    const output = '0|%1|vim|/home/user/project|1234\n0|%2|bash|/home/user|1235\n1|%3|node|/home/user/api|1236';
    const result = parsePaneCommands(output);
    expect(result).toEqual([
      { windowIndex: 0, paneId: '%1', command: 'vim', path: '/home/user/project', pid: 1234 },
      { windowIndex: 0, paneId: '%2', command: 'bash', path: '/home/user', pid: 1235 },
      { windowIndex: 1, paneId: '%3', command: 'node', path: '/home/user/api', pid: 1236 },
    ]);
  });
});
