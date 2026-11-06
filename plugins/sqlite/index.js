// SQLite preview (/api/sqlite, lib/api/sqlite.js): tables and rows of a
// database file within the file roots, read-only, through Node's node:sqlite.

import { createSqliteRouter } from '../../lib/api/sqlite.js';

export const name = 'sqlite';

export const inject = ['http', 'fileAccess'];

export function apply(ctx) {
  ctx.http.mount('/api/sqlite', createSqliteRouter({ pathGuard: ctx.fileAccess.pathGuard }));
}
