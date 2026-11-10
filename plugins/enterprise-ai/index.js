// `ctx.enterpriseAi`: the enterprise model pool (lib/agent-providers/enterprise-ai.js):
// its catalog and quota, the embedded relay that serves it to Codex, Claude and
// DSH on loopback, and registering that relay with CC Switch. The Agent console
// reaches it per call and shows no enterprise section without it.
//
// A relay that was enabled resumes when the plugin loads and stops with it.

import { createEnterpriseAiService } from '../../lib/agent-providers/enterprise-ai.js';

export const name = 'enterprise-ai';

export const inject = ['launch'];

export function apply(ctx) {
  const service = createEnterpriseAiService({ configDir: ctx.launch.configDir });
  ctx.effect(() => {
    service.startRuntime().catch(() => {
      ctx.logger.error('集团模型中继恢复失败，请在 Agent 控制台重新启用');
    });
    return () => service.stopRuntime();
  }, 'enterprise-ai.runtime');
  ctx.provide('enterpriseAi', service);
}
