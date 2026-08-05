import { describe, it, expect, vi } from 'vitest';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock('node-pty', () => ({ default: { spawn } }));

import { TerminalManager } from '../server/terminal.js';

describe('TerminalManager PTY locale', () => {
  it('supplies a UTF-8 locale when the service process has none', () => {
    const oldLang = process.env.LANG;
    const oldLcCtype = process.env.LC_CTYPE;
    delete process.env.LANG;
    delete process.env.LC_CTYPE;

    const term = {
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onExit: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    };
    spawn.mockReturnValue(term);
    const listeners = {};
    const ws = {
      OPEN: 1,
      CONNECTING: 0,
      readyState: 1,
      on: vi.fn((name, fn) => { listeners[name] = fn; }),
      close: vi.fn(),
      send: vi.fn(),
      ping: vi.fn(),
      terminate: vi.fn(),
    };

    try {
      const manager = new TerminalManager();
      const id = manager.create(ws, '%1');
      const options = spawn.mock.calls[0][2];
      expect(options.env.LANG).toBe('C.UTF-8');
      expect(options.env.LC_CTYPE).toBe('C.UTF-8');
      manager.destroy(id);
    } finally {
      if (oldLang === undefined) delete process.env.LANG;
      else process.env.LANG = oldLang;
      if (oldLcCtype === undefined) delete process.env.LC_CTYPE;
      else process.env.LC_CTYPE = oldLcCtype;
    }
  });
});
