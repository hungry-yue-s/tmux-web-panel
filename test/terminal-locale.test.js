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
      const id = manager.create(ws, '%1', 80, 24, false, {
        spawn: { file: 'ssh', args: [], env: { SSH_ASKPASS_REQUIRE: 'force', TMUX_PANEL_SSH_SERVER_ID: 'remote' } },
      });
      const options = spawn.mock.calls[0][2];
      expect(options.env.LANG).toBe('C.UTF-8');
      expect(options.env.LC_CTYPE).toBe('C.UTF-8');
      expect(options.env.SSH_ASKPASS_REQUIRE).toBe('force');
      expect(options.env.TMUX_PANEL_SSH_SERVER_ID).toBe('remote');
      manager.destroy(id);
    } finally {
      if (oldLang === undefined) delete process.env.LANG;
      else process.env.LANG = oldLang;
      if (oldLcCtype === undefined) delete process.env.LC_CTYPE;
      else process.env.LC_CTYPE = oldLcCtype;
    }
  });
});
