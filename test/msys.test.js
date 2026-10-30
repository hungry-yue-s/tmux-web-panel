import { describe, it, expect } from 'vitest';
import {
  resolveTmuxBin,
  resolveMsysRoot,
  withNoGlob,
  toNativePath,
  toPosixPath,
  msysHomeRoots,
  msysQuote,
  msysExecArgs,
  tmuxUserHome,
} from '../server/msys.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWindowsDiskStats } from '../server/platform-system-stats.js';

const ROOT = 'C:\\msys64';

describe('environment of tmux children', () => {
  it.runIf(process.platform === 'win32')('keeps the Windows PATH in panes of a server the panel starts', () => {
    expect(process.env.MSYS2_PATH_TYPE).toBe('inherit');
  });
});

describe('resolveTmuxBin', () => {
  it('honors TMUX_BIN on every platform', () => {
    expect(resolveTmuxBin({ env: { TMUX_BIN: '/opt/tmux' }, platform: 'linux' })).toBe('/opt/tmux');
    expect(resolveTmuxBin({ env: { TMUX_BIN: 'D:\\tmux.exe' }, platform: 'win32' })).toBe('D:\\tmux.exe');
  });

  it('keeps plain tmux on Unix', () => {
    expect(resolveTmuxBin({ env: {}, platform: 'darwin', exists: () => true })).toBe('tmux');
  });

  it('finds the MSYS2 package on Windows without PATH changes', () => {
    expect(resolveTmuxBin({ env: {}, platform: 'win32', exists: () => true })).toBe('C:\\msys64\\usr\\bin\\tmux.exe');
    expect(resolveTmuxBin({ env: { MSYS2_ROOT: 'D:\\msys2' }, platform: 'win32', exists: () => true }))
      .toBe('D:\\msys2\\usr\\bin\\tmux.exe');
    expect(resolveTmuxBin({ env: {}, platform: 'win32', exists: () => false })).toBe('tmux');
  });
});

describe('resolveMsysRoot', () => {
  it('derives the root from an MSYS2 tmux path', () => {
    expect(resolveMsysRoot({ env: {}, tmuxBin: 'D:\\tools\\msys64\\usr\\bin\\tmux.exe' })).toBe('D:\\tools\\msys64');
  });

  it('prefers MSYS2_ROOT and falls back to the default install', () => {
    expect(resolveMsysRoot({ env: { MSYS2_ROOT: 'E:\\msys' }, tmuxBin: 'tmux' })).toBe('E:\\msys');
    expect(resolveMsysRoot({ env: {}, tmuxBin: 'tmux' })).toBe('C:\\msys64');
  });
});

describe('withNoGlob', () => {
  it('adds noglob and replaces an explicit glob option', () => {
    expect(withNoGlob(undefined)).toBe('noglob');
    expect(withNoGlob('winsymlinks:nativestrict')).toBe('winsymlinks:nativestrict noglob');
    expect(withNoGlob('glob:ignorecase')).toBe('noglob');
    expect(withNoGlob('noglob')).toBe('noglob');
  });
});

describe('MSYS path translation', () => {
  it('maps drive paths to drive letters', () => {
    expect(toNativePath('/c/Users/me/a.txt', ROOT)).toBe('C:\\Users\\me\\a.txt');
    expect(toNativePath('/cygdrive/d/work', ROOT)).toBe('D:\\work');
    expect(toNativePath('/c', ROOT)).toBe('C:\\');
  });

  it('maps other absolute paths under the MSYS root', () => {
    expect(toNativePath('/home/me/.tmux.conf', ROOT)).toBe('C:\\msys64\\home\\me\\.tmux.conf');
    expect(toNativePath('/tmp', ROOT)).toBe('C:\\msys64\\tmp');
    expect(toNativePath('/', ROOT)).toBe('C:\\msys64\\');
  });

  it('inverts the mapping for fs results', () => {
    expect(toPosixPath('C:\\msys64\\home\\me\\notes.md', ROOT)).toBe('/home/me/notes.md');
    expect(toPosixPath('c:\\MSYS64\\tmp', ROOT)).toBe('/tmp');
    expect(toPosixPath('C:\\msys64', ROOT)).toBe('/');
    expect(toPosixPath('D:\\work\\repo', ROOT)).toBe('/d/work/repo');
    expect(toPosixPath('E:\\', ROOT)).toBe('/e');
  });

  it('does not treat a sibling directory as the MSYS root', () => {
    expect(toPosixPath('C:\\msys64-old\\x', ROOT)).toBe('/c/msys64-old/x');
  });

  it('round-trips pane paths', () => {
    for (const path of ['/home/me/src', '/c/Users/me', '/tmp/tmux-web-panel-uploads/1_a.png']) {
      expect(toPosixPath(toNativePath(path, ROOT), ROOT)).toBe(path);
    }
  });
});

