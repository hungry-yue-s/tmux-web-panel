import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';

import { createCodexProviderSwitcher } from '../../server/agent-providers/codex-provider-switch.js';

const roots = [];

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'tmux-provider-switch-'));
  roots.push(home);
  await mkdir(join(home, '.codex'), { recursive: true });
  await mkdir(join(home, '.cc-switch'), { recursive: true });
  await writeFile(join(home, '.codex', 'config.toml'), '[mcp_servers.demo]\ncommand = "demo"\n');
  await writeFile(join(home, '.cc-switch', 'settings.json'), JSON.stringify({ currentProviderCodex: 'official' }));
  return home;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('embedded Codex provider switcher', () => {
  it('preserves runtime preferences and MCP when selecting an embedded enterprise model', async () => {
    const home = await fixture();
    await writeFile(join(home, '.codex/config.toml'), 'service_tier="fast"\nmodel_reasoning_effort="high"\n[mcp_servers.demo]\ncommand="demo"\n');
    const row = { id: 'group', name: 'Group', category: 'custom', is_current: 0,
      settings_config: JSON.stringify({ auth: { OPENAI_API_KEY: 'local-key' }, config: 'model_provider="tmux_enterprise"\nmodel="mode-auto"\n[model_providers.tmux_enterprise]\nbase_url="http://127.0.0.1:15723/codex/v1"\nwire_api="responses"\n' }),
      meta: JSON.stringify({ tmuxPanelEnterprise: 'tmux-panel-token-switch-v1' }) };
    const runSQLite = async (_path, query) => query.includes('from providers where') ? JSON.stringify([row])
      : query.includes('proxy_live_backup') ? '[{"count":0}]' : '[]';
    await createCodexProviderSwitcher({ home, databasePath: join(home, 'cc.db'), runSQLite })('group');
    const config = parse(await readFile(join(home, '.codex/config.toml'), 'utf8'));
    expect(config).toMatchObject({ service_tier: 'fast', model_reasoning_effort: 'high', model: 'mode-auto',
      mcp_servers: { demo: { command: 'demo' } } });
  });
  it('projects a provider without requiring CC Switch to be running', async () => {
    const home = await fixture();
    const sql = [];
    const rows = [
      { id: 'official', name: 'OpenAI Official', category: 'official', is_current: 1, settings_config: '{"auth":{},"config":""}', meta: '{}' },
      {
        id: 'glm', name: 'Zhipu GLM', category: 'cn_official', is_current: 0,
        settings_config: JSON.stringify({
          auth: { OPENAI_API_KEY: 'secret-key' },
          config: 'model_provider = "custom"\nmodel = "glm-5.3"\nmodel_catalog_json = "cc-switch-model-catalog.json"\n[model_providers.custom]\nbase_url = "https://open.bigmodel.cn/api/v1"\nwire_api = "responses"\n',
          modelCatalog: { models: [{ model: 'glm-5.3', displayName: 'GLM-5.3' }] },
        }),
        meta: JSON.stringify({ commonConfigEnabled: true }),
      },
    ];
    const runSQLite = async (_path, query) => {
      sql.push(query);
      if (query.includes('from providers where')) return JSON.stringify(rows);
      if (query.includes('proxy_live_backup')) return '[{"count":0}]';
      if (query.includes('common_config_codex')) return '[{"value":"disable_response_storage = true\\n"}]';
      if (query.startsWith('update providers set settings_config=')) return '';
      if (query.startsWith('begin immediate')) return '';
      throw new Error(`unexpected SQL: ${query}`);
    };
    const switchProvider = createCodexProviderSwitcher({ home, databasePath: join(home, 'cc.db'), runSQLite });

    await expect(switchProvider('glm')).resolves.toMatchObject({ providerId: 'glm', active: true });
    const configText = await readFile(join(home, '.codex', 'config.toml'), 'utf8');
    const config = parse(configText);
    expect(config.model_provider).toBe('custom');
    // The CC Switch camelCase catalog is not a valid Codex model catalog, so the
    // reference is dropped rather than written and crashing `codex` on load.
    expect(config.model_catalog_json).toBeUndefined();
    expect(config.disable_response_storage).toBe(true);
    expect(config.model_providers.custom.experimental_bearer_token).toBe('secret-key');
    expect(config.model_providers.custom.requires_openai_auth).toBe(false);
    expect(config.mcp_servers.demo.command).toBe('demo');
    await expect(readFile(join(home, '.codex', 'cc-switch-model-catalog.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(sql.some((query) => query.startsWith('update providers set settings_config='))).toBe(true);
    const settings = JSON.parse(await readFile(join(home, '.cc-switch', 'settings.json'), 'utf8'));
    expect(settings.currentProviderCodex).toBe('glm');
    expect(sql.some((query) => query.includes("id='glm'"))).toBe(true);
  });

  it('forwards a Codex-native model catalog and keeps the reference', async () => {
    const home = await fixture();
    const nativeCatalog = {
      models: [{ slug: 'glm-5.3', display_name: 'GLM-5.3', description: 'GLM-5.3' }],
    };
    const rows = [
      { id: 'official', name: 'OpenAI Official', category: 'official', is_current: 1, settings_config: '{"auth":{},"config":""}', meta: '{}' },
      {
        id: 'glm', name: 'Zhipu GLM', category: 'cn_official', is_current: 0,
        settings_config: JSON.stringify({
          auth: { OPENAI_API_KEY: 'secret-key' },
          config: 'model_provider = "custom"\nmodel = "glm-5.3"\nmodel_catalog_json = "cc-switch-model-catalog.json"\n[model_providers.custom]\nbase_url = "https://open.bigmodel.cn/api/v1"\nwire_api = "responses"\n',
          modelCatalog: nativeCatalog,
        }),
        meta: JSON.stringify({ commonConfigEnabled: true }),
      },
    ];
    const runSQLite = async (_path, query) => {
      if (query.includes('from providers where')) return JSON.stringify(rows);
      if (query.includes('proxy_live_backup')) return '[{"count":0}]';
      if (query.includes('common_config_codex')) return '[]';
      if (query.startsWith('update providers set settings_config=')) return '';
      if (query.startsWith('begin immediate')) return '';
      throw new Error(`unexpected SQL: ${query}`);
    };
    const switchProvider = createCodexProviderSwitcher({ home, databasePath: join(home, 'cc.db'), runSQLite });

    await expect(switchProvider('glm')).resolves.toMatchObject({ providerId: 'glm', active: true });
    const config = parse(await readFile(join(home, '.codex', 'config.toml'), 'utf8'));
    expect(config.model_catalog_json).toBe('cc-switch-model-catalog.json');
    const catalog = JSON.parse(await readFile(join(home, '.codex', 'cc-switch-model-catalog.json'), 'utf8'));
    expect(catalog).toEqual(nativeCatalog);
  });

  it('refuses a direct write while proxy takeover owns the live config', async () => {
    const home = await fixture();
    const row = { id: 'glm', name: 'Zhipu GLM', category: 'custom', is_current: 0, settings_config: '{}', meta: '{}' };
    const runSQLite = async (_path, query) => query.includes('proxy_live_backup') ? '[{"count":1}]' : JSON.stringify([row]);
    const switchProvider = createCodexProviderSwitcher({ home, databasePath: join(home, 'cc.db'), runSQLite });
    await expect(switchProvider('glm')).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('restores live files and the previous database selection when activation fails', async () => {
    const home = await fixture();
    const originalConfig = await readFile(join(home, '.codex', 'config.toml'), 'utf8');
    const rows = [
      { id: 'official', name: 'Official', category: 'official', is_current: 1, settings_config: '{"auth":{},"config":""}', meta: '{}' },
      {
        id: 'custom', name: 'Custom', category: 'custom', is_current: 0,
        settings_config: JSON.stringify({
          auth: { OPENAI_API_KEY: 'secret' },
          config: 'model_provider = "custom"\n[model_providers.custom]\nbase_url = "https://example.test"\nwire_api = "responses"\n',
        }),
        meta: '{}',
      },
    ];
    let transaction = 0;
    const calls = [];
    const runSQLite = async (_path, query) => {
      calls.push(query);
      if (query.includes('from providers where')) return JSON.stringify(rows);
      if (query.includes('proxy_live_backup')) return '[{"count":0}]';
      if (query.includes('common_config_codex')) return '[]';
      if (query.startsWith('update providers set settings_config=')) return '';
      if (query.startsWith('begin immediate') && transaction++ === 0) throw new Error('database write failed');
      if (query.startsWith('begin immediate')) return '';
      throw new Error(`unexpected SQL: ${query}`);
    };
    const switchProvider = createCodexProviderSwitcher({ home, databasePath: join(home, 'cc.db'), runSQLite });

    await expect(switchProvider('custom')).rejects.toThrow('database write failed');
    expect(await readFile(join(home, '.codex', 'config.toml'), 'utf8')).toBe(originalConfig);
    expect(JSON.parse(await readFile(join(home, '.cc-switch', 'settings.json'), 'utf8')).currentProviderCodex).toBe('official');
    expect(calls.at(-1)).toContain("id='official'");
    await expect(readFile(join(home, '.config', 'tmux-web-panel', 'codex-provider-switch.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
