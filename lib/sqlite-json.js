// SQLite for the agent providers: CC Switch's and Token Switch's databases.
//
// Node's built-in node:sqlite where this Node has it (22.13 and later, all of
// 24), otherwise the sqlite3 command line as before. Windows rarely has a
// sqlite3 on PATH, so without the built-in module provider switching and the
// Token Switch status silently did nothing there.
//
// Both keep the command line's contract, which the callers were written to:
// - runSQLiteJson(path, sql) answers what `sqlite3 -json [-readonly]` prints:
//   the rows as JSON text, or '' when there are none;
// - mutateSQLite(path, script) runs a script like `sqlite3 -bail` with a
//   5-second busy timeout on an existing database, and stops at the first
//   error; closing the connection rolls back a transaction the script left
//   open. The script carries credentials, so no error says anything about it.
//
// Statements are split on semicolons outside quotes and comments; scripts
// with CREATE TRIGGER bodies are not supported (none are written here).

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const BUSY_TIMEOUT_MS = 5000;

let builtin;

/** node:sqlite, or null when this Node has none. */
export async function loadBuiltinSqlite() {
  if (builtin === undefined) {
    try {
      builtin = await import('node:sqlite');
    } catch {
      builtin = null;
    }
  }
  return builtin;
}

/** The statements of a script, without the separating semicolons. */
export function splitStatements(script) {
  const statements = [];
  let start = 0;
  let i = 0;
  const n = script.length;
  while (i < n) {
    const c = script[i];
    if (c === "'" || c === '"' || c === '`') {
      // A quote ends at the same character not doubled.
      i += 1;
      while (i < n) {
        if (script[i] === c) {
          if (script[i + 1] === c) i += 2;
          else break;
        } else i += 1;
      }
      i += 1;
    } else if (c === '[') {
      const end = script.indexOf(']', i + 1);
      i = end < 0 ? n : end + 1;
    } else if (c === '-' && script[i + 1] === '-') {
      const end = script.indexOf('\n', i + 2);
      i = end < 0 ? n : end + 1;
    } else if (c === '/' && script[i + 1] === '*') {
      const end = script.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === ';') {
      statements.push(script.slice(start, i));
      i += 1;
      start = i;
    } else i += 1;
  }
  statements.push(script.slice(start));
  return statements.map((statement) => statement.trim()).filter(Boolean);
}

function open(sqlite, path, readOnly) {
  // Neither kind of call may create a database that is not there.
  if (!existsSync(path)) throw Object.assign(new Error(`no database at ${path}`), { code: 'ENOENT' });
  const db = new sqlite.DatabaseSync(path, { readOnly });
  db.exec(`pragma busy_timeout = ${BUSY_TIMEOUT_MS}`);
  return db;
}

function jsonValue(value) {
  if (value === null || value === undefined) return 'null';
  // Every integer, as its digits: past 2^53 a Number would throw or round.
  if (typeof value === 'bigint') return value.toString();
  // The command line prints a BLOB as a string of its bytes.
  if (value instanceof Uint8Array) return JSON.stringify(Buffer.from(value).toString('utf8'));
  return JSON.stringify(value);
}

/** Rows as `sqlite3 -json` prints them. */
export function rowsToJson(rows) {
  return '[' + rows.map((row) => '{' + Object.entries(row)
    .map(([column, value]) => JSON.stringify(column) + ':' + jsonValue(value)).join(',') + '}').join(',') + ']';
}

/** Like `sqlite3 -json [-readonly] path sql`. */
export async function runSQLiteJson(path, sql, { readonly = false, sqlite } = {}) {
  const module = sqlite === undefined ? await loadBuiltinSqlite() : sqlite;
  if (!module) {
    const args = ['-json', ...(readonly ? ['-readonly'] : []), path, sql];
    return (await execFileAsync('sqlite3', args, { timeout: BUSY_TIMEOUT_MS, maxBuffer: 1024 * 1024 })).stdout;
  }
  const db = open(module, path, readonly);
  try {
    const rows = [];
    for (const statement of splitStatements(sql)) {
      const prepared = db.prepare(statement);
      prepared.setReadBigInts(true);
      rows.push(...prepared.all());
    }
    return rows.length ? rowsToJson(rows) : '';
  } finally {
    db.close();
  }
}

/** Like `sqlite3 -bail -cmd '.timeout 5000' file:path?mode=rw` with the script on stdin. */
export async function mutateSQLite(path, script, { sqlite } = {}) {
  const module = sqlite === undefined ? await loadBuiltinSqlite() : sqlite;
  if (!module) return mutateWithCommandLine(path, script);
  let db;
  try {
    db = open(module, path, false);
    for (const statement of splitStatements(script)) db.prepare(statement).run();
  } catch {
    throw new Error('SQLite write failed');
  } finally {
    db?.close();
  }
}

function mutateWithCommandLine(path, script) {
  return new Promise((resolve, reject) => {
    const database = pathToFileURL(path);
    database.searchParams.set('mode', 'rw');
    const child = spawn('sqlite3', ['-bail', '-cmd', `.timeout ${BUSY_TIMEOUT_MS}`, database.href], { stdio: ['pipe', 'ignore', 'ignore'] });
    const timer = setTimeout(() => { child.kill(); }, BUSY_TIMEOUT_MS + 1000);
    child.on('error', () => { clearTimeout(timer); reject(new Error('SQLite write failed')); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('SQLite write failed'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(script);
  });
}
