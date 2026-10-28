import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import express from 'express';
import request from 'supertest';
import { JSDOM } from 'jsdom';

import {
  DEFAULT_PROGRAMS, choiceFor, choiceList, isValidChoice, programName, restoreCommand, resurrectProcessOptions,
} from '../server/session-protection/catalog.js';
import { layoutSize, listSnapshots, parseSnapshot, readLatest, summarize } from '../server/session-protection/snapshot.js';
import { freeName, restoreSession } from '../server/session-protection/restore.js';
import { SessionProtection } from '../server/session-protection/service.js';
import { createSessionProtectionRouter } from '../server/api/session-protection.js';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temp() { const dir = mkdtempSync(join(tmpdir(), 'session-protect-')); dirs.push(dir); return dir; }

const LAYOUT = '{"V":2,"L":{"t":"h","w":200,"h":50,"x":0,"y":0,"c":[{"t":"p","w":100,"h":50,"x":0,"y":0,"i":0},{"t":"p","w":99,"h":50,"x":101,"y":0,"i":1}]}}';
const SNAPSHOT = [
  'pane\t环境 部署\t0\t0\t:-\t0\thost\t:/home/me\t1\tbash\t:',
  'pane\t环境 部署\t1\t1\t:*\t0\thost\t:/home/me/proj\t0\tclaude\t:C:\\\\Users\\\\me\\\\.local\\\\bin\\\\claude.exe --verbose',
  'pane\t环境 部署\t1\t1\t:*\t1\thost\t:/home/me/proj\t1\tvim\t:vim notes.md',
  'pane\tops\t2\t1\t:*\t0\thost\t:/srv\t1\tfish\t:fish',
  'window\t环境 部署\t0\t:shell\t0\t:-\tc9ab,80x24,0,0,0\t:',
  'window\t环境 部署\t1\t:work\t1\t:*\t' + LAYOUT + '\toff',
  'window\tops\t2\t:logs\t1\t:*\tc9ab,80x24,0,0,3\t:',
  'state\t环境 部署\tops',
].join('\n') + '\n';

describe('program choices', () => {
  it('names a program from what resurrect saved, Windows paths and login shells included', () => {
    expect(programName('C:\\\\Users\\\\me\\\\.local\\\\bin\\\\claude.exe --verbose')).toBe('claude');
    expect(programName('/usr/bin/vim notes.md')).toBe('vim');
    expect(programName('-bash')).toBe('bash');
    expect(programName('my\\ tool --x')).toBe('my tool');
    expect(programName('')).toBeNull();
  });

  it('resumes AI assistants, reruns other chosen programs, and leaves the default shell alone', () => {
    const pane = (fullCommand, command = '') => ({ fullCommand, command });
    expect(restoreCommand(pane('/opt/claude --verbose'), DEFAULT_PROGRAMS, 'bash')).toBe('claude --continue');
    expect(restoreCommand(pane('codex'), DEFAULT_PROGRAMS, 'bash')).toBe('codex resume --last');
    expect(restoreCommand(pane('vim notes.md'), DEFAULT_PROGRAMS, 'bash')).toBe('vim notes.md');
    expect(restoreCommand(pane('fish'), DEFAULT_PROGRAMS, 'bash')).toBe('fish');
    expect(restoreCommand(pane('', 'bash'), DEFAULT_PROGRAMS, 'bash')).toBeNull();
    expect(restoreCommand(pane('vim a'), ['ai'], 'bash')).toBeNull();
    // Programs outside every group only come back when picked one by one.
    expect(restoreCommand(pane('npm run dev'), DEFAULT_PROGRAMS, 'bash')).toBeNull();
    expect(restoreCommand(pane('npm run dev'), ['cmd:npm'], 'bash')).toBe('npm run dev');
  });

  it('lists every group plus programs seen in panes, and keeps a chosen one that is gone', () => {
    const seen = new Map([['npm', 'npm run dev'], ['vim', ''], ['bash', '']]);
    const choices = choiceList(['ai', 'cmd:npm', 'cmd:rails'], seen, 'bash');
    expect(choices.map((choice) => choice.id)).toEqual(['ai', 'editors', 'viewers', 'monitors', 'shells', 'cmd:npm', 'cmd:rails']);
    expect(choices.find((choice) => choice.id === 'cmd:npm')).toMatchObject({ selected: true, detail: '重新运行上次的命令：npm run dev' });
    expect(choices.find((choice) => choice.id === 'editors').selected).toBe(false);
    expect(choiceFor('htop')).toBe('monitors');
    expect(isValidChoice('cmd:a;rm')).toBe(false);
    expect(isValidChoice('editors')).toBe(true);
  });

  it('gives resurrect the same choices, replacing its built-in list', () => {
    expect(resurrectProcessOptions([])).toEqual({ defaultProcesses: '_twp_none_', processes: 'false' });
    const { processes } = resurrectProcessOptions(['ai', 'monitors', 'cmd:npm']);
    expect(processes).toContain('"~claude->claude --continue"');
    expect(processes).toContain('htop');
    expect(processes.endsWith('npm')).toBe(true);
  });
});

