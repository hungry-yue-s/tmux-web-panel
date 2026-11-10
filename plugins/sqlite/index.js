// SQLite preview: its view in the file preview (client/), and /api/sqlite
// (lib/api/sqlite.js) for the tables and rows of a database file within the
// file roots, through Node's node:sqlite.

import { createSqliteRouter } from '../../lib/api/sqlite.js';

export const name = 'sqlite';

export const inject = ['http', 'fileAccess'];

export function apply(ctx) {
  ctx.http.mount('/api/sqlite', createSqliteRouter({ pathGuard: ctx.fileAccess.pathGuard }));
  // The front end, where there are pages at all.
  ctx.inject(['ui'], (ctx) => ctx.ui.contribute(new URL('./client/page.json', import.meta.url)));
}
