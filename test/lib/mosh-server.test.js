import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';

import { MoshService, MAX_SESSIONS, NETWORK_TIMEOUT_S, CAPABILITY_CACHE_MS, findMoshServer } from '../../lib/mosh/server.js';
import { parseMsysPs, parseUnixPs, sameProcess, sameStart } from '../../lib/mosh/processes.js';
import { createMoshRouter } from '../../lib/api/mosh.js';
import { isRelayable } from '../../lib/hub/proxy.js';
import { HUB_CALL_HEADER, forwardRequestHeaders } from '../../lib/hub/node-link.js';
import { collectNodeInfo } from '../../lib/node/info.js';
import { TerminalManager, buildTmuxAttachArgs } from '../../lib/terminal.js';
import { TMUX_BIN, MSYS_ROOT } from '../../lib/msys.js';
import { win32 } from 'node:path';

const KEY = 'AbCdEfGhIjKlMnOpQrStUv';
const DAEMON = 500;
const CHILD = 501;

/**
 * Processes as a ps table the test controls. A process dies on TERM unless it was
 * told to resist; `exec(pid, command)` is what the command child does once the
 * first client packet arrives: same pid and start, another executable.
 */
function fakeProcesses() {
  const procs = new Map();
  const signals = [];
  const resist = new Map();
  return {
    procs,
    signals,
    resist,
    add(entry) { procs.set(entry.pid, { ppid: 1, winpid: entry.pid + 10_000, start: '16:00:00', command: '/usr/bin/x', ...entry }); },
    exec(pid, command) { const entry = procs.get(pid); procs.set(pid, { ...entry, command, winpid: entry.winpid + 1 }); },
    /** pid -> reads during which, once signalled, it is still listed but its birth cannot be read. */
    exiting: new Map(),
    async read() {
      const table = new Map([...procs].map(([pid, entry]) => [pid, { ...entry }]));
      for (const [pid, left] of this.exiting) {
        if (!procs.has(pid) || procs.get(pid).start !== null) continue;
        if (left <= 1) { this.exiting.delete(pid); procs.delete(pid); } else this.exiting.set(pid, left - 1);
      }
      return table;
    },
    /** mosh-server ends by itself once its command has gone, after telling its client. */
    daemonFollowsChild: false,
    async signal(pid, signal) {
      signals.push([pid, signal]);
      if ((resist.get(pid) || []).includes(signal)) return;
      const entry = procs.get(pid);
      if (this.exiting.has(pid) && entry) {
        // On its way out: still listed, birth no longer readable, for a few reads.
        procs.set(pid, { ...entry, start: null });
        return;
      }
      procs.delete(pid);
      // Children outlive their parent, as they do: they are re-parented.
      for (const [otherPid, other] of procs) if (entry && other.ppid === pid) procs.set(otherPid, { ...other, ppid: 1 });
      if (this.daemonFollowsChild && entry && procs.get(entry.ppid)?.command === '/usr/bin/mosh-server') {
        const daemon = entry.ppid;
        setTimeout(() => {
          if (this.exiting.has(daemon) && procs.has(daemon)) procs.set(daemon, { ...procs.get(daemon), start: null });
          else procs.delete(daemon);
        }, 20);
      }
    },
  };
}

/** A mosh-server that prints what the real one does, forks its daemon and command child, and exits. */
function fakeSpawn(processes, { connect = true, pid: firstPid = DAEMON, printPid = true } = {}) {
  const calls = [];
  const spawnImpl = vi.fn((file, args, options) => {
    // Each mosh-server forks its own daemon: 500/501, then 510/511, ...
    const pid = firstPid + calls.length * 10;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    calls.push({ file, args, options, child });
    setTimeout(() => {
      if (connect) {
        child.stdout.emit('data', `\r\nMOSH CONNECT 60001 ${KEY}\r\n`);
        processes.add({ pid, ppid: 1, command: '/usr/bin/mosh-server' });
        processes.add({ pid: pid + 1, ppid: pid, command: '/usr/bin/mosh-server' });
      }
      if (printPid) child.stderr.emit('data', `\nmosh-server (mosh 1.4.0) [build mosh 1.4.0]\n[mosh-server detached, pid = ${pid}]\n`);
      child.emit('exit', 0);
    }, 5);
    return child;
  });
  return { spawnImpl, calls };
}

