// Notebooks (/api/notebook, lib/api/open.js): open a .ipynb within the file
// roots in this machine's Jupyter.

import { createNotebookRouter } from '../../lib/api/open.js';

export const name = 'notebook';

export const inject = ['http', 'fileAccess'];

export function apply(ctx) {
  ctx.http.mount('/api/notebook', createNotebookRouter({ pathGuard: ctx.fileAccess.pathGuard }));
}
