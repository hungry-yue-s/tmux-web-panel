import { Router } from 'express';
import { requireSameOrigin } from './same-origin.js';

// The database block: browse, query and edit SQLite files the preview can
// open. Uses Node's built-in node:sqlite, so nothing native is installed.

const PAGE_MAX = 500;
const QUERY_ROWS_MAX = 1000;

class SqliteError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

let sqliteModule = null;
async function loadSqlite() {
  if (!sqliteModule) {
    try {
      sqliteModule = await import('node:sqlite');
    } catch {
      throw new SqliteError('sqlite_unavailable', 501);
    }
  }
  return sqliteModule;
}

export function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

/** JSON-safe cell value: blobs become a marker, big integers strings. */
export function cellValue(value) {
  if (value instanceof Uint8Array) return { $blob: value.byteLength };
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function plainRows(rows, limit) {
  const out = [];
  for (const row of rows) {
    if (out.length >= limit) break;
    const plain = {};
    for (const key of Object.keys(row)) plain[key] = cellValue(row[key]);
    out.push(plain);
  }
  return out;
}

export function createSqliteRouter({ pathGuard }) {
  const router = Router();
  router.use(requireSameOrigin);

  async function openDb(source, { write = false } = {}) {
    const target = await pathGuard.resolve(source.path, source.paneId);
    if (target.error) throw new SqliteError(target.error, target.status);
    if (!target.stat.isFile()) throw new SqliteError('Not a regular file');
    const { DatabaseSync } = await loadSqlite();
    let db;
    try {
      db = new DatabaseSync(target.nativePath, { readOnly: !write, timeout: 3000 });
      db.prepare('SELECT count(*) FROM sqlite_master').get();
    } catch (error) {
      if (db) db.close();
      throw new SqliteError('not_a_sqlite_database: ' + error.message);
    }
    return db;
  }

  function tablesOf(db) {
    return db.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
  }

  function requireTable(db, name) {
    const table = tablesOf(db).find((entry) => entry.name === name);
    if (!table) throw new SqliteError('unknown_table', 404);
    return table;
  }

  function hasRowid(db, table) {
    try {
      db.prepare(`SELECT rowid FROM ${quoteIdent(table)} LIMIT 0`).all();
      return true;
    } catch {
      return false;
    }
  }

  const route = (fn) => async (req, res) => {
    let db = null;
    try {
      const data = await fn(req, (handle) => { db = handle; return handle; });
      res.json({ success: true, data, error: null });
    } catch (error) {
      res.status(error.status || 400).json({ success: false, data: null, error: error.message });
    } finally {
      if (db) {
        try { db.close(); } catch { /* already closed */ }
      }
    }
  };

  router.get('/schema', route(async (req, keep) => {
    const db = keep(await openDb(req.query));
    return {
      tables: tablesOf(db).map((entry) => {
        const columns = db.prepare(`PRAGMA table_info(${quoteIdent(entry.name)})`).all()
          .map((col) => ({ name: col.name, type: col.type, pk: col.pk > 0, notnull: !!col.notnull }));
        let rows = null;
        try {
          rows = Number(db.prepare(`SELECT count(*) AS n FROM ${quoteIdent(entry.name)}`).get().n);
        } catch {
          // A view over a missing table still lists.
        }
        return { name: entry.name, type: entry.type, columns, rows, editable: entry.type === 'table' && hasRowid(db, entry.name) };
      }),
    };
  }));

  router.get('/rows', route(async (req, keep) => {
    const db = keep(await openDb(req.query));
    const table = requireTable(db, req.query.table);
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 1), PAGE_MAX);
    const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
    const columns = db.prepare(`PRAGMA table_info(${quoteIdent(table.name)})`).all().map((col) => col.name);
    const rowid = table.type === 'table' && hasRowid(db, table.name);
    let order = '';
    if (typeof req.query.order === 'string' && columns.includes(req.query.order)) {
      order = ` ORDER BY ${quoteIdent(req.query.order)} ${req.query.dir === 'desc' ? 'DESC' : 'ASC'}`;
    }
    const select = rowid ? `rowid AS "__rowid__", *` : '*';
    const rows = db.prepare(`SELECT ${select} FROM ${quoteIdent(table.name)}${order} LIMIT ? OFFSET ?`).all(limit, offset);
    const total = Number(db.prepare(`SELECT count(*) AS n FROM ${quoteIdent(table.name)}`).get().n);
    return { columns, rows: plainRows(rows, limit), total, offset, limit, editable: rowid };
  }));

  router.post('/query', route(async (req, keep) => {
    const { sql, write = false } = req.body || {};
    if (typeof sql !== 'string' || !sql.trim() || sql.length > 100_000) throw new SqliteError('invalid_sql');
    const db = keep(await openDb(req.body, { write: write === true }));
    const statement = db.prepare(sql);
    const columns = typeof statement.columns === 'function' ? statement.columns().map((col) => col.name) : null;
    if (columns && columns.length > 0) {
      const rows = [];
      for (const row of statement.iterate()) {
        if (rows.length >= QUERY_ROWS_MAX) break;
        rows.push(row);
      }
      return { columns, rows: plainRows(rows, QUERY_ROWS_MAX), truncated: rows.length >= QUERY_ROWS_MAX };
    }
    const result = statement.run();
    return { columns: [], rows: [], changes: Number(result.changes || 0) };
  }));

  router.patch('/cell', route(async (req, keep) => {
    const { table, rowid, column, value } = req.body || {};
    const db = keep(await openDb(req.body, { write: true }));
    const entry = requireTable(db, table);
    if (entry.type !== 'table' || !hasRowid(db, entry.name)) throw new SqliteError('table_not_editable');
    const columns = db.prepare(`PRAGMA table_info(${quoteIdent(entry.name)})`).all().map((col) => col.name);
    if (!columns.includes(column)) throw new SqliteError('unknown_column');
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) throw new SqliteError('invalid_value');
    const result = db.prepare(`UPDATE ${quoteIdent(entry.name)} SET ${quoteIdent(column)} = ? WHERE rowid = ?`)
      .run(typeof value === 'boolean' ? Number(value) : value, Number(rowid));
    if (Number(result.changes) !== 1) throw new SqliteError('row_not_found', 404);
    return { changes: 1 };
  }));

  router.post('/row', route(async (req, keep) => {
    const { table } = req.body || {};
    const db = keep(await openDb(req.body, { write: true }));
    const entry = requireTable(db, table);
    if (entry.type !== 'table') throw new SqliteError('table_not_editable');
    const result = db.prepare(`INSERT INTO ${quoteIdent(entry.name)} DEFAULT VALUES`).run();
    return { rowid: Number(result.lastInsertRowid) };
  }));

  router.delete('/row', route(async (req, keep) => {
    const { table, rowid } = req.body || {};
    const db = keep(await openDb(req.body, { write: true }));
    const entry = requireTable(db, table);
    if (entry.type !== 'table' || !hasRowid(db, entry.name)) throw new SqliteError('table_not_editable');
    const result = db.prepare(`DELETE FROM ${quoteIdent(entry.name)} WHERE rowid = ?`).run(Number(rowid));
    return { changes: Number(result.changes) };
  }));

  return router;
}
