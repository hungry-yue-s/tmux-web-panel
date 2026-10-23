import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { networkInterfaces, tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createServer } from 'node:net';
import { DesktopRuntime, isPortAvailable, validateSettings } from '../scripts/desktop-runtime.mjs';
import { verifyPassword } from '../server/auth.js';

const cleanups = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
async function freePort() {
  const server = createServer();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise(done => server.close(done));
  return port;
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'tmux-desktop-unit-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const bundle = join(dir, '客户端 & bundle'), home = join(dir, '测试 & user');
  await mkdir(join(bundle, 'bin'), { recursive: true }); await mkdir(join(bundle, 'app/server'), { recursive: true });
  for (const p of ['bin/node', 'bin/tmux', 'app/server/index.js']) await writeFile(join(bundle, p), 'fixture', { mode: 0o755 });
  await writeFile(join(bundle, 'manifest.json'), JSON.stringify({ buildId: 'unit-test', arch: process.arch, nodeVersion: 'v24-test', tmuxVersion: 'test', tmuxSourceCommit: 'a'.repeat(40) }));
  await mkdir(join(bundle, 'app/public/js'), { recursive: true });
  await cp('relay', join(bundle, 'app/relay'), { recursive: true });
  await cp('public/js/theme.js', join(bundle, 'app/public/js/theme.js'));
  const loaded = new Set(), calls = [];
  const run = vi.fn(async (file, args) => {
    calls.push([file, args]);
    if (file.endsWith('/bin/tmux') && args[0] === 'show-options') return { stdout: 'off\n' };
    if (file !== '/bin/launchctl') throw new Error('Unexpected subprocess in isolated fixture');
    if (args[0] === 'print') {
      if (!loaded.has(args[1].split('/').at(-1))) throw new Error('not loaded');
      return { stdout: 'state = running' };
    }
    if (args[0] === 'bootstrap') loaded.add(basename(args[2], '.plist'));
    if (args[0] === 'bootout') loaded.delete(args[1].split('/').at(-1));
    return { stdout: '' };
  });
  const manager = new DesktopRuntime({ dataDir: join(home, 'Application Support/工作台'), runtimePath: bundle,
    username: '新用户', password: 'test-password-2026', port: 0, launchAtLogin: false }, { run, home });
  cleanups.push(() => rm(manager.socketRoot, { recursive: true, force: true }));
  manager.certificates = vi.fn(async () => {
    const path = join(manager.root, 'tls'); await mkdir(path, { recursive: true });
    for (const p of ['cert.pem', 'key.pem', 'ca.crt', 'ca.key']) await writeFile(join(path, p), 'fixture-' + p, { mode: 0o600 });
    const ips = [...new Set(Object.values(networkInterfaces()).flat().filter(a => a && !a.internal && a.family === 'IPv4' && !a.address.startsWith('169.254.')).map(a => a.address))];
    await writeFile(join(path, '.addresses.json'), JSON.stringify(['127.0.0.1', ...ips]));
    return { cert: join(path, 'cert.pem'), key: join(path, 'key.pem'), ca: join(path, 'ca.crt') };
  });
  manager.certificateStatus = async () => ({ valid: true, addressesCurrent: true });
  manager.request = vi.fn(async (_config, path) => path === '/login.html' ? { status: 200 } : { status: 200, data: { success: true, data: { token: 'only-once-session' } } });
  // Reserve a currently free nonprivileged port without choosing a live service.
  manager.input.port = await freePort();
  return { manager, dir, bundle, home, loaded, calls };
}

