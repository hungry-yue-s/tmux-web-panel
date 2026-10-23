import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configDirectory, resolveRuntimeConfig } from '../server/runtime-config.js';
import { hashPassword, initTokenPersistence, verifyPassword } from '../server/auth.js';
import { ManagedResources } from '../server/managed-resources.js';
import { enrollTotp, loadTotpSecret, totpFilePath } from '../server/totp.js';

const directories = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function temp() { const directory = mkdtempSync(join(tmpdir(), 'panel-runtime-')); directories.push(directory); return directory; }
function stored(overrides = {}) {
  const directory = temp();
  const path = join(directory, 'settings.json');
  const settings = { schemaVersion: 1, initialized: true, port: 17681, listenOnLAN: false,
    runtimePath: join(directory, 'runtime', 'build-1'), auth: { username: 'owner', ...hashPassword('local password') }, ...overrides };
  writeFileSync(path, JSON.stringify(settings), { mode: 0o600 });
  return { directory, path, settings };
}
function load(path, env = {}, extra = []) {
  return resolveRuntimeConfig({ argv: ['node', 'server/index.js', '--config', path, ...extra], env, home: '/legacy-user' });
}

describe('unified desktop runtime settings', () => {
  it('keeps source installations on their legacy defaults and honors existing CLI/environment precedence', () => {
    const config = resolveRuntimeConfig({ argv: ['node', 'index'], env: {}, home: '/legacy-user' });
    expect(config).toMatchObject({ port: 7681, host: '0.0.0.0', auth: null, httpPort: 80,
      configDir: '/legacy-user/.config/tmux-web-panel', managedRuntime: false, tokenFileName: 'tokens.json' });
    const overridden = resolveRuntimeConfig({ argv: ['node', 'index', '--port', '9002', '--auth', 'cli:password:with:colon'],
      env: { PORT: '9001', AUTH: 'env:other', HOST: '127.0.0.1' } });
    expect(overridden.port).toBe(9002);
    expect(overridden.authCredentials.username).toBe('cli');
    expect(overridden.tokenFileName).toBe('tokens.json');
    expect(verifyPassword('password:with:colon', overridden.authCredentials.salt, overridden.authCredentials.hash)).toBe(true);
  });

  it('uses the stored password hash directly and isolates mutable data beside the settings', () => {
    const { directory, path, settings } = stored();
    const config = load(path);
    expect(config).toMatchObject({ port: 17681, host: '127.0.0.1', configDir: directory, managedRuntime: true,
      runtimePath: settings.runtimePath, authCredentials: settings.auth, httpPort: null });
    expect(verifyPassword('local password', config.authCredentials.salt, config.authCredentials.hash)).toBe(true);
    expect(verifyPassword('wrong password', config.authCredentials.salt, config.authCredentials.hash)).toBe(false);
    expect(JSON.parse(readFileSync(path))).toEqual(settings);
  });

  it('keeps managed trusted devices across restarts but invalidates them after identity changes', () => {
    const { directory, path, settings } = stored();
    const original = load(path).tokenFileName;
    expect(original).toMatch(/^tokens\.[a-f\d]{32}\.json$/);
    expect(load(path).tokenFileName).toBe(original);
    for (const secret of [settings.auth.username, settings.auth.salt, settings.auth.hash, 'local password']) expect(original).not.toContain(secret);
    const oldTokenPath = join(directory, original);
    const oldTokens = JSON.stringify([['trusted-old-device', { expiresAt: null, trusted: true }]]);
    writeFileSync(oldTokenPath, oldTokens, { mode: 0o600 });
    const restarted = new Map();
    initTokenPersistence(restarted, join(directory, load(path).tokenFileName));
    expect(restarted.has('trusted-old-device')).toBe(true);

    // Network/runtime preferences do not change the login identity.
    writeFileSync(path, JSON.stringify({ ...settings, port: 18000, runtimePath: join(directory, 'runtime/build-2') }));
    expect(load(path).tokenFileName).toBe(original);
    for (const auth of [
      { ...settings.auth, username: 'new-owner' },
      { ...settings.auth, ...hashPassword('new local password') },
    ]) {
      writeFileSync(path, JSON.stringify({ ...settings, auth }));
      const changed = load(path).tokenFileName;
      expect(changed).not.toBe(original);
      expect(load(path).tokenFileName).toBe(changed);
      const reset = new Map();
      initTokenPersistence(reset, join(directory, changed));
      expect(reset.has('trusted-old-device')).toBe(false);
      expect(readFileSync(oldTokenPath, 'utf8')).toBe(oldTokens);
    }
  });

  it('keeps managed operator overrides stable without retaining tokens for a changed override', () => {
    const { path } = stored();
    const first = load(path, { AUTH: 'operator:override password' }).tokenFileName;
    expect(load(path, { AUTH: 'operator:override password' }).tokenFileName).toBe(first);
    expect(load(path, { AUTH: 'operator:different password' }).tokenFileName).not.toBe(first);
    expect(load(path).tokenFileName).not.toBe(first);
    expect(first).not.toContain('operator');
    expect(first).not.toContain('override password');
  });

  it('retains explicit operator overrides and selects HTTPS without a privileged redirect listener', () => {
    const { path, directory } = stored({ listenOnLAN: true, tls: { cert: 'tls/cert.pem', key: 'tls/key.pem' } });
    const config = load(path, { PORT: '20000', TMUX_PANEL_CONFIG_DIR: '/explicit-data' }, ['--port', '21000']);
    expect(config.port).toBe(21000);
    expect(config.configDir).toBe('/explicit-data');
    expect(config.host).toBe('0.0.0.0');
    expect(config.tls).toEqual({ cert: join(directory, 'tls/cert.pem'), key: join(directory, 'tls/key.pem') });
    expect(config.httpPort).toBeNull();
    expect(load(path, { HTTP_PORT: '17680' }).httpPort).toBe(17680);
  });

  it.each([
    { initialized: false }, { schemaVersion: 2 }, { port: 0 }, { port: 65536 },
    { auth: { username: 'owner', salt: 'bad', hash: 'bad' } },
    { auth: null }, { runtimePath: 'relative/path' }, { listenOnLAN: true },
  ])('rejects incomplete or unsafe desktop settings %j', overrides => {
    expect(() => load(stored(overrides).path)).toThrow();
  });

  it('only exposes the valid enabled public relay URL', () => {
    const relay = { enabled: true, pagesURL: 'https://example.github.io/relay/', duckdnsToken: 'private-token' };
    const config = load(stored({ relay }).path);
    expect(config.relayPage).toBe(relay.pagesURL);
    expect(JSON.stringify(config)).not.toContain('private-token');
    expect(load(stored({ relay: { ...relay, enabled: false } }).path).relayPage).toBe('');
    expect(() => load(stored({ relay: { ...relay, pagesURL: 'http://example.test/' } }).path)).toThrow('HTTPS');
  });

  it('resolves panel-owned state and MFA independently of the legacy home', () => {
    const directory = temp();
    expect(configDirectory({ home: '/legacy-user', env: { TMUX_PANEL_CONFIG_DIR: directory } })).toBe(directory);
    const path = totpFilePath(directory);
    const secret = enrollTotp(path);
    expect(loadTotpSecret(path)).toBe(secret);
    expect(loadTotpSecret(totpFilePath(join(directory, 'other')))).toBeNull();
    expect(() => resolveRuntimeConfig({ argv: ['node', 'index'], env: { TMUX_PANEL_MANAGED_RUNTIME: '1' } })).toThrow('--config');
    expect(() => load(stored().path, { PORT: 'invalid' })).toThrow('port');
  });
});

