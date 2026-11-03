import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import { createProcessTable, parseMsysPs, sameProcess, sameStart } from '../server/mosh/processes.js';
import { MoshService } from '../server/mosh/server.js';

// Entirely fake exec/process table: never starts bash, stat, tmux, Mosh or a server.
const HEADER = '      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND';
const BIRTH = '1793692800';
const entries = () => new Map([
  [500, { pid: 500, ppid: 1, winpid: 10500, command: '/usr/bin/mosh-server' }],
  [501, { pid: 501, ppid: 500, winpid: 10501, command: '/usr/bin/mosh-server' }],
]);

function fixture() {
  const state = { entries: entries(), stime: '16:00:00', omit: new Set(), births: new Map(), winpids: new Map(), error: null, truncate: false };
  const calls = [];
  const output = () => {
    const ps = [...state.entries.values()].map((p) => `  ${p.pid} ${p.ppid} ${p.pid} ${p.winpid} ? 197108 ${state.stime} ${p.command}`).join('\n');
    const births = [...state.entries.values()].filter((p) => !state.omit.has(p.pid))
      .map((p) => `${p.pid}\t${state.births.get(p.pid) || BIRTH}\t${state.winpids.get(p.pid) || p.winpid}`).join('\n');
    return `${HEADER}\n${ps}\n__TWP_PROCESS_BIRTHS__\n${births}\n${state.truncate ? '' : '__TWP_PROCESS_END__\n'}`;
  };
  const execFileImpl = vi.fn((file, args, options, callback) => {
    const call = { file, args, options, script: null };
    calls.push(call);
    const stdin = new EventEmitter();
    stdin.end = (script) => {
      call.script = script;
      queueMicrotask(() => callback(state.error, output(), ''));
    };
    if (file.endsWith('kill.exe')) queueMicrotask(() => callback(null, '', ''));
    return { stdin };
  });
  return { state, calls, execFileImpl, reader: createProcessTable({ platform: 'win32', msysRoot: 'D:\\MSYS tools', execFileImpl }) };
}

