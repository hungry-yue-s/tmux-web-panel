/**
 * Processes a mosh session is made of, told apart from later processes that reuse
 * their pid. A recorded process is signalled only while the system still describes
 * it the same way: same pid, start time, executable and, on Windows, Windows pid.
 *
 * Windows: MSYS2 pids and raw /proc directory birth times. ps's displayed STIME
 * changes after 24 hours, so it is never an identity. Elsewhere: full ps start time.
 */

import { execFile } from 'node:child_process';
import { win32 } from 'node:path';

import { MSYS_ROOT, msysExecArgs, withNoGlob } from '../msys.js';

// One MSYS shell and one batched stat, not a subprocess for each pid. /proc/PID's
// mtime is pinfo.start_time, which survives exec; /proc/PID/stat's field 22 instead
// follows the replacement Windows process. Read winpid after stat to bind the
// birth to the same incarnation ps saw, rather than a pid recycled between reads.
const MSYS_SNAPSHOT = `
set -f
ps=$(/usr/bin/ps -l) || exit 1
printf '%s\\n' "$ps"
printf '__ANYMUX_PROCESS_BIRTHS__\\n'
paths=()
while read -r first rest; do
  case "$first" in I|O|S) read -r pid rest <<< "$rest" ;; *) pid=$first ;; esac
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] && paths+=("/proc/$pid")
done <<< "$ps"
if (( \${#paths[@]} )); then
  births=$(/usr/bin/stat --printf='%n\\t%Y\\n' -- "\${paths[@]}" 2>/dev/null) || :
  while IFS=$'\\t' read -r proc birth; do
    [[ "$proc" =~ ^/proc/[1-9][0-9]*$ && "$birth" =~ ^[1-9][0-9]*$ ]] || continue
    pid=\${proc#/proc/}
    IFS= read -r winpid < "$proc/winpid" 2>/dev/null || continue
    [[ "$winpid" =~ ^[1-9][0-9]*$ ]] || continue
    printf '%s\\t%s\\t%s\\n' "$pid" "$birth" "$winpid"
  done <<< "$births"
fi
printf '__ANYMUX_PROCESS_END__\\n'
`;

const invalidTable = () => new Error('Process identity snapshot is incomplete');

/**
 * `ps -l` of MSYS2/Cygwin:
 *       PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND
 *   1329790       1 1329790      19736  ?         197108 16:46:46 /usr/bin/mosh-server
 * STIME is a time before age 24h, then a date. Neither is a birth identity.
 */
export function parseMsysPs(text) {
  const table = new Map();
  const lines = String(text).split('\n');
  if (!/^\s*PID\s+PPID\s+PGID\s+WINPID\s+TTY\s+UID\s+STIME\s+COMMAND\s*$/.test(lines.shift() || '')) throw invalidTable();
  for (const line of lines) {
    if (!line.trim()) continue;
    const match = /^\s*[IOS]?\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(?:\d{2}:\d{2}:\d{2}|[A-Z][a-z]{2}\s+\d{1,2})\s+(\S.*?)\s*$/.exec(line);
    if (!match) throw invalidTable();
    const [, pid, ppid, , winpid, , , command] = match;
    table.set(Number(pid), { pid: Number(pid), ppid: Number(ppid), winpid: Number(winpid), start: null, command });
  }
  return table;
}

function parseMsysSnapshot(text) {
  const parts = String(text).replace(/\r\n/g, '\n').split('\n__ANYMUX_PROCESS_BIRTHS__\n');
  if (parts.length !== 2 || !parts[1].endsWith('__ANYMUX_PROCESS_END__\n')) throw invalidTable();
  const table = parseMsysPs(parts[0]);
  const seen = new Set();
  for (const line of parts[1].slice(0, -'__ANYMUX_PROCESS_END__\n'.length).split('\n')) {
    if (!line) continue;
    const match = /^([1-9]\d*)\t([1-9]\d*)\t([1-9]\d*)$/.exec(line);
    if (!match || seen.has(match[1])) throw invalidTable();
    seen.add(match[1]);
    const entry = table.get(Number(match[1]));
    if (entry && entry.winpid === Number(match[3])) entry.start = match[2];
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
  return Boolean(sameStart(recorded, current)
    && recorded.command === current.command && recorded.winpid === current.winpid);
}

/**
 * The same process, possibly after an exec: it keeps its pid and start time, while
 * its executable changes, and on MSYS2 its Windows process too.
 */
export function sameStart(recorded, current) {
  return Boolean(recorded && current && recorded.start && current.start
    && recorded.pid === current.pid && recorded.start === current.start);
}

export function createProcessTable({ platform = process.platform, execFileImpl = execFile, msysRoot = MSYS_ROOT } = {}) {
  const windows = platform === 'win32';
  const bin = (name) => (windows ? win32.join(msysRoot, 'usr', 'bin', `${name}.exe`) : name);
  const run = (file, args, script = null) => new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (windows) {
      env.MSYS = withNoGlob(env.MSYS);
      env.LC_ALL = 'C';
      env.COLUMNS = '65536';
      delete env.BASH_ENV;
      delete env.ENV;
    }
    const [argv, options] = msysExecArgs(args, { argv0: file, env, timeout: 5000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, windows);
    const child = execFileImpl(file, argv, options, (err, stdout) => {
      // Partial stdout on timeout, maxBuffer or another error cannot prove absence.
      if (err) reject(err);
      else resolve(String(stdout || ''));
    });
    if (script) {
      if (!child?.stdin) { reject(invalidTable()); return; }
      child.stdin.on('error', reject);
      child.stdin.end(script);
    }
  });
  return {
    /** Every process of this user: pid -> { pid, ppid, winpid, start, command }. */
    async read() {
      return windows
        ? parseMsysSnapshot(await run(bin('bash'), ['--noprofile', '--norc', '-s'], MSYS_SNAPSHOT))
        : parseUnixPs(await run('ps', ['-A', '-o', 'pid=,ppid=,lstart=,comm=']));
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