describe('bundled tmux management', () => {
  it('reports and edits its own runtime without rebuilding binaries or touching personal tmux config', async () => {
    const directory = temp();
    const configDir = join(directory, 'desktop-data');
    const runtimePath = join(directory, 'runtime', 'build-1');
    const personal = join(directory, '.tmux.conf');
    writeFileSync(personal, 'set -g status off\n');
    const spawnProcess = vi.fn();
    const execProcess = vi.fn(async () => ({ stdout: 'tmux bundled-version\n' }));
    const resources = new ManagedResources({ projectDir: directory, configDir, userHome: directory,
      runtimePath, packaged: true, spawnProcess, execProcess });
    await resources.load();
    const status = await resources.status();
    expect(status.runtime).toMatchObject({ path: join(runtimePath, 'bin/tmux'), buildSupported: false, rollbackSupported: false, packaged: true });
    expect(status.tmuxConfig).toMatchObject({ userPath: null, linkSupported: false, path: join(configDir, 'tmux.conf') });
    await expect(resources.linkConfig(true)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    await expect(resources.buildTmux()).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    await expect(resources.rollbackTmux()).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    await resources.saveConfig({ content: status.tmuxConfig.content + 'set -g status off\n', expectedContent: status.tmuxConfig.content });
    await resources.applyConfig();
    expect(execProcess).toHaveBeenCalledWith(join(runtimePath, 'bin/tmux'), ['source-file', join(configDir, 'tmux.conf')], { timeout: 5000 });
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(readFileSync(personal, 'utf8')).toBe('set -g status off\n');
  });
});
