// Notebooks: their rendering in the file preview (client/), and /api/notebook
// (lib/api/open.js) to run a .ipynb within the file roots in this machine's Jupyter.

import { createNotebookRouter } from '../../lib/api/open.js';

export const name = 'notebook';

export const inject = ['http', 'fileAccess'];

export function apply(ctx) {
  ctx.http.mount('/api/notebook', createNotebookRouter({ pathGuard: ctx.fileAccess.pathGuard }));
  // The front end, where there are pages at all.
  ctx.inject(['ui'], (ctx) => ctx.ui.contribute(new URL('./client/page.json', import.meta.url)));
}