describe('snapshots', () => {
  it('reads sessions, windows and panes in order with their layout and rename behaviour', () => {
    const snapshot = parseSnapshot(SNAPSHOT);
    expect(snapshot.activeSession).toBe('环境 部署');
    expect(snapshot.sessions.map((session) => session.name)).toEqual(['环境 部署', 'ops']);
    const work = snapshot.sessions[0].windows[1];
    expect(work).toMatchObject({ index: 1, name: 'work', active: true, layout: LAYOUT, automaticRename: false });
    expect(work.panes.map((pane) => [pane.index, pane.path, pane.active])).toEqual([[0, '/home/me/proj', false], [1, '/home/me/proj', true]]);
    expect(work.panes[1].fullCommand).toBe('vim notes.md');
    expect(snapshot.sessions[0].windows[0].automaticRename).toBe(true);
    expect(summarize(snapshot)).toEqual({ sessions: 2, windows: 3, panes: 4 });
  });

  it('knows the size a layout was drawn at in both layout formats', () => {
    expect(layoutSize(LAYOUT)).toEqual({ width: 200, height: 50 });
    expect(layoutSize('c9ab,80x24,0,0,0')).toEqual({ width: 80, height: 24 });
    expect(layoutSize('')).toBeNull();
  });

  it('lists snapshot files newest first and reads `last` even when it is a copy', async () => {
    const dir = temp();
    writeFileSync(join(dir, 'tmux_resurrect_20261027T100000.txt'), SNAPSHOT);
    writeFileSync(join(dir, 'tmux_resurrect_20261027T120000.txt'), SNAPSHOT);
    writeFileSync(join(dir, 'notes.txt'), 'x');
    utimesSync(join(dir, 'tmux_resurrect_20261027T100000.txt'), new Date(1000e3), new Date(1000e3));
    utimesSync(join(dir, 'tmux_resurrect_20261027T120000.txt'), new Date(2000e3), new Date(2000e3));
    expect((await listSnapshots(dir)).map((entry) => entry.id)).toEqual(['tmux_resurrect_20261027T120000.txt', 'tmux_resurrect_20261027T100000.txt']);
    expect(await listSnapshots(join(dir, 'missing'))).toEqual([]);
    expect(await readLatest(dir)).toBeNull();
    writeFileSync(join(dir, 'last'), SNAPSHOT);
    expect((await readLatest(dir)).snapshot.sessions).toHaveLength(2);
  });
});

/** Records tmux commands and answers the -P formats restore relies on. */
function recordingTmux() {
  const calls = [];
  const ids = { window: 0, pane: 0 };
  const tmux = async (args) => {
    calls.push(args);
    if (args[0] === 'new-session') return `$1\t@${++ids.window}\t%${++ids.pane}\n`;
    if (args[0] === 'new-window') return `@${++ids.window}\t%${++ids.pane}\n`;
    if (args[0] === 'split-window') return `%${++ids.pane}\n`;
    return '';
  };
  return { tmux, calls };
}

