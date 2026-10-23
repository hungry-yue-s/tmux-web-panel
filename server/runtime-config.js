import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { hashPassword } from './auth.js';

export function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--') && i + 1 < argv.length) args[argv[i].slice(2)] = argv[++i];
  }
  return args;
}

/** Panel-owned state only; third-party Agent settings remain in their own homes. */
export function configDirectory({ configDir, home = homedir(), env = process.env } = {}) {
  return resolve(configDir || env.TMUX_PANEL_CONFIG_DIR || join(home, '.config', 'tmux-web-panel'));
}

function storedSettings(path) {
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error('Cannot read desktop settings; reopen Settings and Runtime Status to repair them.'); }
  if (!value || value.schemaVersion !== 1 || value.initialized !== true || !Number.isInteger(value.port)
    || value.port < 1 || value.port > 65535 || typeof value.listenOnLAN !== 'boolean'
    || typeof value.runtimePath !== 'string' || !isAbsolute(value.runtimePath)) {
    throw new Error('Desktop settings are incomplete or unsupported; run the client initialization again.');
  }
  const auth = value.auth;
  if (!auth || typeof auth.username !== 'string' || !auth.username.trim()
    || /[\x00-\x1f\x7f]/.test(auth.username) || !/^[a-f\d]{32}$/i.test(auth.salt || '')
    || !/^[a-f\d]{128}$/i.test(auth.hash || '')) {
    throw new Error('Desktop login credentials are missing or invalid; create an account in the client.');
  }
  if (value.tls && (typeof value.tls.cert !== 'string' || !value.tls.cert || typeof value.tls.key !== 'string' || !value.tls.key)) {
    throw new Error('Desktop HTTPS settings require both a certificate and private key.');
  }
  if (value.listenOnLAN && !value.tls) throw new Error('Enable local HTTPS before allowing access from other devices.');
  return value;
}

export function resolveRuntimeConfig({ argv = process.argv, env = process.env, home = homedir() } = {}) {
  const args = parseArgs(argv);
  const settingsPath = args.config ? resolve(args.config) : null;
  if (env.TMUX_PANEL_MANAGED_RUNTIME === '1' && !settingsPath) throw new Error('A desktop runtime requires an explicit --config settings file.');
  const settings = settingsPath ? storedSettings(settingsPath) : null;
  const configDir = configDirectory({ configDir: env.TMUX_PANEL_CONFIG_DIR || (settingsPath && dirname(settingsPath)), home, env });
  const legacyAuth = args.auth ?? env.AUTH ?? null;
  let authCredentials = settings?.auth || null;
  if (legacyAuth) {
    const split = legacyAuth.indexOf(':');
    authCredentials = { username: legacyAuth.slice(0, split), ...hashPassword(legacyAuth.slice(split + 1)) };
  }
  const cert = args['tls-cert'] ?? env.TLS_CERT ?? (settings?.tls?.cert ? resolve(dirname(settingsPath), settings.tls.cert) : null);
  const key = args['tls-key'] ?? env.TLS_KEY ?? (settings?.tls?.key ? resolve(dirname(settingsPath), settings.tls.key) : null);
  if (settings && Boolean(cert) !== Boolean(key)) throw new Error('Both HTTPS certificate and private key are required.');
  let relayPage = '';
  if (settings?.relay?.enabled && settings.relay.pagesURL) {
    try {
      const url = new URL(settings.relay.pagesURL);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new Error();
      relayPage = url.href;
    } catch { throw new Error('The relay URL must be a complete HTTPS website address without credentials or a fragment.'); }
  }
  const httpPortValue = args['http-port'] ?? env.HTTP_PORT ?? (settings ? null : 80);
  const port = Number(args.port ?? env.PORT ?? settings?.port ?? 7681);
  if (settings && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('The panel port must be an integer between 1 and 65535.');
  // Bind persisted devices to the managed identity, including stable operator
  // overrides. Rehashing a raw override uses a random salt on each restart.
  const tokenFileName = settings ? 'tokens.' + createHash('sha256')
    .update(JSON.stringify([settings.auth.username, settings.auth.salt, settings.auth.hash, legacyAuth || null]))
    .digest('hex').slice(0, 32) + '.json' : 'tokens.json';
  return Object.freeze({
    port,
    host: args.host ?? env.HOST ?? (settings ? (settings.listenOnLAN ? '0.0.0.0' : '127.0.0.1') : '0.0.0.0'),
    auth: legacyAuth || settings?.auth || null,
    authCredentials,
    pollInterval: Number(args['poll-interval'] ?? env.POLL_INTERVAL ?? 3000),
    maxConnections: Number(args['max-connections'] ?? env.MAX_CONNECTIONS ?? 5),
    tls: cert && key ? { cert, key } : null,
    httpPort: httpPortValue === null ? null : Number(httpPortValue),
    configDir, settingsPath, managedRuntime: !!settings, tokenFileName,
    runtimePath: settings?.runtimePath || null, relayPage,
  });
}
