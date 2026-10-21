import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { createTokenSwitchClaudeRelay } from '../../server/agent-providers/token-switch-claude-relay.js';

const roots = [];
const NOW = 1_800_000_000_000;
const execFileAsync = promisify(execFile);
const NATIVE_CONFIG = 'model_provider = "tokenswitch"\nmodel = "mode-Auto"\n[model_providers.tokenswitch]\nbase_url = "http://127.0.0.1:15722/v1"\nwire_api = "responses"\nexperimental_bearer_token = "native-local-bearer"\n';

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'tmux-token-switch-relay-'));
  roots.push(home);
  for (const directory of ['.token-switch', '.cc-switch', '.claude', '.codex']) await mkdir(join(home, directory));
  const files = {
    '.token-switch/token-switch.db': 'token-database-snapshot',
    '.token-switch/settings.json': '{"currentProviderCodex":"official","enableLocalProxy":false}',
    '.cc-switch/cc-switch.db': 'cc-database-snapshot',
    '.cc-switch/settings.json': '{"currentProviderClaude":"original","enableLocalProxy":false}',
    '.claude/settings.json': '{"env":{"ANTHROPIC_AUTH_TOKEN":"private-claude-auth"}}',
    '.codex/auth.json': '{"tokens":{"access_token":"private-codex-auth"}}',
    '.codex/config.toml': NATIVE_CONFIG,
  };
  for (const [path, text] of Object.entries(files)) await writeFile(join(home, path), text);
  return { home, files };
}

function provider(app, name, current = 0) {
  return {
    id: `${app}-${name}`, app, name, is_current: current,
    meta: JSON.stringify({ managedCatalog: { serverModelId: `mode-${name}` } }),
  };
}

