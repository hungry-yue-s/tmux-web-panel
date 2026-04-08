// Per-process stats from /proc — CPU, memory, IO with delta sampling.
// Stateless reads + a stateful Map of previous samples for delta calculation.

import { readFile } from 'node:fs/promises';
import os from 'node:os';

const CLK_TCK = 100; // Linux default; SC_CLK_TCK
const CPU_COUNT = os.cpus().length;

// pid → { utime, stime, rb, wb, ts }
const _prev = new Map();

async function readStat(pid) {
  const buf = await readFile(`/proc/${pid}/stat`, 'utf8');
  // Skip past comm field which can contain spaces and parentheses
  const close = buf.lastIndexOf(')');
  const rest = buf.slice(close + 2).split(' ');
  // After "comm) ", index 0 is state. utime=index 11, stime=index 12 in original
  // After slicing, utime=11, stime=12 (since field 1 was pid, field 2 was comm).
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  return { utime, stime };
}

async function readStatus(pid) {
  const buf = await readFile(`/proc/${pid}/status`, 'utf8');
  const r = buf.match(/^VmRSS:\s+(\d+)\s+kB/m);
  const s = buf.match(/^VmSwap:\s+(\d+)\s+kB/m);
  return { rssKb: r ? Number(r[1]) : 0, swapKb: s ? Number(s[1]) : 0 };
}

async function readIo(pid) {
  try {
    const buf = await readFile(`/proc/${pid}/io`, 'utf8');
    const r = buf.match(/^read_bytes:\s+(\d+)/m);
    const w = buf.match(/^write_bytes:\s+(\d+)/m);
    return { rb: r ? Number(r[1]) : 0, wb: w ? Number(w[1]) : 0 };
  } catch {
    // EACCES if not owner; fall back to 0
    return { rb: 0, wb: 0 };
  }
}

async function readChildren(pid) {
  try {
    const buf = await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8');
    return buf.trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

// Walk the process tree rooted at `rootPid`, returning all descendant PIDs (incl. root).
export async function collectPids(rootPid) {
  const out = [];
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop();
    out.push(pid);
    const children = await readChildren(pid);
    for (const c of children) stack.push(c);
  }
  return out;
}

// Sample one PID; returns { cpuPercent (delta-based), rssKb, ioBps }.
async function samplePid(pid, now) {
  const [stat, status, io] = await Promise.all([
    readStat(pid).catch(() => null),
    readStatus(pid).catch(() => null),
    readIo(pid),
  ]);
  if (!stat || !status) return null;

  const prev = _prev.get(pid);
  _prev.set(pid, {
    utime: stat.utime,
    stime: stat.stime,
    rb: io.rb,
    wb: io.wb,
    ts: now,
  });

  let cpuPercent = 0;
  let ioBps = 0;
  if (prev) {
    const dtSec = (now - prev.ts) / 1000;
    if (dtSec > 0) {
      const jiffies = stat.utime + stat.stime - prev.utime - prev.stime;
      cpuPercent = (jiffies / CLK_TCK / dtSec) * 100; // single-core %
      const ioDelta = (io.rb - prev.rb) + (io.wb - prev.wb);
      ioBps = ioDelta / dtSec;
    }
  }
  return { cpuPercent, rssKb: status.rssKb, swapKb: status.swapKb, ioBps };
}

// Aggregate stats for a process tree rooted at rootPid.
export async function sampleTree(rootPid) {
  const pids = await collectPids(rootPid);
  const now = Date.now();
  const samples = await Promise.all(pids.map((pid) => samplePid(pid, now)));
  let cpu = 0, rss = 0, swap = 0, io = 0, count = 0;
  for (const s of samples) {
    if (!s) continue;
    cpu += s.cpuPercent;
    rss += s.rssKb;
    swap += s.swapKb;
    io += s.ioBps;
    count++;
  }
  return {
    cpuPercent: cpu,
    memBytes: rss * 1024,
    swapBytes: swap * 1024,
    ioBps: io,
    procCount: count,
  };
}

// Garbage-collect _prev entries that weren't touched in the last N polls.
export function pruneStaleSamples(maxAgeMs) {
  const cutoff = Date.now() - maxAgeMs;
  for (const [pid, v] of _prev) {
    if (v.ts < cutoff) _prev.delete(pid);
  }
}

export const cpuCount = CPU_COUNT;
