// Optional, bounded OS detail for a diagnostic capture. Never runs when idle.
import { execFile, spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import os from 'node:os';
import { repoPath } from './paths.js';

const WINDOWS_SAMPLER = repoPath('scripts', 'windows', 'sample-performance.ps1');
const MAC_NAMES = /^(?:Tmux ?Panel|tmux|node|ssh|sshd|git|claude|codex|WindowServer|com\.apple\.WebKit\.[\w.]+)$/;

function cpuSeconds(value) {
  const parts = value.split('-');
  const days = parts.length > 1 ? Number(parts.shift()) : 0;
  return parts[0].split(':').reduce((sum, n) => sum * 60 + Number(n), 0) + days * 86400;
}

export function parseMacProcesses(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+([\d:.\-]+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const name = m[6].slice(m[6].lastIndexOf('/') + 1);
    if (!MAC_NAMES.test(name)) continue;
    const start = Date.parse(m[3]);
    const cpu = cpuSeconds(m[4]);
    if (!Number.isFinite(start) || !Number.isFinite(cpu)) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), name, startedAt: new Date(start).toISOString(), cpuSeconds: cpu, rssBytes: Number(m[5]) * 1024 });
  }
  return rows;
}

/** Returns cleanup for this capture's own child/timer; never touches a service. */
export function startPlatformSampler({ record, durationMs }) {
  if (process.platform === 'win32') {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WINDOWS_SAMPLER,
      '-DurationSeconds', String(Math.ceil(durationMs / 1000)), '-IntervalSeconds', '5', '-ParentProcessId', String(process.pid)],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let stopped = false;
    child.once('spawn', () => record('windows', { phase: 'sampler-start', pid: child.pid }));
    child.stdout.on('data', (chunk) => {
      if (stopped) return;
      pending += decoder.write(chunk);
      // Never accumulate a malformed or unexpectedly large sampler output.
      if (pending.length > 128 * 1024) {
        record('windows', { code: 'SAMPLER_OUTPUT_LIMIT' });
        stop();
        return;
      }
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end).trim();
        pending = pending.slice(end + 1);
        if (!line) continue;
        try { record('windows', JSON.parse(line)); }
        catch { record('windows', { code: 'SAMPLER_INVALID_JSON' }); }
      }
    });
    child.once('error', () => record('windows', { code: 'SAMPLER_START_FAILED' }));
    child.once('exit', (code) => { if (!stopped) record('windows', { code: code === 0 ? 'SAMPLER_ENDED' : 'SAMPLER_FAILED', exitCode: code }); });
    function stop() {
      if (stopped) return;
      stopped = true;
      // A plain PowerShell sampler, not node-pty or any tmux process.
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    return stop;
  }
  if (process.platform !== 'darwin') return () => {};

  let stopped = false;
  let timer;
  let child;
  let previous = new Map();
  const deadline = performance.now() + durationMs;
  const cpuCount = os.cpus().length || 1;
  function sample() {
    if (stopped || performance.now() >= deadline) return;
    const began = performance.now();
    child = execFile('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,time=,rss=,comm='], {
      env: { ...process.env, LC_ALL: 'C' }, timeout: 3000, maxBuffer: 1024 * 1024,
    }, (error, stdout) => {
      child = null;
      if (stopped) return;
      if (error) record('platform', { code: 'MAC_PROCESS_SAMPLE_FAILED' });
      else {
        const at = performance.now();
        const rows = parseMacProcesses(stdout);
        const next = new Map();
        const groups = new Map();
        for (const row of rows) {
          const key = row.pid + ':' + row.startedAt;
          const old = previous.get(key);
          row.cpuPercent = old && row.cpuSeconds >= old.cpuSeconds && at > old.at
            ? 100000 * (row.cpuSeconds - old.cpuSeconds) / ((at - old.at) * cpuCount) : null;
          next.set(key, { cpuSeconds: row.cpuSeconds, at });
          const group = groups.get(row.name) || { name: row.name, count: 0, rssBytes: 0, cpuPercent: 0 };
          group.count += 1;
          group.rssBytes += row.rssBytes;
          group.cpuPercent = group.cpuPercent !== null && row.cpuPercent !== null ? group.cpuPercent + row.cpuPercent : null;
          groups.set(row.name, group);
        }
        previous = next;
        rows.sort((a, b) => (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1) || b.rssBytes - a.rssBytes);
        record('platform', { platform: 'darwin', sampleMs: performance.now() - began,
          processes: rows.slice(0, 60), processGroups: [...groups.values()], totalMatchingProcesses: rows.length, truncated: rows.length > 60 });
      }
      if (!stopped) timer = setTimeout(sample, 5000);
      timer?.unref();
    });
  }
  sample();
  return () => {
    stopped = true;
    clearTimeout(timer);
    if (child) child.kill();
    previous.clear();
  };
}
