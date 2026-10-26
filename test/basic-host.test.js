import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  BasicHost,
  DETECT_SCRIPT,
  PRELUDE,
  attachScript,
  attachScriptName,
  normalizePlatform,
  parseFacts,
  sshTmuxExecutor,
} from '../server/hub/basic/basic-host.js';
import { parseTree } from '../server/tmux.js';
import { AppError, ErrorCode } from '../server/servers/errors.js';

const SEP = '=:=';

/** A fake SshConnection that answers scripts by what they ask tmux to do. */
function fakeConnection({ detect = 'kernel=Linux\narch=x86_64\nhostname=box\ntmux=tmux 3.5a\n', fail = null } = {}) {
  const scripts = [];
  const uploads = [];
  return {
    id: 'box',
    scripts,
    uploads,
    sshEnv: () => ({ ASKPASS: 'x' }),
    ptyArgs: (command = null) => (command === null ? ['-tt', 'box'] : ['-tt', 'box', command]),
    uploadFile: vi.fn(async (local, remote, options) => {
      uploads.push({ remote, options, content: readFileSync(local, 'utf8') });
    }),
    runScript: vi.fn(async (script) => {
      scripts.push(script);
      if (fail) throw fail;
      if (script === DETECT_SCRIPT) return { stdout: detect, stderr: '' };
      if (script.includes("exec tmux list-sessions -F")) {
        return {
          stdout: [
            ['S', '$1', '工作 区', '1', '0', '1700000000'].join(SEP),
            ['W', '$1', '@2', '0', 'logs', '1', '80', '24', '0', '0'].join(SEP),
            ['P', '@2', '%3', '0', '0', '80', '24', '1', 'bash', ''].join(SEP),
          ].join('\n') + '\n',
          stderr: '',
        };
      }
      if (script.includes('exec tmux new-session')) return { stdout: '$9\n', stderr: '' };
      if (script.includes('exec tmux display-message')) {
        return { stdout: ['%3', '$1', '工作 区', '@2', '0'].join(SEP) + '\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    }),
  };
}

describe('facts', () => {
  it('parses detection output and maps MSYS2 to windows', () => {
    expect(parseFacts('kernel=MSYS_NT-10.0\nhostname=a=b\n')).toEqual({ kernel: 'MSYS_NT-10.0', hostname: 'a=b' });
    expect(normalizePlatform('Linux')).toBe('linux');
    expect(normalizePlatform('Darwin')).toBe('darwin');
    expect(normalizePlatform('MINGW64_NT-10.0')).toBe('windows');
    expect(normalizePlatform('unknown')).toBeNull();
  });

  it('only reads; it never installs or starts anything', () => {
    expect(DETECT_SCRIPT).not.toMatch(/\b(install|apt|brew|new-session|start-server)\b/);
    expect(DETECT_SCRIPT.startsWith(PRELUDE)).toBe(true);
  });
});

describe('sshTmuxExecutor', () => {
  it('sends tmux as a quoted sh script on stdin, never through the login shell', async () => {
    const connection = fakeConnection();
    await sshTmuxExecutor(connection).exec('tmux', ['new-session', '-d', '-s', "it's 工作", '-F', '#{session_id}']);

    const script = connection.scripts[0];
    expect(script.startsWith(PRELUDE)).toBe(true);
    expect(script).toContain(`exec tmux new-session -d -s 'it'\\''s 工作' -F '#{session_id}'`);
  });
});

describe('attach script', () => {
  it('mirrors the local attach queue for one pane and is named by plain tokens', () => {
    const script = attachScript('%12', false);
    expect(script.startsWith('#!/bin/sh\n')).toBe(true);
    expect(script).toContain("exec tmux -u select-pane -t '%12' \\; if-shell -F -t '%12' '#{window_zoomed_flag}' '' 'resize-pane -Z -t %12' \\; attach-session -d -t '%12'");
    expect(attachScript('%12', true)).toContain("'#{window_zoomed_flag}' 'resize-pane -Z -t %12' ''");
    // One remote word: survives Windows OpenSSH pasting it unquoted.
    expect(attachScriptName('%12', true)).toBe('.cache/tmux-web-panel/attach-12-1');
  });

  it('refuses anything but a numeric tmux pane id', () => {
    for (const bad of ['%x', '12', "%1'; rm -rf ~", 'pane_1']) {
      expect(() => attachScript(bad, false)).toThrow();
    }
  });
});

describe('BasicHost', () => {
  function makeHost(options) {
    const connection = fakeConnection(options);
    const spawnPty = vi.fn(() => ({ onData() {}, onExit() {}, write() {}, resize() {}, kill() {} }));
    return { host: new BasicHost({ connection, spawnPty }), connection, spawnPty };
  }

  it('uses remote tmux when the host has it, reading the tree in one call', async () => {
    const { host, connection } = makeHost();
    const workspace = await host.getWorkspace();

    expect(host.mode).toBe('tmux');
    expect(workspace).toMatchObject({ provider: 'tmux', persistence: 'tmux' });
    expect(workspace.sessions[0]).toMatchObject({ id: '$1', name: '工作 区' });
    expect(workspace.sessions[0].windows[0].panes[0]).toMatchObject({ id: '%3', command: 'bash' });
    // Detection plus a single tree read.
    expect(connection.runScript).toHaveBeenCalledTimes(2);
  });

  it('hosts login shells when there is no tmux', async () => {
    const { host, spawnPty } = makeHost({ detect: 'kernel=Linux\narch=x86_64\nhostname=box\n' });
    const created = await host.createSession({ name: 'ops' });
    const workspace = await host.getWorkspace();

    expect(host.mode).toBe('ssh');
    expect(workspace).toMatchObject({ provider: 'ssh', persistence: 'process-memory' });
    expect(workspace.sessions[0].name).toBe('ops');
    // The shell starts when the first terminal subscribes.
    expect(spawnPty).not.toHaveBeenCalled();
    host.sshRuntime(workspace.sessions[0].windows[0].panes[0].id).subscribe({ send() {}, exit() {} });
    // `ssh -tt host` with no remote command: whatever login shell the host has.
    expect(spawnPty).toHaveBeenCalledWith(['-tt', 'box'], { ASKPASS: 'x' }, expect.any(Object));
    expect(created.id).toBeTruthy();
    host.destroy();
  });

  it('treats a host without a POSIX shell as hosted-shell only', async () => {
    const shellRejected = Object.assign(new Error('exit 1'), { code: 1, stderr: "'sh' is not recognized" });
    const { host } = makeHost({ fail: shellRejected });
    const facts = await host.detect();
    expect(facts).toMatchObject({ posix: false, tmux: { available: false, reason: 'no_posix_shell' } });
    expect((await host.provider()).provider).toBe('ssh');
  });

  it('lets ssh failures propagate instead of guessing a mode', async () => {
    const { host } = makeHost({ fail: new AppError(ErrorCode.SSH_AUTH_REQUIRED, 'denied') });
    await expect(host.detect()).rejects.toMatchObject({ code: ErrorCode.SSH_AUTH_REQUIRED });
  });

  it('uploads the attach script once per pane and runs it as the single pty word', async () => {
    const { host, connection } = makeHost();
    const first = await host.attachArgs('%3', false);
    await host.attachArgs('%3', false);

    expect(first).toEqual(['-tt', 'box', '.cache/tmux-web-panel/attach-3-0']);
    expect(connection.uploads).toHaveLength(1);
    expect(connection.uploads[0]).toMatchObject({ remote: '.cache/tmux-web-panel/attach-3-0', options: { mode: '755' } });
    expect(connection.uploads[0].content).toBe(attachScript('%3', false));
  });

  it('bumps the revision once per mutation', async () => {
    const changes = [];
    const connection = fakeConnection();
    const host = new BasicHost({ connection, spawnPty: vi.fn(), onChange: (revision) => changes.push(revision) });
    await host.createSession({ name: 'x' });
    expect(changes).toEqual([1]);
  });
});

describe('parseTree', () => {
  it('groups tagged lines and ignores anything else', () => {
    const tree = parseTree([
      ['S', '$1', 'a', '2', '1', '1'].join(SEP),
      ['W', '$1', '@1', '0', 'w0', '1', '80', '24', '0', '0'].join(SEP),
      ['W', '$1', '@2', '1', 'w1', '0', '80', '24', '1', '0'].join(SEP),
      ['P', '@2', '%5', '0', '0', '80', '24', '1', 'vim', 'edit'].join(SEP),
      'noise line',
    ].join('\n'));
    expect(tree).toHaveLength(1);
    expect(tree[0].windowList.map((w) => w.id)).toEqual(['@1', '@2']);
    expect(tree[0].windowList[1].panes).toEqual([expect.objectContaining({ id: '%5', label: 'edit', command: 'vim' })]);
    expect(tree[0].windowList[0].panes).toEqual([]);
  });
});
