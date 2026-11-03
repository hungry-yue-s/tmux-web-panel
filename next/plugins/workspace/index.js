// The workspace feature: its API and its view. It depends on the workspace
// seam only, never on tmux, so it works with any provider of `workspace`.

import { HttpError } from '../http/index.js';

export const name = 'workspace';

export const inject = ['http', 'workspace'];

export function apply(ctx) {
  ctx.http.get('/api/workspace', async () => {
    try {
      return await ctx.workspace.read();
    } catch (error) {
      ctx.logger.warn('workspace read failed: %s', error?.stderr?.trim() || error?.message || error);
      throw new HttpError(503, 'WORKSPACE_UNAVAILABLE', 'The workspace could not be read');
    }
  });

  // The view is only offered where there is a browser client at all.
  ctx.inject(['client'], (ctx) => {
    ctx.client.entry(new URL('./client/index.js', import.meta.url));
  });
}
