import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readFile, writeFile, mkdir, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import express from 'express';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PluginManager } from '../server/plugins.js';
import { createPluginsRouter } from '../server/api/plugins.js';
import { ManagedResources } from '../server/managed-resources.js';
import { tokenAuth } from '../server/auth.js';

const cleanup = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function temp() { const dir = await mkdtemp(join(tmpdir(), 'panel-plugins-')); cleanup.push(() => rm(dir, { recursive: true, force: true })); return dir; }

describe('panel plugin lifecycle and MCP', () => {
  it('installs a real package, persists state, serves MCP, gates disabled/uninstalled tools and preserves job data', async () => {
    const configDir = await temp();
    const deps = { serverService: { list: async () => ({ servers: [{ id: 'local' }] }) } };
    const make = () => new PluginManager({ configDir, catalogDir: resolve('plugins'), dependencies: deps });
    let manager = make(); await manager.load();
    expect((await manager.list())[0].installed).toBe(false);
    await manager.change('tmux-agent', 'install');
    expect(await readFile(join(manager.path('tmux-agent'), 'server.mjs'), 'utf8')).toContain('createPlugin');
    manager = make(); await manager.load();
    expect((await manager.list())[0].enabled).toBe(true);

    const app = express(); app.use(express.json()); app.use('/api/plugins', createPluginsRouter(manager));
    const server = app.listen(0, '127.0.0.1'); await new Promise((r) => server.once('listening', r));
    cleanup.push(() => new Promise((r) => server.close(r)));
    const client = new Client({ name: 'test', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/api/plugins/tmux-agent/mcp`));
    await client.connect(transport); cleanup.push(() => client.close());
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['start_command', 'send_task', 'workspace']));
    const result = await client.callTool({ name: 'list_servers', arguments: {} });
    expect(JSON.parse(result.content[0].text).servers[0].id).toBe('local');
    const bad = await client.callTool({ name: 'read_pane', arguments: { paneId: 'bad' } });
    expect(bad.isError).toBe(true);
    const connection = await request(app).get('/api/plugins/tmux-agent/connection');
    expect(connection.body.data.config.mcpServers['tmux-agent'].url).toContain('/api/plugins/tmux-agent/mcp');
    expect(JSON.stringify(connection.body)).not.toContain('Authorization');
    await manager.change('tmux-agent', 'disable');
    expect((await request(app).post('/api/plugins/tmux-agent/mcp').send({})).status).toBe(409);
    const oldPath = manager.path('tmux-agent');
    await manager.change('tmux-agent', 'update');
    expect(manager.path('tmux-agent')).not.toBe(oldPath);
    expect(manager.state['tmux-agent'].enabled).toBe(false);
    await manager.change('tmux-agent', 'enable');
    await writeFile(join(configDir, 'keep-jobs'), 'durable');
    await manager.change('tmux-agent', 'uninstall');
    expect(await readFile(join(configDir, 'keep-jobs'), 'utf8')).toBe('durable');
    expect((await manager.list())[0].installed).toBe(false);
  });

  it('rejects unknown packages, cross-origin writes and unauthenticated API/MCP calls', async () => {
    const manager = new PluginManager({ configDir: await temp(), catalogDir: resolve('plugins'), dependencies: {} });
    await manager.load();
    const app = express(); app.use(express.json()); app.use('/api', tokenAuth(new Map([['test-token', { expiresAt: null }]])));
    app.use('/api/plugins', createPluginsRouter(manager));
    expect((await request(app).post('/api/plugins/tmux-agent/install')).status).toBe(401);
    expect((await request(app).post('/api/plugins/tmux-agent/mcp')).status).toBe(401);
    expect((await request(app).post('/api/plugins/tmux-agent/install').set('Authorization', 'Bearer test-token').set('Origin', 'https://other.invalid')).status).toBe(403);
    expect((await request(app).post('/api/plugins/unknown/install').set('Authorization', 'Bearer test-token')).status).toBe(400);
    expect((await manager.list())[0].installed).toBe(false);
  });
});

describe('project-managed resources', () => {
  it('tracks a build failure, rejects duplicate builds and records interrupted builds after restart', async () => {
    const home = await temp();
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    const spawnProcess = vi.fn(() => child);
    const options = { userHome: home, configDir: join(home, 'config'), projectDir: resolve('.'), spawnProcess };
    const resources = new ManagedResources(options); await resources.load();
    expect((await resources.buildTmux()).status).toBe('running');
    await expect(resources.buildTmux()).rejects.toThrow('already running');
    const restarted = new ManagedResources(options); await restarted.load();
    expect(restarted.build.status).toBe('interrupted');
    child.stderr.emit('data', 'missing dependency'); child.emit('close', 1);
    await vi.waitFor(async () => expect(JSON.parse(await readFile(join(home, 'config/tmux-build.json'), 'utf8')).status).toBe('failed'));
    expect(resources.build.output).toBe('missing dependency');
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(spawnProcess.mock.calls[0][1]).toEqual([resolve('scripts/build-tmux.sh')]);
  });
  it('backs up config, preserves personal lines and symlink dotfiles, and rejects stale saves', async () => {
    const home = await temp();
    const configDir = join(home, '.config/panel');
    const resources = new ManagedResources({ userHome: home, configDir, projectDir: resolve('.') });
    await resources.load();
    const personal = join(home, 'personal.conf');
    await writeFile(personal, 'set -g status off\n'); await symlink(personal, join(home, '.tmux.conf'));
    const initial = (await resources.status()).tmuxConfig.content;
    const content = initial + 'set -g status-interval 10\n';
    await resources.saveConfig({ content, expectedContent: initial });
    await expect(resources.saveConfig({ content: initial, expectedContent: initial })).rejects.toThrow('changed');
    const linked = await resources.linkConfig(true);
    expect(await readFile(linked.backup, 'utf8')).toBe('set -g status off\n');
    expect((await lstat(join(home, '.tmux.conf'))).isSymbolicLink()).toBe(true);
    await resources.linkConfig(true);
    expect((await readFile(personal, 'utf8')).match(/source-file/g)).toHaveLength(1);
    await resources.linkConfig(false);
    expect(await readFile(personal, 'utf8')).toBe('set -g status off\n');
    expect(await readFile(resources.config, 'utf8')).toBe(content);
    const dangling = join(home, 'dangling.conf');
    await symlink(join(home, 'missing.conf'), dangling);
    await expect(resources.backupWrite(dangling, 'replacement')).rejects.toThrow('dangling symlink');
    expect((await lstat(dangling)).isSymbolicLink()).toBe(true);
  });

  it('only installs/removes owned skill links and discovers them after restart', async () => {
    const home = await temp();
    const options = { userHome: home, configDir: join(home, 'config'), projectDir: resolve('.') };
    const resources = new ManagedResources(options); await resources.load();
    await resources.changeSkill('tmux-agent', 'codex', true);
    const other = new ManagedResources(options); await other.load();
    expect((await other.status()).skills.find((s) => s.name === 'tmux-agent' && s.target === 'codex').status).toBe('managed');
    await other.changeSkill('tmux-agent', 'codex', false);
    const path = resources.skillPath('tmux-agent', 'codex');
    await mkdir(path); await writeFile(join(path, 'SKILL.md'), 'mine');
    await expect(resources.changeSkill('tmux-agent', 'codex', true)).rejects.toThrow('not managed');
    await expect(resources.changeSkill('tmux-agent', 'codex', false)).rejects.toThrow('not managed');
    expect(await readFile(join(path, 'SKILL.md'), 'utf8')).toBe('mine');
    await expect(resources.changeSkill('../other', 'codex', true)).rejects.toThrow('Unknown');
  });
});
