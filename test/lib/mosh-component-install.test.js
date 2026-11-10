import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { InstallLog, NodeInstaller, posixInstallScript, windowsInstallWords } from '../../lib/hub/node-installer.js';
import { createNodeInstallRouter } from '../../lib/api/node-install.js';
import { MoshTerminals } from '../../lib/hub/mosh-terminal.js';
import { collectNodeInfo } from '../../lib/node/info.js';
import { createMoshRouter } from '../../lib/api/mosh.js';
import { HUB_CALL_HEADER } from '../../lib/hub/node-link.js';
import { MoshService } from '../../lib/mosh/server.js';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture({ platform = 'linux', output = '>> check\nTWP_COMPONENT_RESULT=ready\n', code = 0, onComponentInstalled = vi.fn() } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mosh-install-job-')); dirs.push(dir);
  mkdirSync(join(dir, 'scripts', 'remote'), { recursive: true });
  writeFileSync(join(dir, 'scripts/install-mosh.sh'), 'echo fixed-component\r\n');
  writeFileSync(join(dir, 'scripts/install-mosh.ps1'), 'param([string]$Role)\r\nWrite-Output component\r\n');
  writeFileSync(join(dir, 'scripts/remote/install-node.sh'), 'echo primary\n');
  mkdirSync(join(dir, 'vendor/tmux'), { recursive: true });
  writeFileSync(join(dir, 'vendor/tmux/tmux.c'), '');
  const stream = vi.fn(async (_words, options) => { options.onOutput(output); return code; });
  const connection = { stream, uploadFile: vi.fn() };
  const links = { connection: vi.fn(() => connection), detect: vi.fn(async () => ({ platform, posix: platform !== 'windows' })), recheck: vi.fn() };
  const registry = { require: vi.fn(() => ({ id: 'local', kind: 'local' })) };
  const localStream = vi.fn(async (_words, options) => { options.onOutput(output); return code; });
  const pack = vi.fn();
  const installer = new NodeInstaller({ links, registry, projectDir: dir, localStream, platform, onComponentInstalled, pack });
  return { installer, links, registry, stream, localStream, pack, connection, onComponentInstalled };
}
async function finished(installer, id = 'box') {
  await vi.waitFor(() => expect(installer.status(id).finishedAt).toBeTruthy());
  return installer.status(id);
}

