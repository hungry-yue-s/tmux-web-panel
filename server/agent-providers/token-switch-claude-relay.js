import { execFile, spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { parse } from 'smol-toml';

import { AppError, ErrorCode } from '../servers/errors.js';
import { createTokenSwitchStatusReader } from './token-switch-status.js';

const execFileAsync = promisify(execFile);
const ID = 'token-switch-claude-relay';
const OWNER = 'token-switch-claude-relay-v1';
const NAME = 'Token Switch 集团资源池（Claude 兼容路由）';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

function parseJSON(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function sql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

// SQL contains a local proxy credential: keep it off argv, stdout and stderr.
export function mutateSQLite(path, query) {
  return new Promise((resolve, reject) => {
    const database = pathToFileURL(path);
    database.searchParams.set('mode', 'rw');
    const child = spawn('sqlite3', ['-bail', '-cmd', '.timeout 5000', database.href], { stdio: ['pipe', 'ignore', 'ignore'] });
    const timer = setTimeout(() => { child.kill(); }, 6000);
    child.on('error', () => { clearTimeout(timer); reject(new Error('SQLite write failed')); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('SQLite write failed'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(query);
  });
}

export function createTokenSwitchClaudeRelay(options = {}) {
  const home = options.home || homedir();
  const tokenSwitchDatabase = join(home, '.token-switch', 'token-switch.db');
  const ccSwitchDatabase = join(home, '.cc-switch', 'cc-switch.db');
  const runSQLite = options.runSQLite || (async (path, query) => {
    const result = await execFileAsync('sqlite3', ['-readonly', '-json', path, query], {
      timeout: 5000, maxBuffer: 1024 * 1024,
    });
    return result.stdout;
  });
  const readStatus = createTokenSwitchStatusReader({ home, runSQLite, now: options.now });
  // Injected writers must likewise execute query via stdin without logging it.
  const writeSQLite = options.mutateSQLite || mutateSQLite;
  const configPath = options.codexConfigPath || join(home, '.codex', 'config.toml');

  async function rows(path, query) {
    let result;
    try { result = JSON.parse(await runSQLite(path, query) || '[]'); } catch {
      throw new AppError(ErrorCode.UNSUPPORTED, '无法只读检查本地代理配置，请在原生应用中检查');
    }
    if (!Array.isArray(result)) throw new AppError(ErrorCode.UNSUPPORTED, '本地代理配置格式无效');
    return result;
  }

  async function context() {
    const status = await readStatus();
    if (!status.installed || status.error) throw new AppError(ErrorCode.UNSUPPORTED, '尚未发现可读取的 Token Switch 配置');
    if (!status.loggedIn) throw new AppError(ErrorCode.UNSUPPORTED, '请先在 Token Switch 登录或刷新已过期的集团登录态');
    const models = status.models.filter((entry) => entry.app === 'codex');
    const selected = models.find((entry) => entry.is_current)
      || models.find((entry) => entry.name.trim().toLowerCase() === 'auto');
    if (!selected) throw new AppError(ErrorCode.UNSUPPORTED, 'Token Switch 尚无当前或 Auto 托管模型可用于兼容路由预览');

    let ccSwitchExists = false;
    try { ccSwitchExists = (await stat(ccSwitchDatabase)).isFile(); } catch (error) {
      if (error?.code !== 'ENOENT') throw new AppError(ErrorCode.UNSUPPORTED, '无法读取 CC Switch 配置');
    }
    if (!ccSwitchExists) throw new AppError(ErrorCode.UNSUPPORTED, '请先在 CC Switch 完成初始化');
    const existing = await rows(ccSwitchDatabase,
      `select id, meta, is_current from providers where app_type='claude' and id='${ID}' limit 1`);
    if (existing.length && parseJSON(existing[0].meta)?.tmuxPanelRelay !== OWNER) {
      throw new AppError(ErrorCode.PROVIDER_CHANGED, '该 Claude 供应商 ID 已由其他配置占用，未覆盖');
    }
    if (existing.some((entry) => Number(entry.is_current) !== 0)) {
      throw new AppError(ErrorCode.PROVIDER_CHANGED, '兼容供应商正在使用，请先通过 CC Switch 切换后再维护');
    }

    const [tokenProxy, ccProxy] = await Promise.all([
      rows(tokenSwitchDatabase, "select listen_address, listen_port from proxy_config where app_type='codex' limit 1"),
      rows(ccSwitchDatabase, "select listen_address, listen_port from proxy_config where app_type='claude' limit 1"),
    ]);
    const address = tokenProxy[0]?.listen_address;
    const port = tokenProxy[0]?.listen_port;
    if (!LOOPBACK.has(address) || !Number.isInteger(port) || port < 1 || port > 65535
      || !LOOPBACK.has(ccProxy[0]?.listen_address) || !Number.isInteger(ccProxy[0]?.listen_port)
      || ccProxy[0].listen_port < 1 || ccProxy[0].listen_port > 65535) {
      throw new AppError(ErrorCode.UNSUPPORTED, '兼容路由需要两个已配置的本机回环代理地址');
    }
    if (port === ccProxy[0].listen_port) throw new AppError(ErrorCode.UNSUPPORTED, '两个代理端口相同，兼容路由可能成环');

    return { selected, address, port };
  }

  function configuration(model, endpoint) {
    return {
      id: ID, name: NAME, category: 'custom', is_current: false,
      settingsConfig: { env: {
        ANTHROPIC_BASE_URL: endpoint,
        ANTHROPIC_MODEL: model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
        ANTHROPIC_DEFAULT_SONNET_MODEL: model,
        ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      } },
      meta: { apiFormat: 'openai_responses', isFullUrl: true, tmuxPanelRelay: OWNER },
      notes: '需 CC Switch 开启 Claude 本地路由及 Token Switch 启用集团模型；仅验证原生本地配置，端到端响应与额度归属待验证。',
    };
  }

  async function nativeConfig({ selected, port }) {
    if (!selected.is_current) throw new AppError(ErrorCode.UNSUPPORTED, '请先在 Token Switch 启用当前集团托管模型');
    let config;
    try { config = parse(await readFile(configPath, 'utf8')); } catch {
      throw new AppError(ErrorCode.UNSUPPORTED, '无法读取 Token Switch 生成的 Codex 本地配置');
    }
    const model = config.model;
    const provider = config.model_providers?.tokenswitch;
    const managedModels = [selected.id, selected.meta.managedCatalog.serverModelId];
    if (config.model_provider !== 'tokenswitch' || !managedModels.includes(model) || provider?.wire_api !== 'responses') {
      throw new AppError(ErrorCode.UNSUPPORTED, 'Codex 当前配置未匹配 Token Switch 的托管 Responses 模型');
    }
    let url;
    try { url = new URL(provider.base_url); } catch {
      throw new AppError(ErrorCode.UNSUPPORTED, 'Token Switch 原生代理地址无效');
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const livePort = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (!['http:', 'https:'].includes(url.protocol) || !LOOPBACK.has(hostname)
      || livePort !== port || url.username || url.password || url.search || url.hash) {
      throw new AppError(ErrorCode.UNSUPPORTED, 'Token Switch 原生代理必须匹配已配置的本机回环端口');
    }
    const bearer = provider.experimental_bearer_token;
    if (typeof bearer !== 'string' || !bearer.trim() || /[\r\n]/.test(bearer)) {
      throw new AppError(ErrorCode.UNSUPPORTED, 'Token Switch 原生配置缺少可复用的本地代理认证');
    }
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/responses`;
    return { model, endpoint: url.href, bearer };
  }

  return {
    async preview() {
      const state = await context();
      const model = state.selected.meta.managedCatalog.serverModelId;
      const endpoint = `http://${state.address === '::1' ? '[::1]' : state.address}:${state.port}/v1/responses`;
      return {
        id: ID, name: NAME, model,
        prepared: false, dryRun: true, blocked: true, requiresNativeProxy: true,
        blockedReason: 'TOKEN_SWITCH_NATIVE_CONFIG_REQUIRED',
        reason: '仅预览；准备时将核对当前原生代理配置并注册未激活供应商，不自动切换或开启代理',
        configurationPreview: configuration(model, endpoint),
      };
    },
    async prepare() {
      const state = await context();
      const { model, endpoint, bearer } = await nativeConfig(state);
      const provider = configuration(model, endpoint);
      provider.settingsConfig.env.ANTHROPIC_AUTH_TOKEN = bearer;
      const query = `begin immediate;
create temp table relay_guard (allowed integer not null check (allowed=1));
insert into relay_guard select case when not exists (
  select 1 from providers where id=${sql(ID)} and app_type='claude'
) or exists (
  select 1 from providers where id=${sql(ID)} and app_type='claude' and is_current=0
    and case when json_valid(meta) then json_extract(meta,'$.tmuxPanelRelay') end=${sql(OWNER)}
) then 1 else 0 end;
insert into providers (id,app_type,name,settings_config,category,created_at,notes,meta,is_current,in_failover_queue)
values (${sql(ID)},'claude',${sql(NAME)},${sql(JSON.stringify(provider.settingsConfig))},'custom',${Number((options.now || Date.now)())},${sql(provider.notes)},${sql(JSON.stringify(provider.meta))},0,0)
on conflict(id,app_type) do update set name=excluded.name,settings_config=excluded.settings_config,
  category=excluded.category,notes=excluded.notes,meta=excluded.meta;
commit;`;
      try { await writeSQLite(ccSwitchDatabase, query); } catch {
        throw new AppError(ErrorCode.PROVIDER_CHANGED, '未更新兼容供应商：配置已变化、正在使用或数据库无法安全写入');
      }
      return {
        id: ID, name: NAME, model, prepared: true, requiresNativeProxy: true,
        verification: 'native-config-only',
        reason: '已注册未激活供应商；仍需 CC Switch 开启 Claude 本地路由，端到端响应与额度归属尚未验证',
      };
    },
  };
}