describe('msysHomeRoots', () => {
  it('covers the MSYS home and the Windows profile', () => {
    expect(msysHomeRoots({ env: { USERNAME: 'me', USERPROFILE: 'C:\\Users\\me' }, root: ROOT }))
      .toEqual(['/home/me', '/c/Users/me']);
  });

  it('keeps an MSYS-style HOME first', () => {
    expect(msysHomeRoots({ env: { HOME: '/c/Users/me', USERNAME: 'me', USERPROFILE: 'C:\\Users\\me' }, root: ROOT }))
      .toEqual(['/c/Users/me', '/home/me']);
  });
});

describe('readWindowsDiskStats', () => {
  it('reports the system and profile drives once each', async () => {
    const calls = [];
    const stat = async (drive) => {
      calls.push(drive);
      return { blocks: 1000, bsize: 4096, bfree: 250, bavail: 200 };
    };
    const disks = await readWindowsDiskStats({ env: { SystemDrive: 'C:' }, home: 'c:\\Users\\me', stat });
    expect(calls).toEqual(['C:\\']);
    expect(disks).toEqual([{
      device: 'C:', fstype: null, mount: 'C:\\', total: 4096000, used: 3072000, avail: 819200, percent: 75,
    }]);
  });

  it('skips drives that cannot be read', async () => {
    const stat = async (drive) => {
      if (drive === 'D:\\') throw new Error('not ready');
      return { blocks: 10, bsize: 1, bfree: 5, bavail: 5 };
    };
    const disks = await readWindowsDiskStats({ env: { SystemDrive: 'C:' }, home: 'D:\\me', stat });
    expect(disks.map((disk) => disk.device)).toEqual(['C:']);
  });
});

describe('arguments for MSYS2 programs', () => {
  const samples = ['{"V":2,"L":{"w":80}}', '"~claude->claude --continue" vim', "it's", 'a\\b "c"', '环境 部署', 'x\\', '', '$HOME * #{session_id}'];

  it('single-quotes, spelling a quote as \'"\'"\'', () => {
    expect(msysQuote("it's")).toBe(`'it'"'"'s'`);
    expect(msysQuote('{"V":2}')).toBe(`'{"V":2}'`);
  });

  it('passes argv through untouched off Windows', () => {
    const options = { timeout: 5 };
    expect(msysExecArgs(['a"b'], options, false)).toEqual([['a"b'], options]);
    expect(msysExecArgs(['a"b'], options, true)).toEqual([[`'a"b'`], { timeout: 5, windowsVerbatimArguments: true }]);
  });

  it('finds the home tmux reads ~/.tmux.conf from', () => {
    expect(tmuxUserHome({ windows: true, root: ROOT, user: 'me' })).toBe('C:\\msys64\\home\\me');
  });

  const bash = 'C:\\msys64\\usr\\bin\\bash.exe';
  it.runIf(process.platform === 'win32' && existsSync(bash))('reaches a real MSYS2 program exactly as given', () => {
    const dir = mkdtempSync(join(tmpdir(), 'msys-argv-'));
    try {
      const script = join(dir, 'args.sh');
      writeFileSync(script, 'for a in "$@"; do printf \'[%s]\\n\' "$a"; done\n');
      const [args, options] = msysExecArgs([script.replace(/\\/g, '/'), ...samples], { encoding: 'utf8', env: { ...process.env, MSYS: 'noglob' } });
      const out = execFileSync(bash, args, options);
      expect(out.replace(/\n$/, '').split('\n').map((line) => line.slice(1, -1))).toEqual(samples);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
