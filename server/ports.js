import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile } from 'node:fs/promises';

const execFileAsync = promisify(execFile);

const PORT_RANGE_MIN = 1024;
const PORT_RANGE_MAX = 65535;
const SS_TIMEOUT = 5000;

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
 * Walks /proc to find all descendant PIDs of the given PID.
 *
 * @param {number} pid - root PID to find descendants for
 * @returns {Promise<Set<number>>} set of all descendant PIDs
 */
export async function getDescendantPids(pid) {
  const descendants = new Set();

  try {
    const entries = await readdir('/proc');
    // Build parent → children map
    const children = new Map();

    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;

      try {
        const statContent = await readFile(`/proc/${entry}/stat`, 'utf8');
        // Format: pid (comm) state ppid ...
        // comm may contain spaces and parentheses, so match from the end of closing paren
        const statMatch = statContent.match(/^\d+ \(.*?\) \S+ (\d+)/);
        if (!statMatch) continue;

        const childPid = Number(entry);
        const parentPid = Number(statMatch[1]);

        if (!children.has(parentPid)) {
          children.set(parentPid, []);
        }
        children.get(parentPid).push(childPid);
      } catch {
        // Process may have exited — skip
      }
    }

    // BFS to collect all descendants
    const queue = [pid];
    while (queue.length > 0) {
      const current = queue.shift();
      const kids = children.get(current) || [];
      for (const child of kids) {
        if (!descendants.has(child)) {
          descendants.add(child);
          queue.push(child);
        }
      }
    }
  } catch {
    // /proc not available or permission error — return empty set
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

  // Gather all unique PIDs to look up descendants for
  const uniquePids = new Set(panePids.values());
  const descendantMap = new Map();

  await Promise.all(
    [...uniquePids].map(async (pid) => {
      const descendants = await getDescendantPids(pid);
      descendantMap.set(pid, descendants);
    }),
  );

  for (const [paneId, pid] of panePids) {
    const descendants = descendantMap.get(pid) || new Set();
    result.set(paneId, filterPortsForPid(allPorts, pid, descendants));
  }

  return result;
}