describe('fixed Mosh component jobs', () => {
  it('repairs only the remote component, sends a quoted password on stdin and preserves links', async () => {
    const f = fixture();
    f.installer.startComponent('box', { sudoPassword: "p'a$(echo hi)" });
    expect(await finished(f.installer)).toMatchObject({ state: 'succeeded', operation: 'mosh', result: 'ready', skipMosh: false });
    const [words, options] = f.stream.mock.calls[0];
    expect(words).toEqual(['sh', '-s']);
    expect(options.input).toContain('TWP_MOSH_ROLE=server\n');
    expect(options.input).toContain("TWP_SUDO_PASSWORD='p'\\''a$(echo hi)'");
    expect(f.pack).not.toHaveBeenCalled();
    expect(f.connection.uploadFile).not.toHaveBeenCalled();
    expect(f.links.recheck).not.toHaveBeenCalled();
    expect(f.onComponentInstalled).toHaveBeenCalledWith('box');
    expect(JSON.stringify(f.installer.status('box'))).not.toContain('echo hi');
  });

  it('runs local client and server preparation without making an SSH connection', async () => {
    const f = fixture({ platform: 'darwin' });
    f.installer.startComponent('local');
    expect((await finished(f.installer, 'local')).state).toBe('succeeded');
    expect(f.localStream.mock.calls[0][1].input).toContain('TWP_MOSH_ROLE=both');
    expect(f.links.connection).not.toHaveBeenCalled();
    expect(f.registry.require).toHaveBeenCalledWith('local');
  });

  it('wraps a Windows param block in its own scope, never sends a sudo password there', async () => {
    const f = fixture({ platform: 'windows' });
    f.installer.startComponent('box', { sudoPassword: 'unused-secret' });
    expect((await finished(f.installer)).state).toBe('succeeded');
    const [words, options] = f.stream.mock.calls[0];
    const decoded = Buffer.from(words.at(-1), 'base64').toString('utf16le');
    expect(words[0]).toBe('powershell');
    expect(words.slice(1, 5)).toEqual(['-InputFormat', 'Text', '-OutputFormat', 'Text']);
    expect(decoded).toContain('[Console]::In.ReadToEnd()');
    expect(words.join(' ').length).toBeLessThan(2000);
    expect(options.input).toContain('& {\nparam(');
    expect(options.input).toContain('} -Role server');
    expect(decoded).not.toContain('unused-secret');
    expect(options.input).not.toContain('unused-secret');
  });

  it.each(['needs_password', 'maintenance_required', 'unsupported'])('keeps %s distinct from success and retryable without a reinstall', async (state) => {
    const f = fixture({ output: `TWP_COMPONENT_REASON=reason_code\nTWP_COMPONENT_RESULT=${state}\n`, code: 1 });
    f.installer.startComponent('box');
    expect(await finished(f.installer)).toMatchObject({ state, result: state, component: { reason: 'reason_code' } });
    expect(f.onComponentInstalled).not.toHaveBeenCalled();
  });

  it.each([[0, ''], [1, 'TWP_COMPONENT_RESULT=ready\n']])('does not invent success from exit %s or a contradictory marker', async (code, output) => {
    const f = fixture({ code, output }); f.installer.startComponent('box');
    expect((await finished(f.installer)).state).toBe('failed');
  });

  it('keeps a job running while its post-install capability refresh completes', async () => {
    let release;
    const f = fixture({ onComponentInstalled: vi.fn(() => new Promise(r => { release = r; })) });
    f.installer.startComponent('box');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(f.installer.status('box').state).toBe('running');
    expect(() => f.installer.start('box')).toThrow(expect.objectContaining({ code: 'SERVER_IN_USE' }));
    release();
    expect((await finished(f.installer)).state).toBe('succeeded');
  });

  it('does not undo component success if a later health refresh is unavailable', async () => {
    const f = fixture({ onComponentInstalled: vi.fn(async () => { throw Error('offline'); }) });
    f.installer.startComponent('box');
    expect((await finished(f.installer)).state).toBe('succeeded');
  });

  it('does not apply an old target result to a reconfigured server or interrupt its package transaction', async () => {
    const f = fixture(); let complete;
    f.stream.mockImplementation((_words, options) => new Promise(resolve => {
      complete = () => { options.onOutput('TWP_COMPONENT_RESULT=ready\n'); resolve(0); };
    }));
    f.installer.startComponent('box');
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    f.links.connection.mockReturnValue({ stream: vi.fn() });
    expect(f.installer.status('box').state).toBe('running');
    complete();
    const status = await finished(f.installer);
    expect(status.state).toBe('failed');
    expect(status.error.message).toContain('配置已变化');
    expect(f.onComponentInstalled).not.toHaveBeenCalled();
    expect(f.links.recheck).not.toHaveBeenCalled();
  });

  it('passes the explicit optional-install choice through both platform installers', () => {
    expect(posixInstallScript('body', { skipMosh: true })).toContain('TWP_SKIP_MOSH=1\n');
    expect(Buffer.from(windowsInstallWords('body', { skipMosh: true }).at(-1), 'base64').toString('utf16le'))
      .toContain("$env:TWP_SKIP_MOSH = '1'");
  });

  it('parses component warnings separately from a successful primary Node install and redacts split secrets', () => {
    const log = new InstallLog();
    log.write('>> sec', 'secret'); log.write('ret\nTWP_COMPONENT_REASON=offline\nTWP_COMPONENT_RESULT=failed\nTWP_RESULT=succeeded\n', 'secret');
    log.end('secret');
    expect(log.result).toBe('succeeded');
    expect(log.component).toEqual({ reason: 'offline', result: 'failed' });
    expect(log.lines).toEqual(['>> [redacted]']);
  });

  it.each(['e', 'ready', 'succeeded'])('keeps public result enums intact when a password is %s', (password) => {
    const log = new InstallLog();
    log.write(`>> private ${password}\nTWP_COMPONENT_RESULT=ready\nTWP_RESULT=succeeded\n`, password);
    log.end(password);
    expect(log.component.result).toBe('ready');
    expect(log.result).toBe('succeeded');
    expect(log.lines[0]).toContain('[redacted]');
  });

  it('keeps the core Node installation successful when the optional component fails', async () => {
    const f = fixture({ output: 'TWP_COMPONENT_REASON=offline\nTWP_COMPONENT_RESULT=failed\nTWP_RESULT=succeeded\n' });
    f.installer.start('box');
    expect(await finished(f.installer)).toMatchObject({ state: 'succeeded', operation: 'node', component: { result: 'failed', reason: 'offline' } });
    expect(f.onComponentInstalled).not.toHaveBeenCalled();
  });

  it('redacts a credential split across log chunks and an error without retaining it in status', async () => {
    const f = fixture();
    f.stream.mockImplementation(async (_words, options) => {
      options.onOutput('>> sec'); options.onOutput('ret\n'); throw Error('failed secret');
    });
    f.installer.startComponent('box', { sudoPassword: 'secret' });
    const status = await finished(f.installer);
    expect(status.state).toBe('failed');
    expect(JSON.stringify(status)).not.toContain('secret');
    expect(status.log).toContain('>> [redacted]');
  });
});

