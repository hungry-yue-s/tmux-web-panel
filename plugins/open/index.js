// `anymux open <path>` from a pane (/api/open, lib/api/open.js): the open pages
// show that file, announced over the status socket (status/event).

import { createOpenRouter } from '../../lib/api/open.js';

export const name = 'open';

export const inject = ['http', 'fileAccess'];

export function apply(ctx) {
  ctx.http.mount('/api/open', createOpenRouter({
    pathGuard: ctx.fileAccess.pathGuard,
    broadcast: (event) => ctx.emit('status/event', event),
  }));
}
