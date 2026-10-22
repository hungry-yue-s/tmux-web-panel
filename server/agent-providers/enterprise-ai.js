import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';

import { AppError, ErrorCode } from '../servers/errors.js';
import { createTokenSwitchStatusReader } from './token-switch-status.js';
import { createQoderCapabilitiesReader } from './qoder-capabilities.js';
import { createQoderUsageReader } from './qoder-usage.js';
import { createTokenSwitchClaudeRelay } from './token-switch-claude-relay.js';
import { createTokenSwitchClient } from './token-switch-client.js';
import { createEnterpriseRuntime } from './enterprise-runtime.js';
import { createAliLangUsageReader } from './alilang-usage.js';

const execFileAsync = promisify(execFile);
const APPS = Object.freeze({
  alilang: '/Applications/AliLang.app',
  tokenswitch: '/Applications/Token Switch.app',
  ccswitch: '/Applications/CC Switch.app',
});

// Keep each pool's entitlements and measured usage separate. Missing numerical
// quota is unavailable, rather than inferred from Token Switch's boolean check.
export function createEnterpriseAiService(options = {}) {
  const home = options.home || homedir();
  const client = options.client || createTokenSwitchClient({ home });
  const runtime = options.runtime || createEnterpriseRuntime({ home, client });
  const localTokenSwitch = createTokenSwitchStatusReader({ home });
  const readTokenSwitch = options.readTokenSwitch || (async () => {
    const local = await localTokenSwitch();
    const session = await client.getStatus();
    if (!session.loggedIn) return { ...local, ...session, canSwitchInPanel: false };
    try {
      const catalog = await client.getCatalog(['Codex']);
      return { ...local, ...session, canSwitchInPanel: true, source: 'direct-token-switch-api',
        capabilities: { ...local.capabilities,
          codex: { supported: true, control: 'embedded', reason: '面板直接切换集团模型' },
          claude: { supported: true, control: 'embedded', reason: '内置协议转换复用已下发的 Codex 集团模型' },
        },
        models: catalog.models.map((model) => ({ ...model, meta: { managedCatalog: {
          serverModelId: model.id, description: model.description, multiplier: model.multiplier, contextWindow: model.contextWindow,
        } } })),
      };
    } catch { return { ...local, ...session, canSwitchInPanel: false, error: '集团模型目录读取失败，请检查登录与网络' }; }
  });
  const readQoder = options.readQoder || createQoderCapabilitiesReader({ home });
  const readQoderUsage = options.readQoderUsage || createQoderUsageReader({ home });
  const relay = options.relay || createTokenSwitchClaudeRelay({ home });
  const readAliLang = options.readAliLang || createAliLangUsageReader({ home });
  const run = options.execFile || execFileAsync;
  const platform = options.platform || process.platform;
  let cached = null;
  let expiresAt = 0;
  let cachedVisibility = '';

  async function status(input = {}) {
    if (input.codex === false && input.claude === false) return null;
    const visibility = `${input.codex !== false}:${input.claude !== false}`;
    if (!cached || Date.now() >= expiresAt || visibility !== cachedVisibility) {
      cachedVisibility = visibility;
      expiresAt = Date.now() + 60_000;
      cached = Promise.all([
        readAliLang(), readTokenSwitch(), input.codex !== false ? readQoder() : null,
        input.codex !== false ? readQoderUsage() : null,
      ]).then(([alilang, tokenSwitch, qoder, qoderUsage]) => ({
        available: Boolean(alilang.installed || tokenSwitch.installed || qoderUsage?.status === 'available'),
        observedAt: new Date().toISOString(),
        alilang, tokenSwitch, qoder,
        pools: [
          ...(input.codex !== false ? [{ id: 'qoder-ide', name: 'Qoder IDE 月额度', applications: ['Qoder IDE'],
            status: qoderUsage?.status === 'available' ? 'available'
              : alilang.pools?.find((pool) => pool.id === 'qoder-ide')?.status || qoderUsage?.status || 'unavailable',
            reason: qoderUsage?.status === 'available' || alilang.pools?.some((pool) => pool.id === 'qoder-ide' && pool.usage)
              ? undefined : qoderUsage?.reason,
            usage: qoderUsage?.status === 'available' ? { ...qoderUsage,
              resetsAt: qoderUsage.expiresAt ? Date.parse(qoderUsage.expiresAt) / 1000 : null }
              : alilang.pools?.find((pool) => pool.id === 'qoder-ide')?.usage || null }] : []),
          alilang.pools?.find((pool) => pool.id === 'enterprise') || {
            id: 'enterprise', name: '集团 AI 资源包', applications: ['以资源包支持应用为准'],
            status: alilang.status || 'unavailable', reason: alilang.reason },
        ],
        runtime: runtime.status(),
      }));
    }
    return cached;
  }

  async function openApp(app) {
    if (!Object.hasOwn(APPS, app)) throw new AppError(ErrorCode.VALIDATION_ERROR, '未知的集团 AI 应用');
    if (platform !== 'darwin') throw new AppError(ErrorCode.UNSUPPORTED, '此入口仅支持本机 macOS 应用');
    try { await run('open', ['-a', APPS[app]], { timeout: 5000, maxBuffer: 16 * 1024 }); }
    catch { throw new AppError(ErrorCode.WORKSPACE_UNAVAILABLE, '无法打开应用，请确认本机已经安装'); }
    return { app, opened: true };
  }

  async function retryQuota() {
    if (typeof readAliLang.retry === 'function') await readAliLang.retry();
    cached = null;
    return status();
  }

  return { status, openApp, previewClaudeRelay: relay.preview, prepareClaudeRelay: relay.prepare,
    prepareManaged: runtime.prepare, dshStatus: runtime.dshStatus, activateDshModel: runtime.activateDshModel,
    startRuntime: runtime.resume, stopRuntime: runtime.stop, retryQuota };
}
