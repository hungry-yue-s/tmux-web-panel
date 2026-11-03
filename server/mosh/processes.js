/**
 * Processes a mosh session is made of, told apart from later processes that reuse
 * their pid. A recorded process is signalled only while the system still describes
 * it the same way: same pid, start time, executable and, on Windows, Windows pid.
 *
 * Windows: MSYS2's own `ps -l`, whose pids are the MSYS2 pids mosh-server prints and
 * MSYS2's kill understands. Elsewhere: `ps -A` with the full start time.
 */

import { execFile } from 'node:child_process';
import { win32 } from 'node:path';

import { MSYS_ROOT } from '../msys.js';

/**
 * `ps -l` of MSYS2/Cygwin:
 *       PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND
 *   1329790       1 1329790      19736  ?         197108 16:46:46 /usr/bin/mosh-server
 * STIME is a time today, a date before that.
 */
export function parseMsysPs(text) {
  const table = new Map();
  for (const line of String(text).split('\n').slice(1)) {
    const match = /^\s*[IOS]?\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\S+(?: \d+)?)\s+(\S.*?)\s*$/.exec(line);
    if (!match) continue;
    const [, pid, ppid, , winpid, , , start, command] = match;
    table.set(Number(pid), { pid: Number(pid), ppid: Number(ppid), winpid: Number(winpid), start, command });
  }
  return table;
}

/** `ps -A -o pid=,ppid=,lstart=,comm=`: lstart is five words, e.g. "Tue Nov  3 16:46:46 2026". */
export function parseUnixPs(text) {
  const table = new Map();
  for (const line of String(text).split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(\S.*?)\s*$/.exec(line);
    if (!match) continue;
    const [, pid, ppid, start, command] = match;
    table.set(Number(pid), { pid: Number(pid), ppid: Number(ppid), winpid: null, start: start.replace(/\s+/g, ' '), command });
  }
  return table;
}

/** The same process as `recorded`, as far as the system can tell. */
export function sameProcess(recorded, current) {
  return Boolean(recorded && current && recorded.pid === current.pid && recorded.start === current.start
    && recorded.command === current.command && recorded.winpid === current.winpid);
}

/**
 * The same process, possibly after an exec: it keeps its pid and start time, while
 * its executable changes, and on MSYS2 its Windows process too.
 */
export function sameStart(recorded, current) {
  return Boolean(recorded && current && recorded.pid === current.pid && recorded.start === current.start);
}

export function createProcessTable({ platform = process.platform, execFileImpl = execFile, msysRoot = MSYS_ROOT } = {}) {
  const windows = platform === 'win32';
  const bin = (name) => (windows ? win32.join(msysRoot, 'usr', 'bin', `${name}.exe`) : name);
  const run = (file, args) => new Promise((resolve, reject) => {
    execFileImpl(file, args, { timeout: 5000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) reject(err);
      else resolve(String(stdout || ''));
    });
  });
  return {
    /** Every process of this user: pid -> { pid, ppid, winpid, start, command }. */
    async read() {
      return windows ? parseMsysPs(await run(bin('ps'), ['-l'])) : parseUnixPs(await run('ps', ['-A', '-o', 'pid=,ppid=,lstart=,comm=']));
    },
    /** Asks a process to end. MSYS2 pids need MSYS2's kill; the caller has checked who it is. */
    async signal(pid, signal = 'TERM') {
      if (!Number.isSafeInteger(pid) || pid <= 1) return;
      if (windows) {
        await run(bin('kill'), [`-${signal}`, String(pid)]).catch(() => {});
        return;
      }
      try { process.kill(pid, `SIG${signal}`); } catch { /* already gone */ }
    },
  };
}
