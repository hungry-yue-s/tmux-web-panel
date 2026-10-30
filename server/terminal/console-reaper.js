/**
 * Frees the conhost.exe of Windows tmux clients that have ended.
 *
 * node-pty cannot do it safely. Its kill closes the console at once, and a console
 * going away takes the tmux server with it if that is attached at the moment
 * (docs/known-issues.md). A client that just exits leaves conhost.exe running
 * until this process ends. So the console is left alone until tmux has long let go
 * of it, and only then ended here.
 *
 * Which conhost belongs to which client comes from time: pty.spawn creates it
 * synchronously, so no other console of this process can be created in that window.
 * Measured here: 30 of 30 consoles were created inside the exact window, so it gets
 * no margin; a margin could reach the console of a client spawned right after. Two
 * windows can still touch at one millisecond, so a console is only ended when nothing
 * still alive could own it. Every pty.spawn in this process goes through
 * trackConsoleSpawn for that. When in doubt a console stays, which is only a leak.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const REAP_DELAY_MS = 5000;
// Listing can fail while the machine is busy, and a console can be impossible to
// place for now. An entry still open after this many sweeps is given up on: its
// console then stays until this process ends, which is only a leak.
const MAX_ATTEMPTS = 3;

/** The spawn windows of every pty of this process that has not exited yet. */
const liveSpawns = new Set();

/**
 * Runs a pty.spawn and keeps its time window on record until the pty exits, replaced
 * or not. A window a client is still using must never look free to the reaper.
 * @template T
 * @param {() => T} spawn
 * @returns {{ term: T, spawnWindow: { from: number, to: number } }}
 */
export function trackConsoleSpawn(spawn) {
  const spawnWindow = { from: Date.now(), to: Infinity };
  liveSpawns.add(spawnWindow);
  let term;
  try {
    term = spawn();
  } catch (err) {
    liveSpawns.delete(spawnWindow);
    throw err;
  }
  spawnWindow.to = Date.now();
  term.onExit(() => liveSpawns.delete(spawnWindow));
  return { term, spawnWindow };
}

const within = ({ createdAt }, { from, to }) => createdAt >= from && createdAt <= to;

/** @returns {Promise<Array<{ pid: number, createdAt: number }>>} */
async function listChildConsoles() {
  const script = `Get-CimInstance Win32_Process -Filter "Name='conhost.exe' AND ParentProcessId=${process.pid}"`
    + " | ForEach-Object { '{0} {1}' -f $_.ProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }";
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: 30000,
    windowsHide: true,
  });
  return String(stdout).split(/\r?\n/).filter(Boolean).map((line) => {
    const [pid, createdAt] = line.trim().split(' ').map(Number);
    return { pid, createdAt };
  });
}

export class ConsoleReaper {
  constructor({
    list = listChildConsoles,
    kill = (pid) => process.kill(pid),
    now = () => Date.now(),
    delayMs = REAP_DELAY_MS,
    live = liveSpawns,
  } = {}) {
    this._list = list;
    this._kill = kill;
    this._now = now;
    this._delayMs = delayMs;
    this._live = live;
    this._ended = [];
    this._timer = null;
    this._sweeping = false;
  }

  /** @param {{ from: number, to: number }} spawnWindow when the client's pty.spawn ran */
  clientEnded(spawnWindow) {
    this._ended.push({ ...spawnWindow, endedAt: this._now(), attempts: 0 });
    this._schedule();
  }

  /** One sweep at a time: anything that ends during one waits for the next. */
  _schedule() {
    if (this._timer || this._sweeping || this._ended.length === 0) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this._sweep().catch((err) => console.error('[terminal] console cleanup failed:', err.message));
    }, this._delayMs);
    if (this._timer.unref) this._timer.unref();
  }

  async _sweep() {
    const due = this._now() - this._delayMs;
    const ready = this._ended.filter((entry) => entry.endedAt <= due);
    this._sweeping = true;
    try {
      if (ready.length === 0) return;
      let consoles;
      try {
        consoles = await this._list();
      } catch (err) {
        // Still owed: the next sweep tries again, up to a limit.
        this._postpone(ready);
        throw err;
      }
      const postponed = [];
      const killed = new Set();
      for (const entry of ready) {
        const inside = consoles.filter((candidate) => within(candidate, entry));
        if (inside.length === 0) continue;
        const [only] = inside;
        // Several in one window, or one a client still running could own: not now.
        const someoneElsesToo = inside.length > 1
          || [...this._live].some((other) => within(only, other))
          || this._ended.some((other) => !ready.includes(other) && within(only, other));
        if (someoneElsesToo) {
          postponed.push(entry);
          continue;
        }
        if (killed.has(only.pid)) continue;
        killed.add(only.pid);
        try { this._kill(only.pid); } catch { /* already gone */ }
      }
      this._ended = this._ended.filter((entry) => !ready.includes(entry) || postponed.includes(entry));
      this._postpone(postponed);
    } finally {
      this._sweeping = false;
      this._schedule();
    }
  }

  _postpone(entries) {
    for (const entry of entries) entry.attempts += 1;
    this._ended = this._ended.filter((entry) => entry.attempts < MAX_ATTEMPTS);
  }
}
