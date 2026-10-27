import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  InstallLog,
  NodeInstaller,
  PORT_CANDIDATES,
  REMOTE_ARCHIVE,
  posixInstallScript,
  windowsInstallWords,
} from '../server/hub/node-installer.js';
import { ErrorCode } from '../server/servers/errors.js';

describe('install scripts', () => {
  it('prepends quoted inputs to the POSIX installer, the password included', () => {
    const script = posixInstallScript('echo body', { sudoPassword: "pa'ss $(x)" });
    expect(script.split('\n').slice(0, 4)).toEqual([
      `TWP_ARCHIVE=${REMOTE_ARCHIVE}`,
      `TWP_PORT_CANDIDATES='${PORT_CANDIDATES}'`,
      `TWP_SUDO_PASSWORD='pa'\\''ss $(x)'`,
      'echo body',
    ]);
  });

  it('runs the Windows installer as plain words in any login shell', () => {
    const words = windowsInstallWords('Write-Output hi');
    expect(words.slice(0, 6)).toEqual(['powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
    for (const word of words) expect(word).toMatch(/^[A-Za-z0-9_./=+-]+$/);
    const decoded = Buffer.from(words.at(-1), 'base64').toString('utf16le');
    expect(decoded).toContain(`$TwpArchive = '${REMOTE_ARCHIVE}'`);
    expect(decoded.endsWith('Write-Output hi')).toBe(true);
  });

  it('keeps the shipped installers readable for both platforms', () => {
    expect(readFileSync('scripts/remote/install-node.sh', 'utf8')).toContain('NODE_ONLY=1 bash scripts/install-service.sh install');
    expect(readFileSync('scripts/remote/install-node.ps1', 'utf8')).toContain('-ListenHost 127.0.0.1');
  });
});

describe('InstallLog', () => {
  it('splits streamed chunks into lines and reads progress and the result', () => {
    const log = new InstallLog(5);
    log.write('>> unpack pa');
    log.write('nel\r\nnpm warn x\n>> npm ci\n');
    log.write('TWP_RESULT=succeeded\n');
    log.end();
    expect(log.lines).toEqual(['>> unpack panel', 'npm warn x', '>> npm ci']);
    expect(log.step).toBe('npm ci');
    expect(log.result).toBe('succeeded');
  });

  it('is bounded', () => {
    const log = new InstallLog(3);
    for (let i = 0; i < 10; i += 1) log.write(`line ${i}\n`);
    expect(log.lines).toEqual(['line 7', 'line 8', 'line 9']);
  });
});

describe('NodeInstaller', () => {
  function project({ tmux = true } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'installer-project-'));
    mkdirSync(join(dir, 'scripts/remote'), { recursive: true });
    // CRLF, as a Windows checkout with core.autocrlf would have it.
    writeFileSync(join(dir, 'scripts/remote/install-node.sh'), 'echo posix\r\n');
    writeFileSync(join(dir, 'scripts/remote/install-node.ps1'), 'Write-Output windows\n');
    if (tmux) {
      mkdirSync(join(dir, 'vendor/tmux'), { recursive: true });
      writeFileSync(join(dir, 'vendor/tmux/tmux.c'), '');
    }
    return dir;
  }

  function setup({ platform = 'linux', posix = true, output = '>> done\nTWP_RESULT=succeeded\n', code = 0, tmux = true } = {}) {
    const connection = {
      uploadFile: vi.fn(async () => {}),
      stream: vi.fn(async (_words, { onOutput }) => { onOutput(output); return code; }),
    };
    const links = {
      connection: vi.fn(() => connection),
      basic: vi.fn(() => ({ detect: vi.fn(async () => ({ posix, platform })) })),
      recheck: vi.fn(),
    };
    const pack = vi.fn(async (_dir, target) => writeFileSync(target, 'archive'));
    const onInstalled = vi.fn();
    const installer = new NodeInstaller({ links, projectDir: project({ tmux }), onInstalled, pack });
    return { installer, connection, links, pack, onInstalled };
  }

  async function finish(installer, id = 'box') {
    await vi.waitFor(() => expect(installer.status(id).finishedAt).toBeTruthy());
    return installer.status(id);
  }

  it('packs with tmux, uploads, streams the POSIX installer and re-checks the server', async () => {
    const { installer, connection, links, pack, onInstalled } = setup();
    expect(installer.start('box', { sudoPassword: 'pw' }).state).toBe('running');

    const status = await finish(installer);
    expect(status.state).toBe('succeeded');
    expect(pack).toHaveBeenCalledWith(expect.any(String), expect.stringMatching(/panel\.tgz$/), { includeTmux: true });
    expect(connection.uploadFile).toHaveBeenCalledWith(expect.any(String), REMOTE_ARCHIVE, { mode: '600' });
    const [words, options] = connection.stream.mock.calls[0];
    expect(words).toEqual(['sh', '-s']);
    expect(options.input).toContain("TWP_SUDO_PASSWORD=pw");
    expect(options.input.endsWith('echo posix\n')).toBe(true);
    expect(options.input).not.toContain('\r');
    expect(links.recheck).toHaveBeenCalledWith('box');
    expect(onInstalled).toHaveBeenCalledWith('box');
    // The password never reaches the status the browser reads.
    expect(JSON.stringify(status)).not.toContain('TWP_SUDO_PASSWORD');
  });

  it('installs Windows through PowerShell without the tmux source', async () => {
    const { installer, connection, pack } = setup({ platform: 'windows', tmux: false });
    installer.start('box');
    expect((await finish(installer)).state).toBe('succeeded');
    expect(pack).toHaveBeenCalledWith(expect.any(String), expect.any(String), { includeTmux: false });
    expect(connection.stream.mock.calls[0][0][0]).toBe('powershell');
  });

  it('asks for a sudo password when the remote side needs one', async () => {
    const { installer, onInstalled } = setup({ output: '!! needs sudo\nTWP_RESULT=needs_password\n', code: 3 });
    installer.start('box');
    expect((await finish(installer)).state).toBe('needs_password');
    expect(onInstalled).not.toHaveBeenCalled();
  });

  it('reports a failed run with its log', async () => {
    const { installer } = setup({ output: '>> npm ci\n!! npm ci failed\nTWP_RESULT=failed\n', code: 1 });
    installer.start('box');
    const status = await finish(installer);
    expect(status.state).toBe('failed');
    expect(status.log).toContain('!! npm ci failed');
    expect(status.step).toBe('npm ci');
  });

  it('refuses a POSIX install when this panel has no tmux source to send', async () => {
    const { installer, connection } = setup({ tmux: false });
    installer.start('box');
    const status = await finish(installer);
    expect(status.state).toBe('failed');
    expect(status.error.code).toBe(ErrorCode.UNSUPPORTED);
    expect(connection.uploadFile).not.toHaveBeenCalled();
  });

  it('runs one installation per server at a time', () => {
    const { installer, connection } = setup();
    connection.stream.mockImplementation(() => new Promise(() => {}));
    installer.start('box');
    expect(() => installer.start('box')).toThrow(expect.objectContaining({ code: ErrorCode.SERVER_IN_USE }));
  });
});
