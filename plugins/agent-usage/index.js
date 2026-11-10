// Claude and Codex usage on this machine (/api/claude-usage, /api/codex-usage):
// tokens, sessions and rate-limit windows read from the agents' own files.

import createClaudeUsageRouter from '../../lib/api/claude-usage.js';
import createCodexUsageRouter from '../../lib/api/codex-usage.js';

export const name = 'agent-usage';

export const inject = ['launch', 'http'];

export function apply(ctx) {
  ctx.http.mount('/api/claude-usage', createClaudeUsageRouter());
  ctx.http.mount('/api/codex-usage', createCodexUsageRouter({ configDir: ctx.launch.configDir }));
}
