import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import { ManagedResources } from '../managed-resources.js';
import { AppError, ErrorCode } from '../servers/errors.js';

const PROVIDER = 'tmux-enterprise';
const KEY_REF = 'TMUX_PANEL_ENTERPRISE_API_KEY';
const JS_TAG = { tag: 'tag:yaml.org,2002:js', resolve: (value) => value };
const plain = (node) => isScalar(node) && !node.tag && typeof node.value === 'string' ? node.value : null;
async function optional(path) {
  try { return await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function document(text, sequence = false) {
  // Parse executable YAML tags as inert text, preserving them on round trips.
  const doc = parseDocument(text ?? (sequence ? '[]\n' : '{}\n'), { customTags: sequence ? [JS_TAG] : [] });
  if (doc.errors.length || (sequence ? !isSeq(doc.contents) : !isMap(doc.contents))) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'DSH 配置格式无效，未覆盖原文件');
  }
  return doc;
}
function row(doc, id) {
  return doc.contents.items.findLast((item) => isMap(item) && item.get('id') === id && !item.has('insert'));
}
function profiles(doc) {
  const providers = row(doc, 'llm-pi-ai')?.getIn(['config', 'providers'], true);
  if (!isMap(providers)) return [];
  return providers.items.flatMap((pair) => {
    const provider = plain(pair.key);
    const models = pair.value?.get?.('models', true);
    if (!provider || provider === PROVIDER || !isSeq(models)) return [];
    return models.items.flatMap((model) => {
      const id = plain(model?.get?.('id', true));
      return id ? [{ provider, model: id, name: plain(model.get('name', true)) || id,
        providerName: plain(pair.value.get('displayName', true)) || provider }] : [];
    });
  });
}

