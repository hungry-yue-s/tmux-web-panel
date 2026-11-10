// SQLite fixtures through Node's built-in module, so the tests need no sqlite3
// command line (Windows rarely has one).

import { DatabaseSync } from 'node:sqlite';

/** Runs a script, creating the database when it is missing. */
export function sqliteExec(path, script) {
  const db = new DatabaseSync(path);
  try {
    db.exec(script);
  } finally {
    db.close();
  }
}

/** The rows of one query, read-only. */
export function sqliteRows(path, query) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(query).all().map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}
