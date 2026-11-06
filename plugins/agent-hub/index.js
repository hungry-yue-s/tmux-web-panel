// The Agent console (/api/agent-hub, lib/api/agent-hub.js): Codex accounts and
// CC Switch providers, switching between them, automatic Codex warm-up, and
// Qoder. The enterprise section comes from the enterprise-ai plugin, looked up
// per call; usage windows are agent-usage's.

import { createAgentHubRouter, createAgentHubService } from '../../lib/api/agent-hub.js';

export const name = 'agent-hub';

export const inject = ['launch', 'http'];

export function apply(ctx) {
  const service = createAgentHubService({
    configDir: ctx.launch.configDir,
    getEnterpriseService: () => ctx.get('enterpriseAi') ?? null,
  });
  ctx.http.mount('/api/agent-hub', createAgentHubRouter(service));
  ctx.effect(() => {
    service.startAutoWarmup();
    return () => service.stopAutoWarmup();
  }, 'agent-hub.warmup');
  ctx.provide('agentHub', service);
  // The front end, where there are pages at all.
  ctx.inject(['ui'], (ctx) => ctx.ui.contribute(new URL('./client/page.json', import.meta.url)));
}
