/**
 * Node identity: what another panel needs to reach this machine's API.
 *
 * Every installation is a node. A hub (another panel) never runs commands on
 * the host; it opens an SSH port forward to the node's own HTTP(S) listener and
 * calls the same API the browser uses. To do that it needs three facts, written
 * to a fixed, owner-only pairing file the hub reads over SFTP:
 *
 *   port            where the node listens (reached through 127.0.0.1)
 *   token           a bearer secret accepted in place of a login token
 *   tlsFingerprint  the certificate to pin when the node serves HTTPS
 *
 * SFTP rather than a remote command keeps pairing independent of the login
 * shell (cmd.exe, PowerShell, fish and bash all answer differently).
 */

import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual, X509Certificate } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Bumped only for changes a hub cannot work around. */
export const NODE_PROTOCOL = 1;
const TOKEN_FILE = 'node-token';
const TOKEN_RE = /^[0-9a-f]{64}$/;

/** Fixed location, relative to the SSH login directory: `.config/tmux-web-panel/node.json`. */
export const PAIRING_RELATIVE_PATH = '.config/tmux-web-panel/node.json';

export function pairingFilePath(home = homedir()) {
  return join(home, ...PAIRING_RELATIVE_PATH.split('/'));
}

export function certificateFingerprint(pem) {
  return new X509Certificate(pem).fingerprint256;
}

/** Address a hub's port forward should target for a given listen host. */
export function loopbackFor(listenHost) {
  if (!listenHost || listenHost === '0.0.0.0' || listenHost === '127.0.0.1' || listenHost === 'localhost') return '127.0.0.1';
  if (listenHost === '::' || listenHost === '::1') return '::1';
  return listenHost;
}

/**
 * Windows ignores the mode bits, and a file under the profile inherits read
 * access for SYSTEM and Administrators; drop inheritance like chmod 600 would.
 */
function restrictOnWindows(path) {
  if (process.platform !== 'win32' || !process.env.USERNAME) return Promise.resolve();
  return new Promise((resolve) => {
    execFile('icacls', [path, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:(F)`], { windowsHide: true }, () => resolve());
  });
}

async function writePrivate(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, content, { mode: 0o600 });
  await chmod(temp, 0o600).catch(() => {});
  await restrictOnWindows(temp);
  await rename(temp, path);
}

/** Reuses the persisted token so a restart does not unpair every hub. */
export async function loadOrCreateNodeToken(configDir) {
  const path = join(configDir, TOKEN_FILE);
  try {
    const existing = (await readFile(path, 'utf8')).trim();
    if (TOKEN_RE.test(existing)) return existing;
  } catch {
    // First start: create below.
  }
  const token = randomBytes(32).toString('hex');
  await writePrivate(path, token + '\n');
  return token;
}

/**
 * Writes the pairing file and returns a checker for the node token. The token
 * is compared in constant time; anything that is not exactly 64 hex characters
 * is rejected before comparing.
 */
export async function initNodeIdentity({ configDir, port, listenHost, tlsCertPath = null, home = homedir() }) {
  const token = await loadOrCreateNodeToken(configDir);
  const pairing = {
    protocol: NODE_PROTOCOL,
    host: loopbackFor(listenHost),
    port,
    tls: Boolean(tlsCertPath),
    tlsFingerprint: tlsCertPath ? certificateFingerprint(await readFile(tlsCertPath, 'utf8')) : null,
    token,
  };
  const path = pairingFilePath(home);
  await writePrivate(path, JSON.stringify(pairing, null, 2) + '\n');
  const expected = Buffer.from(token);
  return {
    pairingPath: path,
    pairing,
    isNodeToken(candidate) {
      if (typeof candidate !== 'string' || !TOKEN_RE.test(candidate)) return false;
      return timingSafeEqual(Buffer.from(candidate), expected);
    },
  };
}

/** Validates a pairing file read from a remote host before anything uses it. */
export function parsePairing(text) {
  let data;
  try {
    data = JSON.parse(String(text));
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  if (!Number.isInteger(data.protocol) || data.protocol < 1) return null;
  if (!Number.isInteger(data.port) || data.port < 1 || data.port > 65535) return null;
  if (typeof data.token !== 'string' || !TOKEN_RE.test(data.token)) return null;
  if (data.host !== '127.0.0.1' && data.host !== '::1' && !/^[A-Za-z0-9.:-]{1,253}$/.test(String(data.host))) return null;
  const tls = data.tls === true;
  if (tls && !/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(String(data.tlsFingerprint))) return null;
  return {
    protocol: data.protocol,
    host: data.host,
    port: data.port,
    tls,
    tlsFingerprint: tls ? data.tlsFingerprint : null,
    token: data.token,
  };
}
