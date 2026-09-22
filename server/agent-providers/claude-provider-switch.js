import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { AppError, ErrorCode } from '../servers/errors.js';

const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

function parseJSON(value, fallback = {}) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function sql(value) {
  return `'${String(value == null ? '' : value).replaceAll("'", "''")}'`;
}

async function readOptional(path) {
  try { return await readFile(path); } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function atomicWrite(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(temporary, value, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function restore(path, snapshot) {
  if (snapshot === null) await unlink(path).catch(() => {});
  else await atomicWrite(path, snapshot);
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

function projectClaudeSettings(rows, target, live) {
  const targetSettings = parseJSON(target.settings_config);
  const managedEnv = new Set(rows.flatMap((row) => Object.keys(parseJSON(row.settings_config).env || {})));
  const preservedEnv = Object.fromEntries(Object.entries(live.env || {}).filter(([key]) => !managedEnv.has(key)));
  return {
    ...live,
    ...targetSettings,
    env: { ...preservedEnv, ...(targetSettings.env || {}) },
  };
}

export function createClaudeProviderSwitcher(options = {}) {
  const home = options.home || homedir();
  const databasePath = options.databasePath || join(home, '.cc-switch', 'cc-switch.db');
  const settingsPath = options.settingsPath || join(home, '.cc-switch', 'settings.json');
  const livePath = options.livePath || join(home, '.claude', 'settings.json');
  const lockPath = options.lockPath || join(home, '.config', 'tmux-web-panel', 'claude-provider-switch.lock');
  const journalPath = options.journalPath || join(home, '.config', 'tmux-web-panel', 'claude-provider-switch.json');
  const runSQLite = options.runSQLite;
  if (typeof runSQLite !== 'function') throw new TypeError('runSQLite is required');

  async function recover() {
    const journal = parseJSON(await readFile(journalPath, 'utf8').catch(() => ''), null);
    if (!journal) return false;
    if (journal.phase === 'committed') {
      await unlink(journalPath).catch(() => {});
      return false;
    }
    await Promise.all([
      restore(livePath, journal.liveSnapshot == null ? null : Buffer.from(journal.liveSnapshot, 'base64')),
      restore(settingsPath, journal.settingsSnapshot == null ? null : Buffer.from(journal.settingsSnapshot, 'base64')),
    ]);
    const restoreSettings = journal.currentId && journal.currentSettings != null
      ? ` update providers set settings_config=${sql(journal.currentSettings)} where app_type='claude' and id=${sql(journal.currentId)};`
      : '';
    const restoreCurrent = journal.currentId
      ? ` update providers set is_current=1 where app_type='claude' and id=${sql(journal.currentId)};`
      : '';
    await runSQLite(databasePath,
      `begin immediate;${restoreSettings} update providers set is_current=0 where app_type='claude';${restoreCurrent} commit;`);
    await unlink(journalPath).catch(() => {});
    return true;
  }

  async function switchLocked(providerId) {
    await recover();
    if (!ID_RE.test(providerId || '')) throw new AppError(ErrorCode.VALIDATION_ERROR, '无效的供应商 ID');
    const rows = parseJSON(await runSQLite(databasePath,
      "select id, name, category, settings_config, is_current from providers where app_type='claude' order by sort_index"), []);
    const target = rows.find((row) => row.id === providerId);
    if (!target) throw new AppError(ErrorCode.VALIDATION_ERROR, 'Claude 供应商不存在', { status: 404 });
    if (target.is_current) return { providerId, active: true, unchanged: true };

    const takeover = parseJSON(await runSQLite(databasePath,
      "select count(*) as count from proxy_live_backup where app_type='claude'"), []);
    if (Number(takeover[0] && takeover[0].count) > 0) {
      throw new AppError(ErrorCode.UNSUPPORTED, 'Claude 正由 CC Switch 代理接管，请先关闭接管后再切换');
    }

    const liveSnapshot = await readOptional(livePath);
    const settingsSnapshot = await readOptional(settingsPath);
    const live = parseJSON(liveSnapshot && liveSnapshot.toString('utf8'));
    const settings = parseJSON(settingsSnapshot && settingsSnapshot.toString('utf8'));
    const current = rows.find((row) => Boolean(row.is_current));
    const next = projectClaudeSettings(rows, target, live);
    settings.currentProviderClaude = providerId;
    const journal = {
      phase: 'prepared',
      liveSnapshot: liveSnapshot && liveSnapshot.toString('base64'),
      settingsSnapshot: settingsSnapshot && settingsSnapshot.toString('base64'),
      currentId: current && current.id,
      currentSettings: current && current.settings_config,
    };
    await atomicWrite(journalPath, `${JSON.stringify(journal)}\n`);

    try {
      if (current && current.id !== providerId) {
        await runSQLite(databasePath,
          `update providers set settings_config=${sql(JSON.stringify(live))} where app_type='claude' and id=${sql(current.id)};`);
      }
      await atomicWrite(livePath, `${JSON.stringify(next, null, 2)}\n`);
      await atomicWrite(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
      await runSQLite(databasePath,
        `begin immediate; update providers set is_current=0 where app_type='claude'; update providers set is_current=1 where app_type='claude' and id=${sql(providerId)}; commit;`);
      journal.phase = 'committed';
      await atomicWrite(journalPath, `${JSON.stringify(journal)}\n`);
      await unlink(journalPath).catch(() => {});
    } catch (error) {
      await recover().catch(() => {});
      throw error;
    }
    return { providerId, active: true, source: 'embedded-cc-switch-compatible' };
  }

  const switchClaudeProvider = (providerId) => withLock(lockPath, () => switchLocked(providerId));
  switchClaudeProvider.recover = () => withLock(lockPath, recover);
  return switchClaudeProvider;
}