function database(options = {}) {
  const providers = options.providers || [provider('codex', 'Auto')];
  return vi.fn(async (path, query) => {
    if (query.includes('from providers') && path.includes('.token-switch')) return JSON.stringify(providers);
    if (query.includes('from settings')) return JSON.stringify([{ value: JSON.stringify({
      accessTokenExpiresAt: options.expiresAt ?? NOW + 60_000,
      user: { name: 'private-user' },
    }) }]);
    if (query.includes('from providers')) return JSON.stringify(options.existing || []);
    if (query.includes('from proxy_config')) return JSON.stringify([{
      listen_address: options.address || '127.0.0.1',
      listen_port: path.includes('.token-switch') ? options.tokenPort ?? 15722 : 15721,
    }]);
    throw new Error(`Unexpected SQL: ${query}`);
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Token Switch Claude relay preview', () => {
  it('previews an inactive Responses route without registering, switching, or loading credentials', async () => {
    const { home, files } = await fixture();
    const runSQLite = database();
    const result = await createTokenSwitchClaudeRelay({ home, runSQLite, now: () => NOW }).preview();
    expect(result).toMatchObject({
      id: 'token-switch-claude-relay', model: 'mode-Auto', prepared: false,
      dryRun: true, blocked: true, blockedReason: 'TOKEN_SWITCH_NATIVE_CONFIG_REQUIRED', requiresNativeProxy: true,
      configurationPreview: {
        is_current: false,
        settingsConfig: { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:15722/v1/responses' } },
        meta: { apiFormat: 'openai_responses', isFullUrl: true },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/private|AUTH_TOKEN|API_KEY|ciphertext/);
    expect(runSQLite.mock.calls.every(([_path, query]) => /^select /i.test(query))).toBe(true);
    for (const [path, content] of Object.entries(files)) expect(await readFile(join(home, path), 'utf8')).toBe(content);
    expect(await readdir(join(home, '.cc-switch'))).toEqual(['cc-switch.db', 'settings.json']);
  });

  it('prefers the current Codex model while keeping app-specific aliases separate', async () => {
    const { home } = await fixture();
    const providers = [provider('claude', 'Other', 1), provider('codex', 'Auto'), provider('codex', 'Current', 1)];
    const result = await createTokenSwitchClaudeRelay({ home, runSQLite: database({ providers }), now: () => NOW }).preview();
    expect(result.model).toBe('mode-Current');
  });

  it('refuses to claim an existing provider id owned by another configuration', async () => {
    const { home } = await fixture();
    const runSQLite = database({ existing: [{ id: 'token-switch-claude-relay', meta: '{}' }] });
    await expect(createTokenSwitchClaudeRelay({ home, runSQLite, now: () => NOW }).preview())
      .rejects.toMatchObject({ code: 'PROVIDER_CHANGED' });
    expect(runSQLite.mock.calls.every(([_path, query]) => /^select /i.test(query))).toBe(true);
  });

  it('can preview its own existing provider without rewriting it', async () => {
    const { home } = await fixture();
    const runSQLite = database({ existing: [{ id: 'token-switch-claude-relay', is_current: 0, meta: '{"tmuxPanelRelay":"token-switch-claude-relay-v1"}' }] });
    await expect(createTokenSwitchClaudeRelay({ home, runSQLite, now: () => NOW }).preview())
      .resolves.toMatchObject({ prepared: false, dryRun: true });
    expect(runSQLite.mock.calls.every(([_path, query]) => /^select /i.test(query))).toBe(true);
  });

  it('requires a current or Auto Codex catalog without borrowing another app', async () => {
    const { home } = await fixture();
    const runSQLite = database({ providers: [provider('claude', 'Auto', 1), provider('codex', 'Unselected')] });
    await expect(createTokenSwitchClaudeRelay({ home, runSQLite, now: () => NOW }).preview())
      .rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('requires an unexpired Token Switch login', async () => {
    const { home } = await fixture();
    const runSQLite = database({ expiresAt: NOW });
    await expect(createTokenSwitchClaudeRelay({ home, runSQLite, now: () => NOW }).preview())
      .rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(runSQLite.mock.calls.every(([path]) => path.includes('.token-switch'))).toBe(true);
  });

  it('rejects a relay cycle or a non-loopback target', async () => {
    const { home } = await fixture();
    for (const options of [{ tokenPort: 15721 }, { address: '0.0.0.0' }]) {
      await expect(createTokenSwitchClaudeRelay({ home, runSQLite: database(options), now: () => NOW }).preview())
        .rejects.toMatchObject({ code: 'UNSUPPORTED' });
    }
  });

  it('prepares only a matching native local configuration and keeps all live/auth files unchanged', async () => {
    const { home, files } = await fixture();
    const runSQLite = database({ providers: [provider('codex', 'Auto', 1)] });
    const mutateSQLite = vi.fn().mockResolvedValue(undefined);
    const result = await createTokenSwitchClaudeRelay({ home, runSQLite, mutateSQLite, now: () => NOW }).prepare();
    expect(result).toMatchObject({
      id: 'token-switch-claude-relay', model: 'mode-Auto', prepared: true,
      requiresNativeProxy: true, verification: 'native-config-only',
    });
    expect(JSON.stringify(result)).not.toMatch(/native-local-bearer|AUTH_TOKEN|private|API_KEY/);
    expect(mutateSQLite).toHaveBeenCalledOnce();
    const [path, query] = mutateSQLite.mock.calls[0];
    expect(path).toBe(join(home, '.cc-switch', 'cc-switch.db'));
    expect(query).toContain('begin immediate;');
    expect(query).toContain('check (allowed=1)');
    expect(query).toContain('http://127.0.0.1:15722/v1/responses');
    expect(query).not.toContain('/codex/v1/responses');
    for (const [file, content] of Object.entries(files)) expect(await readFile(join(home, file), 'utf8')).toBe(content);
  });

  it('refuses official, mismatched, non-loopback, wrong-port, missing-token and inactive native configurations', async () => {
    const { home } = await fixture();
    const mutateSQLite = vi.fn();
    const configs = [
      NATIVE_CONFIG.replace('model_provider = "tokenswitch"', 'model_provider = "openai"'),
      NATIVE_CONFIG.replace('model = "mode-Auto"', 'model = "other"'),
      NATIVE_CONFIG.replace('127.0.0.1', 'example.test'),
      NATIVE_CONFIG.replace('15722', '15723'),
      NATIVE_CONFIG.replace('native-local-bearer', ''),
      NATIVE_CONFIG.replace('wire_api = "responses"', 'wire_api = "chat"'),
    ];
    for (const config of configs) {
      await writeFile(join(home, '.codex', 'config.toml'), config);
      await expect(createTokenSwitchClaudeRelay({ home, runSQLite: database({ providers: [provider('codex', 'Auto', 1)] }), mutateSQLite, now: () => NOW }).prepare())
        .rejects.toMatchObject({ code: 'UNSUPPORTED' });
    }
    await writeFile(join(home, '.codex', 'config.toml'), NATIVE_CONFIG);
    await expect(createTokenSwitchClaudeRelay({ home, runSQLite: database(), mutateSQLite, now: () => NOW }).prepare())
      .rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(mutateSQLite).not.toHaveBeenCalled();
  });

  it('does not update an owned relay while it is current', async () => {
    const { home } = await fixture();
    const mutateSQLite = vi.fn();
    const runSQLite = database({ existing: [{ id: 'token-switch-claude-relay', is_current: 1, meta: '{"tmuxPanelRelay":"token-switch-claude-relay-v1"}' }] });
    await expect(createTokenSwitchClaudeRelay({ home, runSQLite, mutateSQLite, now: () => NOW }).prepare())
      .rejects.toMatchObject({ code: 'PROVIDER_CHANGED' });
    expect(mutateSQLite).not.toHaveBeenCalled();
  });

  it('atomically registers an inactive provider and rolls back an ownership race in a temporary SQLite database', async () => {
    const { home } = await fixture();
    const path = join(home, '.cc-switch', 'cc-switch.db');
    await rm(path);
    await execFileAsync('sqlite3', [path, `create table providers (
      id text,app_type text,name text,settings_config text,category text,created_at integer,
      notes text,meta text,is_current integer,in_failover_queue integer,primary key(id,app_type)
    ); create table proxy_config (app_type text,listen_address text,listen_port integer);
    insert into proxy_config values ('claude','127.0.0.1',15721);
    insert into providers values ('original','claude','Original','{}','custom',0,'','{}',1,0);`]);
    const tokenRows = database({ providers: [provider('codex', 'Auto', 1)] });
    const runSQLite = async (databasePath, query) => databasePath === path
      ? (await execFileAsync('sqlite3', ['-readonly', '-json', path, query])).stdout
      : tokenRows(databasePath, query);
    const relay = createTokenSwitchClaudeRelay({ home, runSQLite, now: () => NOW });
    await expect(relay.prepare()).resolves.toMatchObject({ prepared: true });
    const rows = JSON.parse(await runSQLite(path, 'select id,is_current,settings_config,meta from providers order by id'));
    expect(rows.find((row) => row.id === 'original').is_current).toBe(1);
    const registered = rows.find((row) => row.id === 'token-switch-claude-relay');
    expect(registered.is_current).toBe(0);
    expect(JSON.parse(registered.settings_config).env.ANTHROPIC_AUTH_TOKEN).toBe('native-local-bearer');
    expect(JSON.parse(registered.meta)).toMatchObject({ apiFormat: 'openai_responses', isFullUrl: true });

    const quotedBearer = "local'quoted;credential";
    await writeFile(join(home, '.codex', 'config.toml'), NATIVE_CONFIG.replace('native-local-bearer', quotedBearer));
    await expect(relay.prepare()).resolves.toMatchObject({ prepared: true });
    const updated = JSON.parse(await runSQLite(path, "select settings_config,is_current from providers where id='token-switch-claude-relay'"))[0];
    expect(JSON.parse(updated.settings_config).env.ANTHROPIC_AUTH_TOKEN).toBe(quotedBearer);
    expect(updated.is_current).toBe(0);

    // The readonly preflight sees our row, then another writer claims it before BEGIN IMMEDIATE.
    let claimed = false;
    const racingRead = async (databasePath, query) => {
      const result = await runSQLite(databasePath, query);
      if (databasePath === path && query.includes('select id, meta') && !claimed) {
        claimed = true;
        await execFileAsync('sqlite3', [path, "update providers set meta='{}',settings_config='ownership-race' where id='token-switch-claude-relay'"]);
      }
      return result;
    };
    await expect(createTokenSwitchClaudeRelay({ home, runSQLite: racingRead, now: () => NOW }).prepare())
      .rejects.toMatchObject({ code: 'PROVIDER_CHANGED' });
    const after = JSON.parse(await runSQLite(path, "select settings_config,meta,is_current from providers where id='token-switch-claude-relay'"))[0];
    expect(after).toEqual({ settings_config: 'ownership-race', meta: '{}', is_current: 0 });
  });
});