describe('restoring a session', () => {
  it('rebuilds windows, panes, layout and programs, targeting only the ids tmux returned', async () => {
    const session = parseSnapshot(SNAPSHOT).sessions[0];
    const { tmux, calls } = recordingTmux();
    const result = await restoreSession(tmux, session, { name: '环境 部署', programs: DEFAULT_PROGRAMS, defaultShell: 'bash' });
    expect(result).toEqual({ sessionId: '$1', name: '环境 部署', programs: 2 });
    expect(calls[0]).toEqual(['new-session', '-d', '-P', '-F', '#{session_id}\t#{window_id}\t#{pane_id}',
      '-s', '环境 部署', '-n', 'shell', '-x', '80', '-y', '24', '-c', '/home/me']);
    expect(calls[1]).toEqual(['new-window', '-d', '-P', '-F', '#{window_id}\t#{pane_id}', '-t', '$1:', '-n', 'work', '-c', '/home/me/proj']);
    expect(calls).toContainEqual(['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', '@2', '-c', '/home/me/proj']);
    expect(calls).toContainEqual(['select-layout', '-t', '@2', LAYOUT]);
    // Window 0 kept automatic renaming; window 1 had it off, so it stays named.
    expect(calls).toContainEqual(['set-option', '-w', '-u', '-t', '@1', 'automatic-rename']);
    expect(calls).not.toContainEqual(['set-option', '-w', '-u', '-t', '@2', 'automatic-rename']);
    expect(calls).toContainEqual(['send-keys', '-t', '%2', '-l', 'claude --continue']);
    expect(calls).toContainEqual(['send-keys', '-t', '%3', '-l', 'vim notes.md']);
    expect(calls).toContainEqual(['select-pane', '-t', '%3']);
    expect(calls.at(-1)).toEqual(['select-window', '-t', '@2']);
  });

  it('only types commands for the chosen programs', async () => {
    const session = parseSnapshot(SNAPSHOT).sessions[0];
    const { tmux, calls } = recordingTmux();
    const result = await restoreSession(tmux, session, { name: 'x', programs: [], defaultShell: 'bash' });
    expect(result.programs).toBe(0);
    expect(calls.some((args) => args[0] === 'send-keys')).toBe(false);
  });

  it('never reuses a name that is taken', () => {
    expect(freeName('a', new Set())).toBe('a');
    expect(freeName('a', new Set(['a']))).toBe('a 恢复');
    expect(freeName('a', new Set(['a', 'a 恢复']))).toBe('a 恢复2');
  });
});

/**
 * A tmux stand-in with the state session protection looks at: whether a
 * server runs, its sessions, global options, and the commands it was sent.
 */
function fakeTmux({ running = true, sessions = [], options = {} } = {}) {
  const state = { running, sessions: [...sessions], options: { ...options }, commands: [], home: '/home/me' };
  const answer = (args) => {
    const [command, ...rest] = args;
    state.commands.push(args);
    switch (command) {
      case 'display-message':
        return ['4242', '1700000000', '/bin/bash', state.options['@twp-protect-seen'] || '',
          state.options['@twp-restored-at'] || '', state.options['@twp-restored-from'] || '', state.options['@twp-restored-sessions'] || '',
          state.options['@resurrect-save-script-path'] || '', state.options['@resurrect-dir'] || '', state.options['@continuum-restore'] || '',
        ].join('=:=') + '\n';
      case 'show-environment': return `HOME=${state.home}\n`;
      case 'show-options': return (state.options['status-right'] || '') + '\n';
      case 'list-sessions': return state.sessions.map((name) => name + '\n').join('');
      case 'list-panes': return 'bash\nhtop\n';
      case 'set-option': if (rest[0] === '-g') state.options[rest[1]] = rest[2]; return '';
      case 'new-session': state.sessions.push(rest[rest.indexOf('-s') + 1]); return `$${state.sessions.length}\t@1\t%1\n`;
      case 'new-window': return '@2\t%2\n';
      case 'split-window': return '%3\n';
      default: return '';
    }
  };
  const exec = vi.fn(async (_file, args) => {
    if (!state.running) {
      const err = new Error('no server running on /tmp/tmux-1000/default');
      err.stderr = 'no server running on /tmp/tmux-1000/default';
      throw err;
    }
    // Split a `;`-chained call the way tmux does.
    let out = '';
    let current = [];
    for (const arg of [...args, ';']) {
      if (arg === ';') { if (current.length) out += answer(current); current = []; } else current.push(arg);
    }
    return { stdout: out, stderr: '' };
  });
  return { state, exec };
}

