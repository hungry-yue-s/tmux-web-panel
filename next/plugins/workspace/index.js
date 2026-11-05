// `ctx.workspace`: this machine's session/window/pane tree (lib/workspace).
//
// The single thing the workspace API, the terminal gateway and the panel
// plugins talk to. Every mutation bumps a revision; the change goes out as
// the `status/workspace-changed` event so open pages refetch instead of
// polling. Reads are single-flight and invalidated by mutations.

import { WorkspaceService } from '../../lib/workspace/service.js';
import { createWorkspaceRouter } from '../../lib/api/workspace.js';

export const name = 'workspace';

export const inject = ['http', 'tmux'];

export function apply(ctx) {
  const service = new WorkspaceService({
    tmux: ctx.tmux,
    onChange: (revision) => ctx.emit('status/workspace-changed', revision),
  });
  ctx.http.mount('/api/workspace', createWorkspaceRouter({ workspaceService: service }));
  ctx.provide('workspace', service);
}
