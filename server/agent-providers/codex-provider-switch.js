import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { parse, stringify } from 'smol-toml';

import { AppError, ErrorCode } from '../servers/errors.js';

const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

async function readOptional(path) {
  try { return await readFile(path); } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readJSON(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}

async function atomicWrite(path, value, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(temporary, value, { mode });
  await rename(temporary, path);
  await chmod(path, mode);
}

async function restore(path, snapshot) {
  if (snapshot === null) await unlink(path).catch(() => {});
  else await atomicWrite(path, snapshot);
}

function sql(value) {
  return `'${String(value == null ? '' : value).replaceAll("'", "''")}'`;
}

async function withLock(path, action) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
    let stale = false;
    try {
      const pid = Number(await readFile(path, 'utf8'));
      if (pid) process.kill(pid, 0);
      else stale = Date.now() - (await stat(path)).mtimeMs > 30_000;
    } catch { stale = true; }
    if (!stale) throw new AppError(ErrorCode.PROVIDER_CHANGED, '另一个运行身份切换正在进行');
    await unlink(path).catch(() => {});
    handle = await open(path, 'wx', 0o600);
  }
  try {
    await handle.writeFile(String(process.pid));
    return await action();
  } finally {
    await handle.close().catch(() => {});
    await unlink(path).catch(() => {});
  }
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(target, source) {
  const result = object(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(object(source) ? source : {})) {
    result[key] = object(value) && object(result[key]) ? deepMerge(result[key], value) : value;
  }
  return result;
}

function isSubset(target, source) {
  if (!object(source)) return Object.is(target, source);
  if (!object(target)) return false;
  return Object.entries(source).every(([key, value]) => isSubset(target[key], value));
}

function parseJSON(value, fallback = {}) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function providerConfig(row, commonSnippet, liveText) {
  const settings = parseJSON(row.settings_config);
  const meta = parseJSON(row.meta);
  let config;
  try {
    config = parse(String(settings.config || ''));
  } catch (error) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, `供应商配置 TOML 无效：${error.message}`);
  }

  if (commonSnippet && String(commonSnippet).trim()) {
    let common;
    try { common = parse(String(commonSnippet)); } catch { common = null; }
    const enabled = meta.commonConfigEnabled === true
      || (meta.commonConfigEnabled == null && common && isSubset(config, common));
    if (enabled && common) config = deepMerge(config, common);
  }

  // MCP entries are owned by the panel/CC Switch database, not an individual
  // provider. Preserve the current projection across an identity switch.
  try {
    const live = parse(liveText || '');
    if (object(live.mcp_servers)) config.mcp_servers = live.mcp_servers;
    if (object(live.mcp) && object(live.mcp.servers)) {
      config.mcp = { ...(object(config.mcp) ? config.mcp : {}), servers: live.mcp.servers };
    }
  } catch { /* target validation below still protects the new file */ }

  const ownedCatalog = typeof config.model_catalog_json === 'string'
    && basename(config.model_catalog_json) === 'cc-switch-model-catalog.json';
  const catalog = ownedCatalog && object(settings.modelCatalog) ? settings.modelCatalog : null;
  if (ownedCatalog && !catalog) delete config.model_catalog_json;

  if (row.category !== 'official') {
    const providerName = String(config.model_provider || '');
    const table = object(config.model_providers) && object(config.model_providers[providerName])
      ? config.model_providers[providerName]
      : null;
    const auth = object(settings.auth) ? settings.auth : {};
    const apiKey = auth.OPENAI_API_KEY || auth.openai_api_key || auth.api_key;
    if (!providerName || !table) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, '第三方 Codex 配置缺少活动的 model_providers 条目');
    }
    if (!apiKey) throw new AppError(ErrorCode.VALIDATION_ERROR, '该 API Provider 没有可用的 API Key');
    table.name = table.name || row.name;
    table.experimental_bearer_token = apiKey;
    table.requires_openai_auth = false;
  }

  try {
    const output = stringify(config);
    parse(output);
    return { config: output, catalog: catalog ? `${JSON.stringify(catalog, null, 2)}\n` : null };
  } catch (error) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, `无法生成 Codex 配置：${error.message}`);
  }
}