describe('desktop settings and lifecycle', () => {
  it('validates novice inputs and hashes passwords instead of storing plaintext', () => {
    expect(() => validateSettings({})).toThrow('密码');
    expect(() => validateSettings({ password: 'short' })).toThrow('8');
    expect(() => validateSettings({ password: 'valid-password', port: 80 })).toThrow('端口');
    const settings = validateSettings({ password: 'valid-password', relay: { domain: 'MyBox.duckdns.org', pagesURL: 'https://example.github.io/panel' } });
    expect(settings.listenOnLAN).toBe(false);
    expect(settings.port).toBe(17681);
    expect(verifyPassword('valid-password', settings.auth.salt, settings.auth.hash)).toBe(true);
    expect(JSON.stringify(settings)).not.toContain('valid-password');
    expect(settings.relay.domain).toBe('mybox');
    expect(settings.relay.pagesURL).toBe('https://example.github.io/panel/');
    expect(() => validateSettings({ password: 'valid-password', relay: { pagesURL: 'javascript:alert(1)' } })).toThrow('HTTPS');
  });

  it('inspects without creating configuration or leaking stored secrets', async () => {
    const { manager } = await fixture();
    const report = await manager.execute('inspect');
    expect(report.configuration.initialized).toBe(false);
    expect(report.status.runtimeAvailable).toBe(true);
    await expect(stat(manager.root)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.stringify(report)).not.toContain('test-password-2026');
    expect(manager.label).not.toBe('com.tmux-web-panel');
    expect(Buffer.byteLength(join(manager.socketRoot, 'tmux-501/default'))).toBeLessThan(100);
  });

  it('returns JSON when the CLI is invoked through a symlink', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tmux-desktop-cli-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const script = join(directory, 'helper.mjs'), dataDir = join(directory, 'not-created');
    await symlink(fileURLToPath(new URL('../scripts/desktop-runtime.mjs', import.meta.url)), script);
    const result = spawnSync(process.execPath, [script, 'inspect'], {
      input: JSON.stringify({ dataDir }), encoding: 'utf8', timeout: 20000,
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).configuration.initialized).toBe(false);
    await expect(stat(dataDir)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 25000);

  it.skipIf(process.platform !== 'darwin')('initializes only its own launchd services and preserves tmux while applying pending settings', async () => {
    const { manager, home, loaded, calls } = await fixture();
    const result = await manager.execute('initialize');
    expect(result.ok).toBe(true);
    expect(result.sessionToken).toBe('only-once-session');
    expect(result.status.panelState).toBe('running');
    expect(result.requiresRestart).toBe(false);
    const saved = JSON.parse(await readFile(manager.paths.configuration, 'utf8'));
    expect(saved.auth.username).toBe('新用户');
    expect(verifyPassword('test-password-2026', saved.auth.salt, saved.auth.hash)).toBe(true);
    expect((await stat(manager.paths.configuration)).mode & 0o777).toBe(0o600);
    expect(saved.runtimePath).toContain('/runtime/unit-test');
    expect(calls.filter(([, args]) => args[0] === 'bootstrap')).toHaveLength(2);
    const file = await readFile(join(manager.root, 'launchd', manager.label + '.plist'), 'utf8');
    expect(file).toContain('&amp;');
    expect(file).toContain('TMUX_TMPDIR');
    expect(file).toContain('TERMINFO_DIRS');
    expect(file).not.toContain('test-password-2026');
    await expect(stat(join(home, '.tmux.conf'))).rejects.toMatchObject({ code: 'ENOENT' });
    const before = manager.certificates.mock.calls.length;
    manager.input = { ...manager.input, password: '', port: await freePort(), listenOnLAN: true, relay: { duckdnsToken: 'secret-dns-token' } };
    const pending = await manager.execute('save');
    expect(manager.certificates).toHaveBeenCalledTimes(before);
    expect(pending.requiresRestart).toBe(true);
    expect(pending.status.endpoint).toContain(':' + saved.port + '/');
    expect(JSON.stringify(pending)).not.toContain('secret-dns-token');
    expect(JSON.stringify(pending)).not.toContain(saved.auth.hash);
    const run = manager.run;
    let retiring = false, staleReads = 2;
    manager.run = async (file, args, options) => {
      if (args[0] === 'print' && args[1].endsWith('/' + manager.label) && retiring && staleReads > 0) {
        staleReads--;
        return { stdout: 'state = running' };
      }
      const result = await run(file, args, options);
      if (args[0] === 'bootout') retiring = true;
      return result;
    };
    await manager.execute('restart');
    expect(staleReads).toBe(0);
    expect(loaded.has(manager.label)).toBe(true);
    manager.run = run;
    const bootouts = calls.filter(([, args]) => args[0] === 'bootout');
    expect(bootouts.every(([, args]) => args[1].endsWith('/' + manager.label))).toBe(true);
    await manager.execute('stop');
    expect(loaded.has(manager.tmuxLabel)).toBe(true);
    expect(loaded.has(manager.label)).toBe(false);
    expect(JSON.stringify(calls)).not.toContain('kill-server');
  });

  it.skipIf(process.platform !== 'darwin')('rejects an occupied port before registering anything', async () => {
    const { manager, calls } = await fixture();
    const s = createServer(); await new Promise(done => s.listen(0, '127.0.0.1', done));
    cleanups.push(() => new Promise(done => s.close(done)));
    manager.input.port = s.address().port;
    expect(await isPortAvailable(manager.input.port)).toBe(false);
    await expect(manager.execute('initialize')).rejects.toMatchObject({ code: 'PORT_IN_USE' });
    expect(calls.some(([, args]) => args[0] === 'bootstrap')).toBe(false);
  });

  it.skipIf(process.platform !== 'darwin')('keeps failed initialization in the wizard and accepts corrected inputs on retry', async () => {
    const { manager } = await fixture();
    const wait = manager.waitForPanel.bind(manager);
    manager.waitForPanel = vi.fn().mockRejectedValueOnce(new Error('fixture startup failed')).mockImplementation(wait);
    await expect(manager.execute('initialize')).rejects.toMatchObject({ code: 'SETUP_FAILED' });
    expect((await manager.inspect()).configuration.initialized).toBe(false);
    manager.input = { ...manager.input, username: 'corrected', password: 'corrected-password' };
    const result = await manager.execute('initialize');
    expect(result.configuration.initialized).toBe(true);
    const saved = JSON.parse(await readFile(manager.paths.configuration, 'utf8'));
    expect(saved.auth.username).toBe('corrected');
    expect(verifyPassword('corrected-password', saved.auth.salt, saved.auth.hash)).toBe(true);
  }, 15000);

  it.skipIf(process.platform !== 'darwin')('reports a refused stop rather than claiming the service stopped', async () => {
    const { manager } = await fixture();
    await manager.execute('initialize');
    const original = manager.run;
    manager.run = async (file, args, options) => {
      if (file === '/bin/launchctl' && args[0] === 'bootout') throw new Error('fixture refusal');
      return original(file, args, options);
    };
    await expect(manager.execute('stop')).rejects.toMatchObject({ code: 'SERVICE_STOP_FAILED' });
  });

  it.skipIf(process.platform !== 'darwin')('keeps the running certificate pin when applying a renewed certificate fails before restart', async () => {
    const { manager } = await fixture();
    const initialized = await manager.execute('initialize');
    const saved = JSON.parse(await readFile(manager.paths.configuration, 'utf8'));
    manager.certificates.mockResolvedValue({ ...saved.tls, cert: join(manager.root, 'tls/renewed.pem') });
    manager.waitForTmux = vi.fn().mockRejectedValue(new Error('fixture tmux not ready'));
    await expect(manager.execute('restart')).rejects.toMatchObject({ code: 'SETUP_FAILED' });
    const current = await manager.inspect();
    expect(current.status.panelState).toBe('running');
    expect(current.status.endpoint).toBe(initialized.status.endpoint);
    expect(current.paths.tlsCertificate).toBe(saved.tls.cert);
    expect(current.requiresRestart).toBe(true);
  });

  it.skipIf(process.platform !== 'darwin')('updates compatible components without restarting tmux and rolls back a failed update', async () => {
    const { manager, bundle, calls, loaded } = await fixture();
    await manager.execute('initialize');
    const old = JSON.parse(await readFile(manager.paths.configuration, 'utf8'));
    const manifest = JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8'));
    await writeFile(join(bundle, 'manifest.json'), JSON.stringify({ ...manifest, buildId: 'updated-app' }));
    expect((await manager.inspect()).status.runtimeUpdateAvailable).toBe(true);
    const updated = await manager.execute('repair');
    expect(updated.requiresRestart).toBe(false);
    const current = JSON.parse(await readFile(manager.paths.configuration, 'utf8'));
    expect(current.runtimePath).not.toBe(old.runtimePath);
    expect(current.auth).toEqual(old.auth);
    expect(loaded.has(manager.tmuxLabel)).toBe(true);
    expect(calls.filter(([, args]) => args[0] === 'bootout').every(([, args]) => !args[1].endsWith('/' + manager.tmuxLabel))).toBe(true);
    const wait = manager.waitForPanel.bind(manager);
    manager.waitForPanel = vi.fn().mockRejectedValueOnce(new Error('bad update')).mockImplementation(wait);
    await expect(manager.execute('repair')).rejects.toMatchObject({ code: 'RUNTIME_UPDATE_FAILED' });
    expect(JSON.parse(await readFile(manager.paths.configuration, 'utf8')).runtimePath).toBe(current.runtimePath);
    expect(loaded.has(manager.tmuxLabel)).toBe(true);
    await writeFile(join(bundle, 'manifest.json'), JSON.stringify({ ...manifest, buildId: 'different-engine', tmuxSourceCommit: 'b'.repeat(40) }));
    await expect(manager.execute('repair')).rejects.toMatchObject({ code: 'TMUX_MIGRATION_REQUIRED' });
  }, 20000);

  it('rejects a runtime whose binary is readable but not executable', async () => {
    const { manager, bundle } = await fixture();
    await chmod(join(bundle, 'bin/tmux'), 0o600);
    await expect(manager.manifest(bundle)).rejects.toMatchObject({ code: 'RUNTIME_MISSING' });
  });

  it.skipIf(process.platform !== 'darwin')('exports only public relay assets and requires saved changes to be applied first', async () => {
    const { manager } = await fixture();
    await manager.execute('initialize');
    manager.input = { ...manager.input, password: '', listenOnLAN: true,
      relay: { enabled: true, domain: 'mybox', pagesURL: 'https://example.github.io/panel/', duckdnsToken: 'do-not-publish' } };
    await manager.execute('save');
    await expect(manager.execute('export-relay')).rejects.toMatchObject({ code: 'APPLY_REQUIRED' });
    await manager.execute('restart');
    const result = await manager.execute('export-relay');
    expect(result.ok).toBe(true);
    const names = await readdir(manager.paths.relaySite);
    expect(names.sort()).toEqual(['ca.crt', 'index.html', 'preview.html', 'relay.js', 'robots.txt', 'theme.js', 'themes.html']);
    for (const name of names) expect(await readFile(join(manager.paths.relaySite, name), 'utf8')).not.toContain('do-not-publish');
    expect(await readFile(join(manager.paths.relaySite, 'preview.html'), 'utf8')).not.toContain('src="relay.js"');
  });
});