/** Client turns that run one at a time, as on Windows, and can be held closed. */
function fakeTerminalManager() {
  let turn = Promise.resolve();
  let opened = () => {};
  let gate = Promise.resolve();
  const holds = [];
  const owners = [];
  const tm = {
    holds,
    owners,
    turns: [],
    close() { gate = new Promise((resolve) => { opened = resolve; }); },
    open() { opened(); },
    inClientTurn(fn) {
      const next = turn.then(() => gate).then(fn, fn);
      turn = next.catch(() => {});
      return next;
    },
    whenClientCanStart: vi.fn((target, attach, { cancelled = () => false } = {}) => {
      const run = tm.inClientTurn(async () => (cancelled() ? null : attach()));
      tm.turns.push(run);
      return run;
    }),
    holdStart: vi.fn((over) => holds.push(over)),
    addClientOwner: vi.fn((owner) => owners.push(owner)),
  };
  return tm;
}

const warnings = [];
afterEach(() => { warnings.length = 0; vi.restoreAllMocks(); });

function service({ platform = 'linux', found = '/usr/bin/mosh-server', version = 'mosh-server (mosh 1.4.0) [build mosh 1.4.0]',
  env = {}, spawn = null, clients = '', attachTimeoutMs = 400, goneWaitMs = 300, terminalManager = fakeTerminalManager(),
  versionGate = null, hubSilenceMs = 60_000 } = {}) {
  vi.spyOn(console, 'warn').mockImplementation((...args) => warnings.push(args));
  const processes = fakeProcesses();
  const spawned = spawn || fakeSpawn(processes);
  const tmux = { clients, calls: [] };
  const workspace = { resolvePane: vi.fn(async (paneId) => ({ paneId, sessionId: '$3' })) };
  const execFileImpl = vi.fn((file, args, options, cb) => {
    if (versionGate) versionGate.then(() => cb(null, version, ''));
    else cb(null, version, '');
  });
  const mosh = new MoshService({
    workspace, terminalManager, platform, env: { PATH: '/usr/bin', TMUX: '/tmp/tmux-1/default,1,0', TMUX_PANE: '%2', ...env },
    find: () => found, spawnImpl: spawned.spawnImpl, execFileImpl, processes,
    tmux: async (args) => { tmux.calls.push(args); return tmux.clients; }, tmuxSocketArgs: ['-S', '/tmp/private/sock'],
    attachTimeoutMs, settleMs: 20, goneWaitMs, hubSilenceMs,
  });
  return { mosh, workspace, terminalManager, processes, spawn: spawned, tmux };
}

/** The real TerminalManager under Windows rules, with nothing real behind it. */
function windowsManager() {
  return new TerminalManager({ platform: 'win32', tmux: async () => '', consoleReaper: { clientEnded() {} }, isRunning: () => false });
}

/** An active Windows session: started, its command child exec'd tmux and is listed. */
async function activeWindowsSession(setup) {
  const sessionId = id();
  setup.tmux.clients = '';
  await setup.mosh.start({ id: sessionId, paneId: '%1' });
  const session = setup.mosh.sessions.get(sessionId);
  const child = session.daemon.pid + 1;
  setup.processes.exec(child, '/usr/bin/tmux');
  setup.tmux.clients = `${setup.tmux.clients}\n${child}`;
  await vi.waitFor(() => expect(session.state).toBe('active'));
  return { sessionId, session, child, daemon: session.daemon.pid };
}

const id = () => randomUUID();

describe('process tables', () => {
  it('reads MSYS2 and Unix ps output, and tells a reused pid from the same process after exec', () => {
    const msys = parseMsysPs('      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND\n'
      + '  1329790       1 1329790      19736  ?         197108 16:46:46 /usr/bin/mosh-server\n'
      + '   892149  892122  892149      11180  pty17     197108   Oct 30 /c/Program Files/x y.exe\n');
    // The display time is deliberately not accepted as process identity.
    expect(msys.get(1329790)).toEqual({ pid: 1329790, ppid: 1, winpid: 19736, start: null, command: '/usr/bin/mosh-server' });
    expect(msys.get(892149)).toMatchObject({ start: null, command: '/c/Program Files/x y.exe' });
    const unix = parseUnixPs('  500     1 Tue Nov  3 16:46:46 2026 /usr/bin/mosh-server\n');
    expect(unix.get(500)).toEqual({ pid: 500, ppid: 1, winpid: null, start: 'Tue Nov 3 16:46:46 2026', command: '/usr/bin/mosh-server' });

    const before = { pid: 7, ppid: 6, winpid: 100, start: '16:00:00', command: '/usr/bin/mosh-server' };
    const execd = { ...before, winpid: 101, command: '/usr/bin/tmux' };
    const reused = { ...before, start: '16:05:00' };
    expect(sameProcess(before, execd)).toBe(false);
    expect(sameStart(before, execd)).toBe(true);
    expect(sameStart(before, reused)).toBe(false);
  });
});

