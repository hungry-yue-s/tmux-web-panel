// The Agent console: Claude and Codex usage windows, provider switching,
// automatic Codex warm-up and the embedded enterprise model relay.

import createClaudeUsageRouter from '../../lib/api/claude-usage.js';
import createCodexUsageRouter from '../../lib/api/codex-usage.js';
import { createAgentHubRouter, createAgentHubService } from '../../lib/api/agent-hub.js';

export const name = 'agent-hub';

export const inject = ['launch', 'http'];

export function apply(ctx) {
  const { configDir } = ctx.launch;
  ctx.http.mount('/api/claude-usage', createClaudeUsageRouter());
  ctx.http.mount('/api/codex-usage', createCodexUsageRouter({ configDir }));

  const service = createAgentHubService({ configDir });
  ctx.http.mount('/api/agent-hub', createAgentHubRouter(service));

  ctx.effect(() => {
    service.startAutoWarmup();
    service.startEnterpriseRuntime().catch(() => {
      ctx.logger.error('集团模型中继恢复失败，请在 Agent 控制台重新启用');
    });
    return () => {
      service.stopAutoWarmup();
      return service.stopEnterpriseRuntime();
    };
  }, 'agent-hub.background');

  ctx.provide('agentHub', service);
  // The front end, where there are pages at all.
  ctx.inject(['ui'], (ctx) => ctx.ui.contribute(new URL('./client/page.json', import.meta.url)));
}
