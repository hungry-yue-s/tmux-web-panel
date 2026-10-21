import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const APPS = new Set(['claude', 'claude-desktop', 'codex', 'gemini', 'opencode', 'openclaw', 'hermes', 'qwen-code']);

function parseJSON(value, fallback = null) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function model(row) {
  const app = row.app || row.app_type;
  const catalog = parseJSON(row.meta)?.managedCatalog;
  if (!APPS.has(app) || typeof row.id !== 'string' || !row.id
    || typeof row.name !== 'string' || !object(catalog)
    || typeof catalog.serverModelId !== 'string' || !catalog.serverModelId) return null;
  return {
    id: row.id, app, name: row.name, is_current: row.is_current === 1 || row.is_current === true,
    meta: {
      managedCatalog: {
        serverModelId: catalog.serverModelId,
        description: typeof catalog.description === 'string' ? catalog.description : '',
        multiplier: typeof catalog.multiplier === 'number' && Number.isFinite(catalog.multiplier)
          && catalog.multiplier >= 0 ? catalog.multiplier : null,
        contextWindow: Number.isSafeInteger(catalog.contextWindow) && catalog.contextWindow > 0
          ? catalog.contextWindow : null,
      },
    },
  };
}

function capabilities(models) {
  const capability = (app) => {
    const supported = models.some((entry) => entry.app === app);
    return {
      supported,
      control: 'native-ui',
      reason: supported
        ? '已下发该应用的托管模型，请在 Token Switch 中切换；面板没有原生管理接口'
        : '尚未直接下发该应用的托管配置，兼容代理路径需单独验证',
    };
  };
  return {
    codex: capability('codex'),
    claude: capability('claude'),
    qoder: { supported: false, control: 'unsupported', reason: 'Token Switch 当前没有 Qoder 应用控制入口' },
  };
}

export function createTokenSwitchStatusReader(options = {}) {
  const databasePath = join(options.home || homedir(), '.token-switch', 'token-switch.db');
  const now = options.now || Date.now;
  const runSQLite = options.runSQLite || (async (path, query) => {
    const result = await execFileAsync('sqlite3', ['-readonly', '-json', path, query], {
      timeout: 5000, maxBuffer: 1024 * 1024,
    });
    return result.stdout;
  });

  return async () => {
    const result = {
      installed: false, loggedIn: false, expiresAt: null, models: [],
      capabilities: capabilities([]), canSwitchInPanel: false,
    };
    try {
      if (!(await stat(databasePath)).isFile()) return result;
      result.installed = true;
      const [providers, sessions] = await Promise.all([
        runSQLite(databasePath, 'select id, app_type as app, name, is_current, meta from providers'),
        runSQLite(databasePath, "select value from settings where key='token_switch_auth_session_meta' limit 1"),
      ]);
      const rows = JSON.parse(providers || '[]');
      const authRows = JSON.parse(sessions || '[]');
      if (!Array.isArray(rows) || !Array.isArray(authRows)) throw new Error('Invalid SQLite result');
      result.models = rows.filter(object).map(model).filter(Boolean);
      result.capabilities = capabilities(result.models);
      const expiresAt = parseJSON(authRows[0]?.value)?.accessTokenExpiresAt;
      if (Number.isSafeInteger(expiresAt) && expiresAt > 0) {
        result.expiresAt = expiresAt;
        result.loggedIn = expiresAt > now();
      }
      return result;
    } catch (error) {
      if (error?.code === 'ENOENT' && !result.installed) return result;
      return { ...result, error: '无法只读加载 Token Switch 状态，请在 Token Switch 中检查配置' };
    }
  };
}