describe('finding mosh-server', () => {
  it('finds a newly installed component and notices its removal after the cache expires', async () => {
    let clock = 0;
    let found = null;
    const find = vi.fn(() => found);
    const execFileImpl = vi.fn((_file, _args, _options, done) => done(null, 'mosh-server (mosh 1.4.0)'));
    const mosh = new MoshService({ workspace: {}, terminalManager: {}, find, execFileImpl, now: () => clock });
    expect(await mosh.capability()).toMatchObject({ available: false });
    found = '/test/mosh-server';
    clock = CAPABILITY_CACHE_MS - 1;
    expect(await mosh.capability()).toMatchObject({ available: false });
    clock++;
    expect(await mosh.capability()).toMatchObject({ available: true });
    found = null;
    clock += CAPABILITY_CACHE_MS;
    expect(await mosh.capability()).toMatchObject({ available: false });
    expect(find).toHaveBeenCalledTimes(3);
    expect(execFileImpl).toHaveBeenCalledTimes(1);
  });

  it('shares a component check still in progress instead of starting another one after a clock change', async () => {
    let clock = 0;
    let complete;
    const execFileImpl = vi.fn((_file, _args, _options, done) => { complete = done; });
    const mosh = new MoshService({ workspace: {}, terminalManager: {}, find: () => '/test/mosh-server', execFileImpl, now: () => clock });
    const first = mosh.capability();
    clock += CAPABILITY_CACHE_MS * 2;
    expect(mosh.capability()).toBe(first);
    complete(null, 'mosh-server (mosh 1.4.0)');
    expect(await first).toMatchObject({ available: true });
    expect(execFileImpl).toHaveBeenCalledTimes(1);
  });

  it('looks in the MSYS2 that tmux comes from on Windows, and honours an override', () => {
    const exists = (path) => path.endsWith('mosh-server.exe');
    expect(findMoshServer({ platform: 'win32', env: {}, exists, msysRoot: 'D:\\msys64' })).toBe('D:\\msys64\\usr\\bin\\mosh-server.exe');
    expect(findMoshServer({ platform: 'darwin', env: { PATH: '/x' }, exists: (p) => p === '/opt/homebrew/bin/mosh-server' })).toBe('/opt/homebrew/bin/mosh-server');
    expect(findMoshServer({ platform: 'linux', env: { ANYMUX_MOSH_SERVER: '/a/mosh-server' }, exists: () => false })).toBeNull();
  });

  it('reports what it found without a path, and why not when it did not', async () => {
    expect(await service({ found: null }).mosh.capability()).toEqual({ available: false, version: null, reason: 'mosh_server_not_found' });
    expect(await service({ version: 'garbage' }).mosh.capability()).toMatchObject({ available: false, reason: 'mosh_server_unusable' });
    const { mosh } = service();
    const info = await collectNodeInfo({ tmuxVersion: async () => '3.4', mosh: () => mosh.capability(), platform: 'linux', arch: 'x64', host: 'h' });
    expect(info.capabilities.mosh).toEqual({ available: true, version: '1.4.0', reason: null });
  });

  it('checks an external Windows server with the injected environment and the same MSYS runtime path as its launch', async () => {
    const external = 'D:\\Mosh tools\\mosh-server.exe';
    const env = { PATH: 'C:\\Windows\\System32', ANYMUX_MOSH_SERVER: external, FIXTURE_SETTING: 'kept' };
    const before = { ...env };
    const execFileImpl = vi.fn((_file, _args, options, done) => {
      const ready = options.env?.PATH === `${win32.join(MSYS_ROOT, 'usr', 'bin')};${before.PATH}`
        && options.env.FIXTURE_SETTING === 'kept';
      done(ready ? null : new Error('fixture runtime unavailable'), ready ? 'mosh-server (mosh 1.4.0)' : '');
    });
    const mosh = new MoshService({ platform: 'win32', env, workspace: {}, terminalManager: {},
      find: ({ env: actual }) => actual.ANYMUX_MOSH_SERVER, execFileImpl });
    expect(await mosh.capability()).toMatchObject({ available: true, version: '1.4.0' });
    expect(execFileImpl).toHaveBeenCalledWith(external, ['--version'], expect.objectContaining({
      timeout: 5000, windowsHide: true, env: expect.objectContaining({ FIXTURE_SETTING: 'kept' }),
    }), expect.any(Function));
    expect(env).toEqual(before);
  });

  it('keeps the injected Unix environment intact for the version check without adding a Windows path', async () => {
    const env = { PATH: '/custom/bin:/usr/bin', LANG: 'C.UTF-8', FIXTURE_SETTING: 'kept' };
    const before = { ...env };
    const execFileImpl = vi.fn((_file, _args, _options, done) => done(null, 'mosh-server (mosh 1.4.0)'));
    const mosh = new MoshService({ platform: 'darwin', env, workspace: {}, terminalManager: {},
      find: () => '/custom/bin/mosh-server', execFileImpl });
    expect(await mosh.capability()).toMatchObject({ available: true });
    expect(execFileImpl.mock.calls[0][2].env).toEqual(before);
    expect(env).toEqual(before);
  });
});