describe('component API boundary', () => {
  function api() {
    const installer = { status: vi.fn(() => ({ state: 'running', operation: 'mosh' })), start: vi.fn(() => ({ state: 'running' })), startComponent: vi.fn(() => ({ state: 'running', operation: 'mosh' })) };
    const app = express(); app.use(express.json()); app.use('/api/servers', createNodeInstallRouter({ installer }));
    return { app, installer };
  }
  it('exposes a fixed component endpoint for local and remote, with a shared status', async () => {
    const { app, installer } = api();
    await request(app).post('/api/servers/local/components/mosh/install').send({ sudoPassword: 'pw' }).expect(202);
    expect(installer.startComponent).toHaveBeenCalledWith('local', { sudoPassword: 'pw' });
    await request(app).get('/api/servers/local/components/mosh/install').expect(200);
    await request(app).post('/api/servers/local/components/arbitrary/install').send({}).expect(404);
  });
  it('validates choices and credentials and rejects cross-origin writes before starting anything', async () => {
    const { app, installer } = api();
    await request(app).post('/api/servers/box/node/install').send({ skipMosh: 'yes' }).expect(400);
    await request(app).post('/api/servers/box/components/mosh/install').send({ sudoPassword: 'a\nb' }).expect(400);
    await request(app).post('/api/servers/box/components/mosh/install').set('Origin', 'https://untrusted.test').send({}).expect(403);
    expect(installer.startComponent).not.toHaveBeenCalled();
    await request(app).post('/api/servers/box/node/install').send({ skipMosh: true }).expect(202);
    expect(installer.start).toHaveBeenCalledWith('box', { sudoPassword: '', skipMosh: true });
  });
  it('allows cache refresh only for the trusted node-token Hub mark', async () => {
    const refresh = vi.fn(async () => ({ server: { available: true } }));
    const app = express(); app.use('/api/mosh', createMoshRouter({ mosh: {}, isNodeToken: t => t === 'node', refreshComponents: refresh }));
    await request(app).post('/api/mosh/components/refresh').set('Authorization', 'Bearer node').expect(403);
    await request(app).post('/api/mosh/components/refresh').set('Authorization', 'Bearer login').set(HUB_CALL_HEADER, '1').expect(403);
    await request(app).post('/api/mosh/components/refresh').set('Authorization', 'Bearer node').set(HUB_CALL_HEADER, '1').expect(200);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('client component capability', () => {
  it('explicitly refreshes a stale server capability once without touching sessions', async () => {
    let installed = false;
    const find = vi.fn(() => installed ? '/fake/server' : null);
    const m = new MoshService({ workspace: {}, terminalManager: {}, platform: 'linux', find,
      execFileImpl: (_file, _args, _options, done) => done(null, 'mosh-server (mosh 1.4.0)', '') });
    expect(await m.capability()).toMatchObject({ available: false });
    installed = true;
    const result = await Promise.all([m.refreshCapability(), m.refreshCapability()]);
    expect(result.every(r => r.available)).toBe(true);
    expect(find).toHaveBeenCalledTimes(2);
    expect(m.sessions.size).toBe(0);
  });
  it('verifies the executable, coalesces checks and can refresh a stale negative result', async () => {
    let now = 0, installed = false;
    const exec = vi.fn((_file, _args, _options, callback) => callback(installed ? null : Error('bad'), installed ? 'mosh-client (mosh 1.4.0)' : '', ''));
    const m = new MoshTerminals({ registry: {}, links: {}, wss: {}, client: { available: true, path: '/fake' }, now: () => now, execFileImpl: exec });
    const first = m.clientCapability();
    expect(m.clientCapability()).toBe(first);
    expect(await first).toMatchObject({ available: false, reason: 'mosh_client_unusable' });
    installed = true; now = 30_001;
    expect(await m.clientCapability()).toEqual({ available: true, version: '1.4.0', reason: null });
    expect(exec).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(await m.clientCapability())).not.toContain('/fake');
  });
  it('exposes both roles without paths, and tolerates a missing client probe', async () => {
    const info = await collectNodeInfo({ tmuxVersion: async () => '3.8', mosh: async () => ({ available: true, version: '1.4.0', path: '/secret' }),
      moshClient: async () => ({ available: false, version: null, reason: 'client_platform', path: '/secret' }) });
    expect(info.capabilities.moshClient).toEqual({ available: false, version: null, reason: 'client_platform' });
    expect(JSON.stringify(info.capabilities)).not.toContain('/secret');
  });
});
