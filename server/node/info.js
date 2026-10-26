/**
 * GET /api/node/info: what this machine is and what it can do.
 *
 * The hub derives a server's whole status from this one call, so it must stay
 * cheap (one `tmux -V`) and must never fail just because tmux is missing.
 */

import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';

import { NODE_PROTOCOL } from './identity.js';

const PACKAGE_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || null;
  } catch {
    return null;
  }
})();

export function normalizeArch(arch) {
  if (arch === 'x64' || arch === 'x86_64' || arch === 'amd64') return 'x64';
  if (arch === 'arm64' || arch === 'aarch64') return 'arm64';
  return arch || null;
}

export function nodePlatform(platform = process.platform) {
  return platform === 'win32' ? 'windows' : platform;
}

/**
 * @param {object} deps
 * @param {() => Promise<string|null>} deps.tmuxVersion
 */
export async function collectNodeInfo({ tmuxVersion, platform = process.platform, arch = process.arch, host = hostname() }) {
  let version = null;
  let reason = null;
  try {
    version = await tmuxVersion();
    if (!version) reason = 'version_unparseable';
  } catch (err) {
    reason = err && err.code === 'ENOENT' ? 'command_not_found' : 'command_failed';
  }
  const windows = platform === 'win32';
  return {
    protocol: NODE_PROTOCOL,
    version: PACKAGE_VERSION,
    hostname: host || null,
    platform: nodePlatform(platform),
    arch: normalizeArch(arch),
    tmux: { available: Boolean(version), version, reason },
    capabilities: {
      metrics: { available: true, level: windows ? 'basic' : 'full' },
      files: { available: true },
      processStats: { available: !windows },
    },
  };
}
