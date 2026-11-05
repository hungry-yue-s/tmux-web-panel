import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const PORT_RANGE_MIN = 1024;
const PORT_RANGE_MAX = 65535;
const SS_TIMEOUT = 5000;
const PS_TIMEOUT = 5000;

/**
 * Parses `ss -tlnp` output into an array of { port, pid } objects.
 * Only includes ports in range (1024, 65535] (exclusive lower, inclusive upper).
 *
 * @param {string} output - raw stdout from `ss -tlnp`
 * @returns {{ port: number, pid: number }[]}
 */
export function parseSsOutput(output) {
  if (!output || output.trim().length === 0) return [];

  const results = [];
  const lines = output.trim().split('\n');

  for (const line of lines) {
    // Extract port from Local Address:Port field
    // Handles formats: 0.0.0.0:3000, [::]:3000, *:3000, :::3000
    const portMatch = line.match(/(?:\*|\[?[^\s\]]*\]?):(\d+)\s/);
    if (!portMatch) continue;

    const port = Number(portMatch[1]);
    if (port <= PORT_RANGE_MIN || port > PORT_RANGE_MAX) continue;

    // Extract pid from users:((...,pid=NNNN,...))
    const pidMatch = line.match(/pid=(\d+)/);
    if (!pidMatch) continue;

    const pid = Number(pidMatch[1]);
    results.push({ port, pid });
  }

  return results;
}

/**
 * Builds a parent → children map from `ps -eo pid,ppid` output.
 * Single subprocess call replaces per-process /proc reads (avoids FD leak).
 *
 * @returns {Promise<Map<number, number[]>>} parent pid → child pids
 */
export async function buildProcessTree() {
  const children = new Map();

  try {
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid,ppid', '--no-headers'], {
      timeout: PS_TIMEOUT,
    });

    for (const line of stdout.trim().split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2) continue;

      const childPid = Number(parts[0]);
      const parentPid = Number(parts[1]);
      if (!Number.isFinite(childPid) || !Number.isFinite(parentPid)) continue;

      if (!children.has(parentPid)) {
        children.set(parentPid, []);
      }
      children.get(parentPid).push(childPid);
    }
  } catch {
    // ps unavailable or failed
  }

  return children;
}

/**
 * Finds all descendant PIDs of the given PID using a pre-built process tree.
 *
 * @param {number} pid - root PID to find descendants for
 * @param {Map<number, number[]>} processTree - parent → children map
 * @returns {Set<number>} set of all descendant PIDs
 */
export function getDescendantPids(pid, processTree) {
  const descendants = new Set();
  const queue = [pid];

  while (queue.length > 0) {
    const current = queue.shift();
    const kids = processTree.get(current) || [];
    for (const child of kids) {
      if (!descendants.has(child)) {
        descendants.add(child);
        queue.push(child);
      }
    }
  }

  return descendants;
}

/**
 * Filters ports from allPorts that belong to the given pid or any of its descendants.
 *
 * @param {{ port: number, pid: number }[]} allPorts
 * @param {number} pid
 * @param {Set<number>} descendants - set of descendant PIDs
 * @returns {number[]} unique port numbers
 */
export function filterPortsForPid(allPorts, pid, descendants) {
  const portSet = new Set();

  for (const entry of allPorts) {
    if (entry.pid === pid || descendants.has(entry.pid)) {
      portSet.add(entry.port);
    }
  }

  return [...portSet];
}

/**
 * Runs `ss -tlnp` and returns a Map of paneId → listening port numbers.
 *
 * @param {Map<string, number>} panePids - Map<paneId, pid>
 * @returns {Promise<Map<string, number[]>>} Map<paneId, port[]>
 */
export async function scanPorts(panePids) {
  const result = new Map();

  if (panePids.size === 0) return result;

  let ssOutput = '';
  try {
    const { stdout } = await execFileAsync('ss', ['-tlnp'], {
      timeout: SS_TIMEOUT,
    });
    ssOutput = stdout;
  } catch {
    // ss unavailable or failed — return empty ports for all panes
    for (const paneId of panePids.keys()) {
      result.set(paneId, []);
    }
    return result;
  }

  const allPorts = parseSsOutput(ssOutput);

  // Build process tree once, reuse for all PIDs
  const processTree = await buildProcessTree();

  for (const [paneId, pid] of panePids) {
    const descendants = getDescendantPids(pid, processTree);
    result.set(paneId, filterPortsForPid(allPorts, pid, descendants));
  }

  return result;
}
