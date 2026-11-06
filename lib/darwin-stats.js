// macOS per-process stats based on one cached `ps` snapshot.
// Darwin has no Linux-style /proc tree, so build PID/PPID relationships once
// and reuse them for all windows in the same sampling cycle.

import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PS_CACHE_MS = 1_250;

let _cachedSnapshot = null;
let _cachedAt = 0;
let _snapshotPromise = null;

function processName(command, fallback = '') {
  const first = String(command || '').trim().split(/\s+/, 1)[0];
  return fallback || (first ? path.basename(first) : 'unknown');
}

/** Parse `ps -axo pid=,ppid=,%cpu=,rss=,ucomm=,command=` output. */
export function parseDarwinPs(output) {
  const processes = new Map();
  for (const line of String(output || '').split('\n')) {
    // ucomm is a whitespace-free executable name on Darwin; command is the
    // remainder and may contain arbitrary spaces.
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const cpuPercent = Number(m[3]);
    const rssKb = Number(m[4]);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid)) continue;
    processes.set(pid, {
      pid,
      ppid,
      cpuPercent: Number.isFinite(cpuPercent) ? Math.max(0, cpuPercent) : 0,
      rssKb: Number.isFinite(rssKb) ? Math.max(0, rssKb) : 0,
      comm: processName(m[6], m[5]),
      cmdline: (m[6].trim() || m[5]).slice(0, 200),
    });
  }
  return processes;
}

async function loadSnapshot() {
  const now = Date.now();
  if (_cachedSnapshot && now - _cachedAt < PS_CACHE_MS) return _cachedSnapshot;
  if (_snapshotPromise) return _snapshotPromise;

  _snapshotPromise = execFileAsync('/bin/ps', [
    '-axo', 'pid=,ppid=,%cpu=,rss=,ucomm=,command=',
  ], { timeout: 3_000, maxBuffer: 8 * 1024 * 1024 })
    .then(({ stdout }) => {
      const byPid = parseDarwinPs(stdout);
      const children = new Map();
      for (const proc of byPid.values()) {
        let list = children.get(proc.ppid);
        if (!list) {
          list = [];
          children.set(proc.ppid, list);
        }
        list.push(proc.pid);
      }
      _cachedSnapshot = { byPid, children };
      _cachedAt = Date.now();
      return _cachedSnapshot;
    })
    .finally(() => { _snapshotPromise = null; });

  return _snapshotPromise;
}

async function collectPidsFromSnapshot(rootPid, snapshot) {
  const root = Number(rootPid);
  if (!Number.isInteger(root) || root <= 0 || !snapshot.byPid.has(root)) return [];
  const out = [];
  const seen = new Set();
  const stack = [root];
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    for (const child of snapshot.children.get(pid) || []) stack.push(child);
  }
  return out;
}

export async function collectPids(rootPid) {
  return collectPidsFromSnapshot(rootPid, await loadSnapshot());
}

export async function sampleTree(rootPid) {
  const snapshot = await loadSnapshot();
  const pids = await collectPidsFromSnapshot(rootPid, snapshot);
  let cpuPercent = 0;
  let rssKb = 0;
  for (const pid of pids) {
    const proc = snapshot.byPid.get(pid);
    if (!proc) continue;
    cpuPercent += proc.cpuPercent;
    rssKb += proc.rssKb;
  }
  return {
    cpuPercent,
    memBytes: rssKb * 1024,
    swapBytes: 0,
    ioBps: 0,
    procCount: pids.length,
  };
}

export async function sampleNonTmuxByComm(excludePids) {
  const snapshot = await loadSnapshot();
  const excluded = excludePids instanceof Set ? excludePids : new Set(excludePids || []);
  const byComm = new Map();
  for (const proc of snapshot.byPid.values()) {
    if (excluded.has(proc.pid)) continue;
    let group = byComm.get(proc.comm);
    if (!group) {
      group = { comm: proc.comm, cpuPercent: 0, memBytes: 0, swapBytes: 0, ioBps: 0, procCount: 0 };
      byComm.set(proc.comm, group);
    }
    group.cpuPercent += proc.cpuPercent;
    group.memBytes += proc.rssKb * 1024;
    group.procCount += 1;
  }
  return Array.from(byComm.values()).filter(
    (g) => g.cpuPercent > 0.05 || g.memBytes > 4 * 1024 * 1024,
  );
}

export async function samplePidDetail(pid) {
  const proc = (await loadSnapshot()).byPid.get(Number(pid));
  if (!proc) return null;
  return {
    pid: proc.pid,
    comm: proc.comm,
    cmdline: proc.cmdline,
    cpuPercent: proc.cpuPercent,
    memBytes: proc.rssKb * 1024,
    ioBps: 0,
  };
}

export async function readDiskIo() {
  return new Map();
}

export function pruneStaleSamples() {}

export function _resetDarwinSnapshotForTests() {
  _cachedSnapshot = null;
  _cachedAt = 0;
  _snapshotPromise = null;
}

export const cpuCount = os.cpus().length;