// Native dsh-tui profile integration; no global npm package or upstream login edits.
export function createDshTuiManager(options = {}) {
  const home = options.home || homedir();
  const dshHome = options.dshHome || (options.home ? null : process.env.DSH_HOME) || join(home, '.dsh');
  const profile = join(dshHome, 'profiles', 'dsh-tui');
  const patchPath = join(profile, 'cordis.patch.yml');
  const credentialsPath = join(dshHome, '.credentials.yaml');
  const modelPath = join(home, '.dsh-tui', 'model.json');
  const kernelPath = join(home, '.dsh-tui', 'kernel.json');
  const contextDisplayPath = join(profile, 'node_modules/@deepseek-harness-tui/dsh-tui/lib/types/dsh-adapter/context-occupancy.js');
  const resources = new ManagedResources({ projectDir: '', configDir: join(home, '.config/tmux-web-panel'), userHome: home });
  const parseJSON = (text) => {
    try { const value = JSON.parse(text || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
    catch { return {}; }
  };

  async function status() {
    const manifest = parseJSON(await optional(join(profile, 'node_modules/@deepseek-harness-tui/dsh-tui/package.json')));
    if (typeof manifest.version !== 'string') return { installed: false, profiles: [] };
    try {
      const doc = document(await optional(patchPath), true);
      const pref = parseJSON(await optional(modelPath));
      const tui = row(doc, 'dsh-tui');
      const defaults = row(doc, 'agent-default-model');
      const configured = (key) => plain(tui?.getIn(['config', key], true));
      const backend = configured('backend') || parseJSON(await optional(kernelPath)).backend || 'dsh';
      const deployment = configured('provider') && configured('model') ? {
        provider: configured('provider'), model: configured('model'),
      } : { provider: plain(defaults?.getIn(['config', 'provider'], true)), model: plain(defaults?.getIn(['config', 'model'], true)) };
      const selected = typeof pref.provider === 'string' && pref.provider && typeof pref.model === 'string' && pref.model ? pref : deployment;
      return { installed: true, version: manifest.version, backend,
        provider: selected.provider, model: selected.model,
        enterpriseModelId: backend === 'dsh' && selected.provider === PROVIDER ? selected.model : null,
        profiles: profiles(doc), launchCommand: 'dsh-tui --backend dsh',
        reason: backend !== 'dsh' ? '当前选择其他后端；切换模型将为下次启动选择 DSH 后端' : null };
    } catch { return { installed: true, version: manifest.version, profiles: [], reason: 'DSH 配置读取失败，请先修复原配置' }; }
  }

  async function activate({ provider = PROVIDER, model, models, base, key }) {
    if (!(await status()).installed) throw new AppError(ErrorCode.UNSUPPORTED, '尚未发现已安装的 dsh-tui profile');
    const locks = [];
    const written = [];
    try {
      // Match DSH's profile editor and credential store lock paths and PID records.
      for (const path of [join(profile, 'package.json'), credentialsPath, kernelPath, modelPath]) {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        let handle;
        try { handle = await open(`${path}.lock`, 'wx', 0o600); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          throw new AppError(ErrorCode.PROVIDER_CHANGED, 'DSH 正在修改配置，请稍后重试');
        }
        locks.push({ path: `${path}.lock`, handle });
        await handle.writeFile(`${process.pid}\n`);
      }
      const before = new Map(await Promise.all([patchPath, credentialsPath, kernelPath, modelPath, contextDisplayPath].map(async (path) => [path, await optional(path)])));
      const doc = document(before.get(patchPath), true);
      const backend = plain(row(doc, 'dsh-tui')?.getIn(['config', 'backend'], true));
      if (backend && backend !== 'dsh') throw new AppError(ErrorCode.UNSUPPORTED, 'DSH profile 固定了其他后端，请先在 dsh-tui 中选择 DSH 后端');
      const changes = [];
      if (provider === PROVIDER) {
        let entry = row(doc, 'llm-pi-ai');
        if (!entry) { doc.add({ id: 'llm-pi-ai', config: { providers: {} } }); entry = row(doc, 'llm-pi-ai'); }
        const existing = entry.getIn(['config', 'providers', PROVIDER], true);
        if (existing && (existing.get?.('apiKeyEnv') !== KEY_REF || existing.get?.('baseURL') !== `${base}/codex/v1`)) {
          throw new AppError(ErrorCode.PROVIDER_CHANGED, 'DSH 中已有同名提供方，未覆盖');
        }
        entry.setIn(['config', 'providers', PROVIDER], {
          displayName: '集团 AI 资源包', apiKeyEnv: KEY_REF, api: 'openai-responses',
          baseURL: `${base}/codex/v1`, transport: 'sse',
          models: models.map((item) => ({ id: item.id, name: item.name,
            ...(Number.isFinite(item.contextWindow) && item.contextWindow > 0 ? { contextWindow: item.contextWindow } : {}) })),
        });
        const credentials = document(before.get(credentialsPath));
        const version = credentials.get('version');
        if (version !== undefined && version !== 1) throw new AppError(ErrorCode.UNSUPPORTED, 'DSH 凭据格式版本不受支持');
        if (credentials.has('refs') && !isMap(credentials.get('refs', true))) throw new AppError(ErrorCode.VALIDATION_ERROR, 'DSH 凭据格式无效');
        credentials.set('version', 1);
        credentials.setIn(['refs', KEY_REF], key);
        changes.push([credentialsPath, credentials.toString()], [patchPath, doc.toString()]);
      } else if (!profiles(doc).some((item) => item.provider === provider && item.model === model)) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 'DSH 提供方或模型不在当前配置中');
      }
      // dsh-tui 0.16.1 prefers the preceding request's projected capacity even
      // after /model has resolved the new route's window. Patch only this known
      // expression; newer/unrecognized implementations remain untouched.
      const contextSource = before.get(contextDisplayPath);
      const staleWindow = 'const contextWindow = projected?.contextWindow ?? requestWindow;';
      const liveWindow = 'const contextWindow = requestWindow ?? projected?.contextWindow;';
      const repairContextWindow = contextSource?.includes('export function resolveContextOccupancy(')
        && contextSource.split(staleWindow).length === 2;
      if (repairContextWindow) changes.push([contextDisplayPath, contextSource.replace(staleWindow, liveWindow)]);
      changes.push([kernelPath, JSON.stringify({ backend: 'dsh' }) + '\n'], [modelPath, JSON.stringify({ provider, model }) + '\n']);
      const backups = [];
      for (const [path, text] of changes) {
        if (await optional(path) !== before.get(path)) throw new AppError(ErrorCode.PROVIDER_CHANGED, 'DSH 配置已改变，请重新读取');
        backups.push(await resources.backupWrite(path, text));
        written.push({ path, text, before: before.get(path) });
      }
      return { agent: 'dsh', modelId: model, active: true, backups: backups.filter(Boolean).length, source: 'native-dsh-profile',
        contextWindowRepaired: Boolean(repairContextWindow) };
    } catch (error) {
      for (const item of written.reverse()) {
        // A running TUI may save preferences without taking a file lock.
        if (await optional(item.path) !== item.text) continue;
        if (item.before === null) await unlink(item.path);
        else await resources.backupWrite(item.path, item.before);
      }
      throw error;
    } finally {
      for (const lock of locks.reverse()) { await lock.handle.close(); await unlink(lock.path); }
    }
  }
  return { status, activate };
}