describe('starting a session', () => {
  it('runs the pane\'s own attach command on the named server, without the inherited TMUX, and answers with port and key', async () => {
    const { mosh, spawn } = service();
    const sessionId = id();
    const session = await mosh.start({ id: sessionId, paneId: '%7', nozoom: true });
    expect(session).toEqual({ id: sessionId, port: 60001, key: KEY, paneId: '%7' });
    const { file, args, options } = spawn.calls[0];
    expect(file).toBe('/usr/bin/mosh-server');
    expect(args).toEqual(['new', '-c', '256', '-l', 'LANG=C.UTF-8', '-p', '60000:61000', '--',
      TMUX_BIN, '-S', '/tmp/private/sock', ...buildTmuxAttachArgs('%7', { nozoom: true })]);
    expect(options.env.MOSH_SERVER_NETWORK_TMOUT).toBe(String(NETWORK_TIMEOUT_S));
    expect(options.env.TMUX).toBeUndefined();
    expect(options.env.TMUX_PANE).toBeUndefined();
    await vi.waitFor(() => expect(mosh.sessions.get(sessionId).state).toBe('active'));
    expect(mosh.sessions.get(sessionId).daemon).toMatchObject({ pid: DAEMON, command: '/usr/bin/mosh-server' });
  });

  it('takes its id from the hub, once', async () => {
    const { mosh } = service();
    await expect(mosh.start({ id: 'nope', paneId: '%1' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const sessionId = id();
    await mosh.start({ id: sessionId, paneId: '%1' });
    await expect(mosh.start({ id: sessionId, paneId: '%1' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    // Ended ids stay used: a late request for one starts nothing.
    const late = id();
    expect(await mosh.stop(late)).toEqual({ stopped: false, clean: true });
    await expect(mosh.start({ id: late, paneId: '%1' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('counts sessions still starting against the limit', async () => {
    const { mosh, terminalManager } = service();
    terminalManager.close();
    for (let i = 0; i < MAX_SESSIONS; i += 1) mosh.start({ id: id(), paneId: '%1' }).catch(() => {});
    await vi.waitFor(() => expect(mosh.sessions.size).toBe(MAX_SESSIONS));
    await expect(mosh.start({ id: id(), paneId: '%1' })).rejects.toMatchObject({ code: 'CONNECTION_LIMIT' });
    const stopping = mosh.stopAll();
    terminalManager.open();
    expect(await stopping).toBe(true);
    expect(mosh.sessions.size).toBe(0);
  });

  it('refuses when mosh-server is missing, and quotes for MSYS2 with its runtime on PATH on Windows', async () => {
    await expect(service({ found: null }).mosh.start({ id: id(), paneId: '%1' })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    const windows = service({ platform: 'win32', env: { PATH: 'C:\\Windows' }, clients: String(CHILD) });
    await windows.mosh.start({ id: id(), paneId: '%1' });
    const { args, options } = windows.spawn.calls[0];
    expect(options.windowsVerbatimArguments).toBe(true);
    expect(args[0]).toBe("'new'");
    expect(args).toContain("'#{window_zoomed_flag}'");
    expect(options.env.PATH).toMatch(/usr\\bin;C:\\Windows$/);
  });

  it('honours a port range and a bind address only when they are one', async () => {
    const good = service({ env: { ANYMUX_MOSH_PORTS: '60100:60110', ANYMUX_MOSH_BIND: '127.0.0.1' } });
    await good.mosh.start({ id: id(), paneId: '%1' });
    expect(good.spawn.calls[0].args.slice(5, 9)).toEqual(['-p', '60100:60110', '-i', '127.0.0.1']);
    const bad = service({ env: { ANYMUX_MOSH_PORTS: '1; rm -rf', ANYMUX_MOSH_BIND: 'example.com -- sh' } });
    await bad.mosh.start({ id: id(), paneId: '%1' });
    expect(bad.spawn.calls[0].args).toContain('60000:61000');
    expect(bad.spawn.calls[0].args).not.toContain('-i');
  });
});

describe('on Windows, the client turn lasts until tmux shows the attach', () => {
  it('answers at CONNECT, but holds the turn and counts as starting until a child of this mosh-server is a tmux client', async () => {
    const { mosh, terminalManager, processes, tmux } = service({ platform: 'win32', attachTimeoutMs: 2000 });
    const sessionId = id();
    const answered = await mosh.start({ id: sessionId, paneId: '%1' });
    expect(answered.key).toBe(KEY);
    let turnOver = false;
    terminalManager.turns[0].then(() => { turnOver = true; });
    expect(terminalManager.holds).toHaveLength(1);
    let holdOver = false;
    terminalManager.holds[0].then(() => { holdOver = true; });

    // The hub's mosh-client has not reached it yet: tmux lists other clients only.
    tmux.clients = '777\n';
    await new Promise((resolve) => { setTimeout(resolve, 200); });
    expect(turnOver).toBe(false);
    expect(holdOver).toBe(false);
    expect(mosh.sessions.get(sessionId).state).toBe('starting');

    // The first packet arrives: the command child execs tmux, and tmux lists it.
    processes.exec(CHILD, '/usr/bin/tmux');
    tmux.clients = `777\n${CHILD}\n`;
    await vi.waitFor(() => expect(turnOver).toBe(true));
    expect(holdOver).toBe(true);
    expect(mosh.sessions.get(sessionId).state).toBe('active');
    expect(tmux.calls.every((args) => args[0] === 'list-clients')).toBe(true);
  });

  it('ends the session in its turn when no attach comes, child before mosh-server, and stays clean', async () => {
    const { mosh, terminalManager, processes } = service({ platform: 'win32', attachTimeoutMs: 200 });
    const sessionId = id();
    await mosh.start({ id: sessionId, paneId: '%1' });
    await terminalManager.turns[0];
    expect(processes.signals).toEqual([[CHILD, 'TERM'], [DAEMON, 'TERM']]);
    expect(mosh.sessions.has(sessionId)).toBe(false);
    expect(await mosh.stop(sessionId)).toEqual({ stopped: false, clean: true });
    expect(warnings.some(([tag, line]) => tag === '[mosh] session' && line.includes('not_attached'))).toBe(true);
  });

  it('stops a session cancelled while it waits for the attach, and does not attach afterwards', async () => {
    const { mosh, processes, tmux } = service({ platform: 'win32', attachTimeoutMs: 5000 });
    const sessionId = id();
    await mosh.start({ id: sessionId, paneId: '%1' });
    const stopped = await mosh.stop(sessionId);
    expect(stopped).toEqual({ stopped: true, clean: true });
    expect(processes.procs.size).toBe(0);
    tmux.clients = String(CHILD);
    expect(mosh.sessions.size).toBe(0);
  });
});

describe('cancelling and ending', () => {
  it('starts nothing for a session cancelled while it waited for its turn', async () => {
    const { mosh, terminalManager, spawn } = service();
    terminalManager.close();
    const sessionId = id();
    const starting = mosh.start({ id: sessionId, paneId: '%1' });
    await vi.waitFor(() => expect(mosh.sessions.size).toBe(1));
    const stopping = mosh.stop(sessionId);
    terminalManager.open();
    await expect(starting).rejects.toMatchObject({ code: 'TERMINAL_BUSY' });
    expect(await stopping).toEqual({ stopped: true, clean: true });
    expect(spawn.calls).toHaveLength(0);
  });

  it('ends only processes that are still the ones it started, including a child that has exec\'d tmux', async () => {
    const { mosh, processes } = service();
    const sessionId = id();
    await mosh.start({ id: sessionId, paneId: '%1' });
    processes.exec(CHILD, '/usr/bin/tmux');
    // mosh-server went by itself and its pid now belongs to something else.
    processes.procs.set(DAEMON, { pid: DAEMON, ppid: 1, winpid: 1, start: '17:00:00', command: '/usr/bin/vim' });
    expect(await mosh.stop(sessionId)).toEqual({ stopped: true, clean: true });
    expect(processes.signals).toEqual([[CHILD, 'TERM']]);
    expect(processes.procs.get(DAEMON).command).toBe('/usr/bin/vim');
  });

  it('ends the tmux client first and lets mosh-server end itself, so it can tell its client', async () => {
    const { mosh, processes } = service();
    processes.daemonFollowsChild = true;
    const sessionId = id();
    await mosh.start({ id: sessionId, paneId: '%1' });
    processes.exec(CHILD, '/usr/bin/tmux');
    expect(await mosh.stop(sessionId)).toEqual({ stopped: true, clean: true });
    expect(processes.signals).toEqual([[CHILD, 'TERM']]);
    expect(processes.procs.size).toBe(0);
  });

  it('waits out a process that shows without its birth while it exits, signals nothing it cannot identify, and is clean', async () => {
    const { mosh, processes } = service();
    const sessionId = id();
    await mosh.start({ id: sessionId, paneId: '%1' });
    processes.exec(CHILD, '/usr/bin/tmux');
    processes.exiting.set(CHILD, 2);
    expect(await mosh.stop(sessionId)).toEqual({ stopped: true, clean: true });
    // TERM for the child; once unreadable it gets nothing more.
    expect(processes.signals.filter(([pid]) => pid === CHILD)).toEqual([[CHILD, 'TERM']]);
    expect(processes.procs.size).toBe(0);
  });

  it('waits out mosh-server showing without its birth as it ends itself after its tmux client', async () => {
    const { mosh, processes } = service();
    processes.daemonFollowsChild = true;
    const sessionId = id();
    await mosh.start({ id: sessionId, paneId: '%1' });
    processes.exec(CHILD, '/usr/bin/tmux');
    processes.exiting.set(DAEMON, 2);
    expect(await mosh.stop(sessionId)).toEqual({ stopped: true, clean: true });
    expect(processes.signals).toEqual([[CHILD, 'TERM']]);
    expect(processes.procs.size).toBe(0);
  });

  it('is not clean while one of its processes stays listed without a readable birth', async () => {
    const { mosh, processes } = service({ goneWaitMs: 200 });
    const sessionId = id();
    await mosh.start({ id: sessionId, paneId: '%1' });
    processes.exiting.set(CHILD, Infinity);
    expect(await mosh.stop(sessionId)).toEqual({ stopped: true, clean: false });
    expect(processes.signals.filter(([pid]) => pid === CHILD)).toEqual([[CHILD, 'TERM']]);
  });

  it('says not clean when its processes will not go, after TERM and KILL', async () => {
    const { mosh, processes } = service({ goneWaitMs: 200 });
    const sessionId = id();
    await mosh.start({ id: sessionId, paneId: '%1' });
    processes.resist.set(CHILD, ['TERM', 'KILL']);
    expect(await mosh.stop(sessionId)).toEqual({ stopped: true, clean: false });
    expect(processes.signals).toContainEqual([CHILD, 'KILL']);
    expect(warnings.some(([tag, line]) => tag === '[mosh] session' && line.includes('not_clean'))).toBe(true);
    expect(await mosh.stop(sessionId)).toEqual({ stopped: true, clean: false });
  });

  it('says not clean when mosh-server printed CONNECT, so forked, but never said its pid', async () => {
    const processes = fakeProcesses();
    const { mosh } = service({ spawn: fakeSpawn(processes, { printPid: false }) });
    const sessionId = id();
    await expect(mosh.start({ id: sessionId, paneId: '%1' })).rejects.toMatchObject({ message: 'mosh-server exited without a session' });
    expect(await mosh.stop(sessionId)).toEqual({ stopped: true, clean: false });
  });

  it('says what became of a session, for a hub watching one it bridges', async () => {
    const { mosh } = service();
    const sessionId = id();
    expect(mosh.state(sessionId)).toEqual({ state: 'unknown' });
    await mosh.start({ id: sessionId, paneId: '%1' });
    await vi.waitFor(() => expect(mosh.state(sessionId)).toEqual({ state: 'active' }));
    await mosh.stop(sessionId);
    expect(mosh.state(sessionId)).toEqual({ state: 'ended', clean: true });
  });

  it('drops sessions whose processes went by themselves', async () => {
    const { mosh, processes } = service();
    const sessionId = id();
    await mosh.start({ id: sessionId, paneId: '%1' });
    await vi.waitFor(() => expect(mosh.sessions.get(sessionId).state).toBe('active'));
    await mosh.reap();
    expect(mosh.sessions.has(sessionId)).toBe(true);
    processes.procs.clear();
    await mosh.reap();
    expect(mosh.sessions.has(sessionId)).toBe(false);
    expect(await mosh.stop(sessionId)).toEqual({ stopped: false, clean: true });
  });

  it('clears active sessions on a tmux session for a new client there, and only those', async () => {
    const { mosh, terminalManager, processes } = service();
    const a = id();
    await mosh.start({ id: a, paneId: '%1' });
    await vi.waitFor(() => expect(mosh.sessions.get(a).state).toBe('active'));
    expect(terminalManager.owners).toEqual([mosh]);
    expect(await mosh.endClientsOn('$9')).toBe(true);
    expect(mosh.sessions.has(a)).toBe(true);
    expect(await mosh.endClientsOn('$3')).toBe(true);
    expect(mosh.sessions.has(a)).toBe(false);
    expect(processes.procs.size).toBe(0);
  });

  it('on shutdown refuses new sessions and ends every one before it resolves', async () => {
    const { mosh, processes } = service();
    await mosh.start({ id: id(), paneId: '%1' });
    expect(await mosh.stopAll()).toBe(true);
    expect(processes.procs.size).toBe(0);
    await expect(mosh.start({ id: id(), paneId: '%1' })).rejects.toMatchObject({ code: 'TERMINAL_BUSY' });
  });
});

describe('with the real client turns of Windows', () => {
  it('does not end a mosh client while another client is still starting, not even to stop it', async () => {
    const setup = service({ platform: 'win32', terminalManager: windowsManager(), attachTimeoutMs: 3000 });
    const { sessionId, child } = await activeWindowsSession(setup);
    let settleA;
    setup.terminalManager.holdStart(new Promise((resolve) => { settleA = resolve; }));
    const stopping = setup.mosh.stop(sessionId);
    await new Promise((resolve) => { setTimeout(resolve, 150); });
    expect(setup.processes.signals).toEqual([]);
    settleA();
    expect(await stopping).toEqual({ stopped: true, clean: true });
    expect(setup.processes.signals[0]).toEqual([child, 'TERM']);
  });

  it('clears an old mosh client for a new client only after other starts have settled', async () => {
    const setup = service({ platform: 'win32', terminalManager: windowsManager(), attachTimeoutMs: 3000 });
    await activeWindowsSession(setup);
    let settleA;
    setup.terminalManager.holdStart(new Promise((resolve) => { settleA = resolve; }));
    const attach = vi.fn(() => 'attached');
    const starting = setup.terminalManager.whenClientCanStart('$3', attach);
    await new Promise((resolve) => { setTimeout(resolve, 150); });
    expect(setup.processes.signals).toEqual([]);
    expect(attach).not.toHaveBeenCalled();
    settleA();
    expect(await starting).toBe('attached');
    expect(setup.processes.signals.length).toBeGreaterThan(0);
    expect(setup.mosh.sessions.size).toBe(0);
  });

  it('a new start then a stop of the old session, queued in that order, end it once and both finish', async () => {
    const setup = service({ platform: 'win32', terminalManager: windowsManager(), attachTimeoutMs: 3000 });
    const old = await activeWindowsSession(setup);
    let settleA;
    setup.terminalManager.holdStart(new Promise((resolve) => { settleA = resolve; }));
    // The new start takes the next turn and will clear the old session there...
    const next = id();
    const starting = setup.mosh.start({ id: next, paneId: '%1' });
    await vi.waitFor(() => expect(setup.mosh.sessions.size).toBe(2));
    // ...and the stop of the old one queues behind it.
    const stopping = setup.mosh.stop(old.sessionId);
    settleA();
    const answer = await starting;
    expect(answer.key).toBe(KEY);
    expect(await stopping).toEqual({ stopped: true, clean: true });
    const oldSignals = setup.processes.signals.filter(([pid]) => pid === old.child || pid === old.daemon);
    expect(oldSignals.filter(([pid, signal]) => pid === old.child && signal === 'TERM')).toHaveLength(1);
    expect(setup.mosh.sessions.has(old.sessionId)).toBe(false);
  });
});

describe('a start that waited for the capability', () => {
  it('starts nothing for an id ended meanwhile, after shutdown began, or a second time', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const setup = service({ versionGate: gate });
    const cancelledId = id();
    const shared = id();
    const cancelled = setup.mosh.start({ id: cancelledId, paneId: '%1' });
    const first = setup.mosh.start({ id: shared, paneId: '%1' });
    const second = setup.mosh.start({ id: shared, paneId: '%1' });
    expect(await setup.mosh.stop(cancelledId)).toEqual({ stopped: false, clean: true });
    release();
    await expect(cancelled).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const results = await Promise.allSettled([first, second]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(setup.spawn.calls).toHaveLength(1);

    let releaseAgain;
    const closing = service({ versionGate: new Promise((resolve) => { releaseAgain = resolve; }) });
    const late = closing.mosh.start({ id: id(), paneId: '%1' });
    await closing.mosh.stopAll();
    releaseAgain();
    await expect(late).rejects.toMatchObject({ code: 'TERMINAL_BUSY' });
    expect(closing.spawn.calls).toHaveLength(0);
  });
});

describe('a hub that stopped asking', () => {
  it('has its session ended by the node, before mosh-server would time out by itself', async () => {
    let clock = 1_000_000;
    const setup = service({ hubSilenceMs: 60_000 });
    setup.mosh._now = () => clock;
    const sessionId = id();
    await setup.mosh.start({ id: sessionId, paneId: '%1' });
    await vi.waitFor(() => expect(setup.mosh.sessions.get(sessionId).state).toBe('active'));
    clock += 45_000;
    setup.mosh.state(sessionId);
    clock += 45_000;
    await setup.mosh.reap();
    expect(setup.mosh.sessions.has(sessionId)).toBe(true);
    clock += 61_000;
    await setup.mosh.reap();
    await vi.waitFor(() => expect(setup.mosh.sessions.has(sessionId)).toBe(false));
    expect(setup.mosh.state(sessionId)).toEqual({ state: 'ended', clean: true });
  });
});

describe('who may open a mosh session', () => {
  const NODE_TOKEN = 'n'.repeat(64);
  const SESSION = '11111111-1111-1111-1111-111111111111';
  function app({ start } = {}) {
    const mosh = {
      start: vi.fn(start || (async ({ id: sessionId, paneId }) => ({ id: sessionId, port: 60001, key: KEY, paneId }))),
      stop: vi.fn(async () => ({ stopped: true, clean: true })),
    };
    const server = express();
    server.use(express.json());
    server.use('/api/mosh', createMoshRouter({ mosh, isNodeToken: (token) => token === NODE_TOKEN }));
    return { server, mosh };
  }
  const hub = { authorization: `Bearer ${NODE_TOKEN}`, [HUB_CALL_HEADER]: '1' };

  it('answers the hub itself: the node token and the mark of its own calls', async () => {
    const { server, mosh } = app();
    const res = await request(server).post('/api/mosh/sessions').set(hub).send({ id: SESSION, paneId: '%3' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ port: 60001, key: KEY });
    expect(mosh.start).toHaveBeenCalledWith({ id: SESSION, paneId: '%3', nozoom: false });
    expect(mosh.stop).not.toHaveBeenCalled();
    const del = await request(server).delete(`/api/mosh/sessions/${SESSION}`).set(hub);
    expect(del.body.data).toEqual({ stopped: true, clean: true });
  });

  it('answers a hub installed before the rename, which sends only the old mark', async () => {
    const { server } = app();
    const res = await request(server).post('/api/mosh/sessions')
      .set({ authorization: `Bearer ${NODE_TOKEN}`, 'x-twp-hub-call': '1' }).send({ id: SESSION, paneId: '%3' });
    expect(res.status).toBe(201);
    const browser = await request(server).post('/api/mosh/sessions')
      .set({ authorization: `Bearer ${NODE_TOKEN}` }).send({ id: SESSION, paneId: '%3' });
    expect(browser.status).toBe(403);
  });

  it('ends the session when the hub gave up before the answer', async () => {
    let release;
    const { server, mosh } = app({ start: () => new Promise((resolve) => { release = resolve; }) });
    const listening = server.listen(0, '127.0.0.1');
    await new Promise((resolve) => listening.once('listening', resolve));
    const { port } = listening.address();
    const http = await import('node:http');
    const req = http.request({ host: '127.0.0.1', port, path: '/api/mosh/sessions', method: 'POST',
      headers: { ...hub, 'content-type': 'application/json' } });
    req.on('error', () => {});
    req.end(JSON.stringify({ id: SESSION, paneId: '%3' }));
    await vi.waitFor(() => expect(mosh.start).toHaveBeenCalled());
    req.destroy();
    await vi.waitFor(() => expect(mosh.stop).toHaveBeenCalledWith(SESSION));
    release({ id: SESSION, port: 1, key: KEY, paneId: '%3' });
    listening.close();
  });

  it('refuses a login token, and the node token on a request a hub relayed for a browser', async () => {
    const { server, mosh } = app();
    for (const headers of [{ authorization: 'Bearer login-token', [HUB_CALL_HEADER]: '1' }, { authorization: `Bearer ${NODE_TOKEN}` }, {}]) {
      const res = await request(server).post('/api/mosh/sessions').set(headers).send({ id: SESSION, paneId: '%3' });
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain(KEY);
    }
    expect(mosh.start).not.toHaveBeenCalled();
  });

  it('checks what it is given', async () => {
    const { server } = app();
    expect((await request(server).post('/api/mosh/sessions').set(hub).send({ id: SESSION, paneId: 'main:0' })).status).toBe(400);
    expect((await request(server).post('/api/mosh/sessions').set(hub).send({ paneId: '%3' })).status).toBe(400);
    expect((await request(server).delete('/api/mosh/sessions/..%2F..').set(hub)).status).toBe(400);
  });

  it('is never relayed, however it is spelled, and a browser cannot forge the mark', () => {
    for (const path of ['/api/mosh/sessions', '/api/mosh', '/api/%6Dosh/sessions', '/api//mosh/sessions', '/api/MOSH/sessions', '/api/%zz']) {
      expect(isRelayable(path)).toBe(false);
    }
    expect(isRelayable('/api/mosher')).toBe(true);
    expect(forwardRequestHeaders({ [HUB_CALL_HEADER]: '1', 'X-Anymux-Hub-Call': '1', accept: '*/*' }, 't'.repeat(64))).toEqual({ accept: '*/*', authorization: `Bearer ${'t'.repeat(64)}` });
    // Nor the mark a Node installed before the rename checks.
    expect(forwardRequestHeaders({ 'x-twp-hub-call': '1', 'X-TWP-Hub-Call': '1', accept: '*/*' }, 't'.repeat(64))).toEqual({ accept: '*/*', authorization: `Bearer ${'t'.repeat(64)}` });
  });
});