export function createCodexProviderSwitcher(options = {}) {
  const home = options.home || homedir();
  const databasePath = options.databasePath || join(home, '.cc-switch', 'cc-switch.db');
  const settingsPath = options.settingsPath || join(home, '.cc-switch', 'settings.json');
  const lockPath = options.lockPath || join(home, '.config', 'tmux-web-panel', 'codex-provider-switch.lock');
  const journalPath = options.journalPath || join(home, '.config', 'tmux-web-panel', 'codex-provider-switch.json');
  const runSQLite = options.runSQLite;
  if (typeof runSQLite !== 'function') throw new TypeError('runSQLite is required');

  async function recover() {
    const journal = await readJSON(journalPath, null);
    if (!journal) return false;
    if (journal.phase === 'committed') {
      await unlink(journalPath).catch(() => {});
      return false;
    }
    const buffer = (value) => value == null ? null : Buffer.from(value, 'base64');
    await Promise.all([
      restore(journal.configPath, buffer(journal.configSnapshot)),
      journal.catalogPath ? restore(journal.catalogPath, buffer(journal.catalogSnapshot)) : Promise.resolve(),
      restore(settingsPath, buffer(journal.settingsSnapshot)),
    ]);
    const restoreSettings = journal.currentId && journal.currentSettings != null
      ? ` update providers set settings_config=${sql(journal.currentSettings)} where app_type='codex' and id=${sql(journal.currentId)};`
      : '';
    const restoreCurrent = journal.currentId
      ? ` update providers set is_current=1 where app_type='codex' and id=${sql(journal.currentId)};`
      : '';
    await runSQLite(databasePath,
      `begin immediate;${restoreSettings} update providers set is_current=0 where app_type='codex';${restoreCurrent} commit;`);
    await unlink(journalPath).catch(() => {});
    return true;
  }

  async function switchLocked(providerId) {
    await recover();
    if (!ID_RE.test(providerId || '')) throw new AppError(ErrorCode.VALIDATION_ERROR, '无效的供应商 ID');
    const rows = parseJSON(await runSQLite(databasePath,
      "select id, name, category, settings_config, meta, is_current from providers where app_type='codex' order by sort_index"), []);
    const target = rows.find((row) => row.id === providerId);
    if (!target) throw new AppError(ErrorCode.VALIDATION_ERROR, 'Codex 供应商不存在', { status: 404 });
    if (target.is_current) return { providerId, active: true, unchanged: true };

    const takeover = parseJSON(await runSQLite(databasePath,
      "select count(*) as count from proxy_live_backup where app_type='codex'"), []);
    if (Number(takeover[0] && takeover[0].count) > 0) {
      throw new AppError(ErrorCode.UNSUPPORTED, 'Codex 正由 CC Switch 代理接管，请先在 CC Switch 关闭接管后再切换');
    }

    const settings = await readJSON(settingsPath, {});
    const codexDir = settings.codexConfigDir || join(home, '.codex');
    const configPath = join(codexDir, 'config.toml');
    const catalogPath = join(codexDir, 'cc-switch-model-catalog.json');
    const configSnapshot = await readOptional(configPath);
    const catalogSnapshot = await readOptional(catalogPath);
    const settingsSnapshot = await readOptional(settingsPath);
    const current = rows.find((row) => Boolean(row.is_current));
    const commonRows = parseJSON(await runSQLite(databasePath,
      "select value from settings where key='common_config_codex' limit 1"), []);
    const liveText = configSnapshot ? configSnapshot.toString('utf8') : '';
    const nextProjection = providerConfig(target, commonRows[0] && commonRows[0].value, liveText);
    settings.currentProviderCodex = providerId;
    const journal = {
      phase: 'prepared', configPath, catalogPath,
      configSnapshot: configSnapshot && configSnapshot.toString('base64'),
      catalogSnapshot: catalogSnapshot && catalogSnapshot.toString('base64'),
      settingsSnapshot: settingsSnapshot && settingsSnapshot.toString('base64'),
      currentId: current && current.id,
      currentSettings: current && current.settings_config,
    };
    await atomicWrite(journalPath, `${JSON.stringify(journal)}\n`);

    try {
      if (current && current.id !== providerId) {
        const currentSettings = parseJSON(current.settings_config);
        // Preserve direct edits made by Codex while avoiding a second copy of
        // the injected bearer token in the provider registry.
        currentSettings.config = liveText.replace(/^\s*experimental_bearer_token\s*=.*(?:\n|$)/gm, '');
        await runSQLite(databasePath,
          `update providers set settings_config=${sql(JSON.stringify(currentSettings))} where app_type='codex' and id=${sql(current.id)};`);
      }
      await atomicWrite(configPath, nextProjection.config);
      if (nextProjection.catalog) await atomicWrite(catalogPath, nextProjection.catalog);
      else await unlink(catalogPath).catch(() => {});
      await atomicWrite(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
      await runSQLite(databasePath,
        `begin immediate; update providers set is_current=0 where app_type='codex'; update providers set is_current=1 where app_type='codex' and id=${sql(providerId)}; commit;`);
      journal.phase = 'committed';
      await atomicWrite(journalPath, `${JSON.stringify(journal)}\n`);
      await unlink(journalPath).catch(() => {});
    } catch (error) {
      await recover().catch(() => {});
      throw error;
    }
    return { providerId, active: true, source: 'embedded-cc-switch-compatible' };
  }

  const switchCodexProvider = (providerId) => withLock(lockPath, () => switchLocked(providerId));
  switchCodexProvider.recover = () => withLock(lockPath, recover);
  switchCodexProvider.runExclusive = (action) => withLock(lockPath, async () => {
    await recover();
    return action(switchLocked);
  });
  return switchCodexProvider;
}
