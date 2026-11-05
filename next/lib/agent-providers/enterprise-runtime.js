import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import { stringify } from 'smol-toml';

import { AppError, ErrorCode } from '../servers/errors.js';
import { mutateSQLite } from './token-switch-claude-relay.js';
import { requestToResponses, responseToAnthropic, responsesToAnthropicStream } from './anthropic-responses.js';
import { createDshTuiManager } from './dsh-tui.js';
import { configDirectory } from '../runtime-config.js';

const sql = (value) => `'${String(value).replaceAll("'", "''")}'`;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const OWNER = 'tmux-panel-token-switch-v1';

// The panel owns this listener and local key. Token Switch supplies only the
// existing user's session and authorized catalog, never a running UI process.
export function createEnterpriseRuntime(options = {}) {
  const home = options.home || homedir();
  const client = options.client;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const configDir = configDirectory({ configDir: options.configDir, home });
  const settingsPath = join(configDir, 'enterprise-relay.json');
  const database = join(home, '.cc-switch', 'cc-switch.db');
  const writeSQLite = options.writeSQLite || mutateSQLite;
  const dsh = options.dsh || createDshTuiManager({ home, configDir, dshHome: options.dshHome || process.env.DSH_HOME });
  let server = null;
  let starting = null;
  let local = null;
  let address = null;
  let catalogCache = null;
  let catalogExpiresAt = 0;
  const requests = new Set();

  async function settings() {
    if (local) return local;
    await mkdir(dirname(settingsPath), { recursive: true, mode: 0o700 });
    try { local = JSON.parse(await readFile(settingsPath, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('集团中继本地配置无效');
      const initial = { version: 1, port: options.port ?? 15723, key: randomBytes(32).toString('hex') };
      try { await writeFile(settingsPath, `${JSON.stringify(initial)}\n`, { mode: 0o600, flag: 'wx' }); }
      catch (writeError) { if (writeError.code !== 'EEXIST') throw writeError; }
      local = JSON.parse(await readFile(settingsPath, 'utf8'));
    }
    if (local.version !== 1 || !/^[a-f0-9]{64}$/.test(local.key)
      || !Number.isInteger(local.port) || local.port < 0 || local.port > 65535) throw new Error('集团中继本地配置无效');
    return local;
  }

  async function modelFor(id) {
    if (!catalogCache || Date.now() >= catalogExpiresAt) {
      catalogCache = client.getCatalog(['Codex']);
      catalogExpiresAt = Date.now() + 60000;
      catalogCache.catch(() => { catalogCache = null; });
    }
    const catalog = await catalogCache;
    const model = catalog.models.find((entry) => entry.app === 'codex' && entry.id === id);
    if (!model) throw new AppError(ErrorCode.UNSUPPORTED, '该模型未在当前集团账号的 Codex 目录中下发');
    const url = new URL(model.baseUrl);
    if (url.origin !== 'https://token-hub.alibaba-inc.com'
      || url.pathname.replace(/\/$/, '') !== '/portal/llm-api/openai/v1' || url.username || url.password || url.search || url.hash) {
      throw new AppError(ErrorCode.UNSUPPORTED, '集团模型网关地址尚未验证');
    }
    return { ...model, endpoint: `${url.href.replace(/\/$/, '')}/responses` };
  }

  function authorized(req) {
    if (!LOOPBACK.has(req.socket.remoteAddress) || req.headers.origin) return false;
    const value = req.headers.authorization?.replace(/^Bearer /, '') || req.headers['x-api-key'] || '';
    const key = Buffer.from(local.key);
    const given = Buffer.from(String(value));
    return key.length === given.length && timingSafeEqual(key, given);
  }

  async function bodyOf(req) {
    let length = 0;
    const chunks = [];
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 16 * 1024 * 1024) throw new Error('请求内容过大');
      chunks.push(chunk);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('请求 JSON 无效'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求 JSON 无效');
    return body;
  }

  async function handle(req, res) {
    const controller = new AbortController();
    requests.add(controller);
    req.once('aborted', () => controller.abort());
    res.once('close', () => { if (!res.writableFinished) controller.abort(); });
    try {
      if (!authorized(req)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { type: 'authentication_error', message: '本地中继认证失败' } }));
      }
      const claude = req.url === '/claude/v1/messages';
      if (req.method !== 'POST' || (!claude && req.url !== '/codex/v1/responses')) {
        res.writeHead(404); return res.end();
      }
      const body = await bodyOf(req);
      const model = await modelFor(body.model);
      const upstream = claude ? requestToResponses(body) : { ...body };
      upstream.model = model.id;
      const headers = await client.gatewayHeaders('Codex', model.id);
      const response = await fetchImpl(model.endpoint, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json', accept: body.stream ? 'text/event-stream' : 'application/json' },
        body: JSON.stringify(upstream), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(600000)]), redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        res.writeHead(response.status, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { type: 'api_error', message: `集团模型请求失败 (${response.status})` } }));
      }
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const source = claude ? responsesToAnthropicStream(response.body, model.id) : response.body;
        for await (const chunk of source) {
          if (controller.signal.aborted) break;
          if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal });
        }
        res.end();
      } else {
        const value = await response.json();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(claude ? responseToAnthropic(value, model.id) : value));
      }
    } catch (error) {
      if (res.headersSent) res.destroy();
      else {
        res.writeHead(error instanceof AppError ? 503 : 400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'api_error', message: error instanceof AppError ? error.message : '集团中继未能完成请求，请检查登录、模型和请求格式' } }));
      }
    } finally { requests.delete(controller); }
  }

  async function start() {
    if (address) return address;
    if (!starting) starting = (async () => {
      const config = await settings();
      const listener = createServer((req, res) => { void handle(req, res); });
      listener.listen(config.port, '127.0.0.1');
      try { await once(listener, 'listening'); }
      catch { listener.close(); throw new AppError(ErrorCode.WORKSPACE_UNAVAILABLE, '集团中继端口无法启动'); }
      if (config.port === 0) {
        const port = listener.address().port;
        try { await writeFile(settingsPath, `${JSON.stringify({ ...config, port })}\n`, { mode: 0o600 }); }
        catch (error) { listener.close(); throw error; }
        config.port = port;
      }
      server = listener;
      address = `http://127.0.0.1:${listener.address().port}`;
      return address;
    })().finally(() => { starting = null; });
    return starting;
  }

  async function resume() {
    try { await stat(settingsPath); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    await start();
  }

  async function prepare(agent, modelId) {
    if (!['claude', 'codex', 'dsh'].includes(agent)) throw new AppError(ErrorCode.VALIDATION_ERROR, '不支持此 Agent 的集团模型配置');
    const model = await modelFor(modelId);
    if (!(await client.checkQuota('Codex', model.id)).available) throw new AppError(ErrorCode.UNSUPPORTED, '该集团模型当前没有可用额度');
    if (agent === 'dsh') {
      const base = await start();
      const catalog = await catalogCache;
      return dsh.activate({ model: model.id, models: catalog.models.filter((item) => item.app === 'codex'), base, key: local.key });
    }
    if (!(await stat(database).catch(() => null))?.isFile()) throw new AppError(ErrorCode.UNSUPPORTED, '未找到现有供应商配置库');
    const base = await start();
    const id = `tmux-group-${model.id}`;
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(id)) throw new AppError(ErrorCode.UNSUPPORTED, '该集团模型 ID 暂不支持本地身份投影');
    const name = `集团资源池 · ${model.name}`;
    const config = agent === 'codex' ? {
      auth: { OPENAI_API_KEY: local.key },
      config: stringify({ model_provider: 'tmux_enterprise', model: model.id,
        model_providers: { tmux_enterprise: { name: '集团资源池', base_url: `${base}/codex/v1`, wire_api: 'responses', requires_openai_auth: false } } }),
    } : { env: { ANTHROPIC_BASE_URL: `${base}/claude`, ANTHROPIC_AUTH_TOKEN: local.key,
      ANTHROPIC_MODEL: model.id, ANTHROPIC_DEFAULT_HAIKU_MODEL: model.id,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model.id, ANTHROPIC_DEFAULT_OPUS_MODEL: model.id } };
    const meta = { tmuxPanelEnterprise: OWNER, enterpriseModelId: model.id, apiFormat: agent === 'claude' ? 'anthropic' : 'openai_responses' };
    const serialized = JSON.stringify(config);
    const guard = `not exists(select 1 from providers where id=${sql(id)} and app_type=${sql(agent)}) or exists(select 1 from providers where id=${sql(id)} and app_type=${sql(agent)} and case when json_valid(meta) then json_extract(meta,'$.tmuxPanelEnterprise') end=${sql(OWNER)} and (is_current=0 or settings_config=${sql(serialized)}))`;
    try { await writeSQLite(database, `begin immediate;
create temp table enterprise_guard(ok integer check(ok=1));
insert into enterprise_guard select case when ${guard} then 1 else 0 end;
insert into providers(id,app_type,name,settings_config,category,created_at,meta,is_current,in_failover_queue)
values(${sql(id)},${sql(agent)},${sql(name)},${sql(serialized)},'custom',${Date.now()},${sql(JSON.stringify(meta))},0,0)
on conflict(id,app_type) do update set name=excluded.name,settings_config=excluded.settings_config,meta=excluded.meta;
commit;`); } catch { throw new AppError(ErrorCode.PROVIDER_CHANGED, '集团供应商配置发生冲突，未覆盖'); }
    return { providerId: id, agent, modelId: model.id, name, prepared: true, requiresNativeProxy: false };
  }

  async function stop() {
    await starting?.catch(() => {});
    for (const request of requests) request.abort();
    const listener = server;
    server = null; address = null;
    if (listener) await new Promise((resolve) => { listener.close(resolve); listener.closeAllConnections(); });
  }

  return { start, resume, stop, prepare, dshStatus: dsh.status, activateDshModel: dsh.activate,
    status: () => ({ running: Boolean(address), activeRequests: requests.size }) };
}
