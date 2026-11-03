import { it, expect, vi } from 'vitest';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pty from 'node-pty';
import { JSDOM } from 'jsdom';
import { buildTmuxAttachCommand } from '../server/terminal.js';
import { PRIVATE_TMUX_IDENTITY_FORMAT, parsePrivateTmuxIdentity, cleanupPrivateTmux } from './helpers/private-tmux.js';

const source = readFileSync('public/js/terminal.js', 'utf8');
it('tracks breakpoints while panes load and rejects stale pane responses', async () => {
  const dom = new JSDOM('<div id="content"></div>', { runScripts: 'outside-only' });
  const win = dom.window;
  const pending = [];
  Object.assign(win, {
    escapeHtml: String, innerWidth: 1024, scrollTo: vi.fn(), terminalState: {}, _terminalMode: 'split',
    state: { currentTab: 'terminal', currentSession: 'test', currentWindow: '0', currentPane: '%0' },
    _isValidWindowIndex: () => true, _createFabPanel: vi.fn(), _cleanupFontOffsets: vi.fn(),
    renderPanePills: vi.fn(), _mountTerminal: vi.fn(), switchPane: vi.fn(),
    TerminalTarget: { listPanes: () => new Promise(resolve => pending.push(resolve)), supportsTmuxActions: () => true },
  });
  win._isMobileTerminal = () => win.MobileUI ? win.MobileUI.isMobile() : win.innerWidth < 768;
  win.eval(source.slice(source.indexOf('function _cleanupTerminalResources('), source.indexOf('function cleanupTerminal()')));
  win.eval(source.slice(source.indexOf('function _terminalToolIcon'), source.indexOf('// === Mount Terminal Instance')));
  const container = win.document.getElementById('content');
  win.renderTerminal(container);
  win.innerWidth = 375;
  win.dispatchEvent(new win.Event('resize'));
  expect(pending).toHaveLength(2);
  const panes = [{ id: '%0' }, { id: '%1' }];
  pending[1](panes);
  await Promise.resolve();
  expect(win._mountTerminal).toHaveBeenLastCalledWith(container.querySelector('.terminal-container'), false);
  expect(container.querySelector('[data-mode="tab"]').getAttribute('aria-pressed')).toBe('true');
  pending[0]([{ id: '%stale' }]);
  await Promise.resolve();
  expect(win.state.panes).toEqual(panes);
  expect(win._mountTerminal).toHaveBeenCalledTimes(1);
  win.innerWidth = 1024;
  win.dispatchEvent(new win.Event('resize'));
  pending[2](panes);
  await Promise.resolve();
  expect(win._mountTerminal).toHaveBeenLastCalledWith(container.querySelector('.terminal-container'), true);
  expect(container.querySelector('[data-mode="split"]').getAttribute('aria-pressed')).toBe('true');
  win.innerWidth = 1100;
  win.dispatchEvent(new win.Event('resize'));
  expect(pending).toHaveLength(3);
  win._cleanupTerminalResources();
  dom.window.close();
});

it('retains a private directory without killing a server whose identity changed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmux-cleanup-test-'));
  const socket = join(dir, 'tmux.sock');
  const killServer = vi.fn();
  try {
    await expect(cleanupPrivateTmux({ dir, socket, identity: { pid: 1, socketPath: socket },
      readIdentity: async () => ({ pid: 2, socketPath: socket }), killServer })).rejects.toThrow('identity changed');
    expect(killServer).not.toHaveBeenCalled();
    expect(existsSync(dir)).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); } // No server was created in this fixture.
});

it('reports an unverified cleanup without replacing the original test error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmux-cleanup-test-'));
  const socket = join(dir, 'tmux.sock');
  const original = new Error('fixture assertion failure');
  const killServer = vi.fn();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const failing = async () => {
      try { throw original; }
      finally {
        await cleanupPrivateTmux({ dir, socket, identity: { pid: 1, socketPath: socket },
          readIdentity: async () => ({ pid: 2, socketPath: socket }), killServer, primaryError: original });
      }
    };
    await expect(failing()).rejects.toBe(original);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Retained private tmux directory'));
    expect(killServer).not.toHaveBeenCalled();
    expect(existsSync(dir)).toBe(true);
  } finally { warn.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
});

let tmux;
// This harness exercises POSIX sh/PTY semantics, not the native Windows/MSYS2
// spawn path. Never let Windows bypass isolation through a resolved tmux.exe.
if (process.platform !== 'win32') {
  try { tmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim(); } catch { /* optional local integration */ }
}
it.skipIf(process.platform === 'win32' || !tmux)('keeps the latest mode after overlapping mobile/desktop attachments exit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmux-layout-test-'));
  const socket = join(dir, 'tmux.sock');
  const env = { ...process.env };
  delete env.TMUX;
  delete env.TMUX_PANE;
  const run = (...args) => execFileSync(tmux, ['-S', socket, ...args], { timeout: 5000, encoding: 'utf8', env }).trim();
  const readIdentity = () => parsePrivateTmuxIdentity(run('display-message', '-p', PRIVATE_TMUX_IDENTITY_FORMAT), socket);
  const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
  const clients = [];
  let identity, primaryError;
  const waitUntil = async (check) => {
    for (let i = 0; i < 100; i++) {
      if (check()) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Isolated tmux transition timed out');
  };
  try {
    run('-f', '/dev/null', 'new-session', '-d', '-s', 'test', '-x', '120', '-y', '40', 'sleep 60');
    identity = readIdentity();
    run('split-window', '-h', '-t', 'test:0', 'sleep 60');
    const panes = run('list-panes', '-t', 'test:0', '-F', '#{pane_id}').split('\n');
    let previous;
    for (const [nozoom, pane] of [[false, panes[0]], [true, panes[1]], [false, panes[1]], [false, panes[0]], [true, panes[0]], [false, panes[1]]]) {
      const command = buildTmuxAttachCommand(pane, { nozoom });
      expect(command).toMatch(/^tmux /);
      const isolated = quote(tmux) + ' -S ' + quote(socket) + ' ' + command.slice('tmux '.length);
      const term = pty.spawn('/bin/sh', ['-c', isolated], {
        cols: nozoom ? 120 : 40, rows: 30, name: 'xterm-256color',
        env,
      });
      const client = { term, exited: false };
      term.onData(() => {});
      term.onExit(() => { client.exited = true; });
      clients.push(client);
      await waitUntil(() => run('list-clients', '-F', '#{client_tty}').includes(term.ptsName));
      // The old client exits only after the new client takes over with -d.
      if (previous) await waitUntil(() => previous.exited);
      expect(run('display-message', '-p', '-t', pane, '#{window_zoomed_flag}')).toBe(nozoom ? '0' : '1');
      expect(run('display-message', '-p', '-t', 'test:0', '#{pane_id}')).toBe(pane);
      previous = client;
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    for (const { term, exited } of clients) if (!exited) try { term.kill(); } catch { /* already exited */ }
    await cleanupPrivateTmux({ dir, socket, identity, readIdentity, killServer: () => run('kill-server'), primaryError });
  }
}, 15000);