async function owned(f) {
  const recorded = await f.reader.read();
  const signals = [];
  const processes = { read: () => f.reader.read(), signal: async (pid, signal) => { signals.push([pid, signal]); f.state.entries.delete(pid); } };
  const mosh = new MoshService({ platform: 'win32', workspace: {}, processes, goneWaitMs: 0,
    terminalManager: { addClientOwner() {}, inClientTurn: (fn) => Promise.resolve().then(fn) } });
  const session = { id: randomUUID(), state: 'active', cancelled: false, sessionTarget: '$3',
    daemon: recorded.get(500), children: [recorded.get(501)], launch: null, attached: true,
    teardown: null, queued: null, lastSeen: Date.now(), settled: Promise.resolve() };
  mosh.sessions.set(session.id, session);
  return { mosh, session, signals };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('MSYS stable process birth', () => {
  it('keeps identity across the 24-hour display transition, including a double-space single-digit date', async () => {
    const f = fixture();
    const before = (await f.reader.read()).get(500);
    f.state.stime = 'Nov  3';
    const after = (await f.reader.read()).get(500);
    expect(after).toEqual(before);
    expect(after.start).toBe(BIRTH);
    expect(sameProcess(before, after)).toBe(true);
    const parsed = parseMsysPs(`${HEADER}\n  700 1 700 10700 ? 197108 Nov  3 /c/Program Files/a b.exe\n`);
    expect(parsed.get(700)).toMatchObject({ start: null, command: '/c/Program Files/a b.exe' });
  });

  it('preserves child identity through exec but keeps strict Windows pid and image checks', async () => {
    const f = fixture();
    const before = (await f.reader.read()).get(501);
    f.state.entries.set(501, { ...f.state.entries.get(501), winpid: 20501, command: '/usr/bin/tmux' });
    const execd = (await f.reader.read()).get(501);
    expect(sameStart(before, execd)).toBe(true);
    expect(sameProcess(before, execd)).toBe(false);
    expect(sameProcess(before, { ...before, winpid: 30501 })).toBe(false);
    expect(sameProcess(before, { ...before, command: '/usr/bin/other' })).toBe(false);
    f.state.births.set(501, '1793692801');
    expect(sameStart(before, (await f.reader.read()).get(501))).toBe(false);
  });

  it('retains ps rows with unknown identity when stat is unavailable or belongs to another Windows incarnation', async () => {
    const f = fixture();
    f.state.omit.add(500);
    f.state.winpids.set(501, 99999);
    const table = await f.reader.read();
    expect(table.size).toBe(2);
    expect(table.get(500).start).toBeNull();
    expect(table.get(501).start).toBeNull();
    expect(sameProcess(table.get(500), table.get(500))).toBe(false);
    expect(sameStart(table.get(501), table.get(501))).toBe(false);
  });

  it('rejects incomplete snapshots and command errors even when they contain partial stdout', async () => {
    const f = fixture();
    f.state.truncate = true;
    await expect(f.reader.read()).rejects.toThrow('incomplete');
    f.state.truncate = false;
    f.state.error = Object.assign(new Error('fixture'), { code: 'EACCES' });
    await expect(f.reader.read()).rejects.toMatchObject({ code: 'EACCES' });
    expect(() => parseMsysPs(`${HEADER}\n  500 1 500 10500 ? 197108 16:00:00\n`)).toThrow('incomplete');
  });

  it('uses a bounded MSYS stdin script without loading startup environment and batches directory stat', async () => {
    vi.stubEnv('BASH_ENV', 'must-not-load');
    vi.stubEnv('ENV', 'must-not-load');
    const f = fixture();
    await f.reader.read();
    expect(f.calls).toHaveLength(1);
    const call = f.calls[0];
    expect(call.file).toBe('D:\\MSYS tools\\usr\\bin\\bash.exe');
    expect(call.args).toEqual(["'--noprofile'", "'--norc'", "'-s'"]);
    expect(call.options.windowsVerbatimArguments).toBe(true);
    expect(call.options.timeout).toBe(5000);
    expect(call.options.env.BASH_ENV).toBeUndefined();
    expect(call.options.env.ENV).toBeUndefined();
    expect(call.options.env.LC_ALL).toBe('C');
    expect(call.options.env.MSYS.split(/\s+/)).toContain('noglob');
    expect((call.script.match(/\/usr\/bin\/stat /g) || []).length).toBe(1);
    expect(call.script).toContain('"${paths[@]}"');
    expect(call.script).toContain('"$proc/winpid"');
    await f.reader.signal(500, 'TERM');
    expect(f.calls[1].args).toEqual(["'-TERM'", "'500'"]);
  });
});

describe('Mosh cleanup with stable or unknown birth', () => {
  it('actually ends both owned processes after 24h instead of reporting clean without a signal', async () => {
    const f = fixture();
    const { mosh, session, signals } = await owned(f);
    f.state.stime = 'Nov  3';
    await mosh.reap();
    expect(mosh.sessions.has(session.id)).toBe(true);
    expect(await mosh.stop(session.id)).toEqual({ stopped: true, clean: true });
    expect(signals).toEqual([[501, 'TERM'], [500, 'TERM']]);
    expect(f.state.entries.size).toBe(0);
    expect(mosh.state(session.id)).toEqual({ state: 'ended', clean: true });
  });

  it.each([[500], [501], [500, 501]])('keeps ownership and blocks attach while a listed birth is unreadable (%j)', async (...missing) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fixture();
    const { mosh, session, signals } = await owned(f);
    f.state.omit = new Set(missing.flat());
    await mosh.reap();
    expect(mosh.sessions.has(session.id)).toBe(true);
    expect(mosh._ended.has(session.id)).toBe(false);
    expect(await mosh.stop(session.id)).toEqual({ stopped: true, clean: false });
    expect(mosh.sessions.has(session.id)).toBe(true);
    expect(await mosh.endClientsOn('$3')).toBe(false);
    expect(signals).toEqual([]);
    // An unknown read must not overwrite the child identity recorded earlier.
    expect(session.children[0].start).toBe(BIRTH);
    f.state.omit.clear();
    expect(await mosh.endClientsOn('$3')).toBe(true);
    expect(signals).toEqual([[501, 'TERM'], [500, 'TERM']]);
    expect(mosh.sessions.size).toBe(0);
  });

  it('does not reap or lose ownership on a partial/failed process query', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fixture();
    const { mosh, session, signals } = await owned(f);
    f.state.error = Object.assign(new Error('fixture'), { code: 'ETIMEDOUT' });
    await expect(mosh.reap()).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect(await mosh.stop(session.id)).toEqual({ stopped: true, clean: false });
    expect(mosh.sessions.has(session.id)).toBe(true);
    expect(signals).toEqual([]);
    f.state.error = null;
    expect(await mosh.endClientsOn('$3')).toBe(true);
  });

  it('does not claim clean when a newly seen daemon child has no readable birth yet', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fixture();
    const { mosh, session, signals } = await owned(f);
    session.children = [];
    f.state.omit.add(501);
    expect(await mosh.stop(session.id)).toEqual({ stopped: true, clean: false });
    expect(signals).toEqual([]);
    expect(mosh.sessions.has(session.id)).toBe(true);
    f.state.omit.clear();
    expect(await mosh.endClientsOn('$3')).toBe(true);
    expect(signals).toEqual([[501, 'TERM'], [500, 'TERM']]);
  });

  it('settles an already queued stop when an earlier owner turn could not confirm identity', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fixture();
    const { mosh, session, signals } = await owned(f);
    const queued = [];
    mosh.terminalManager.inClientTurn = (fn) => new Promise((resolve, reject) => {
      queued.push(() => Promise.resolve().then(fn).then(resolve, reject));
    });
    f.state.omit.add(500);
    const stopping = mosh.stop(session.id);
    expect(queued).toHaveLength(1);
    // A caller already inside an earlier turn performs this teardown first.
    expect(await mosh.endClientsOn('$3')).toBe(false);
    await queued.shift()();
    expect(await stopping).toEqual({ stopped: true, clean: false });
    expect(signals).toEqual([]);
    f.state.omit.clear();
    expect(await mosh.endClientsOn('$3')).toBe(true);
  });
});