function setup({ tmux = fakeTmux(), now = 1_000_000, snapshot = SNAPSHOT } = {}) {
  const home = temp();
  const configDir = join(home, 'config');
  const dir = join(home, '.local', 'share', 'tmux', 'resurrect');
  mkdirSync(dir, { recursive: true });
  if (snapshot !== null) {
    writeFileSync(join(dir, 'tmux_resurrect_20261027T120000.txt'), snapshot);
    writeFileSync(join(dir, 'last'), snapshot);
  }
  // tmux reports this HOME, so snapshots are looked for under it.
  tmux.state.home = home;
  const clock = { now };
  const protection = new SessionProtection({
    configDir, projectDir: resolve('.'), windows: false, exec: tmux.exec, now: () => clock.now, home,
    intervalMs: 300_000,
  });
  return { protection, tmux, clock, home, dir, configDir };
}

describe('SessionProtection', () => {
  it('restores the latest save once, on the first look at an empty tmux server', async () => {
    const tmux = fakeTmux();
    const { protection } = setup({ tmux });
    await protection.tick();
    expect(tmux.state.sessions).toEqual(['环境 部署', 'ops']);
    expect(tmux.state.options['@twp-protect-seen']).toBe('4242');
    expect(tmux.state.options['@twp-restored-sessions']).toBe('2');
    expect(tmux.state.options['@resurrect-processes']).toContain('claude');
    // Reopened programs may still be starting: no save straight away.
    expect(tmux.state.commands.some((args) => args[0] === 'run-shell' && args[1].includes('save.sh'))).toBe(false);

    const count = tmux.state.sessions.length;
    await protection.tick();
    expect(tmux.state.sessions.length).toBe(count);
  });

  it('leaves a server that already has sessions alone, then saves on schedule', async () => {
    const tmux = fakeTmux({ sessions: ['main'] });
    const { protection, clock } = setup({ tmux });
    await protection.tick();
    expect(tmux.state.sessions).toEqual(['main']);
    const saves = () => tmux.state.commands.filter((args) => args[0] === 'run-shell' && args[1].includes('save.sh'));
    expect(saves()).toHaveLength(1);
    expect(saves()[0][1]).toMatch(/^bash '.*tmux-resurrect[\\/]scripts[\\/]save\.sh' quiet$/);
    await protection.tick();
    expect(saves()).toHaveLength(1);
    clock.now += 300_000;
    await protection.tick();
    expect(saves()).toHaveLength(2);
  });

  it('tries the resurrect options again when tmux refused them, without restoring twice', async () => {
    const tmux = fakeTmux();
    const { protection } = setup({ tmux });
    const real = tmux.exec.getMockImplementation();
    tmux.exec.mockImplementation(async (file, args) => {
      if (args.includes('@resurrect-processes') && !tmux.state.refused) {
        tmux.state.refused = true;
        throw Object.assign(new Error('command set-option: too many arguments'), { stderr: 'too many arguments' });
      }
      return real(file, args);
    });
    await expect(protection.tick()).rejects.toThrow('too many arguments');
    expect(tmux.state.sessions).toEqual([]);
    await protection.tick();
    expect(tmux.state.options['@resurrect-processes']).toContain('claude');
    expect(tmux.state.sessions).toEqual(['环境 部署', 'ops']);
    await protection.tick();
    expect(tmux.state.sessions).toHaveLength(2);
  });

  it('never saves while tmux has no sessions, so the last save survives', async () => {
    const tmux = fakeTmux({ options: { '@twp-protect-seen': '1' } });
    const { protection } = setup({ tmux, snapshot: null });
    await protection.tick();
    expect(tmux.state.commands.some((args) => args[0] === 'run-shell' && args[1].includes('save.sh'))).toBe(false);
    await expect(protection.saveNow()).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('stays out of the way of a resurrect the user loads in ~/.tmux.conf', async () => {
    const tmux = fakeTmux({ options: { '@resurrect-save-script-path': '/home/me/.tmux/plugins/tmux-resurrect/scripts/save.sh', 'status-right': '#(/x/continuum_save.sh)' } });
    const { protection } = setup({ tmux });
    await protection.tick();
    expect(tmux.state.sessions).toEqual([]);
    expect(tmux.state.commands.some((args) => args[0] === 'set-option')).toBe(false);
    const status = await protection.status();
    expect(status).toMatchObject({ mode: 'external', external: { continuum: true } });
  });

  it('does not restore when turned off, and remembers the setting', async () => {
    const tmux = fakeTmux();
    const { protection, configDir } = setup({ tmux });
    await protection.update({ enabled: false, programs: ['ai'] });
    await protection.tick();
    expect(tmux.state.sessions).toEqual([]);
    const again = new SessionProtection({ configDir, projectDir: resolve('.'), windows: false, exec: tmux.exec });
    await again.load();
    expect(again.settings).toEqual({ enabled: false, programs: ['ai'] });
    await expect(protection.update({ programs: ['rm -rf'] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(protection.update({ enabled: 'yes' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('reports what the page needs, with the programs seen in panes', async () => {
    const tmux = fakeTmux({ sessions: ['main'] });
    const { protection } = setup({ tmux });
    const status = await protection.status();
    expect(status).toMatchObject({ mode: 'managed', enabled: true, intervalMinutes: 5, tmux: { running: true },
      latest: { sessions: 2, windows: 3, panes: 4 }, autoRestore: null });
    expect(status.programs.map((choice) => choice.id)).toContain('editors');
    expect(status.programs.some((choice) => choice.id === 'cmd:bash')).toBe(false);
  });

  it('brings back one session from history under a free name', async () => {
    const tmux = fakeTmux({ sessions: ['ops'], options: { '@twp-protect-seen': '1' } });
    const { protection } = setup({ tmux });
    const restored = await protection.restore('tmux_resurrect_20261027T120000.txt', 'ops');
    expect(restored.name).toBe('ops 恢复');
    expect(tmux.state.sessions).toEqual(['ops', 'ops 恢复']);
    await expect(protection.restore('../../etc/passwd', 'ops')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    await expect(protection.restore('tmux_resurrect_20261027T120000.txt', 'nope')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    const { snapshots } = await protection.snapshots();
    expect(snapshots[0]).toMatchObject({ sessions: 2, windows: 3, list: [{ name: '环境 部署', windows: ['shell', 'work'], panes: 3 }, { name: 'ops' }] });
  });

  it('is calm when tmux is not running', async () => {
    const tmux = fakeTmux({ running: false });
    const { protection } = setup({ tmux });
    await protection.tick();
    const status = await protection.status();
    expect(status.tmux.running).toBe(false);
    expect(status.latest).toMatchObject({ sessions: 2 });
    await expect(protection.saveNow()).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });
});

describe('session protection API', () => {
  it('maps the page actions to the service and validates the restore target', async () => {
    const protection = {
      status: vi.fn(async () => ({ mode: 'managed' })),
      update: vi.fn(async (patch) => ({ patch })),
      saveNow: vi.fn(async () => ({ saved: true })),
      snapshots: vi.fn(async () => ({ snapshots: [] })),
      restore: vi.fn(async (id, session) => ({ id, session })),
      linkBase: vi.fn(async () => ({ linked: true })),
    };
    const app = express();
    app.use(express.json());
    app.use('/api/session-protection', createSessionProtectionRouter({ protection }));
    expect((await request(app).get('/api/session-protection')).body.data).toEqual({ mode: 'managed' });
    await request(app).put('/api/session-protection').send({ enabled: false, programs: ['ai'], extra: 1 });
    expect(protection.update).toHaveBeenCalledWith({ enabled: false, programs: ['ai'] });
    const restored = await request(app).post('/api/session-protection/snapshots/s1/restore').send({ session: 'ops' });
    expect(restored.status).toBe(201);
    expect(protection.restore).toHaveBeenCalledWith('s1', 'ops');
    expect((await request(app).post('/api/session-protection/snapshots/s1/restore').send({})).status).toBe(400);
    expect((await request(app).post('/api/session-protection/save').set('Origin', 'https://evil.example')).status).toBe(403);
  });
});

describe('session page', () => {
  function page(status, snapshots = []) {
    const dom = new JSDOM('<div id="root"></div>', { runScripts: 'outside-only', url: 'http://localhost' });
    const win = dom.window;
    win.AppShell = { escape: (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'), toast: vi.fn() };
    win.Api = {
      nodeUrl: (serverId, path) => (serverId === 'local' ? path : '/n/' + serverId + path),
      get: vi.fn(async (path) => (path.endsWith('/snapshots') ? { snapshots } : status)),
      post: vi.fn(async (path, body) => (path.endsWith('/restore') ? { name: body.session + ' 恢复', programs: 1 } : status)),
      request: vi.fn(async () => status),
    };
    win.eval(readFileSync('public/js/session-protection.js', 'utf8'));
    return { win, root: win.document.getElementById('root'), dom };
  }

  const managed = {
    mode: 'managed', enabled: true, intervalMinutes: 5, tmux: { running: true, startedAt: '2026-10-27T09:54:00Z' },
    lastSave: null, latest: { at: '2026-10-27T09:50:00Z', sessions: 2, windows: 5, panes: 6 },
    autoRestore: { at: '2026-10-27T09:54:20Z', from: '2026-10-27T09:50:00Z', sessions: 2 }, external: null,
    programs: [{ id: 'ai', label: 'AI 编程助手', detail: 'claude', selected: true }, { id: 'cmd:npm', label: 'npm', detail: 'x', selected: false }],
    base: { linked: false, packaged: false, userPath: '/home/me/.tmux.conf', file: '.tmux.conf', path: '/c/tmux.conf', extraLines: 0 },
  };

  it('shows the switch, what happened, the program choices and history for that server', async () => {
    const { win, root, dom } = page(managed, [{ id: 'snap1', at: '2026-10-27T09:50:00Z', sessions: 1, windows: 2, list: [{ name: 'ops', windows: ['logs'], panes: 1 }] }]);
    await win.SessionProtectionPage.mount(root, 'box');
    expect(win.Api.get).toHaveBeenCalledWith('/n/box/api/session-protection');
    expect(root.querySelector('[data-sp="enabled"]').checked).toBe(true);
    expect(root.textContent).toContain('面板已自动恢复 2 个会话');
    expect(root.querySelector('[data-sp="link-base"]')).not.toBeNull();

    const npm = root.querySelector('[data-sp="program"][value="cmd:npm"]');
    npm.checked = true;
    npm.dispatchEvent(new win.Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(win.Api.request).toHaveBeenCalledWith('PUT', '/n/box/api/session-protection', { programs: ['ai', 'cmd:npm'] }));

    root.querySelector('[data-sp="restore"]').click();
    await vi.waitFor(() => expect(win.Api.post).toHaveBeenCalledWith('/n/box/api/session-protection/snapshots/snap1/restore', { session: 'ops' }));
    await vi.waitFor(() => expect(win.AppShell.toast).toHaveBeenCalledWith('已恢复为会话“ops 恢复”，并重新打开了 1 个程序'));
    dom.window.close();
  });

  it('does not offer settings that the user\'s own tmux config controls', async () => {
    const { win, root, dom } = page({ ...managed, mode: 'external', external: { continuum: true }, autoRestore: null });
    await win.SessionProtectionPage.mount(root, 'local');
    expect(root.querySelector('[data-sp="enabled"]')).toBeNull();
    expect(root.querySelector('[data-sp="program"]')).toBeNull();
    expect(root.textContent).toContain('tmux-continuum');
    dom.window.close();
  });

  it('explains an older panel on that machine instead of failing', async () => {
    const { win, root, dom } = page(managed);
    win.Api.get = vi.fn(async () => { const err = new Error('Not Found'); err.status = 404; throw err; });
    await win.SessionProtectionPage.mount(root, 'old');
    expect(root.textContent).toContain('版本较旧');
    dom.window.close();
  });
});
