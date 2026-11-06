import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { AppError, ErrorCode } from './servers/errors.js';

// Bundled, reviewed packages only. Installing arbitrary remote code is not part
// of the panel's plugin contract.
const CATALOG = ['tmux-agent'];

export class PluginManager {
  constructor({ configDir, catalogDir, dependencies }) {
    this.root = join(configDir, 'plugins');
    this.catalogDir = catalogDir;
    this.dependencies = dependencies;
    this.state = {};
    this.runtime = new Map();
    this.changing = false;
  }

  async load() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      this.state = JSON.parse(await readFile(join(this.root, 'state.json'), 'utf8'));
      if (!this.state || Array.isArray(this.state) || typeof this.state !== 'object') throw new Error('Invalid plugin state');
      for (const [id, entry] of Object.entries(this.state)) {
        this.requireKnown(id);
        if (!/^[a-f0-9-]{36}$/.test(entry.generation) || typeof entry.enabled !== 'boolean') throw new Error('Invalid plugin installation');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  requireKnown(id) {
    if (!CATALOG.includes(id)) throw new AppError(ErrorCode.VALIDATION_ERROR, 'Unknown plugin');
  }

  path(id) {
    this.requireKnown(id);
    const entry = this.state[id];
    if (!entry) throw new AppError(ErrorCode.WORKSPACE_UNAVAILABLE, 'Plugin is not installed');
    return join(this.root, id + '-' + entry.generation);
  }

  async list() {
    return Promise.all(CATALOG.map(async (id) => {
      const manifest = JSON.parse(await readFile(join(this.catalogDir, id, 'panel-plugin.json'), 'utf8'));
      return { ...manifest, installed: !!this.state[id], enabled: !!this.state[id]?.enabled,
        installedVersion: this.state[id]?.version || null };
    }));
  }

  async save(next) {
    const file = join(this.root, 'state.json');
    await writeFile(file + '.tmp', JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    await rename(file + '.tmp', file);
    this.state = next;
  }

  async change(id, action) {
    this.requireKnown(id);
    if (!['install', 'update', 'enable', 'disable', 'uninstall'].includes(action)) throw new AppError(ErrorCode.VALIDATION_ERROR, 'Unknown plugin action');
    if (this.changing) throw new AppError(ErrorCode.SERVER_IN_USE, 'Another plugin change is in progress');
    this.changing = true;
    try {
      const entry = this.state[id];
      if ((action === 'install' && !entry) || action === 'update') {
        if (action === 'update' && !entry) throw new AppError(ErrorCode.WORKSPACE_UNAVAILABLE, 'Plugin is not installed');
        const previousPath = entry ? this.path(id) : null;
        const generation = randomUUID();
        const destination = join(this.root, id + '-' + generation);
        try {
          await cp(join(this.catalogDir, id), destination, { recursive: true, errorOnExist: true, force: false });
          const manifest = JSON.parse(await readFile(join(destination, 'panel-plugin.json'), 'utf8'));
          // Import before activation: a broken package never becomes enabled.
          const module = await import(pathToFileURL(join(destination, 'server.mjs')).href);
          if (typeof module.createPlugin !== 'function') throw new Error('Invalid plugin entrypoint');
          await saveManifestConfig(destination, id);
          await this.save({ ...this.state, [id]: { generation, version: manifest.version, enabled: entry ? entry.enabled : true } });
        } catch (error) {
          await rm(destination, { recursive: true, force: true });
          throw error;
        }
        this.runtime.delete(id);
        if (previousPath) await rm(previousPath, { recursive: true, force: true });
      } else if (action === 'uninstall') {
        if (entry) {
          const destination = this.path(id);
          const next = { ...this.state };
          delete next[id];
          await this.save(next);
          this.runtime.delete(id);
          await rm(destination, { recursive: true, force: true });
        }
      } else if (action !== 'install') {
        if (!entry) throw new AppError(ErrorCode.WORKSPACE_UNAVAILABLE, 'Plugin is not installed');
        await this.save({ ...this.state, [id]: { ...entry, enabled: action === 'enable' } });
      }
      return (await this.list()).find((item) => item.id === id);
    } finally {
      this.changing = false;
    }
  }

  requireEnabled(id) {
    this.requireKnown(id);
    if (!this.state[id]?.enabled) throw new AppError(ErrorCode.WORKSPACE_UNAVAILABLE, 'Plugin is not enabled');
  }

  async getRuntime(id) {
    this.requireEnabled(id);
    if (!this.runtime.has(id)) {
      const url = pathToFileURL(join(this.path(id), 'server.mjs')).href;
      this.runtime.set(id, import(url).then((module) => module.createPlugin(this.dependencies)));
    }
    const runtime = await this.runtime.get(id);
    this.requireEnabled(id);
    return runtime;
  }

  async connection(id, origin) {
    this.requireEnabled(id);
    const url = new URL('/api/plugins/' + id + '/mcp', origin).href;
    return {
      url,
      config: { mcpServers: { [id]: { type: 'http', url } } },
      skill: await readFile(join(this.path(id), 'skills', id, 'SKILL.md'), 'utf8'),
      authentication: 'Use the panel Bearer token when authentication is enabled. No token is included here.',
    };
  }
}

async function saveManifestConfig(destination, id) {
  // Portable sample; the management page supplies the actual panel origin.
  await writeFile(join(destination, '.mcp.json'), JSON.stringify({ mcpServers: {
    [id]: { type: 'http', url: 'http://localhost:7681/api/plugins/' + id + '/mcp' },
  } }, null, 2) + '\n');
}
