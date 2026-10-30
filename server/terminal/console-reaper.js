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
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const REAP_DELAY_MS = 5000;
const CLOCK_MARGIN_MS = 20;

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
  } = {}) {
    this._list = list;
    this._kill = kill;
    this._now = now;
    this._delayMs = delayMs;
    this._ended = [];
    this._timer = null;
  }

  /** @param {{ from: number, to: number }} spawnWindow when the client's pty.spawn ran */
  clientEnded(spawnWindow) {
    this._ended.push({ ...spawnWindow, endedAt: this._now() });
    this._schedule();
  }

  _schedule() {
    if (this._timer || this._ended.length === 0) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this._sweep().catch((err) => console.error('[terminal] console cleanup failed:', err.message));
    }, this._delayMs);
    if (this._timer.unref) this._timer.unref();
  }

  async _sweep() {
    const due = this._now() - this._delayMs;
    const ready = this._ended.filter((entry) => entry.endedAt <= due);
    this._ended = this._ended.filter((entry) => entry.endedAt > due);
    try {
      if (ready.length === 0) return;
      for (const { pid, createdAt } of await this._list()) {
        const belongs = ready.some(({ from, to }) => createdAt >= from - CLOCK_MARGIN_MS && createdAt <= to + CLOCK_MARGIN_MS);
        if (!belongs) continue;
        try { this._kill(pid); } catch { /* already gone */ }
      }
    } finally {
      this._schedule();
    }
  }
}
